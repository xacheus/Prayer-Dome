/*!
 * Prayer Dome — admin modules added in the professionalisation pass
 * ===========================================================================
 *   • Church Locations  — add a branch without touching source code
 *   • Daily Challenges  — schedule by date, weekday always Africa/Lusaka
 *   • Membership Cards  — template, authorised signature, verification issue
 *   • Data Audit        — read-only collection inventory (never deletes)
 *
 * This file is an ES module: it imports `getCountFromServer` so the audit can
 * report exact collection sizes at a fraction of the read cost of downloading
 * every document. Everything else uses the Firestore bindings the admin shell
 * exposes on `window.PDAdmin`.
 */
import { getCountFromServer } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const LUSAKA = 'Africa/Lusaka';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let bridge = null;
let cardTemplateSignature = '';

/* ------------------------------------------------------------------ utils */
function $(id) { return document.getElementById(id); }

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(message, type) {
  if (bridge && typeof bridge.toast === 'function') bridge.toast(message, type || 'success');
  else if (window.toast) window.toast(message, type || 'success');
}

function lusakaWeekday(dateValue) {
  if (!dateValue) return '';
  const date = new Date(dateValue + 'T12:00:00');
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: LUSAKA, weekday: 'long' }).format(date);
  } catch (error) {
    return WEEKDAYS[date.getDay()];
  }
}

function lusakaWeekdayIndex(dateValue) {
  const name = lusakaWeekday(dateValue);
  const index = WEEKDAYS.indexOf(name);
  return index >= 0 ? index : 0;
}

function formatDate(value) {
  if (!value) return '—';
  if (typeof value.toDate === 'function') value = value.toDate();
  else if (value.seconds) value = new Date(value.seconds * 1000);
  else if (typeof value === 'string') value = new Date(value + (value.length === 10 ? 'T12:00:00' : ''));
  if (!value || Number.isNaN(value.getTime())) return '—';
  return value.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function todayValue() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

/* ---------------------------------------------------------------- locations */
async function loadChurchLocations() {
  const body = $('locAdminList');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="5"><div class="spinner" style="width:26px;height:26px;"></div></td></tr>';
  try {
    const store = bridge.firestore;
    const snapshot = await store.getDocs(store.query(
      store.collection(bridge.db, 'churchLocations'),
      store.orderBy('priority', 'asc')
    ));
    const rows = [];
    snapshot.forEach((entry) => rows.push(Object.assign({ id: entry.id }, entry.data())));
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5">No extra branches yet. The three official congregations are built in and already live on <a href="/locations" target="_blank" rel="noopener">/locations</a>.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((row) => {
      const statusClass = row.status === 'active' ? 'ok' : row.status === 'planned' ? 'warn' : 'bad';
      return '<tr>' +
        '<td><strong>' + escapeHtml(row.name || '') + '</strong></td>' +
        '<td>' + escapeHtml([row.town || row.district, row.country].filter(Boolean).join(', ')) + '</td>' +
        '<td><span class="audit-pill ' + statusClass + '">' + escapeHtml(row.status || 'active') + '</span></td>' +
        '<td>' + escapeHtml(row.priority != null ? row.priority : 100) + '</td>' +
        '<td><button class="btn btn-outline btn-sm" type="button" aria-label="Edit ' + escapeHtml(row.name || 'branch') + '" title="Edit branch" onclick="editChurchLocation(\'' + escapeHtml(row.id) + '\')"><i class="pd-i pd-i-pen" aria-hidden="true"></i></button> ' +
        '<button class="btn btn-outline btn-sm" type="button" aria-label="Delete ' + escapeHtml(row.name || 'branch') + '" title="Delete branch" onclick="deleteChurchLocation(\'' + escapeHtml(row.id) + '\')"><i class="pd-i pd-i-trash" aria-hidden="true"></i></button></td>' +
      '</tr>';
    }).join('');
    window.__pdLocationRows = rows;
  } catch (error) {
    console.error('Locations load failed:', error);
    body.innerHTML = '<tr><td colspan="5">' + (error && error.code === 'permission-denied'
      ? 'Your account does not have access to church locations.'
      : 'Locations could not be loaded. Check the connection and try again.') + '</td></tr>';
  }
}

function newChurchLocation() {
  ['locAdminId', 'locAdminName', 'locAdminCountry', 'locAdminProvince', 'locAdminDistrict',
    'locAdminTown', 'locAdminPlusCode', 'locAdminLat', 'locAdminLng', 'locAdminMapUrl',
    'locAdminImage', 'locAdminPhone', 'locAdminEmail', 'locAdminLeader'].forEach((id) => {
    const field = $(id);
    if (field) field.value = '';
  });
  if ($('locAdminStatus')) $('locAdminStatus').value = 'active';
  if ($('locAdminPriority')) $('locAdminPriority').value = '100';
}

