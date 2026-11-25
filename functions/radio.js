'use strict';

/*
 * Prayer Dome Radio — presenter access and live-session service.
 * ---------------------------------------------------------------------------
 * The listener-facing player is deliberately not the security boundary. Every
 * sensitive transition is decided here, under the Admin SDK:
 *
 *   request  → a signed-in member asks for one programme slot
 *   decision → only an administrator can approve, reject, ask for changes or
 *               revoke an approval
 *   start    → the approved owner starts inside the approved window; the
 *               server creates the session and the public LIVE state
 *   heartbeat→ the presenter keeps the session alive
 *   end/stop → the presenter or an administrator ends it
 *   watchdog → an expired, disconnected or stale session is ended even if the
 *               presenter closes the browser without pressing Stop
 *
 * Firestore rules deny client writes to requests, sessions and live state.
 * The WebRTC signal channel is separate and is covered by its own rules.
 *
 * No stream credentials are handled here. The public station URL is metadata
 * configured by an administrator; provider secrets stay in server env.
 */

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const notifications = require('./notifications');
const { defineSecret } = require('firebase-functions/params');

const REGION = 'us-central1';
const brevoApiKey = defineSecret('BREVO_API_KEY');
const runtime = functions.runWith({ secrets: [brevoApiKey] }).region(REGION);
const { HttpsError } = functions.https;

const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'changes', 'revoked', 'expired', 'completed'];
const ACTIVE_SESSION_MS = 90 * 1000; // three missed heartbeats
const ACCESS_LEAD_MS = 30 * 60 * 1000;
const ACCESS_GRACE_MS = 15 * 60 * 1000;
const MAX_DURATION_MINUTES = 480;
const MIN_DURATION_MINUTES = 15;

function fail(code, message) {
  throw new HttpsError(code, message);
}

function text(value, max) {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max || 500);
}

function longText(value, max) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim().slice(0, max || 600);
}

function nowMs() {
  return Date.now();
}

function stampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value.seconds) return Number(value.seconds) * 1000;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatLusaka(value) {
  const ms = stampMs(value);
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Lusaka', dateStyle: 'medium', timeStyle: 'short'
    }).format(new Date(ms)) + ' (Lusaka time)';
  } catch (error) { return new Date(ms).toISOString(); }
}

async function isAdmin(uid) {
  if (!uid) return false;
  const db = admin.firestore();
  try {
    const [member, user] = await Promise.all([
      db.collection('memberships').doc(uid).get(),
      db.collection('users').doc(uid).get()
    ]);
    return (member.exists && member.data().role === 'admin') ||
      (user.exists && user.data().role === 'admin');
  } catch (error) { return false; }
}

async function requireAdmin(context) {
  if (!context || !context.auth || !context.auth.uid) {
    fail('unauthenticated', 'Sign in with an administrator account.');
  }
  if (!(await isAdmin(context.auth.uid))) {
    fail('permission-denied', 'Only a Prayer Dome administrator can manage radio presenters.');
  }
  return context.auth;
}

async function adminIds() {
  const db = admin.firestore();
  const ids = new Set();
  const queries = [
    db.collection('users').where('role', '==', 'admin').limit(25).get(),
    db.collection('memberships').where('role', '==', 'admin').limit(25).get()
  ];
  const results = await Promise.allSettled(queries);
  results.forEach(function (result) {
    if (result.status !== 'fulfilled') return;
    result.value.forEach(function (entry) { ids.add(entry.id); });
  });
  return Array.from(ids);
}

async function notifyAdmins(requestId, values) {
  const ids = await adminIds();
  if (!ids.length) return { sent: 0, reason: 'no-admins' };
  const results = await Promise.all(ids.map(function (uid) {
    return notifications.deliverEvent({
      event: 'radio_presenter_request',
      eventId: 'evt_radio_request_' + requestId + '_' + uid,
      userId: uid,
      values,
      title: 'Radio presenter request',
      message: values.name + ' requested ' + values.title + ' at ' + values.date + '.',
      link: '/admin.html#radio'
    }).catch(function (error) { return { sent: false, error: error && error.message }; });
  }));
  return { sent: results.filter(function (item) { return item && item.sent; }).length };
}

