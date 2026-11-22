// Use the v1 compatibility surface because these exports intentionally use
// first-generation triggers (pubsub.schedule, firestore.document and onCall).
// firebase-functions v7 no longer exposes that surface from the package root.
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const shareHandler = require('./share');
const brevo = require('./brevo');
const translateHandler = require('./translate');
const facebookCampaign = require('./facebookCampaign');
const { defineSecret } = require('firebase-functions/params');
const { signUpload } = require('./cloudinary');
const cloudinaryApiSecret = defineSecret('CLOUDINARY_API_SECRET');
const brevoApiKey = defineSecret('BREVO_API_KEY');

if (!admin.getApps().length) {
  admin.initializeApp();
}

const verseBank = require('./verse-bank');

/* Notifications must look identical on every surface: the web push card, the
   Android shade and the notification the installed PWA draws. Absolute URLs
   are required by the Web Push and APNs transports, so they are built once
   here instead of being left as page-relative paths (which silently lose
   their icon on Android). */
const SITE_URL = process.env.PD_SITE_URL || 'https://prayerdome.net';
const PUSH_ICON = SITE_URL + '/assets/logo-192.png';
const PUSH_BADGE = SITE_URL + '/assets/logo-192.png';

function absoluteUrl(value, fallback) {
  if (!value || typeof value !== 'string') return fallback || SITE_URL + '/index.html';
  if (/^https?:\/\//i.test(value)) return value;
  return SITE_URL + (value.charAt(0) === '/' ? value : '/' + value);
}

function normaliseKind(value) {
  const raw = String(value || 'general').toLowerCase();
  const aliases = { scripture: 'verse', urgent: 'general', announcement: 'news', notice: 'news' };
  const kind = aliases[raw] || raw;
  return ['verse', 'live', 'news', 'prayer', 'sermon', 'devotional', 'event', 'general'].includes(kind)
    ? kind
    : 'general';
}

/** Drop devices whose owner switched this category off on their account page. */
async function filterTokensByPreference(tokens, kind) {
  if (!tokens.length) return tokens;
  try {
    const db = admin.firestore();
    const [prefsSnap, tokenSnap] = await Promise.all([
      db.collection('userNotificationPrefs').get(),
      db.collection('userTokens').get()
    ]);
    const prefsByUser = {};
    prefsSnap.forEach((doc) => {
      const row = doc.data() || {};
      if (row.prefs) prefsByUser[row.uid || doc.id] = row.prefs;
    });
    if (!Object.keys(prefsByUser).length) return tokens;   // everyone still on
    const userByToken = {};
    tokenSnap.forEach((doc) => {
      const row = doc.data() || {};
      if (row.token && row.userId) userByToken[row.token] = row.userId;
    });
    // Devotionals live under the member's "Sermons and devotionals" switch;
    // the preference document stores that category as `sermon`.
    const prefKey = kind === 'devotional' ? 'sermon' : kind;
    return tokens.filter((token) => {
      const prefs = prefsByUser[userByToken[token]];
      return !prefs || prefs[prefKey] !== false;
    });
  } catch (error) {
    console.warn('Could not read notification preferences; sending to all:', error.message);
    return tokens;
  }
}

function linkFor(record) {
  if (record && (record.link || record.url)) return absoluteUrl(record.link || record.url);
  const kind = normaliseKind(record && record.type);
  if (record && record.screen) return absoluteUrl('/' + String(record.screen).replace(/^\/+/, '') + '.html');
  if (kind === 'live') return absoluteUrl('/live.html');
  if (kind === 'news') return absoluteUrl('/news.html');
  if (kind === 'prayer') return absoluteUrl('/prayer.html');
  if (kind === 'sermon' || kind === 'devotional') return absoluteUrl('/sermons.html');
  if (kind === 'event') return absoluteUrl('/events.html');
  if (kind === 'verse') return absoluteUrl('/bible.html');
  return absoluteUrl('/index.html');
}

/* One Android channel per notification category, matching the channels the app
   creates in assets/pd-app.js. A channel owns its importance and lock-screen
   visibility, so a member can mute events without missing a live service. */
const ANDROID_CHANNELS = {
  verse: 'prayer_dome_verse',
  live: 'prayer_dome_live',
  prayer: 'prayer_dome_prayer',
  news: 'prayer_dome_news',
  sermon: 'prayer_dome_sermon',
  devotional: 'prayer_dome_sermon',
  event: 'prayer_dome_events',
  general: 'prayer_dome_general'
};

function pushMessage({ tokens, title, body, image, kind, link, id, tag }) {
  const message = {
    tokens,
    notification: {
      title: title || 'Prayer Dome',
      body: body || '',
      ...(image ? { image: absoluteUrl(image) } : {})
    },
    data: {
      // FCM data values must all be strings.
      url: absoluteUrl(link),
      link: absoluteUrl(link),
      title: String(title || 'Prayer Dome'),
      body: String(body || ''),
      kind: normaliseKind(kind),
      id: String(id || ''),
      tag: String(tag || ('pd-' + (id || Date.now())))
    },
    webpush: {
      // High urgency wakes a sleeping phone; a day of TTL means a device that
      // was off overnight still receives the message when it comes back.
      headers: { Urgency: 'high', TTL: '86400' },
      fcmOptions: { link: absoluteUrl(link) },
      notification: {
        icon: PUSH_ICON,
        badge: PUSH_BADGE,
        ...(image ? { image: absoluteUrl(image) } : {}),
        tag: String(tag || ('pd-' + (id || Date.now()))),
        vibrate: [180, 90, 180],
        ...(normaliseKind(kind) === 'verse' ? {
          actions: [
            { action: 'read', title: 'Read in Bible' },
            { action: 'pray', title: 'Pray now' }
          ]
        } : {})
      }
    },
    android: {
      priority: 'high',
      notification: {
        channelId: ANDROID_CHANNELS[normaliseKind(kind)] || 'prayer_dome_general',
        icon: 'ic_notification',
        color: '#0A4D9B',
        sound: 'default'
      }
    },
    apns: {
      payload: { aps: { sound: 'default', 'mutable-content': 1 } }
    }
  };
  return message;
}

async function disableDeadTokens(response, tokens) {
  if (!response || !response.failureCount) return;
  const dead = [];
  response.responses.forEach((entry, index) => {
    if (entry.success) return;
    const code = (entry.error && entry.error.code) || '';
    if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
      dead.push(tokens[index]);
    }
  });
  if (!dead.length) return;
  const db = admin.firestore();
  for (const token of dead) {
    try {
      const snap = await db.collection('userTokens').where('token', '==', token).get();
      snap.forEach((doc) => doc.ref.update({ active: false, invalidReason: 'token_expired' }));
    } catch (error) {
      console.warn('Could not retire an expired token:', error.message);
    }
  }
}