function editChurchLocation(id) {
  const row = (window.__pdLocationRows || []).filter((item) => item.id === id)[0];
  if (!row) return;
  const set = (fieldId, value) => { const field = $(fieldId); if (field) field.value = value == null ? '' : value; };
  set('locAdminId', row.id);
  set('locAdminName', row.name);
  set('locAdminCountry', row.country);
  set('locAdminProvince', row.province);
  set('locAdminDistrict', row.district);
  set('locAdminTown', row.town);
  set('locAdminPlusCode', row.plusCode);
  set('locAdminLat', row.lat);
  set('locAdminLng', row.lng);
  set('locAdminMapUrl', row.mapUrl);
  set('locAdminImage', row.image);
  set('locAdminPhone', row.phone);
  set('locAdminEmail', row.email);
  set('locAdminLeader', row.leader);
  set('locAdminStatus', row.status || 'active');
  set('locAdminPriority', row.priority != null ? row.priority : 100);
  const panel = $('view-locations');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveChurchLocation() {
  if (!bridge) return;
  const name = ($('locAdminName').value || '').trim();
  const country = ($('locAdminCountry').value || '').trim();
  const lat = Number($('locAdminLat').value);
  const lng = Number($('locAdminLng').value);
  if (!name) return toast('Enter the branch name.', 'error');
  if (!country) return toast('Enter the country.', 'error');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return toast('Enter a valid latitude (between -90 and 90).', 'error');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return toast('Enter a valid longitude (between -180 and 180).', 'error');

  const payload = {
    name,
    country,
    province: ($('locAdminProvince').value || '').trim(),
    district: ($('locAdminDistrict').value || '').trim(),
    town: ($('locAdminTown').value || '').trim(),
    plusCode: ($('locAdminPlusCode').value || '').trim(),
    lat,
    lng,
    mapUrl: ($('locAdminMapUrl').value || '').trim(),
    image: ($('locAdminImage').value || '').trim(),
    phone: ($('locAdminPhone').value || '').trim(),
    email: ($('locAdminEmail').value || '').trim(),
    leader: ($('locAdminLeader').value || '').trim(),
    status: $('locAdminStatus').value || 'active',
    priority: Number($('locAdminPriority').value) || 100,
    updatedAt: bridge.firestore.serverTimestamp()
  };
  const id = $('locAdminId').value;
  try {
    const store = bridge.firestore;
    if (id) {
      await store.updateDoc(store.doc(bridge.db, 'churchLocations', id), payload);
    } else {
      await store.addDoc(store.collection(bridge.db, 'churchLocations'), Object.assign({}, payload, {
        createdAt: store.serverTimestamp()
      }));
    }
    toast(id ? 'Branch updated — the locations page will show it.' : 'Branch added — it is live on /locations.', 'success');
    newChurchLocation();
    await loadChurchLocations();
  } catch (error) {
    console.error('Location save failed:', error);
    toast(error && error.code === 'permission-denied'
      ? 'Your account does not have permission to edit branches.'
      : 'The branch could not be saved. Please try again.', 'error');
  }
}

async function deleteChurchLocation(id) {
  if (!bridge) return;
  const row = (window.__pdLocationRows || []).filter((item) => item.id === id)[0];
  if (!window.confirm('Delete “' + ((row && row.name) || 'this branch') + '” from the directory?\n\nOfficial congregations built into the app are not affected.')) return;
  try {
    const store = bridge.firestore;
    await store.deleteDoc(store.doc(bridge.db, 'churchLocations', id));
    toast('Branch removed from the directory.', 'success');
    await loadChurchLocations();
  } catch (error) {
    toast('The branch could not be deleted.', 'error');
  }
}

/* ---------------------------------------------------------- daily challenges */
async function loadDailyChallenges() {
  const body = $('dcAdminList');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6"><div class="spinner" style="width:26px;height:26px;"></div></td></tr>';
  try {
    const store = bridge.firestore;
    const snapshot = await store.getDocs(store.query(
      store.collection(bridge.db, 'dailyChallenges'),
      store.orderBy('date', 'desc'),
      store.limit(100)
    ));
    const rows = [];
    snapshot.forEach((entry) => rows.push(Object.assign({ id: entry.id }, entry.data())));
    window.__pdChallengeRows = rows;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6">No scheduled challenges. The built-in seven-day plan is showing on the home page; add a dated challenge here to override a day.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((row) => {
      const weekday = row.date ? lusakaWeekday(row.date) : (WEEKDAYS[Number(row.weekday) || 0] || '');
      return '<tr>' +
        '<td>' + escapeHtml(row.date || 'Every ' + weekday) + '</td>' +
        '<td>' + escapeHtml(weekday) + '</td>' +
        '<td><strong>' + escapeHtml(row.title || '') + '</strong></td>' +
        '<td>' + escapeHtml(row.points != null ? row.points : 20) + '</td>' +
        '<td><span class="audit-pill ' + (row.published ? 'ok' : 'warn') + '">' + (row.published ? 'Published' : 'Draft') + '</span></td>' +
        '<td><button class="btn btn-outline btn-sm" type="button" aria-label="Edit ' + escapeHtml(row.title || 'challenge') + '" title="Edit challenge" onclick="editDailyChallenge(\'' + escapeHtml(row.id) + '\')"><i class="pd-i pd-i-pen" aria-hidden="true"></i></button> ' +
        '<button class="btn btn-outline btn-sm" type="button" aria-label="Delete ' + escapeHtml(row.title || 'challenge') + '" title="Delete challenge" onclick="deleteDailyChallenge(\'' + escapeHtml(row.id) + '\')"><i class="pd-i pd-i-trash" aria-hidden="true"></i></button></td>' +
      '</tr>';
    }).join('');
  } catch (error) {
    console.error('Challenges load failed:', error);
    body.innerHTML = '<tr><td colspan="6">Challenges could not be loaded. Check the connection and try again.</td></tr>';
  }
}

