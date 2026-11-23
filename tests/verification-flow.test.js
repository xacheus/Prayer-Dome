/*
 * Prayer Dome — membership verification flow
 * ===========================================================================
 * Exercises the server's real resolution path (not just the page's copy):
 * a membership number and a QR token must both resolve to the issued card,
 * every lifecycle state must be distinguished from "does not exist", and the
 * public projection must never leak contact details.
 *
 * The test injects an in-memory Firestore-shaped handle into the exported
 * helper, so it proves readByToken/readCard/memberForCard/resolveState without
 * needing the emulator, credentials or a deployment.
 */
'use strict';

const assert = require('node:assert/strict');
const { _resolveState, _publicRecord, _resolveRequest } = require('../functions/verification');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('PASS  ' + name);
  } catch (error) {
    fail += 1;
    console.log('FAIL  ' + name + '  ' + error.message);
  }
}
async function ta(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('PASS  ' + name);
  } catch (error) {
    fail += 1;
    console.log('FAIL  ' + name + '  ' + error.message);
  }
}

const NOW = new Date('2026-11-22T12:00:00Z');
const TOKEN = 'AbCdEfGhIjKlMnOp';
const PRIVATE = {
  email: 'member@example.com',
  phone: '+260 000 000000',
  identityNumber: '000000/00/0',
  signature: 'data:image/png;base64,PRIVATE'
};

function snapshot(id, value) {
  return {
    id,
    exists: Boolean(value),
    data: () => value
  };
}

function makeDb({ cards = {}, refs = {}, members = {} } = {}) {
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              if (name === 'membershipVerification') return snapshot(id, cards[id]);
              if (name === 'membershipVerificationRefs') return snapshot(id, refs[id]);
              if (name === 'memberships') return snapshot(id, members[id]);
              return snapshot(id, null);
            }
          };
        },
        where(field, op, value) {
          assert.equal(op, '==', 'only equality lookups are used');
          return {
            limit() {
              return {
                async get() {
                  const docs = Object.keys(members)
                    .filter((id) => members[id] && members[id][field] === value)
                    .map((id) => snapshot(id, members[id]));
                  return { empty: docs.length === 0, docs };
                }
              };
            }
          };
        }
      };
    }
  };
}

const approvedCard = {
  membershipId: 'PD20260001',
  userId: 'uid-1',
  displayName: 'Grace Mwale',
  category: 'Member',
  department: 'INTERCESSION',
  branch: 'Lusaka',
  organization: 'PRAYER DOME',
  photoUrl: 'https://example.com/photo.jpg',
  photoAllowed: true,
  membershipStatus: 'approved',
  status: 'approved',
  verificationRef: TOKEN,
  issuedAt: new Date('2026-01-10T00:00:00Z'),
  expiresAt: new Date('2027-01-10T00:00:00Z'),
  ...PRIVATE
};
const approvedMember = {
  membershipId: 'PD20260001',
  fullName: 'Grace Mwale',
  status: 'approved',
  branch: 'Lusaka',
  ...PRIVATE
};

const db = makeDb({
  cards: { PD20260001: approvedCard },
  refs: { [TOKEN]: approvedCard },
  members: { 'uid-1': approvedMember }
});