// Dynamic social sharing pages for news and testimony links.
exports.share = functions.https.onRequest((req, res) => shareHandler(req, res));

// Same-origin relay for the app's auto-translation tier (pd-i18n.js sends
// batches of text the reviewed phrase pack does not cover yet). See
// functions/translate.js for the plain module this wraps — the identical
// module also runs as api/translate.js on Vercel.
exports.translate = functions.https.onRequest((req, res) => translateHandler(req, res));

// ==========================================
// Brevo email (verification + support newsletter)
// ==========================================
// A signed-in member may request a fresh verification message, but not in a
// loop: three per minute is enough for a real inbox and stops a script from
// burning the ministry's Brevo quota. The map is per function instance.
const brevoVerificationHits = new Map();
function allowBrevoVerification(uid) {
  const now = Date.now();
  const hits = (brevoVerificationHits.get(uid) || []).filter((at) => now - at < 60 * 1000);
  if (hits.length >= 3) { brevoVerificationHits.set(uid, hits); return false; }
  hits.push(now);
  brevoVerificationHits.set(uid, hits);
  if (brevoVerificationHits.size > 2000) {
    for (const [key, times] of brevoVerificationHits) {
      if (!times.some((at) => now - at < 60 * 1000)) brevoVerificationHits.delete(key);
    }
  }
  return true;
}