function syncChallengeWeekday(preferred) {
  const date = $('dcAdminDate') && $('dcAdminDate').value;
  const field = $('dcAdminWeekday');
  if (!field) return;
  if (date) { field.value = String(lusakaWeekdayIndex(date)); return; }
  if (preferred != null && preferred !== '') { field.value = String(Number(preferred) || 0); return; }
  if (field.value === '') field.value = String(lusakaWeekdayIndex(todayValue()));
}

function newDailyChallenge() {
  ['dcAdminId', 'dcAdminDate', 'dcAdminTitle', 'dcAdminDescription', 'dcAdminActivities', 'dcAdminVerse'].forEach((id) => {
    const field = $(id);
    if (field) field.value = '';
  });
  if ($('dcAdminPoints')) $('dcAdminPoints').value = '20';
  if ($('dcAdminPublished')) $('dcAdminPublished').checked = true;
  syncChallengeWeekday();
}

function editDailyChallenge(id) {
  const row = (window.__pdChallengeRows || []).filter((item) => item.id === id)[0];
  if (!row) return;
  const set = (fieldId, value) => { const field = $(fieldId); if (field) field.value = value == null ? '' : value; };
  set('dcAdminId', row.id);
  set('dcAdminDate', row.date || '');
  set('dcAdminTitle', row.title || '');
  set('dcAdminDescription', row.description || '');
  set('dcAdminActivities', row.activities || '');
  set('dcAdminVerse', row.verse || '');
  set('dcAdminPoints', row.points != null ? row.points : 20);
  if ($('dcAdminPublished')) $('dcAdminPublished').checked = row.published !== false;
  syncChallengeWeekday(row.date ? null : row.weekday);
  const panel = $('view-daily-challenges');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveDailyChallenge() {
  if (!bridge) return;
  const title = ($('dcAdminTitle').value || '').trim();
  if (!title) return toast('Give the challenge a title.', 'error');
  const date = ($('dcAdminDate').value || '').trim();
  const payload = {
    title,
    description: ($('dcAdminDescription').value || '').trim(),
    activities: ($('dcAdminActivities').value || '').trim(),
    verse: ($('dcAdminVerse').value || '').trim(),
    points: Number($('dcAdminPoints').value) || 20,
    published: !!$('dcAdminPublished').checked,
    weekday: date ? lusakaWeekdayIndex(date) : Number($('dcAdminWeekday').value),
    date: date || '',
    updatedAt: bridge.firestore.serverTimestamp()
  };
  if (!Number.isInteger(payload.weekday) || payload.weekday < 0 || payload.weekday > 6) {
    return toast('Choose the weekday this challenge repeats on.', 'error');
  }
  const id = $('dcAdminId').value;
  try {
    const store = bridge.firestore;
    if (id) {
      await store.updateDoc(store.doc(bridge.db, 'dailyChallenges', id), payload);
    } else {
      await store.addDoc(store.collection(bridge.db, 'dailyChallenges'), Object.assign({}, payload, {
        createdAt: store.serverTimestamp(),
        createdBy: (bridge.auth.currentUser && (bridge.auth.currentUser.email || bridge.auth.currentUser.displayName)) || 'Administrator'
      }));
    }
    toast('Challenge saved — the home page updates automatically.', 'success');
    newDailyChallenge();
    await loadDailyChallenges();
  } catch (error) {
    console.error('Challenge save failed:', error);
    toast(error && error.code === 'permission-denied'
      ? 'Your account does not have permission to schedule challenges.'
      : 'The challenge could not be saved. Please try again.', 'error');
  }
}

async function deleteDailyChallenge(id) {
  if (!bridge) return;
  if (!window.confirm('Delete this challenge? Published challenges disappear from the home page immediately.')) return;
  try {
    const store = bridge.firestore;
    await store.deleteDoc(store.doc(bridge.db, 'dailyChallenges', id));
    toast('Challenge deleted.', 'success');
    await loadDailyChallenges();
  } catch (error) {
    toast('The challenge could not be deleted.', 'error');
  }
}

/* ----------------------------------------------------------- membership cards */
function applyTemplateToForm(template) {
  const data = template || {};
  const set = (id, value) => { const field = $(id); if (field) field.value = value || ''; };
  set('mcardChurch', data.churchName || 'Prayer Dome Ministry');
  set('mcardSignatory', data.signatoryName || 'Pastor Seedwell K. Masuku');
  set('mcardRole', data.signatoryRole || 'Founder & Senior Pastor');
  set('mcardPhone', data.phone || '+268 7658 1804');
  set('mcardEmail', data.email || 'info@prayerdome.net');
  cardTemplateSignature = data.signature || '';
  const preview = $('mcardSignaturePreview');
  const empty = $('mcardSignatureEmpty');
  if (preview) {
    if (cardTemplateSignature) {
      preview.src = cardTemplateSignature;
      preview.hidden = false;
      if (empty) empty.hidden = true;
    } else {
      preview.removeAttribute('src');
      preview.hidden = true;
      if (empty) empty.hidden = false;
    }
  }
}

async function loadCardTemplate() {
  try {
    const store = bridge.firestore;
    const snapshot = await store.getDoc(store.doc(bridge.db, 'membershipCardSettings', 'main'));
    const data = snapshot.exists() ? snapshot.data() : null;
    applyTemplateToForm(data);
    if (data) {
      try { localStorage.setItem('pd_membership_card_template', JSON.stringify(data)); } catch (error) { /* private mode */ }
    }
  } catch (error) {
    console.warn('Card template could not be loaded:', error && error.message);
    applyTemplateToForm(null);
  }
}

function handleCardSignatureFile(event) {
  const file = event && event.target && event.target.files && event.target.files[0];
  if (!file) return;
  if (!/^image\//.test(file.type)) return toast('Choose a PNG or JPG signature image.', 'error');
  if (file.size > 400 * 1024) return toast('Signature images must stay under 400 KB.', 'error');
  const reader = new FileReader();
  reader.onload = () => {
    cardTemplateSignature = String(reader.result);
    const preview = $('mcardSignaturePreview');
    const empty = $('mcardSignatureEmpty');
    if (preview) { preview.src = cardTemplateSignature; preview.hidden = false; }
    if (empty) empty.hidden = true;
    toast('Signature attached — press Save template to publish it.', 'info');
  };
  reader.readAsDataURL(file);
}

async function saveCardTemplate() {
  if (!bridge) return;
  const payload = {
    churchName: ($('mcardChurch').value || '').trim() || 'Prayer Dome Ministry',
    signatoryName: ($('mcardSignatory').value || '').trim(),
    signatoryRole: ($('mcardRole').value || '').trim(),
    phone: ($('mcardPhone').value || '').trim(),
    email: ($('mcardEmail').value || '').trim(),
    signature: cardTemplateSignature || '',
    updatedAt: bridge.firestore.serverTimestamp(),
    updatedBy: (bridge.auth.currentUser && (bridge.auth.currentUser.email || bridge.auth.currentUser.displayName)) || 'Administrator'
  };
  if (!payload.signatoryName) return toast('Enter the authorised signatory’s name.', 'error');
  try {
    const store = bridge.firestore;
    await store.setDoc(store.doc(bridge.db, 'membershipCardSettings', 'main'), payload, { merge: true });
    try { localStorage.setItem('pd_membership_card_template', JSON.stringify(payload)); } catch (error) { /* private mode */ }
    toast('Card template saved — every card now uses it.', 'success');
  } catch (error) {
    console.error('Template save failed:', error);
    toast(error && error.code === 'permission-denied'
      ? 'Your account does not have permission to change the card template.'
      : 'The template could not be saved. Please try again.', 'error');
  }
}

async function loadMembershipCardAdmin() {
  await loadCardTemplate();
  const body = $('mcardList');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6"><div class="spinner" style="width:26px;height:26px;"></div></td></tr>';
  try {
    const store = bridge.firestore;
    const [memberships, verifications] = await Promise.all([
      store.getDocs(store.query(store.collection(bridge.db, 'memberships'), store.orderBy('createdAt', 'desc'), store.limit(150))),
      store.getDocs(store.query(store.collection(bridge.db, 'membershipVerification'), store.limit(300)))
    ]);
    const verificationByKey = {};
    verifications.forEach((entry) => {
      const data = entry.data();
      verificationByKey[String(data.membershipId || entry.id).toUpperCase()] = Object.assign({ id: entry.id }, data);
    });
    const rows = [];
    memberships.forEach((entry) => rows.push(Object.assign({ uid: entry.id }, entry.data())));
    window.__pdCardRows = rows;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6">No membership records yet.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((row) => {
      const number = String(row.membershipId || '').toUpperCase();
      const verification = verificationByKey[number];
      const verifyLabel = !number
        ? '<span class="audit-pill warn">No number</span>'
        : !verification
          ? '<span class="audit-pill warn">Not issued</span>'
          : verification.status === 'approved'
            ? '<span class="audit-pill ok"><i class="pd-i pd-i-shield-check"></i> Verified</span>'
            : '<span class="audit-pill bad">' + escapeHtml(verification.status || 'revoked') + '</span>';
      return '<tr>' +
        '<td><strong>' + escapeHtml(row.fullName || row.name || 'Member') + '</strong><br><span style="font-size:.7rem;color:var(--text-sub);">' + escapeHtml(row.email || '') + '</span></td>' +
        '<td>' + escapeHtml(row.membershipId || '—') + '</td>' +
        '<td>' + escapeHtml(row.branch || '—') + '</td>' +
        '<td><span class="audit-pill ' + (row.status === 'approved' ? 'ok' : 'warn') + '">' + escapeHtml(row.status || 'pending') + '</span></td>' +
        '<td>' + verifyLabel + '</td>' +
        '<td>' +
          (number ? '<button class="btn btn-outline btn-sm" type="button" onclick="issueCardVerification(\'' + escapeHtml(row.uid) + '\')"><i class="pd-i pd-i-shield-check"></i> Issue</button> ' : '') +
          (verification ? '<button class="btn btn-outline btn-sm" type="button" onclick="revokeCardVerification(\'' + escapeHtml(number) + '\')"><i class="pd-i pd-i-shield-x"></i> Revoke</button>' : '') +
        '</td>' +
      '</tr>';
    }).join('');
  } catch (error) {
    console.error('Membership cards load failed:', error);
    body.innerHTML = '<tr><td colspan="6">Memberships could not be loaded. Check the connection and try again.</td></tr>';
  }
}

