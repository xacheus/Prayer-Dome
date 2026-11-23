'use strict';

/*
 * Server-side membership-card verification.
 * ===========================================================================
 * The public /verify page no longer reads Firestore directly. It calls
 * `verifyMembership`, which uses the Admin SDK. That keeps the private card
 * document (user id, issuing administrator, internal status flags) off the
 * public internet while still allowing a guest to validate a printed card.
 *
 * Canonical identity:
 *   memberships/{uid}                 → membershipId (source of truth)
 *   membershipVerification/{ID}       → issued card snapshot
 *   membershipVerificationRefs/{token}→ unguessable QR pointer
 *
 * A number in `memberships` is never treated as verified by itself: the
 * membership must be approved and a card must be genuinely issued (or the
 * legacy approved record must exist). The projection is created for an
 * already-approved member by `ensureMyCard`, never by inventing a new ID.
 */

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const crypto = require('crypto');

const REGION = 'us-central1';
const { HttpsError } = functions.https;
const ORGANISATION = 'PRAYER DOME';
const SITE_URL = String(process.env.PD_SITE_URL || 'https://prayerdome.net').replace(/\/+$/, '');

function fail(code, message) {
  throw new HttpsError(code, message);
}

function text(value, max) {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max || 200);
}

/** Trim and normalise case only — never rewrite or invent a membership ID. */
function normaliseId(value) {
  return text(value, 40).toUpperCase();
}

function validId(id) {
  return /^[A-Z0-9][A-Z0-9 ._-]{3,39}$/.test(id);
}

function validToken(token) {
  return /^[A-Za-z0-9_-]{16,128}$/.test(token);
}

