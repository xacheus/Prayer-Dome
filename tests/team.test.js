'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

/* ------------------------------------------------ 1. the shared record model */
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(read('assets/pd-team-store.js'), sandbox);
const PDTeam = sandbox.window.PDTeam;
assert.ok(PDTeam, 'PDTeam is published on window');

// A record written by the old console must keep every fact it had.
const legacy = PDTeam.normalize({
  id: 'team-old',
  name: 'Pastor Test Person',
  title: 'Prayer Dome Pastor',
  role: 'Pastor',
  category: 'zambia',
  country: 'Zambia',
  image: 'https://example.com/photo.jpg',
  description: 'A faithful servant.',
  email: 'private@example.com',
  phone: '+260 000 000',
  order: 4,
  archived: false,
  deceased: false
}, { email: 'private@example.com', phone: '+260 000 000' });
assert.equal(legacy.status, 'active');
assert.equal(legacy.priority, 4);
assert.equal(legacy.privateEmail, 'private@example.com');
assert.equal(legacy.email, '', 'a private email is not the public email');
assert.equal(legacy.department, 'Pastoral Ministry', 'legacy categories gain a sensible department');

// Archived and passed-away legacy records keep their status and are preserved.
assert.equal(PDTeam.normalize({ archived: true }).status, 'former');
assert.equal(PDTeam.normalize({ deceased: true }).status, 'deceased');
assert.equal(PDTeam.normalize({ status: 'deceased', passedAt: '2025-01-02', memorialMessage: 'Home with the Lord' }).passedAt, '2025-01-02');

// Public projection: no private contact details, ever.
const inMemory = PDTeam.normalize({
  id: 'x', name: 'Deceased Member', title: 'Pastor', status: 'deceased',
  published: true, showInMemorial: true, priority: 2,
  passedAt: '2025-02-01', memorialMessage: 'Faithful to the end.'
}, { email: 'secret@example.com', phone: '+260 111 111' });
const publicDoc = PDTeam.toPublicDoc(inMemory);
assert.equal(publicDoc.email, undefined, 'public documents never carry the private email field');
assert.equal(publicDoc.phone, undefined, 'public documents never carry the private phone field');
assert.equal(publicDoc.publicEmail, '', 'an unapproved email is not in the public document');
assert.equal(publicDoc.status, 'deceased');
assert.equal(publicDoc.memorialMessage, 'Faithful to the end.');
assert.equal(publicDoc.priority, 2);
assert.equal(PDTeam.toContactDoc(inMemory).email, 'secret@example.com');

// The "show my email publicly" switch is the only way an address is published.
const shared = PDTeam.normalize({ name: 'Public Email', emailPublic: true, publicEmail: 'office@example.com' }, {});
assert.equal(shared.email, 'office@example.com');
assert.equal(PDTeam.toPublicDoc(shared).publicEmail, 'office@example.com');
assert.equal(PDTeam.toPublicDoc(PDTeam.normalize({ name: 'No Email', emailPublic: true })).publicEmail, '');

// Validation rejects malformed input without inventing an address.
assert.equal(PDTeam.validate({ name: '' }).ok, false);
assert.equal(PDTeam.validate({ name: 'A', privateEmail: 'not-an-email', status: 'active', priority: 1 }).ok, false);
assert.equal(PDTeam.validate({ name: 'A', privateEmail: '', status: 'active', priority: 1 }).ok, true);
assert.equal(PDTeam.validate({ name: 'A', status: 'active', priority: 'abc' }).ok, false);

// Priority drives the public order; lower numbers first.
const sorted = PDTeam.sort([
  { name: 'Third', priority: 30 },
  { name: 'First', priority: 1 },
  { name: 'Second', priority: 20 }
]);
assert.deepEqual(sorted.map(m => m.name), ['First', 'Second', 'Third']);