async function issueCardVerification(uid) {
  if (!bridge) return;
  const row = (window.__pdCardRows || []).filter((item) => item.uid === uid)[0];
  if (!row) return;
  const number = String(row.membershipId || '').trim().toUpperCase();
  if (!number) return toast('This member has no membership number yet. Approve the membership first.', 'error');
  try {
    const store = bridge.firestore;
    await store.setDoc(store.doc(bridge.db, 'membershipVerification', number), {
      membershipId: number,
      displayName: row.fullName || row.name || 'Prayer Dome member',
      category: row.category || row.membershipType || row.role || 'Member',
      branch: row.branch || '',
      status: row.status === 'approved' ? 'approved' : 'pending',
      issuedAt: row.status === 'approved' ? store.serverTimestamp() : null,
      updatedAt: store.serverTimestamp(),
      issuedBy: (bridge.auth.currentUser && (bridge.auth.currentUser.email || bridge.auth.currentUser.displayName)) || 'Administrator'
    }, { merge: true });
    toast(row.status === 'approved'
      ? 'Card verified — the QR code now resolves to an official record.'
      : 'Pending record issued. Approve the membership to make the card verify as active.', 'success');
    await loadMembershipCardAdmin();
  } catch (error) {
    console.error('Verification issue failed:', error);
    toast(error && error.code === 'permission-denied'
      ? 'Your account does not have permission to issue card verification.'
      : 'The verification record could not be written.', 'error');
  }
}