// Verification email: Firebase still owns the account and the verification
// state, but the message is delivered by Brevo from the ministry's authenticated
// domain instead of the generic firebaseapp.com sender. The account is never
// blocked if Brevo is unavailable — the client falls back to Firebase's own
// sendEmailVerification().
exports.sendBrevoVerificationEmail = functions.runWith({ secrets: [brevoApiKey] }).https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.token.email) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in before requesting a verification email.');
  }
  if (context.auth.token.email_verified) {
    return { sent: false, reason: 'already-verified' };
  }
  if (!brevo.isConfigured(process.env)) {
    return { sent: false, reason: 'not-configured' };
  }
  if (!allowBrevoVerification(context.auth.uid)) {
    throw new functions.https.HttpsError('resource-exhausted', 'Please wait a minute before requesting another email.');
  }
  const email = context.auth.token.email;
  const name = String((data && data.name) || context.auth.token.name || '').slice(0, 80);
  let link;
  try {
    link = await admin.auth().generateEmailVerificationLink(email, {
      url: SITE_URL + '/account?verified=1'
    });
  } catch (error) {
    console.error('Could not generate a verification link:', error.message);
    throw new functions.https.HttpsError('internal', 'The verification link could not be created.');
  }
  try {
    return await brevo.sendVerificationEmail({ email, name, link, env: process.env });
  } catch (error) {
    console.error('Brevo verification email failed:', error.code || error.message);
    throw new functions.https.HttpsError('unavailable', 'Email delivery is temporarily unavailable.');
  }
});

// Newsletter / updates signup used by the support page. The same handler runs
// as api/newsletter.js on Vercel; this export gives Firebase Hosting parity.
exports.brevoSubscribe = functions.runWith({ secrets: [brevoApiKey] }).https.onRequest((req, res) => {
  brevo.newsletterHandler(req, res);
});

// ==========================================
// Secure Server-Side Cloudinary Signing
// ==========================================
// Call this from the client to get a secure upload signature.
// The API secret never leaves the server.
exports.getCloudinarySignature = functions.runWith({ secrets: [cloudinaryApiSecret] }).https.onCall((data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be signed in to perform this action.'
    );
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = cloudinaryApiSecret.value();

  if (!cloudName || !apiKey || !apiSecret) {
    throw new functions.https.HttpsError(
      'failed-precondition', 'Media uploads are not configured. Contact an administrator.'
    );
  }

  // Never sign caller-supplied folders or presets: that would let members
  // upload into administrator-controlled namespaces or use privileged presets.
  const params = {
    timestamp: Math.floor(Date.now() / 1000),
    upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET || 'live_streams',
    folder: `user_uploads/${context.auth.uid}`
  };
  return { ...params, signature: signUpload(params, apiSecret), apiKey, cloudName };
});