// Memorial membership is explicit: deceased + published + showInMemorial.
const memorials = PDTeam.memorialMembers([
  { name: 'A', status: 'deceased', published: true, showInMemorial: true, priority: 1 },
  { name: 'B', status: 'deceased', published: true, showInMemorial: false, priority: 2 },
  { name: 'C', status: 'deceased', published: false, showInMemorial: true, priority: 3 },
  { name: 'D', status: 'active', published: true, priority: 4 }
]);
assert.deepEqual(memorials.map(m => m.name), ['A']);

/* --------------------------------------------- 2. public team page renders it */
const team = read('team.html');
assert.ok(team.includes('/assets/pd-team-store.js'), 'the public team page loads the shared model');
assert.ok(team.includes('teamMemorialSection'), 'the public page has a separate Memorial section');
assert.ok(team.includes('In Loving Memory'));
assert.ok(team.includes('member.responsibilities'), 'responsibilities are rendered');
assert.ok(team.includes('member.department'), 'departments are rendered');
assert.ok(team.includes('member.dateJoined'), 'date joined is rendered');
assert.ok(team.includes('member.emailPublic && member.publicEmail'), 'only an approved email is rendered');
assert.ok(team.includes('PDTeam.memorialMembers(allMembers())'));
assert.ok(!/member\.privateEmail[^]*?teamGrid/.test(team), 'the public renderer does not read private emails');

/* ------------------------------------------- 3. admin console can manage all */
const admin = read('admin.html');
for (const field of ['teamMemberDepartment', 'teamMemberResponsibilities', 'teamMemberDateJoined',
  'teamMemberPriority', 'teamMemberPublished', 'teamMemberShowInMemorial', 'teamMemberEmailPublic',
  'teamMemberPassedAt', 'teamMemberMemorialNote']) {
  assert.ok(admin.includes(field), `admin editor exposes ${field}`);
}
assert.ok(admin.includes('adminTeamSearch'), 'admins can search members');
assert.ok(admin.includes('teamMemberContacts'), 'private contacts live in their own collection');
assert.ok(admin.includes('PDTeam.validate(record)'), 'admin writes are validated');
assert.ok(admin.includes('In Loving Memory'), 'the memorial state is explained in the console');
assert.ok(/deleteDoc|batch\.delete/.test(admin), 'permanent removal exists');

/* ------------------------------------------------ 4. security rules are real */
const rules = read('firestore.rules');
assert.ok(rules.includes('match /teamMemberContacts/{id}'), 'private contacts have their own rules');
assert.ok(/match \/teamMembers\/\{id\} \{[^}]*allow read: if resource\.data\.published == true \|\| isAdmin\(\);/.test(rules),
  'public reads require a published profile');
assert.ok(/match \/teamMemberContacts\/\{id\} \{\s*allow read: if isAdmin\(\);/.test(rules),
  'private contacts are admin-only');
assert.ok(rules.includes("request.resource.data.status in ['active', 'inactive', 'deceased', 'former']"),
  'rules validate the member status');

/* ---------------------------------- 5. the responsive account layout is fixed */
const account = read('account.html');
assert.ok(account.includes('admin-access-actions'), 'leadership access uses a responsive action grid');
assert.ok(/\.admin-access-btn \{[^}]*word-break: normal/s.test(account), 'admin buttons never split words');
assert.ok(/\.admin-access-actions \{[^}]*repeat\(auto-fit, minmax\(min\(100%, 150px\), 1fr\)\)/s.test(account),
  'the action grid collapses to one column on very small screens');
assert.ok(account.includes('notif-health-grid') && account.includes('notif-pref-grid'),
  'notification settings use full-width responsive cards');
assert.ok(/\.notif-card \{[^}]*flex-direction: column/s.test(account));
assert.ok(account.includes('Delete Account') && account.includes('deleteAccountModal'),
  'delete-account confirmation is preserved');

const overflowCss = read('assets/pd-responsive-fix.css');
assert.ok(/\.topic-chip \{[^}]*word-break: normal/s.test(overflowCss),
  'buttons and pills wrap between words instead of breaking inside them');
assert.ok(overflowCss.includes('button > i'), 'button icons keep their width');

console.log('Team model, management UI, privacy rules and responsive layout checks passed.');