async function revokeCardVerification(number) {
  if (!bridge || !number) return;
  if (!window.confirm('Revoke verification for ' + number + '?\n\nThe member’s QR code will report the card as no longer valid.')) return;
  try {
    const store = bridge.firestore;
    await store.setDoc(store.doc(bridge.db, 'membershipVerification', String(number).toUpperCase()), {
      status: 'revoked',
      updatedAt: store.serverTimestamp(),
      revokedBy: (bridge.auth.currentUser && (bridge.auth.currentUser.email || bridge.auth.currentUser.displayName)) || 'Administrator'
    }, { merge: true });
    toast('Card verification revoked.', 'success');
    await loadMembershipCardAdmin();
  } catch (error) {
    toast('The verification record could not be updated.', 'error');
  }
}

/* ---------------------------------------------------------------- data audit */
const AUDIT_COLLECTIONS = [
  { name: 'users', protected: true, note: 'Member accounts and profiles — never remove.' },
  { name: 'memberships', protected: true, note: 'Membership records and roles — never remove.' },
  { name: 'prayers', protected: true, note: 'Prayer wall requests — essential church data.' },
  { name: 'testimonies', protected: true, note: 'Member testimonies — essential church data.' },
  { name: 'news', protected: true, note: 'News and announcements.' },
  { name: 'events', protected: true, note: 'Church events.' },
  { name: 'sermons', protected: true, note: 'Sermon library.' },
  { name: 'teamMembers', protected: true, note: 'Team profiles — historical records must be preserved.' },
  { name: 'teamMemberContacts', protected: true, note: 'Private team contact data (admin only).' },
  { name: 'financialReports', protected: true, note: 'Financial history — export before any change.' },
  { name: 'offerings', protected: true, note: 'Giving records — financial history.' },
  { name: 'expenses', protected: true, note: 'Expense records — financial history.' },
  { name: 'documents', protected: true, note: 'Document Studio letters and audit trail.' },
  { name: 'churchLocations', protected: false, note: 'Branch directory — reviewed in the Locations module.' },
  { name: 'dailyChallenges', protected: false, note: 'Daily challenge schedule.' },
  { name: 'transactions', protected: false, note: 'Review: legacy transaction collection. Preserve any financial rows.' },
  { name: 'live', protected: false, note: 'Review: legacy live-session collection.' },
  { name: 'reports', protected: false, note: 'Review: legacy reports. Financial rows must be exported first.' }
];

