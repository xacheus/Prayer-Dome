'use strict';
// Run against the local emulator only. No production credentials are used.
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, getDoc, deleteField, increment } = require('firebase/firestore');
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
    console.log('Firestore authorization regression checks passed.');
  } finally { await env.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