async function notifyPresenter(uid, values) {
  if (!uid) return { sent: false, reason: 'missing-presenter' };
  try {
    return await notifications.deliverEvent({
      event: 'radio_presenter_decision',
      eventId: 'evt_radio_decision_' + values.requestId + '_' + values.status + '_' + Date.now().toString(36),
      userId: uid,
      values,
      title: 'Presenter request ' + values.status,
      message: values.title + ': ' + values.status,
      link: '/radio.html#presenter-studio'
    });
  } catch (error) {
    console.warn('Presenter decision notification failed:', error && error.message);
    return { sent: false, error: error && error.message };
  }
}

async function writeHealth(entry) {
  try {
    await admin.firestore().collection('radioStreamHealth').add(Object.assign({
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, entry || {}));
  } catch (error) { /* health logging must not break a live transition */ }
}

function cleanRequest(data) {
  const name = text(data && data.name, 80);
  const programmeTitle = text(data && (data.programmeTitle || data.title), 100);
  const description = longText(data && data.description, 600);
  const startRaw = data && (data.startAt || data.start);
  const start = startRaw ? new Date(startRaw) : null;
  const durationMinutes = Number(data && data.durationMinutes);
  if (!name || name.length < 2) fail('invalid-argument', 'Enter the presenter name.');
  if (!programmeTitle || programmeTitle.length < 2) fail('invalid-argument', 'Enter the programme title.');
  if (!start || Number.isNaN(start.getTime())) fail('invalid-argument', 'Choose a valid proposed start time.');
  if (start.getTime() < nowMs() - 5 * 60 * 1000) fail('invalid-argument', 'The proposed start time has already passed.');
  if (start.getTime() > nowMs() + 30 * 24 * 60 * 60 * 1000) fail('invalid-argument', 'Choose a start time within the next 30 days.');
  if (!Number.isFinite(durationMinutes) || durationMinutes < MIN_DURATION_MINUTES || durationMinutes > MAX_DURATION_MINUTES) {
    fail('invalid-argument', 'Choose a duration between ' + MIN_DURATION_MINUTES + ' and ' + MAX_DURATION_MINUTES + ' minutes.');
  }
  if (description.length < 20) fail('invalid-argument', 'Describe the programme in at least 20 characters.');
  return { name, programmeTitle, description, start, durationMinutes: Math.round(durationMinutes) };
}

function publicRequest(row) {
  return {
    id: row.id,
    name: row.name || '',
    programmeTitle: row.programmeTitle || '',
    startAt: row.startAt || null,
    endAt: row.endAt || null,
    durationMinutes: Number(row.durationMinutes) || 0,
    description: row.description || '',
    status: row.status || 'pending',
    adminNote: row.adminNote || '',
    createdAt: row.createdAt || null,
    decidedAt: row.decidedAt || null,
    accessStartsAt: row.accessStartsAt || null,
    accessEndsAt: row.accessEndsAt || null
  };
}

function sessionPublic(row) {
  return {
    id: row.id,
    requestId: row.requestId || '',
    presenterName: row.presenterName || '',
    programmeTitle: row.programmeTitle || '',
    status: row.status || 'active',
    startedAt: row.startedAt || null,
    expiresAt: row.expiresAt || null,
    lastHeartbeatAt: row.lastHeartbeatAt || null,
    endedAt: row.endedAt || null,
    endReason: row.endReason || ''
  };
}

async function endSessionInternal(sessionRef, reason, actor) {
  const db = admin.firestore();
  const liveRef = db.doc('radioLiveState/current');
  let ended = null;
  await db.runTransaction(async function (tx) {
    const sessionSnap = await tx.get(sessionRef);
    if (!sessionSnap.exists) return;
    const session = sessionSnap.data() || {};
    if (session.status === 'ended' || session.status === 'revoked') {
      ended = session;
      return;
    }
    const liveSnap = await tx.get(liveRef);
    const broadcastRef = db.doc('radioLive/' + sessionRef.id);
    const broadcastSnap = await tx.get(broadcastRef);
    const requestRef = session.requestId ? db.doc('radioPresenterRequests/' + session.requestId) : null;
    const requestSnap = requestRef ? await tx.get(requestRef) : null;
    tx.set(sessionRef, {
      status: session.status === 'revoked' ? 'revoked' : 'ended',
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
      endReason: text(reason, 160),
      endedBy: text(actor, 160),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    if (requestSnap && requestSnap.exists && (requestSnap.data() || {}).status === 'approved') {
      // One approval is one session. Ending it (including a disconnect) closes
      // the approval window; a presenter who needs another slot requests again.
      tx.set(requestRef, {
        status: 'completed',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    if (broadcastSnap.exists) {
      tx.set(broadcastRef, {
        status: 'ended',
        endedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    if (liveSnap.exists && (liveSnap.data() || {}).sessionId === sessionRef.id) {
      tx.set(liveRef, {
        status: 'automation',
        previousSessionId: sessionRef.id,
        presenterName: '',
        programmeTitle: '',
        sessionId: '',
        endedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    ended = Object.assign({}, session, { status: 'ended' });
  });
  if (ended) {
    await writeHealth({
      type: 'session-end',
      sessionId: sessionRef.id,
      presenterUid: ended.presenterUid || '',
      programmeTitle: ended.programmeTitle || '',
      message: text(reason, 160) || 'Session ended.',
      actor: text(actor, 160)
    });
  }
  return ended;
}

async function endActiveForRequest(requestId, reason, actor) {
  const db = admin.firestore();
  const snapshot = await db.collection('radioPresenterSessions')
    .where('requestId', '==', requestId).limit(10).get();
  let ended = 0;
  for (const entry of snapshot.docs) {
    const row = entry.data() || {};
    if (row.status !== 'active') continue;
    const result = await endSessionInternal(entry.ref, reason, actor);
    if (result) ended += 1;
  }
  return ended;
}

exports.radioPresenterRequest = runtime.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    fail('unauthenticated', 'Sign in to request a presenter session.');
  }
  const uid = context.auth.uid;
  const input = cleanRequest(data || {});
  const db = admin.firestore();
  const current = await db.collection('radioPresenterRequests')
    .where('uid', '==', uid).limit(20).get();
  const now = nowMs();
  for (const entry of current.docs) {
    const row = entry.data() || {};
    if (['pending', 'approved'].includes(row.status)) {
      fail('failed-precondition', row.status === 'pending'
        ? 'You already have a presenter request awaiting review.'
        : 'You already have an approved presenter session. Use that approval or ask an administrator to revoke it.');
    }
    const rowStart = stampMs(row.startAt);
    const rowEnd = stampMs(row.endAt);
    const newStart = input.start.getTime();
    const newEnd = newStart + input.durationMinutes * 60000;
    if (['rejected', 'changes', 'expired'].includes(row.status) && rowStart && rowEnd &&
      newStart < rowEnd && newEnd > rowStart) {
      fail('failed-precondition', 'That time overlaps your previous request. Choose another slot.');
    }
    if (row.createdAt && stampMs(row.createdAt) > now - 24 * 60 * 60 * 1000 && row.status === 'pending') {
      fail('resource-exhausted', 'Please wait for the existing request to be reviewed.');
    }
  }
  const endAt = new Date(input.start.getTime() + input.durationMinutes * 60000);
  const ref = db.collection('radioPresenterRequests').doc();
  const row = {
    uid,
    email: text(context.auth.token.email, 254),
    name: input.name,
    programmeTitle: input.programmeTitle,
    description: input.description,
    startAt: admin.firestore.Timestamp.fromDate(input.start),
    endAt: admin.firestore.Timestamp.fromDate(endAt),
    durationMinutes: input.durationMinutes,
    accessStartsAt: admin.firestore.Timestamp.fromMillis(input.start.getTime() - ACCESS_LEAD_MS),
    accessEndsAt: admin.firestore.Timestamp.fromMillis(endAt.getTime() + ACCESS_GRACE_MS),
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await ref.set(row);
  await writeHealth({
    type: 'request',
    requestId: ref.id,
    presenterUid: uid,
    programmeTitle: input.programmeTitle,
    message: 'Presenter request submitted.'
  });
  const values = {
    name: input.name,
    title: input.programmeTitle,
    date: formatLusaka(input.start),
    minutes: String(input.durationMinutes),
    status: 'Pending',
    reason: input.description
  };
  const notified = await notifyAdmins(ref.id, values);
  return { ok: true, requestId: ref.id, status: 'pending', adminsNotified: notified.sent || 0 };
});

exports.radioPresenterDecision = runtime.https.onCall(async (data, context) => {
  const actor = await requireAdmin(context);
  const requestId = text(data && data.requestId, 160);
  const decision = text(data && data.decision, 20).toLowerCase();
  const note = longText(data && data.note, 600);
  if (!requestId) fail('invalid-argument', 'Choose a presenter request.');
  if (!['approve', 'reject', 'changes', 'revoke'].includes(decision)) {
    fail('invalid-argument', 'Choose approve, reject, request changes or revoke.');
  }
  const db = admin.firestore();
  const ref = db.collection('radioPresenterRequests').doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) fail('not-found', 'That presenter request no longer exists.');
  const row = snap.data() || {};
  if (['expired', 'completed'].includes(row.status) && decision !== 'revoke') {
    fail('failed-precondition', 'That request is already closed.');
  }
  const status = decision === 'approve' ? 'approved'
    : decision === 'reject' ? 'rejected'
      : decision === 'changes' ? 'changes' : 'revoked';
  const decidedBy = text((actor.token && (actor.token.email || actor.token.name)) || actor.uid, 160);
  await ref.set({
    status,
    adminNote: note,
    decidedByUid: actor.uid,
    decidedBy,
    decidedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  if (decision === 'reject' || decision === 'changes' || decision === 'revoke') {
    await endActiveForRequest(requestId, 'Administrator ' + decision, decidedBy);
  }
  await writeHealth({
    type: 'decision',
    requestId,
    presenterUid: row.uid || '',
    programmeTitle: row.programmeTitle || '',
    message: 'Administrator ' + decision + (note ? ': ' + note : ''),
    actor: decidedBy
  });
  const values = {
    requestId,
    name: row.name || '',
    title: row.programmeTitle || '',
    date: formatLusaka(row.startAt),
    minutes: String(row.durationMinutes || ''),
    status: status === 'changes' ? 'changes requested' : status,
    reason: note || (status === 'approved' ? 'Your session window opens 30 minutes before the requested start.' : '')
  };
  const notified = await notifyPresenter(row.uid, values);
  return { ok: true, requestId, status, presenterNotified: Boolean(notified && notified.sent) };
});

exports.radioPresenterStart = runtime.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    fail('unauthenticated', 'Sign in to start a presenter session.');
  }
  const uid = context.auth.uid;
  const requestId = text(data && data.requestId, 160);
  if (!requestId) fail('invalid-argument', 'Choose an approved presenter request.');
  const db = admin.firestore();
  const requestRef = db.collection('radioPresenterRequests').doc(requestId);
  const requestSnap = await requestRef.get();
  if (!requestSnap.exists) fail('not-found', 'That presenter request no longer exists.');
  const request = requestSnap.data() || {};
  if (request.uid !== uid) fail('permission-denied', 'This request belongs to another presenter.');
  if (request.status !== 'approved') fail('failed-precondition', 'The administrator has not approved this request.');
  const now = nowMs();
  if (now < stampMs(request.accessStartsAt)) {
    fail('failed-precondition', 'This session opens 30 minutes before the approved start time.');
  }
  if (now > stampMs(request.accessEndsAt)) {
    await requestRef.set({ status: 'expired', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    fail('failed-precondition', 'The approved session window has closed. Submit a new request.');
  }
  const liveRef = db.doc('radioLiveState/current');
  const sessionRef = db.collection('radioPresenterSessions').doc('radio_' + requestId + '_' + Date.now().toString(36));
  let created = null;
  await db.runTransaction(async function (tx) {
    const liveSnap = await tx.get(liveRef);
    const live = liveSnap.exists ? (liveSnap.data() || {}) : {};
    if (live.status === 'live' && live.sessionId) {
      fail('failed-precondition', 'Another presenter is already live. Wait for that session to end.');
    }
    const activeSnapshot = await db.collection('radioPresenterSessions')
      .where('status', '==', 'active').limit(20).get();
    const another = activeSnapshot.docs.some(function (entry) {
      const row = entry.data() || {};
      return row.presenterUid === uid && row.status === 'active';
    });
    if (another) fail('failed-precondition', 'You already have an active presenter session.');
    const expiresAt = request.accessEndsAt || admin.firestore.Timestamp.fromMillis(now + 60 * 60 * 1000);
    tx.set(sessionRef, {
      requestId,
      presenterUid: uid,
      presenterEmail: text(context.auth.token.email, 254),
      presenterName: request.name || text(context.auth.token.name, 80) || 'Prayer Dome presenter',
      programmeTitle: request.programmeTitle || 'Prayer Dome Radio',
      status: 'active',
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(liveRef, {
      status: 'live',
      sessionId: sessionRef.id,
      requestId,
      presenterName: request.name || text(context.auth.token.name, 80) || 'Prayer Dome presenter',
      programmeTitle: request.programmeTitle || 'Prayer Dome Radio',
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.set(db.collection('radioLive').doc(sessionRef.id), {
      sessionId: sessionRef.id,
      requestId,
      presenterUid: uid,
      presenterName: request.name || text(context.auth.token.name, 80) || 'Prayer Dome presenter',
      programmeTitle: request.programmeTitle || 'Prayer Dome Radio',
      status: 'live',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    created = { sessionId: sessionRef.id, expiresAt: stampMs(expiresAt) };
  });
  await writeHealth({
    type: 'session-start',
    sessionId: created.sessionId,
    requestId,
    presenterUid: uid,
    programmeTitle: request.programmeTitle || '',
    message: 'Presenter session started.',
    actor: text(context.auth.token.email || uid, 160)
  });
  return {
    ok: true,
    sessionId: created.sessionId,
    expiresAt: new Date(created.expiresAt).toISOString(),
    programmeTitle: request.programmeTitle || 'Prayer Dome Radio',
    presenterName: request.name || ''
  };
});

exports.radioPresenterHeartbeat = runtime.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) fail('unauthenticated', 'Sign in to keep the session alive.');
  const sessionId = text(data && data.sessionId, 160);
  if (!sessionId) fail('invalid-argument', 'A presenter session is required.');
  const db = admin.firestore();
  const ref = db.collection('radioPresenterSessions').doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) fail('not-found', 'That presenter session no longer exists.');
  const row = snap.data() || {};
  if (row.presenterUid !== context.auth.uid && !(await isAdmin(context.auth.uid))) {
    fail('permission-denied', 'This session belongs to another presenter.');
  }
  if (row.status !== 'active') return { ok: true, active: false, status: row.status || 'ended' };
  if (nowMs() > stampMs(row.expiresAt)) {
    await endSessionInternal(ref, 'Approved session window ended', 'watchdog');
    return { ok: true, active: false, status: 'ended', reason: 'expired' };
  }
  await ref.set({ lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true, active: true, expiresAt: row.expiresAt || null };
});

exports.radioPresenterEnd = runtime.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) fail('unauthenticated', 'Sign in to end a presenter session.');
  const sessionId = text(data && data.sessionId, 160);
  if (!sessionId) fail('invalid-argument', 'A presenter session is required.');
  const ref = admin.firestore().collection('radioPresenterSessions').doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) fail('not-found', 'That presenter session no longer exists.');
  const row = snap.data() || {};
  const adminUser = await isAdmin(context.auth.uid);
  if (row.presenterUid !== context.auth.uid && !adminUser) {
    fail('permission-denied', 'This session belongs to another presenter.');
  }
  await endSessionInternal(ref, text(data && data.reason, 120) || 'Presenter ended the programme', text(context.auth.token.email || context.auth.uid, 160));
  return { ok: true, status: 'ended' };
});

exports.radioAdminStop = runtime.https.onCall(async (data, context) => {
  const actor = await requireAdmin(context);
  const sessionId = text(data && data.sessionId, 160);
  const requestId = text(data && data.requestId, 160);
  let stopped = 0;
  if (sessionId) {
    const ref = admin.firestore().collection('radioPresenterSessions').doc(sessionId);
    if ((await ref.get()).exists) {
      await endSessionInternal(ref, text(data && data.reason, 120) || 'Stopped by an administrator', text(actor.token.email || actor.uid, 160));
      stopped += 1;
    }
  } else if (requestId) {
    stopped = await endActiveForRequest(requestId, text(data && data.reason, 120) || 'Stopped by an administrator', text(actor.token.email || actor.uid, 160));
    if (stopped) {
      await admin.firestore().collection('radioPresenterRequests').doc(requestId).set({
        status: 'revoked',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
  } else {
    fail('invalid-argument', 'Choose an active presenter or request.');
  }
  return { ok: true, stopped };
});

exports.radioPresenterStatus = runtime.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    return { signedIn: false, live: null, requests: [] };
  }
  const db = admin.firestore();
  const [requests, sessions, live] = await Promise.all([
    db.collection('radioPresenterRequests').where('uid', '==', context.auth.uid).limit(20).get(),
    db.collection('radioPresenterSessions').where('status', '==', 'active').limit(20).get(),
    db.doc('radioLiveState/current').get()
  ]);
  const mine = sessions.docs.filter(function (entry) { return (entry.data() || {}).presenterUid === context.auth.uid; })
    .map(function (entry) { return sessionPublic(Object.assign({ id: entry.id }, entry.data())); });
  const liveRow = live.exists ? live.data() : null;
  return {
    signedIn: true,
    uid: context.auth.uid,
    email: context.auth.token.email || '',
    admin: await isAdmin(context.auth.uid),
    requests: requests.docs.map(function (entry) {
      return publicRequest(Object.assign({ id: entry.id }, entry.data()));
    }).sort(function (a, b) { return stampMs(b.createdAt) - stampMs(a.createdAt); }),
    sessions: mine,
    live: liveRow && liveRow.status === 'live' ? {
      status: 'live',
      sessionId: liveRow.sessionId || '',
      presenterName: liveRow.presenterName || '',
      programmeTitle: liveRow.programmeTitle || '',
      startedAt: liveRow.startedAt || null
    } : null
  };
});

exports.radioReportIssue = runtime.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) fail('unauthenticated', 'Sign in to report a radio issue.');
  const message = text(data && data.message, 400);
  if (message.length < 4) fail('invalid-argument', 'Describe the issue.');
  const sessionId = text(data && data.sessionId, 160);
  await writeHealth({
    type: 'issue',
    sessionId,
    presenterUid: context.auth.uid,
    message,
    actor: text(context.auth.token.email || context.auth.uid, 160)
  });
  return { ok: true };
});

exports.radioAdminHealth = runtime.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const db = admin.firestore();
  const [live, sessions, requests, health, tracks, voices, nowPlaying] = await Promise.all([
    db.doc('radioLiveState/current').get(),
    db.collection('radioPresenterSessions').where('status', '==', 'active').limit(25).get(),
    db.collection('radioPresenterRequests').orderBy('createdAt', 'desc').limit(100).get(),
    db.collection('radioStreamHealth').orderBy('createdAt', 'desc').limit(20).get().catch(function () { return { docs: [] }; }),
    db.collection('worshipSongs').limit(500).get().catch(function () { return { docs: [] }; }),
    db.collection('radioVoices').limit(200).get().catch(function () { return { docs: [] }; }),
    db.doc('radioNowPlaying/current').get().catch(function () { return { exists: false }; })
  ]);
  const requestRows = requests.docs.map(function (entry) {
    const row = entry.data() || {};
    return Object.assign(publicRequest(Object.assign({ id: entry.id }, row)), {
      uid: row.uid || '', email: row.email || '', decidedBy: row.decidedBy || ''
    });
  });
  const liveRow = live.exists ? live.data() : null;
  return {
    live: liveRow && liveRow.status === 'live' ? {
      status: 'live', sessionId: liveRow.sessionId || '', presenterName: liveRow.presenterName || '',
      programmeTitle: liveRow.programmeTitle || '', startedAt: liveRow.startedAt || null,
      expiresAt: liveRow.expiresAt || null
    } : { status: 'automation' },
    nowPlaying: nowPlaying.exists ? (nowPlaying.data() || {}) : null,
    activeSessions: sessions.docs.map(function (entry) { return sessionPublic(Object.assign({ id: entry.id }, entry.data())); }),
    requests: requestRows,
    health: health.docs.map(function (entry) { return Object.assign({ id: entry.id }, entry.data()); }),
    counts: {
      requests: requestRows.length,
      pending: requestRows.filter(function (row) { return row.status === 'pending'; }).length,
      approved: requestRows.filter(function (row) { return row.status === 'approved'; }).length,
      rejected: requestRows.filter(function (row) { return row.status === 'rejected'; }).length,
      tracks: tracks.docs.length,
      approvedTracks: tracks.docs.filter(function (entry) { return (entry.data() || {}).approved === true; }).length,
      voices: voices.docs.length,
      approvedVoices: voices.docs.filter(function (entry) { return (entry.data() || {}).approved === true; }).length
    },
    checkedAt: new Date().toISOString()
  };
});

exports.radioSessionWatchdog = runtime.pubsub
  .schedule('every 1 minutes')
  .timeZone('Africa/Lusaka')
  .onRun(async () => {
    const db = admin.firestore();
    const now = nowMs();
    let ended = 0;
    const sessions = await db.collection('radioPresenterSessions').where('status', '==', 'active').limit(100).get();
    for (const entry of sessions.docs) {
      const row = entry.data() || {};
      const expires = stampMs(row.expiresAt);
      const heartbeat = stampMs(row.lastHeartbeatAt) || stampMs(row.startedAt);
      const stale = heartbeat && now - heartbeat > ACTIVE_SESSION_MS;
      if ((expires && now > expires) || stale) {
        await endSessionInternal(entry.ref, expires && now > expires ? 'Approved session window ended' : 'Presenter heartbeat stopped', 'watchdog');
        ended += 1;
      }
    }
    const approved = await db.collection('radioPresenterRequests').where('status', '==', 'approved').limit(200).get();
    for (const entry of approved.docs) {
      const row = entry.data() || {};
      if (stampMs(row.accessEndsAt) && now > stampMs(row.accessEndsAt)) {
        await entry.ref.set({ status: 'expired', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
    }
    return { checked: sessions.size, ended };
  });

module.exports = {
  REQUEST_STATUSES,
  radioPresenterRequest: exports.radioPresenterRequest,
  radioPresenterDecision: exports.radioPresenterDecision,
  radioPresenterStart: exports.radioPresenterStart,
  radioPresenterHeartbeat: exports.radioPresenterHeartbeat,
  radioPresenterEnd: exports.radioPresenterEnd,
  radioAdminStop: exports.radioAdminStop,
  radioPresenterStatus: exports.radioPresenterStatus,
  radioReportIssue: exports.radioReportIssue,
  radioAdminHealth: exports.radioAdminHealth,
  radioSessionWatchdog: exports.radioSessionWatchdog
};