async function runDataAudit() {
  if (!bridge) return;
  const body = $('dataAuditList');
  body.innerHTML = '<tr><td colspan="4"><div class="spinner" style="width:26px;height:26px;"></div></td></tr>';
  const results = [];
  for (const entry of AUDIT_COLLECTIONS) {
    let count = null;
    let error = '';
    try {
      const snapshot = await getCountFromServer(bridge.firestore.collection(bridge.db, entry.name));
      count = snapshot.data().count;
    } catch (err) {
      error = err && err.code ? err.code : 'unavailable';
    }
    results.push(Object.assign({}, entry, { count, error }));
  }
  window.__pdAuditResults = results;
  const total = results.reduce((sum, row) => sum + (row.count || 0), 0);
  const protectedRows = results.filter((row) => row.protected);
  const reviewRows = results.filter((row) => !row.protected);
  const summary = $('dataAuditSummary');
  if (summary) {
    summary.innerHTML =
      '<span class="audit-pill ok"><i class="pd-i pd-i-database"></i> ' + total + ' records scanned</span>' +
      '<span class="audit-pill warn">' + protectedRows.length + ' protected collections</span>' +
      '<span class="audit-pill">' + reviewRows.length + ' under review</span>' +
      '<span class="audit-pill">' + new Date().toLocaleString('en-GB') + '</span>';
  }
  body.innerHTML = results.map((row) => {
    const status = row.error
      ? '<span class="audit-pill warn">' + escapeHtml(row.error) + '</span>'
      : row.count === 0
        ? '<span class="audit-pill">Empty</span>'
        : '<span class="audit-pill ok">' + row.count + '</span>';
    return '<tr>' +
      '<td><strong>' + escapeHtml(row.name) + '</strong></td>' +
      '<td>' + status + '</td>' +
      '<td>' + (row.protected ? '<span class="audit-pill ok">Protected</span>' : '<span class="audit-pill warn">Review only</span>') + '</td>' +
      '<td style="font-size:.76rem;line-height:1.5;">' + escapeHtml(row.note) + '</td>' +
    '</tr>';
  }).join('');
  toast('Read-only scan complete — nothing was changed.', 'success');
}