// ==========================================
// Scheduled Devotional Dispatcher
// ==========================================
// Runs once per day (configure the schedule in Firebase Console
// after deploying). Loads today's devotional from Firestore and
// sends a notification to all users who opted in.
exports.dailyDevotionalNotification = functions.pubsub
  .schedule('0 6 * * *') // 06:00 UTC daily — adjust to your timezone
  .timeZone('Africa/Lusaka')
  .onRun(async () => {
    const db = admin.firestore();
    const today = new Date().toISOString().split('T')[0];

    try {
      const devQ = await db.collection('devotionals')
        .where('publishDate', '==', today)
        .limit(1)
        .get();

      if (devQ.empty) {
        console.log('No devotional scheduled for today:', today);
        return null;
      }

      const dev = devQ.docs[0].data();
      const tokensSnap = await db.collection('userTokens')
        .where('active', '!=', false)
        .get();

      const tokens = [];
      const seenTokens = new Set();
      tokensSnap.forEach(doc => {
        const d = doc.data();
        if (d.token && d.notifications !== false && !seenTokens.has(d.token)) {
          seenTokens.add(d.token);
          tokens.push(d.token);
        }
      });

      if (tokens.length === 0) {
        console.log('No active push tokens for devotional dispatch.');
        return null;
      }

      // Respect the member's "Sermons and devotionals" switch, exactly like a
      // dashboard announcement does.
      const allowedTokens = await filterTokensByPreference(tokens, 'devotional');
      if (!allowedTokens.length) {
        console.log('Every device muted devotionals; nothing to send.');
        return null;
      }

      const payload = pushMessage({
        tokens: allowedTokens,
        title: 'Daily Devotional — Prayer Dome',
        body: dev.title ? `${dev.title}: ${dev.thought ? dev.thought.substring(0, 80) + '…' : 'Read today\'s word.'}` : 'Your daily devotional is ready.',
        kind: 'devotional',
        link: '/sermons.html',
        id: `devotional-${today}`,
        tag: `pd-devotional-${today}`
      });

      const response = await admin.messaging().sendEachForMulticast(payload);
      await disableDeadTokens(response, allowedTokens);
      console.log(`Devotional notification sent to ${response.successCount}/${allowedTokens.length} devices.`);

      // Log the dispatch.
      await db.collection('devotionalLogs').add({
        date: today,
        title: dev.title,
        sentCount: response.successCount,
        failureCount: response.failureCount,
        dispatchedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return null;
    } catch (err) {
      console.error('Daily devotional dispatch failed:', err);
      return null;
    }
  });

// ==========================================
// Prayer Reminder Notification Scheduler
// ==========================================
// Users can schedule a daily prayer reminder time. This function
// runs every 15 minutes and sends reminders to users whose
// reminder time matches the current window.
exports.prayerReminderDispatch = functions.pubsub
  .schedule('*/15 * * * *')
  .timeZone('Africa/Lusaka')
  .onRun(async () => {
    const db = admin.firestore();
    // Date#getHours() is UTC, even inside a scheduled function. Compute the
    // wall clock in each member's own timezone instead, or every reminder
    // fires at the wrong hour. The ministry default is Africa/Lusaka.
    const formatters = {};
    const clockIn = (timeZone) => {
      const tz = timeZone || 'Africa/Lusaka';
      if (!formatters[tz]) {
        formatters[tz] = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false
        });
      }
      const parts = formatters[tz].formatToParts(new Date());
      const at = (type) => (parts.find((p) => p.type === type) || {}).value;
      return {
        date: `${at('year')}-${at('month')}-${at('day')}`,
        minutes: (parseInt(at('hour'), 10) || 0) * 60 + (parseInt(at('minute'), 10) || 0)
      };
    };
    const baseClock = clockIn('Africa/Lusaka');
    const localDate = baseClock.date;

    try {
      const usersSnap = await db.collection('userReminders').get();
      const due = [];
      usersSnap.forEach((doc) => {
        const row = doc.data() || {};
        if (row.notifications === false || !row.reminderTime) return;
        const clock = clockIn(row.timeZone);
        if (row.lastSentDate === clock.date) return;      // already sent today
        const [rh, rm] = String(row.reminderTime).split(':').map(Number);
        if (!Number.isFinite(rh) || !Number.isFinite(rm)) return;
        const target = rh * 60 + rm;
        // The scheduler runs every quarter hour. Send in the 15-minute window
        // *after* the chosen minute, never before it, and only once a day.
        const after = (clock.minutes - target + 1440) % 1440;
        if (after <= 14) due.push({ id: doc.id, ...row, clockDate: clock.date });
      });

      if (!due.length) return null;

      // Resolve every reminder to that member's registered devices, honouring
      // the category switch they set on the account page.
      const [tokenSnap, prefsSnap] = await Promise.all([
        db.collection('userTokens').get(),
        db.collection('userNotificationPrefs').get()
      ]);
      const tokensByUser = {};
      const seenTokens = {};
      tokenSnap.forEach((doc) => {
        const row = doc.data() || {};
        if (!row.token || row.active === false) return;
        // The same token is stored twice (owner alias + device doc); send once.
        if (seenTokens[row.token]) return;
        seenTokens[row.token] = true;
        (tokensByUser[row.userId] = tokensByUser[row.userId] || []).push(row.token);
      });
      const prefsByUser = {};
      prefsSnap.forEach((doc) => {
        const row = doc.data() || {};
        if (row.prefs) prefsByUser[row.uid || doc.id] = row.prefs;
      });

      const recipients = [];
      due.forEach((row) => {
        const prefs = prefsByUser[row.userId || row.id];
        if (prefs && prefs.prayer === false) return;
        const tokens = tokensByUser[row.userId || row.id] || (row.fcmToken ? [row.fcmToken] : []);
        tokens.forEach((token) => recipients.push({ token, userId: row.userId || row.id, reminderId: row.id }));
      });
      if (!recipients.length) return null;

      const message = pushMessage({
        tokens: recipients.map((r) => r.token),
        title: 'Prayer Time — Prayer Dome',
        body: 'Take a moment to lift your requests to God. He is listening.',
        kind: 'prayer',
        link: '/prayer.html',
        tag: 'pd-reminder-' + localDate,
        id: 'reminder-' + localDate
      });
      const response = await admin.messaging().sendEachForMulticast(message);
      console.log(`Prayer reminders sent to ${response.successCount}/${recipients.length} devices.`);

      const sentUsers = new Set();
      const batch = db.batch();
      const sentDates = {};
      due.forEach((row) => { sentDates[row.id] = row.clockDate; });
      recipients.forEach((recipient, index) => {
        if (response.responses[index] && response.responses[index].success) sentUsers.add(recipient.reminderId);
        batch.set(db.collection('reminderLogs').doc(), {
          userId: recipient.userId,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          success: !!(response.responses[index] && response.responses[index].success)
        });
      });
      sentUsers.forEach((id) => batch.set(db.collection('userReminders').doc(id), {
        lastSentDate: sentDates[id] || localDate,
        lastSentAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }));
      await batch.commit();
      return null;
    } catch (err) {
      console.error('Prayer reminder dispatch failed:', err);
      return null;
    }
  });