(async function run() {
  await ta('a printed membership number resolves to the approved card', async () => {
    const result = await _resolveRequest(db, 'pd20260001', false);
    assert.equal(result.state, 'active');
    assert.equal(result.record.membershipId, 'PD20260001');
    assert.equal(result.record.displayName, 'Grace Mwale');
    assert.equal(result.record.branch, 'Lusaka');
    assert.equal(result.record.organization, 'PRAYER DOME');
  });

  await ta('the QR token resolves to the same card with exact case', async () => {
    const result = await _resolveRequest(db, TOKEN, true);
    assert.equal(result.state, 'active');
    assert.equal(result.record.membershipId, 'PD20260001');
  });

  await ta('a token is case-sensitive; a lower-cased QR code is invalid', async () => {
    const result = await _resolveRequest(db, TOKEN.toLowerCase(), true);
    assert.equal(result.state, 'invalid');
    assert.equal(result.record, null);
  });

  await ta('the public projection never exposes contact or signature data', () => {
    const record = _publicRecord(approvedCard, approvedMember, 'active');
    const serialised = JSON.stringify(record);
    assert.doesNotMatch(serialised, /member@example\.com/);
    assert.doesNotMatch(serialised, /000000\/00\/0/);
    assert.doesNotMatch(serialised, /PRIVATE/);
    assert.equal(record.photoUrl, 'https://example.com/photo.jpg');
    assert.equal(record.verifyUrl, 'https://prayerdome.net/verify');
  });

  await ta('an unknown number is invalid, not a server error', async () => {
    const result = await _resolveRequest(db, 'PD99999999', false);
    assert.equal(result.state, 'invalid');
    assert.equal(result.record, null);
  });

  await ta('an unknown QR token is invalid', async () => {
    const result = await _resolveRequest(db, 'ZzZzZzZzZzZzZzZz', true);
    assert.equal(result.state, 'invalid');
  });

  await ta('a legacy approved member without a projection still verifies', async () => {
    const legacyDb = makeDb({
      members: { 'uid-2': { membershipId: 'PD20260002', fullName: 'John Banda', status: 'approved' } }
    });
    const result = await _resolveRequest(legacyDb, 'PD20260002', false);
    assert.equal(result.state, 'active');
    assert.equal(result.record.membershipId, 'PD20260002');
  });

  await ta('a pending member is not reported as active', async () => {
    const pendingDb = makeDb({
      cards: { PD20260003: { membershipId: 'PD20260003', userId: 'uid-3', status: 'pending', membershipStatus: 'pending' } },
      members: { 'uid-3': { membershipId: 'PD20260003', fullName: 'Pending Person', status: 'pending' } }
    });
    const result = await _resolveRequest(pendingDb, 'PD20260003', false);
    assert.equal(result.state, 'pending');
  });

  await ta('revocation and suspension survive a stale approved member record', async () => {
    const revokedDb = makeDb({
      cards: { PD20260004: { membershipId: 'PD20260004', userId: 'uid-4', status: 'revoked', membershipStatus: 'approved' } },
      members: { 'uid-4': { membershipId: 'PD20260004', fullName: 'Revoked Person', status: 'approved' } }
    });
    assert.equal((await _resolveRequest(revokedDb, 'PD20260004', false)).state, 'revoked');
    const suspendedDb = makeDb({
      cards: { PD20260005: { membershipId: 'PD20260005', userId: 'uid-5', status: 'suspended', membershipStatus: 'approved' } },
      members: { 'uid-5': { membershipId: 'PD20260005', fullName: 'Suspended Person', status: 'approved' } }
    });
    assert.equal((await _resolveRequest(suspendedDb, 'PD20260005', false)).state, 'suspended');
  });

  await ta('an old card is expired even when the member is still approved', async () => {
    const expiredDb = makeDb({
      cards: {
        PD20260006: {
          membershipId: 'PD20260006',
          userId: 'uid-6',
          status: 'approved',
          membershipStatus: 'approved',
          expiresAt: new Date('2026-01-01T00:00:00Z')
        }
      },
      members: { 'uid-6': { membershipId: 'PD20260006', fullName: 'Expired Person', status: 'approved' } }
    });
    assert.equal((await _resolveRequest(expiredDb, 'PD20260006', false)).state, 'expired');
  });

  await ta('a renumbered member invalidates the old printed card', async () => {
    const renumberedDb = makeDb({
      cards: { PD20260007: { membershipId: 'PD20260007', userId: 'uid-7', status: 'approved' } },
      members: { 'uid-7': { membershipId: 'PD20260008', fullName: 'Renumbered Person', status: 'approved' } }
    });
    assert.equal((await _resolveRequest(renumberedDb, 'PD20260007', false)).state, 'revoked');
  });

  t('the state resolver distinguishes not-issued from invalid', () => {
    assert.equal(_resolveState(null, { status: 'approved' }, NOW), 'not_issued');
    assert.equal(_resolveState(null, null, NOW), 'invalid');
    assert.equal(_resolveState({ status: 'approved' }, null, NOW), 'active');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
