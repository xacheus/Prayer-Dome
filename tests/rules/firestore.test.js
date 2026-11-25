'use strict';
// Run against the local emulator only. No production credentials are used.
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, getDoc, getDocs, collection, deleteField, increment } = require('firebase/firestore');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  assert(process.env.FIRESTORE_EMULATOR_HOST, 'Use npm run test:rules, never a production database');
  const env = await initializeTestEnvironment({ projectId: 'demo-prayer-dome',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') } });
  try {
    const member = env.authenticatedContext('member').firestore();
    const other = env.authenticatedContext('other').firestore();
    const admin = env.authenticatedContext('admin').firestore();
    const guest = env.unauthenticatedContext().firestore();
    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await setDoc(doc(db, 'users/admin'), { role: 'admin' });
      await setDoc(doc(db, 'liveStatus/current'), { viewers: 2, totalViews: 5, isLive: true });
    });
    for (const collection of ['users', 'memberships']) {
      await assertFails(setDoc(doc(member, `${collection}/member`), { role: 'admin' }));
      await assertSucceeds(setDoc(doc(member, `${collection}/member`), { role: 'member', status: 'pending' }));
      await assertFails(updateDoc(doc(member, `${collection}/member`), { role: 'admin' }));
      await assertFails(updateDoc(doc(member, `${collection}/member`), { role: deleteField() }));
      await assertFails(updateDoc(doc(other, `${collection}/member`), { fullName: 'Impersonation' }));
      await assertSucceeds(updateDoc(doc(member, `${collection}/member`), { fullName: 'Member' }));
      await assertSucceeds(updateDoc(doc(admin, `${collection}/member`), { role: 'leader' }));
    }
    await assertFails(updateDoc(doc(member, 'memberships/member'), { status: 'approved' }));
    await assertSucceeds(updateDoc(doc(admin, 'memberships/member'), { status: 'approved' }));
    await assertFails(setDoc(doc(member, 'announcements/forged'), { title: 'Forged' }));
    await assertSucceeds(updateDoc(doc(guest, 'liveStatus/current'), { viewers: increment(1), totalViews: increment(1) }));
    await assertSucceeds(updateDoc(doc(guest, 'liveStatus/current'), { viewers: increment(-1) }));
    await assertFails(updateDoc(doc(guest, 'liveStatus/current'), { isLive: false }));
    await assertFails(updateDoc(doc(member, 'liveStatus/current'), { viewers: 9999 }));
    for (const collection of ['userTokens', 'userEvents']) {
      await assertSucceeds(setDoc(doc(member, `${collection}/owned`), { userId: 'member' }));
      await assertFails(updateDoc(doc(other, `${collection}/owned`), { userId: 'other' }));
      await assertFails(getDoc(doc(other, `${collection}/owned`)));
      await assertSucceeds(updateDoc(doc(member, `${collection}/owned`), { active: true }));
    }
    // Public content: anyone can read, only admins can change it.
    for (const collection of ['news', 'teamMembers']) {
      const payload = collection === 'teamMembers'
        ? { published: true, name: 'Entry', status: 'active', priority: 1 }
        : { published: true, name: 'Entry' };
      await assertSucceeds(setDoc(doc(admin, `${collection}/entry`), payload));
      await assertSucceeds(getDoc(doc(guest, `${collection}/entry`)));
      await assertFails(setDoc(doc(member, `${collection}/forged`), payload));
      await assertFails(updateDoc(doc(member, `${collection}/entry`), { name: 'Changed' }));
    }
    // Team member privacy and validation.
    await assertSucceeds(setDoc(doc(admin, 'teamMembers/public'), {
      name: 'Public Member', status: 'active', published: true, priority: 1, schemaVersion: 2,
      publicEmail: 'office@example.com', emailPublic: true
    }));
    await assertSucceeds(getDoc(doc(guest, 'teamMembers/public')));
    await assertSucceeds(setDoc(doc(admin, 'teamMembers/hidden'), {
      name: 'Hidden Member', status: 'deceased', published: false, priority: 2, schemaVersion: 2
    }));
    await assertFails(getDoc(doc(guest, 'teamMembers/hidden')));
    await assertFails(getDoc(doc(member, 'teamMembers/hidden')));
    await assertSucceeds(getDoc(doc(admin, 'teamMembers/hidden')));
    // Required, type-checked fields.
    await assertFails(setDoc(doc(admin, 'teamMembers/invalid'), {
      name: 'Missing status', published: true, priority: 3
    }));
    await assertFails(setDoc(doc(admin, 'teamMembers/invalid'), {
      name: 'Bad status', status: 'retired', published: true, priority: 3
    }));
    // Private contacts are administrator-only in both directions.
    await assertSucceeds(setDoc(doc(admin, 'teamMemberContacts/public'), {
      memberId: 'public', email: 'private@example.com', phone: '+260 000 000'
    }));
    await assertSucceeds(getDoc(doc(admin, 'teamMemberContacts/public')));
    await assertFails(getDoc(doc(guest, 'teamMemberContacts/public')));
    await assertFails(getDoc(doc(member, 'teamMemberContacts/public')));
    await assertFails(setDoc(doc(member, 'teamMemberContacts/public'), { email: 'forged@example.com' }));
    // The in-app bell reads a token-free public feed; guests may read it.
    await assertSucceeds(setDoc(doc(admin, 'publicNotifications/notice'), { title: 'Hello', message: 'World', inApp: true }));
    await assertSucceeds(getDoc(doc(guest, 'publicNotifications/notice')));
    await assertFails(setDoc(doc(member, 'publicNotifications/forged'), { title: 'Forged' }));

    // Notification switches are private to the member and read by the server.
    await assertSucceeds(setDoc(doc(member, 'userNotificationPrefs/member'), { uid: 'member', prefs: { news: false } }));
    await assertSucceeds(getDoc(doc(member, 'userNotificationPrefs/member')));
    await assertFails(getDoc(doc(other, 'userNotificationPrefs/member')));
    await assertFails(setDoc(doc(other, 'userNotificationPrefs/member'), { uid: 'other' }));
    await assertSucceeds(getDoc(doc(admin, 'userNotificationPrefs/member')));

    for (const collection of ['prayers', 'testimonies', 'gallery']) {
      await assertFails(setDoc(doc(member, `${collection}/new`), { userId: 'member', status: 'approved' }));
      await assertFails(setDoc(doc(member, `${collection}/new`), { userId: 'other', status: 'pending' }));
      await assertSucceeds(setDoc(doc(member, `${collection}/new`), { userId: 'member', status: 'pending' }));
      await assertSucceeds(updateDoc(doc(admin, `${collection}/new`), { status: 'approved' }));
      await assertSucceeds(getDoc(doc(guest, `${collection}/new`)));
    }
    // Billing: the browser may read only its own records and never change money.
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'paymentRequests/PD-SUB-test'), {
        userId: 'member', status: 'pending_verification', amount: 5, currency: 'USD'
      });
    });
    await assertSucceeds(getDoc(doc(member, 'paymentRequests/PD-SUB-test')));
    await assertFails(getDoc(doc(other, 'paymentRequests/PD-SUB-test')));
    await assertFails(getDoc(doc(guest, 'paymentRequests/PD-SUB-test')));
    await assertFails(setDoc(doc(member, 'paymentRequests/forged'), { userId: 'member', status: 'approved' }));
    await assertFails(updateDoc(doc(member, 'paymentRequests/PD-SUB-test'), { status: 'approved' }));
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      for (const path of ['subscriptions/sub_test', 'walletTransactions/wt_test', 'billingAudit/audit']) {
        await setDoc(doc(db, path), { userId: 'member', status: 'active', amount: 5 });
      }
    });
    for (const path of ['subscriptions/sub_test', 'walletTransactions/wt_test', 'billingAudit/audit']) {
      await assertFails(setDoc(doc(member, path), { userId: 'member', status: 'active' }));
      await assertFails(updateDoc(doc(member, path), { status: 'approved' }));
    }
    await assertSucceeds(setDoc(doc(member, 'wallets/member'), { userId: 'member', balance: 0, currency: 'USD' }));
    await assertSucceeds(updateDoc(doc(member, 'wallets/member'), { pin: '1234' }));
    await assertFails(updateDoc(doc(member, 'wallets/member'), { balance: 9999 }));
    await assertFails(setDoc(doc(member, 'wallets/other'), { userId: 'other', balance: 0, currency: 'USD' }));
    await assertSucceeds(getDoc(doc(member, 'wallets/member')));
    await assertFails(getDoc(doc(other, 'wallets/member')));

    // Giving: public payment instructions, member-created pending offerings,
    // and administrator-only confirmation. Nothing client-side can make a gift
    // look received or attach card data.
    await assertSucceeds(setDoc(doc(admin, 'settings/payments'), {
      updatedBy: 'admin', methods: [{ id: 'mtn', type: 'mobile-money', label: 'MTN', enabled: true, number: '+260970000000' }]
    }));
    await assertSucceeds(getDoc(doc(guest, 'settings/payments')));
    await assertSucceeds(getDoc(doc(member, 'settings/payments')));
    await assertFails(setDoc(doc(member, 'settings/payments'), {
      updatedBy: 'member', methods: []
    }));
    await assertFails(setDoc(doc(admin, 'settings/payments'), {
      updatedBy: 'someone-else', methods: []
    }));
    const offering = {
      organization: 'PRAYER DOME', recipient: 'PRAYER DOME',
      purpose: 'General offering', category: 'general-offering',
      reference: 'PDG-20260101-TEST01', currency: 'SZL',
      donor: 'Test Giver', donorName: 'Test Giver', donorEmail: 'giver@example.com',
      donorUid: 'member', amount: 50, method: 'MTN Mobile Money',
      methodId: 'mtn', methodType: 'mobile-money',
      transactionReference: 'MTN-123456', payTo: '+260970000000',
      receiptUrl: 'https://example.com/receipt.jpg', status: 'pending'
    };
    await assertSucceeds(setDoc(doc(member, 'offerings/PDG-20260101-TEST01'), offering));
    await assertFails(getDoc(doc(other, 'offerings/PDG-20260101-TEST01')));
    await assertSucceeds(getDoc(doc(member, 'offerings/PDG-20260101-TEST01')));
    await assertSucceeds(getDoc(doc(admin, 'offerings/PDG-20260101-TEST01')));
    await assertFails(setDoc(doc(guest, 'offerings/PDG-20260101-GUEST'), Object.assign({}, offering, { donorUid: 'guest' })));
    await assertFails(setDoc(doc(member, 'offerings/PDG-20260101-PAID'), Object.assign({}, offering, { reference: 'PDG-20260101-PAID', status: 'received' })));
    await assertFails(setDoc(doc(member, 'offerings/PDG-20260101-CARD'), Object.assign({}, offering, { reference: 'PDG-20260101-CARD', cardNumber: '4242424242424242' })));
    await assertFails(setDoc(doc(member, 'offerings/PDG-20260101-NOREF'), Object.assign({}, offering, { reference: 'PDG-20260101-NOREF', transactionReference: '' })));
    // A member cannot overwrite another member's gift or confirm their own.
    await assertFails(setDoc(doc(member, 'offerings/PDG-20260101-TEST01'), Object.assign({}, offering, { amount: 5000 })));
    await assertFails(updateDoc(doc(member, 'offerings/PDG-20260101-TEST01'), { status: 'received' }));
    await assertSucceeds(updateDoc(doc(admin, 'offerings/PDG-20260101-TEST01'), {
      status: 'received', receivedAt: new Date(), receiptNumber: 'PD-RCPT-1'
    }));
    await assertFails(updateDoc(doc(admin, 'offerings/PDG-20260101-TEST01'), { amount: 9999 }));
    await assertSucceeds(setDoc(doc(admin, 'givingAudit/entry1'), {
      action: 'offering_received', offeringId: 'PDG-20260101-TEST01',
      actorUid: 'admin', actorEmail: 'admin@example.com'
    }));
    await assertSucceeds(getDoc(doc(admin, 'givingAudit/entry1')));
    await assertFails(getDoc(doc(member, 'givingAudit/entry1')));
    await assertFails(setDoc(doc(member, 'givingAudit/forged'), {
      action: 'offering_received', actorUid: 'member'
    }));
    await assertFails(updateDoc(doc(admin, 'givingAudit/entry1'), { action: 'changed' }));

    // Card verification documents contain private fields and are resolved by
    // the verifyMembership callable (Admin SDK). No public reads, not even one.
    const card = {
      membershipId: 'PD-2026-0001', userId: 'member', displayName: 'Member',
      status: 'approved', verificationRef: 'PDV-0123456789abcdef0123'
    };
    await assertSucceeds(setDoc(doc(admin, 'membershipVerification/PD-2026-0001'), card));
    await assertFails(getDoc(doc(guest, 'membershipVerification/PD-2026-0001')));
    await assertFails(getDoc(doc(member, 'membershipVerification/PD-2026-0001')));
    await assertSucceeds(getDoc(doc(admin, 'membershipVerification/PD-2026-0001')));
    await assertFails(getDocs(collection(guest, 'membershipVerification')));
    await assertFails(setDoc(doc(member, 'membershipVerification/forged'), card));
    await assertSucceeds(setDoc(doc(admin, 'membershipVerificationRefs/PDV-ref'), card));
    await assertFails(getDoc(doc(guest, 'membershipVerificationRefs/PDV-ref')));
    await assertFails(getDocs(collection(guest, 'membershipVerificationRefs')));
    await assertFails(setDoc(doc(member, 'membershipVerificationHistory/entry'), { action: 'issued' }));

    // Signed-in pages may read the founder identity; only an administrator can
    // replace the stored signature images.
    await assertSucceeds(setDoc(doc(admin, 'settings/founder'), {
      founderName: 'S. K. MASUKU', founderTitle: 'Founder and President'
    }));
    await assertSucceeds(getDoc(doc(member, 'settings/founder')));
    await assertFails(getDoc(doc(guest, 'settings/founder')));
    await assertFails(setDoc(doc(member, 'settings/founder'), { founderName: 'Someone else' }));

    // Membership-number counters and reservations are callable-only.
    await assertFails(getDoc(doc(member, 'membershipCounters/2026')));
    await assertFails(setDoc(doc(member, 'membershipCounters/2026'), { lastNumber: 99 }));
    await assertFails(setDoc(doc(admin, 'membershipCounters/2026'), { lastNumber: 99 }));
    await assertFails(setDoc(doc(admin, 'membershipNumberReservations/PD20260001'), { membershipId: 'PD20260001' }));

    console.log('Firestore authorization regression checks passed.');
  } finally { await env.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