// ==========================================
// Send Push Notification
// ==========================================
// The admin console writes one `notifications` document containing the title,
// message, link and the device tokens to reach. This trigger fans it out to
// FCM. It is idempotent: an edited or re-saved document is never sent twice.
exports.sendPushNotification = functions.firestore
  .document('notifications/{notificationId}')
  .onCreate(async (snap, context) => {
    const notification = snap.data() || {};
    if (notification.status === 'sent' || notification.status === 'sending') return null;

    const tokens = Array.isArray(notification.tokens) ? notification.tokens : [];
    const validTokens = [...new Set(tokens.filter((token) => typeof token === 'string' && token.length > 20))];

    if (!validTokens.length) {
      console.log('Notification has no recipients; leaving it in-app only.');
      await snap.ref.set({ status: 'in-app', recipients: 0 }, { merge: true });
      return null;
    }

    const title = notification.title || 'Prayer Dome';
    const body = notification.message || notification.body || '';
    const kind = normaliseKind(notification.type || notification.kind);
    const link = linkFor(notification);
    const allowedTokens = await filterTokensByPreference(validTokens, kind);
    if (!allowedTokens.length) {
      console.log('Every registered device muted this category; notification stays in-app.');
      await snap.ref.set({ status: 'in-app', recipients: 0, filteredByPreference: true }, { merge: true });
      return null;
    }
    const message = pushMessage({
      tokens: allowedTokens,
      title,
      body,
      image: notification.image || notification.imageUrl || null,
      kind,
      link,
      id: context.params.notificationId,
      tag: notification.tag || ('pd-' + context.params.notificationId)
    });

    try {
      await snap.ref.set({ status: 'sending' }, { merge: true });
      // FCM accepts at most 500 tokens per multicast call. Fan out in chunks
      // so a growing church never silently loses the members past 500.
      let successCount = 0;
      let failureCount = 0;
      for (let i = 0; i < allowedTokens.length; i += 500) {
        const chunk = allowedTokens.slice(i, i + 500);
        const response = await admin.messaging().sendEachForMulticast({ ...message, tokens: chunk });
        successCount += response.successCount;
        failureCount += response.failureCount;
        await disableDeadTokens(response, chunk);
      }

      console.log(`Notification "${title}" sent to ${successCount} devices, failed: ${failureCount}`);
      await snap.ref.set({
        status: 'sent',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        successCount,
        failureCount,
        link
      }, { merge: true });

      return { successCount, failureCount };
    } catch (error) {
      console.error('Error sending notifications:', error);
      await snap.ref.set({ status: 'failed', error: error.message }, { merge: true });
      return null;
    }
  });