function dateValue(value) {
  if (!value) return null;
  let date = null;
  try {
    if (typeof value.toDate === 'function') date = value.toDate();
    else if (value.seconds) date = new Date(value.seconds * 1000);
    else if (typeof value === 'number') date = new Date(value);
    else date = new Date(value);
  } catch (error) { return null; }
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function iso(value) {
  const date = dateValue(value);
  return date ? date.toISOString() : '';
}

function addMonths(date, months) {
  const copy = new Date(date.getTime());
  copy.setMonth(copy.getMonth() + Math.max(1, Number(months) || 12));
  return copy;
}

function branchName(value) {
  const branch = text(value, 120);
  return !branch || /freedom/i.test(branch) ? ORGANISATION : branch;
}

function publicRecord(card, member, state) {
  const photo = text((card && card.photoUrl) || (member && (member.photoUrl || member.photoURL)) || '', 1000);
  const photoIsSafe = /^(https:\/\/|\/)/i.test(photo);
  return {
    membershipId: normaliseId((card && card.membershipId) || (member && member.membershipId)),
    displayName: text((card && card.displayName) || (member && member.fullName) || '', 120),
    category: text((card && card.category) || (member && (member.category || member.membershipType)) || 'Member', 80),
    department: text((card && card.department) || (member && (member.department || member.ministry)) || '', 100),
    branch: branchName((card && card.branch) || (member && member.branch)),
    organization: ORGANISATION,
    photoUrl: photoIsSafe && (!card || card.photoAllowed !== false) ? photo : '',
    photoAllowed: !card || card.photoAllowed !== false,
    membershipStatus: text((card && card.membershipStatus) || (member && member.status) || '', 40).toLowerCase(),
    status: state,
    issuedAt: iso(card && (card.issuedAt || card.updatedAt)) || iso(member && member.approvedAt),
    expiresAt: iso(card && (card.expiresAt || card.validUntil)),
    verifyUrl: SITE_URL + '/verify'
  };
}

/**
 * Resolve the effective status from the canonical member + issued card.
 * Existence alone is never enough: a card must be approved, or a legacy
 * approved card record must exist.
 */
function resolveState(card, member, now) {
  const cardStatus = String((card && card.status) || '').toLowerCase();
  const memberStatus = String((member && member.status) || '').toLowerCase();
  const expiry = dateValue(card && (card.expiresAt || card.validUntil));

  if (member && member._superseded) return 'revoked';
  if (cardStatus === 'revoked' || cardStatus === 'rejected' || memberStatus === 'rejected') return 'revoked';
  if (cardStatus === 'suspended' || memberStatus === 'suspended') return 'suspended';
  if (cardStatus === 'expired' || (expiry && expiry.getTime() < now.getTime())) return 'expired';
  if (cardStatus === 'pending' && !member) return 'pending';
  if (cardStatus === 'pending' || memberStatus === 'pending') return 'pending';
  if (cardStatus === 'approved') {
    // A genuinely issued card with an approved member (or a legacy card whose
    // member record has since been removed) is active.
    return 'active';
  }
  if (!card && memberStatus === 'approved' && normaliseId(member.membershipId)) {
    // Legacy approved member whose card projection was never written. This is
    // a real, approved membership, so the manual check can succeed; the QR is
    // still issued by ensureMyCard before a card is printed or downloaded.
    return 'active';
  }
  if (member && !normaliseId(member.membershipId)) return 'not_issued';
  if (member) return 'pending';
  return 'invalid';
}

async function readCard(db, membershipId) {
  if (!membershipId) return null;
  const snap = await db.collection('membershipVerification').doc(membershipId).get();
  return snap.exists ? snap.data() : null;
}

async function findMemberById(db, membershipId) {
  const snap = await db.collection('memberships').where('membershipId', '==', membershipId).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return Object.assign({ uid: doc.id }, doc.data());
}

/**
 * The card can carry a userId. If the member record now has a different
 * membership number, this card was superseded (for example an administrator
 * corrected a number). An old printed QR must stop verifying as active.
 */
async function memberForCard(db, card, membershipId) {
  const member = await findMemberById(db, membershipId);
  if (!card || !card.userId) return member;
  try {
    const snap = await db.collection('memberships').doc(String(card.userId)).get();
    if (!snap.exists) return member;
    const byUid = Object.assign({ uid: snap.id }, snap.data());
    if (normaliseId(byUid.membershipId) && normaliseId(byUid.membershipId) !== membershipId) {
      return Object.assign({}, member || byUid, { _superseded: true });
    }
    return byUid;
  } catch (error) {
    return member;
  }
}

async function readByToken(db, token) {
  const refSnap = await db.collection('membershipVerificationRefs').doc(token).get();
  if (!refSnap.exists) return { card: null, pointer: null };
  const pointer = refSnap.data() || {};
  const card = await readCard(db, normaliseId(pointer.membershipId));
  return { card: card || pointer, pointer };
}

async function resolveRequest(db, raw, isReference) {
  const value = text(raw, 180);
  if (isReference) {
    if (!validToken(value)) return { state: 'invalid', record: null };
    const found = await readByToken(db, value);
    if (!found.card) return { state: 'invalid', record: null };
    const id = normaliseId(found.card.membershipId || (found.pointer && found.pointer.membershipId));
    const member = id ? await memberForCard(db, found.card, id) : null;
    const state = resolveState(found.card, member, new Date());
    return { state, record: publicRecord(found.card, member, state) };
  }

  const id = normaliseId(value);
  if (!id || !validId(id)) return { state: 'invalid', record: null, input: id };
  const card = await readCard(db, id);
  const member = await memberForCard(db, card, id);
  if (!card && !member) return { state: 'invalid', record: null, input: id };
  const state = resolveState(card, member, new Date());
  return { state, record: publicRecord(card, member, state), input: id };
}

async function verifyMembershipHandler(data) {
  const payload = data && typeof data === 'object' ? data : {};
  const isReference = payload.ref != null && payload.ref !== '';
  const raw = isReference ? payload.ref : (payload.id || payload.membershipId || '');
  if (!text(raw, 180)) {
    return { state: 'invalid', record: null, checkedAt: new Date().toISOString() };
  }
  const db = admin.firestore();
  try {
    // A visitor may paste either the printed membership number or the card's
    // secure verification code into one field. Tokens are case-sensitive and
    // longer than a normal number, so try the exact token first before the
    // number normaliser upper-cases it.
    if (!isReference && validToken(String(raw)) && !/^PD[0-9]/i.test(String(raw).trim())) {
      const found = await readByToken(db, String(raw).trim());
      if (found.card) {
        const id = normaliseId(found.card.membershipId || (found.pointer && found.pointer.membershipId));
        const member = id ? await memberForCard(db, found.card, id) : null;
        const state = resolveState(found.card, member, new Date());
        return { state, record: publicRecord(found.card, member, state), checkedAt: new Date().toISOString() };
      }
    }
    const result = await resolveRequest(db, raw, isReference);
    return Object.assign(result, { checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('verifyMembership failed:', error);
    // Never turn a network/server failure into "this card does not exist".
    fail('unavailable', 'Verification records are temporarily unavailable.');
  }
}

function cardStatusFor(status) {
  const value = String(status || '').toLowerCase();
  if (['approved', 'pending', 'rejected', 'revoked', 'suspended', 'expired'].includes(value)) return value;
  return 'pending';
}

async function ensureMyCardHandler(data, context) {
  if (!context.auth || !context.auth.uid) {
    fail('unauthenticated', 'Sign in to register your membership card.');
  }
  const uid = context.auth.uid;
  const db = admin.firestore();
  const memberSnap = await db.collection('memberships').doc(uid).get();
  if (!memberSnap.exists) fail('not-found', 'No membership application was found for this account.');
  const member = memberSnap.data() || {};
  const id = normaliseId(member.membershipId);
  if (!id || !validId(id)) fail('failed-precondition', 'Your membership number has not been assigned yet.');
  if (String(member.status || '').toLowerCase() !== 'approved') {
    fail('failed-precondition', 'Your membership must be approved before a card can be issued.');
  }

  const mainRef = db.collection('membershipVerification').doc(id);
  const existingSnap = await mainRef.get();
  const existing = existingSnap.exists ? existingSnap.data() : null;
  // 16 base64url characters = 96 bits. Keeping the token short leaves the
  // printed QR at version 3 (29 modules) instead of version 4, so the code in
  // the 68 px card back has visibly larger modules and scans reliably.
  const token = existing && validToken(String(existing.verificationRef || ''))
    ? String(existing.verificationRef)
    : crypto.randomBytes(12).toString('base64url');

  // A card status is derived from the live membership, except that an explicit
  // revoke/suspend/expiry (or a rejection) is preserved until an administrator
  // reissues. This prevents an old pending card staying pending after approval.
  const preserved = existing && ['revoked', 'suspended', 'expired', 'rejected'].includes(String(existing.status || '').toLowerCase())
    ? String(existing.status).toLowerCase()
    : '';
  const targetStatus = preserved || cardStatusFor(member.status);

  if (existing && existing.verificationRef === token &&
      String(existing.status || '').toLowerCase() === targetStatus &&
      String(existing.membershipStatus || '').toLowerCase() === String(member.status || '').toLowerCase()) {
    // The card may have been issued before the QR pointer collection existed.
    // Only take the fast path when the token actually resolves to this card.
    const pointerSnap = await db.collection('membershipVerificationRefs').doc(token).get();
    const pointer = pointerSnap.exists ? pointerSnap.data() || {} : null;
    if (pointer && normaliseId(pointer.membershipId) === id) {
      const state = resolveState(existing, member, new Date());
      return { state, record: publicRecord(existing, member, state), verificationRef: token };
    }
  }

  let validity = 12;
  try {
    const settings = await db.collection('membershipCardSettings').doc('main').get();
    if (settings.exists) validity = Math.max(1, Number(settings.data().validityMonths) || 12);
  } catch (error) { /* default */ }

  const issued = dateValue(existing && existing.issuedAt) || dateValue(member.approvedAt) || new Date();
  const expires = dateValue(existing && (existing.expiresAt || existing.validUntil)) || addMonths(issued, validity);
  const status = targetStatus;
  const record = {
    membershipId: id,
    userId: uid,
    displayName: text((existing && existing.displayName) || member.fullName || 'Prayer Dome member', 120),
    category: text((existing && existing.category) || member.category || member.membershipType || member.role || 'Member', 80),
    department: text((existing && existing.department) || member.department || member.ministry || '', 100),
    branch: branchName((existing && existing.branch) || member.branch),
    organization: ORGANISATION,
    photoUrl: text((existing && existing.photoUrl) || member.photoUrl || member.photoURL || '', 1000),
    photoAllowed: !existing || existing.photoAllowed !== false,
    membershipStatus: text(member.status || 'approved', 40).toLowerCase(),
    status: status === 'pending' ? 'pending' : status,
    verificationRef: token,
    issuedAt: admin.firestore.Timestamp.fromDate(issued),
    expiresAt: admin.firestore.Timestamp.fromDate(expires),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await mainRef.set(record, { merge: true });
  await db.collection('membershipVerificationRefs').doc(token).set(record, { merge: true });
  try {
    await db.collection('membershipVerificationHistory').add({
      membershipId: id,
      userId: uid,
      action: existing ? 'repaired' : 'issued',
      status: record.status,
      note: existing ? 'Existing approved member: verification projection completed.' : 'Issued automatically after approval.',
      at: admin.firestore.FieldValue.serverTimestamp(),
      by: 'server:ensureMyCard'
    });
  } catch (error) {
    console.warn('Verification audit history could not be written:', error.message);
  }

  const state = resolveState(record, member, new Date());
  return { state, record: publicRecord(record, member, state), verificationRef: token };
}

const region = functions.region(REGION);

module.exports = {
  verifyMembership: region.https.onCall(verifyMembershipHandler),
  ensureMyCard: region.https.onCall(ensureMyCardHandler),
  // Exported for unit-style checks. These are pure helpers or accept an
  // injected Firestore handle, so the public projection and the QR-pointer
  // path can be exercised without deploying or touching live data.
  _normaliseId: normaliseId,
  _resolveState: resolveState,
  _publicRecord: publicRecord,
  _resolveRequest: resolveRequest
};