function downloadDataAudit() {
  const results = window.__pdAuditResults;
  if (!results || !results.length) return toast('Run a scan first.', 'info');
  const report = {
    generatedAt: new Date().toISOString(),
    project: 'prayer-dome',
    readOnly: true,
    collections: results,
    membershipIntegrity: window.__pdIntegrityResults || null
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'prayer-dome-data-audit-' + todayValue() + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('Audit report downloaded. Back up each collection in the Firebase console before any migration.', 'info');
}

/* --------------------------------------------------- membership integrity */
/* A read-only diagnosis, not a migration. Duplicate membership numbers and
   missing timestamps are exactly what makes an old church database hard to
   manage; naming them here lets an administrator fix the record in Members
   CRM with the audit trail intact. No document is merged or deleted. */
async function runIntegrityCheck() {
  if (!bridge) return;
  const body = $('integrityAuditList');
  const summary = $('integrityAuditSummary');
  if (body) body.innerHTML = '<tr><td colspan="3"><div class="spinner" style="width:26px;height:26px;"></div></td></tr>';
  if (summary) summary.innerHTML = '<span class="audit-pill">Reading membership register…</span>';

  const store = bridge.firestore;
  const rows = [];
  let verification = [];
  try {
    const snap = await store.getDocs(store.query(store.collection(bridge.db, 'memberships'), store.limit(1000)));
    snap.forEach((entry) => rows.push(Object.assign({ id: entry.id }, entry.data())));
  } catch (error) {
    if (body) body.innerHTML = '<tr><td colspan="3"><span class="audit-pill warn">' + escapeHtml(error && error.code ? error.code : 'Membership read failed') + '</span></td></tr>';
    return;
  }
  try {
    const snap = await store.getDocs(store.query(store.collection(bridge.db, 'membershipVerification'), store.limit(1000)));
    snap.forEach((entry) => verification.push(Object.assign({ id: entry.id }, entry.data())));
  } catch (error) {
    verification = [];
  }

  const text = (value) => String(value == null ? '' : value).trim();
  const nameOf = (row) => text(row.fullName || row.name || row.displayName);
  const idOf = (row) => text(row.membershipId).toUpperCase();
  const mailOf = (row) => text(row.email).toLowerCase();

  const missingName = rows.filter((row) => !nameOf(row));
  const missingBranch = rows.filter((row) => !text(row.branch));
  const missingNumber = rows.filter((row) => !idOf(row));
  const missingCreated = rows.filter((row) => !row.createdAt);
  const missingContact = rows.filter((row) => !text(row.email) && !text(row.phone));

  function duplicates(keyFn) {
    const groups = new Map();
    rows.forEach((row) => {
      const key = keyFn(row);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    return [...groups.entries()].filter(([, list]) => list.length > 1);
  }
  const duplicateNumbers = duplicates(idOf);
  const duplicateEmails = duplicates(mailOf);

  const knownStatuses = new Set(['approved', 'pending', 'rejected', 'suspended', 'active', 'inactive', '']);
  const unknownStatus = rows.filter((row) => !knownStatuses.has(text(row.status).toLowerCase()));

  const membershipNumbers = new Set(rows.map(idOf).filter(Boolean));
  const orphanCards = verification.filter((entry) => {
    const key = text(entry.membershipId || entry.id).toUpperCase();
    return key && !membershipNumbers.has(key);
  });

  const results = [
    { check: 'Membership records', count: rows.length, severity: 'ok', action: 'Total records read from the register.' },
    { check: 'Missing display name', count: missingName.length, severity: missingName.length ? 'warn' : 'ok', action: 'Add the member’s full name in Members CRM.' },
    { check: 'Missing branch', count: missingBranch.length, severity: missingBranch.length ? 'warn' : 'ok', action: 'Assign the congregation so the member appears in branch reports.' },
    { check: 'Missing membership number', count: missingNumber.length, severity: missingNumber.length ? 'warn' : 'ok', action: 'Issue a number in Membership Cards; the ID card and /verify need it.' },
    { check: 'Duplicate membership numbers', count: duplicateNumbers.length, severity: duplicateNumbers.length ? 'error' : 'ok', action: 'Keep one record and archive the duplicate after exporting it.' },
    { check: 'Duplicate email addresses', count: duplicateEmails.length, severity: duplicateEmails.length ? 'warn' : 'ok', action: 'Check whether two accounts belong to the same person before merging.' },
    { check: 'Missing created timestamp', count: missingCreated.length, severity: missingCreated.length ? 'warn' : 'ok', action: 'Set createdAt (server timestamp) so admin sorting is stable.' },
    { check: 'No email or phone', count: missingContact.length, severity: missingContact.length ? 'warn' : 'ok', action: 'Record at least one contact route, with the member’s consent.' },
    { check: 'Unrecognised status', count: unknownStatus.length, severity: unknownStatus.length ? 'warn' : 'ok', action: 'Normalise to approved / pending / rejected / suspended.' },
    { check: 'Verification records without a member', count: orphanCards.length, severity: orphanCards.length ? 'warn' : 'ok', action: 'Revoke stale cards in Membership Cards so /verify stops confirming them.' }
  ];

  const details = {
    duplicateNumberValues: duplicateNumbers.map(([key, list]) => ({ value: key, ids: list.map((row) => row.id) })),
    duplicateEmailValues: duplicateEmails.map(([key, list]) => ({ value: key, ids: list.map((row) => row.id) })),
    missingNumberIds: missingNumber.map((row) => row.id),
    missingCreatedIds: missingCreated.map((row) => row.id),
    orphanCards: orphanCards.map((row) => row.membershipId || row.id)
  };
  window.__pdIntegrityResults = { checkedAt: new Date().toISOString(), totals: results, details };

  if (summary) {
    const issues = results.filter((row) => row.severity !== 'ok');
    summary.innerHTML =
      '<span class="audit-pill ' + (issues.length ? 'warn' : 'ok') + '"><i class="pd-i pd-i-' + (issues.length ? 'triangle-alert' : 'circle-check') + '"></i> ' +
        (issues.length ? issues.length + ' check(s) need attention' : 'No integrity problems found') + '</span>' +
      '<span class="audit-pill">' + rows.length + ' memberships read</span>' +
      '<span class="audit-pill">' + verification.length + ' verification cards</span>' +
      '<span class="audit-pill">' + new Date().toLocaleString('en-GB') + '</span>';
  }

  if (body) {
    body.innerHTML = results.map((row) => {
      const pill = row.severity === 'error' ? 'warn' : row.severity === 'warn' ? 'warn' : 'ok';
      return '<tr>' +
        '<td><strong>' + escapeHtml(row.check) + '</strong></td>' +
        '<td><span class="audit-pill ' + pill + '">' + row.count + '</span></td>' +
        '<td style="font-size:.76rem;line-height:1.5;">' + escapeHtml(row.action) + '</td>' +
      '</tr>';
    }).join('');
  }
  toast('Integrity check complete — records were only read.', issuesLengthText());
  function issuesLengthText() {
    const count = results.filter((row) => row.severity !== 'ok').length;
    return count ? count + ' item(s) need review' : 'no problems found';
  }
}

/* ------------------------------------------------------------ expose + init */
/* Inline `onclick` attributes run outside module scope, so every control must
   be published explicitly on window (Object.assign is invisible to the page
   wiring audit and, more importantly, easy to forget when adding a control). */
window.loadChurchLocations = loadChurchLocations;
window.newChurchLocation = newChurchLocation;
window.editChurchLocation = editChurchLocation;
window.saveChurchLocation = saveChurchLocation;
window.deleteChurchLocation = deleteChurchLocation;
window.loadDailyChallenges = loadDailyChallenges;
window.newDailyChallenge = newDailyChallenge;
window.editDailyChallenge = editDailyChallenge;
window.saveDailyChallenge = saveDailyChallenge;
window.deleteDailyChallenge = deleteDailyChallenge;
window.syncChallengeWeekday = syncChallengeWeekday;
window.loadMembershipCardAdmin = loadMembershipCardAdmin;
window.handleCardSignatureFile = handleCardSignatureFile;
window.saveCardTemplate = saveCardTemplate;
window.issueCardVerification = issueCardVerification;
window.revokeCardVerification = revokeCardVerification;
window.runDataAudit = runDataAudit;
window.downloadDataAudit = downloadDataAudit;
window.runIntegrityCheck = runIntegrityCheck;

function whenViewOpens(id, loader) {
  const section = document.getElementById(id);
  const nav = document.querySelector('.nav-item[data-view="' + id + '"]');
  let loaded = false;
  function open() {
    if (loaded) return;
    loaded = true;
    loader();
  }
  if (nav) nav.addEventListener('click', () => setTimeout(open, 120));
  if (!section) return;
  // A deep link (#locations) may already have the view open by the time this
  // module finishes loading, in which case no class mutation will ever fire.
  if (section.classList.contains('active')) { open(); return; }
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => {
      if (section.classList.contains('active')) {
        open();
        observer.disconnect();
      }
    });
    observer.observe(section, { attributes: true, attributeFilter: ['class'] });
  }
}

function boot() {
  if (!window.PDAdmin || !window.PDAdmin.firestore) {
    setTimeout(boot, 300);
    return;
  }
  bridge = window.PDAdmin;
  whenViewOpens('locations', loadChurchLocations);
  whenViewOpens('daily-challenges', loadDailyChallenges);
  whenViewOpens('membership-cards', loadMembershipCardAdmin);
  whenViewOpens('data-audit', () => { if (!window.__pdAuditResults) runDataAudit(); });
  loadCardTemplate();
}

boot();