// Test notification handler — powers the admin's "test my device" button.
exports.sendTestNotification = functions.firestore
  .document('test_notifications/{testId}')
  .onCreate(async (snap, context) => {
    const test = snap.data() || {};
    const token = test.token;
    if (!token) return null;

    const link = absoluteUrl(test.link || '/account.html');
    const message = {
      token,
      ...pushMessage({
        tokens: [token],
        title: test.title || 'Prayer Dome test notification',
        body: test.message || 'Notifications are working on this device.',
        kind: 'general',
        link,
        id: context.params.testId,
        tag: 'pd-test-' + context.params.testId
      })
    };
    delete message.tokens;

    try {
      const response = await admin.messaging().send(message);
      console.log('Test notification sent:', response);
      await snap.ref.set({
        status: 'sent',
        sentAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return response;
    } catch (error) {
      console.error('Test notification failed:', error);
      await snap.ref.set({ status: 'failed', error: error.message }, { merge: true });
      return null;
    }
  });

// ==========================================
// Scheduled daily verse push
// ==========================================
// Works when the app is closed. Every member who switched verse alerts on has a
// `userVerseSettings/{uid}` document (the app mirrors its local settings there)
// with their four slot times and timezone. This function wakes every 15
// minutes, finds the slots that are due in each member's own timezone, and
// sends the same branded verse card the service worker would have drawn.
//
// An administrator can override the verse for a day by writing
// `verseSchedule/{YYYY-MM-DD}` with { text, reference, translation, slots }.
exports.dailyVerseDispatch = functions.pubsub
  .schedule('*/15 * * * *')
  .timeZone('Africa/Lusaka')
  .onRun(async () => {
    const db = admin.firestore();
    const now = new Date();

    try {
      const settingsSnap = await db.collection('userVerseSettings')
        .where('enabled', '==', true)
        .get();
      if (settingsSnap.empty) return null;

      const specialCache = new Map();
      // A member can mute Scripture alerts on their account page; the bell
      // still shows the verse, but their phone stays quiet.
      const prefsSnap = await db.collection('userNotificationPrefs').get();
      const prefsByUser = {};
      prefsSnap.forEach((doc) => {
        const row = doc.data() || {};
        if (row.prefs) prefsByUser[row.uid || doc.id] = row.prefs;
      });

      for (const doc of settingsSnap.docs) {
        const settings = doc.data() || {};
        const uid = settings.uid || doc.id;
        if (prefsByUser[uid] && prefsByUser[uid].verse === false) continue;
        // getTimezoneOffset() is UTC - local, so Lusaka (UTC+2) is -120.
        const offset = Number.isFinite(Number(settings.timezoneOffset)) ? Number(settings.timezoneOffset) : -120;
        // JavaScript's getTimezoneOffset() is UTC - local, in minutes.
        const local = new Date(now.getTime() - offset * 60000);
        const localMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
        const localDate = local.toISOString().slice(0, 10);
        const lastSent = settings.lastSent || {};

        const dueSlots = [];
        for (const slot of verseBank.SLOTS) {
          const conf = (settings.slots && settings.slots[slot.id]) || {};
          if (conf.on === false) continue;
          if (lastSent[slot.id] === localDate) continue;
          const [hour, minute] = String(conf.time || slot.defaultTime).split(':').map(Number);
          const due = (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
          const diff = localMinutes - due;
          if (diff >= 0 && diff <= 14) dueSlots.push({ slot, due });
        }
        if (!dueSlots.length) continue;

        // One verse override lookup per calendar date.
        if (!specialCache.has(localDate)) {
          let special = null;
          try {
            const specialSnap = await db.doc(`verseSchedule/${localDate}`).get();
            if (specialSnap.exists) {
              const value = specialSnap.data() || {};
              if (value.text && value.reference) special = value;
            }
          } catch (error) { /* the override is optional */ }
          specialCache.set(localDate, special);
        }
        const special = specialCache.get(localDate);

        const tokenSnap = await db.collection('userTokens')
          .where('userId', '==', uid)
          .get();
        const tokens = [];
        const seen = new Set();
        tokenSnap.forEach((tokenDoc) => {
          const row = tokenDoc.data() || {};
          if (row.token && row.active !== false && !seen.has(row.token)) {
            seen.add(row.token);
            tokens.push(row.token);
          }
        });
        if (!tokens.length) continue;

        for (const { slot } of dueSlots) {
          let verse = verseBank.verseFor(slot.id, local);
          if (special && (special.slots === 'all' || String(special.slots || '').includes(slot.id))) {
            verse = {
              ...verse,
              text: special.text,
              reference: special.reference,
              translation: special.translation || 'NIV',
              slotLabel: special.title || verse.slotLabel
            };
          }
          const title = `${verse.slotLabel} · Prayer Dome`;
          const body = `\u201C${verse.text}\u201D\n\u2014 ${verse.reference} (${verse.translation || 'NIV'})`;
          const message = pushMessage({
            tokens,
            title,
            body,
            kind: 'verse',
            link: '/bible.html?verse=' + encodeURIComponent(verse.reference),
            id: `${localDate}-${slot.id}-${uid}`,
            tag: `pd-verse-${slot.id}-${localDate}`
          });
          try {
            const response = await admin.messaging().sendEachForMulticast(message);
            await db.collection('verseDispatchLogs').add({
              uid,
              date: localDate,
              slot: slot.id,
              successCount: response.successCount,
              failureCount: response.failureCount,
              dispatchedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await disableDeadTokens(response, tokens);
          } catch (error) {
            console.error(`Verse dispatch failed for ${uid}/${slot.id}:`, error.message);
          }
          lastSent[slot.id] = localDate;
        }

        await doc.ref.set({ lastSent, lastDispatchAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
      return null;
    } catch (error) {
      console.error('Daily verse dispatch failed:', error);
      return null;
    }
  });

// Facebook campaign functions are kept in a dedicated module so Page credentials never reach the browser.
exports.getFacebookCampaignStatus = facebookCampaign.getFacebookCampaignStatus;
exports.generateFacebookCampaign = facebookCampaign.generateFacebookCampaign;
exports.facebookCampaignScheduler = facebookCampaign.facebookCampaignScheduler;
