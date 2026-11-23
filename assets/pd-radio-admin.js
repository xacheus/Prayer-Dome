/*!
 * Prayer Dome — Radio Programming console
 * ---------------------------------------------------------------------------
 * Reviews the AI-assisted daily briefings before /radio can show them. Only an
 * explicit approval publishes a script. Unpublishing sets the record back to
 * draft; it does not delete the audit of who reviewed it.
 */
(function () {
  'use strict';

  const bridge = window.PDAdmin;
  if (!bridge) {
    console.error('Radio admin module: PDAdmin bridge is missing.');
    return;
  }
  const { collection, getDocs, getDoc, doc, setDoc, serverTimestamp, query, where } = bridge.firestore;
  const Billing = window.PDBilling;
  const Scripts = window.PD_RADIO_SCRIPTS;
  const PROGRAMMES = (window.PD_CONTENT && window.PD_CONTENT.RADIO_PROGRAMMES) || [];

  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function lusakaWeekday() {
    try {
      const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lusaka', weekday: 'short' })
        .format(new Date());
      return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name] || 0;
    } catch (error) { return new Date().getDay(); }
  }

  function weekdayName(day) {
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(day) || 0];
  }

  function programmesForDay(day) {
    return PROGRAMMES.filter((programme) => Array.isArray(programme.days) && programme.days.indexOf(Number(day)) !== -1)
      .filter((programme) => Scripts && Scripts.programmes && Scripts.programmes[programme.id]);
  }

  function defaultScript(programmeId, day) {
    return Scripts && typeof Scripts.scriptFor === 'function' ? Scripts.scriptFor(programmeId, day) : '';
  }

  window.loadRadioProgrammes = async function () {
    const body = document.getElementById('radioProgrammeList');
    if (!body) return;
    const select = document.getElementById('radioProgrammeDay');
    const day = select ? Number(select.value) : lusakaWeekday();
    body.innerHTML = '<tr><td colspan="5">Loading programme briefings…</td></tr>';
    try {
      const snapshot = await getDocs(query(collection(bridge.db, 'radioScripts'), where('weekday', '==', day)));
      const rows = {};
      snapshot.docs.forEach((entry) => { rows[entry.id] = entry.data(); });
      const programmes = programmesForDay(day);
      if (!programmes.length) {
        body.innerHTML = '<tr><td colspan="5">No programme is scheduled for ' + esc(weekdayName(day)) + '.</td></tr>';
        return;
      }
      body.innerHTML = programmes.map((programme) => {
        const key = programme.id + '-' + day;
        const row = rows[key];
        const status = row ? String(row.status || 'draft') : 'none';
        const badge = status === 'approved'
          ? '<span class="badge badge-success">Approved</span>'
          : status === 'draft'
            ? '<span class="badge badge-warning">Draft</span>'
            : status === 'rejected'
              ? '<span class="badge badge-danger">Needs rewrite</span>'
              : '<span class="badge">Not reviewed</span>';
        return '<tr>' +
          '<td><strong>' + esc(programme.title) + '</strong><br><span style="font-size:.7rem;color:var(--text-sub);">' + esc(programme.host || 'Prayer Dome Radio') + '</span></td>' +
          '<td>' + badge + '</td>' +
          '<td style="max-width:280px;font-size:.72rem;color:var(--text-sub);">' + esc(row && row.script ? row.script.slice(0, 120) + (row.script.length > 120 ? '…' : '') : 'No approved or saved briefing.') + '</td>' +
          '<td>' + esc(row && (row.reviewedBy || row.updatedBy) || '—') + '</td>' +
          '<td><div style="display:flex;gap:5px;flex-wrap:wrap;">' +
            '<button class="btn btn-primary btn-sm" type="button" onclick="openRadioScript(\'' + esc(programme.id) + '\',' + day + ')"><i class="pd-i pd-i-square-pen"></i> Review</button>' +
            (status === 'approved' ? '<button class="btn btn-outline btn-sm" type="button" onclick="unpublishRadioScript(\'' + esc(programme.id) + '\',' + day + ')"><i class="pd-i pd-i-eye-off"></i> Unpublish</button>' : '') +
          '</div></td>' +
        '</tr>';
      }).join('');
    } catch (error) {
      console.error('Radio briefings load failed:', error);
      body.innerHTML = '<tr><td colspan="5">Briefings could not be loaded: ' + esc(error.message) + '</td></tr>';
    }
  };

  window.openRadioScript = async function (programmeId, day) {
    const programme = PROGRAMMES.filter((row) => row.id === programmeId)[0];
    if (!programme) return window.toast('That programme was not found.', 'error');
    let existing = null;
    try {
      const snap = await getDocs(query(collection(bridge.db, 'radioScripts'), where('weekday', '==', Number(day))));
      snap.docs.forEach((entry) => { if (entry.id === programmeId + '-' + day) existing = entry.data(); });
    } catch (error) { /* a missing read falls back to the draft */ }
    document.getElementById('radioScriptProgrammeId').value = programmeId;
    document.getElementById('radioScriptDay').value = String(day);
    document.getElementById('radioScriptTitle').textContent = programme.title + ' · ' + weekdayName(day);
    document.getElementById('radioScriptText').value = (existing && existing.script) || defaultScript(programmeId, day);
    document.getElementById('radioScriptNote').textContent = existing
      ? 'Last saved by ' + (existing.reviewedBy || existing.updatedBy || 'an administrator') + '. Editing and approving publishes this exact text.'
      : 'This is the AI-assisted draft. Read it aloud, correct anything that is not true of the ministry, then approve it.';
    document.getElementById('modalRadioScript').style.display = 'flex';
  };

  window.saveRadioScript = async function (approve) {
    const programmeId = String(document.getElementById('radioScriptProgrammeId').value || '').trim();
    const day = Number(document.getElementById('radioScriptDay').value);
    const script = String(document.getElementById('radioScriptText').value || '').trim();
    if (!programmeId || !(day >= 0 && day <= 6)) return window.toast('Choose a programme first.', 'error');
    if (script.length < 40) return window.toast('The briefing is too short to publish. Write at least a paragraph.', 'error');
    const reviewedBy = (bridge.auth && bridge.auth.currentUser && (bridge.auth.currentUser.email || bridge.auth.currentUser.uid)) || 'Administrator';
    window.showLoading(approve ? 'Publishing the reviewed briefing…' : 'Saving the draft…');
    try {
      await setDoc(doc(bridge.db, 'radioScripts', programmeId + '-' + day), {
        programmeId,
        weekday: day,
        title: (PROGRAMMES.filter((row) => row.id === programmeId)[0] || {}).title || programmeId,
        script,
        status: approve ? 'approved' : 'draft',
        aiAssisted: true,
        reviewedBy,
        reviewedAt: new Date().toISOString(),
        updatedAt: serverTimestamp()
      }, { merge: true });
      window.hideLoading();
      window.closeModal('modalRadioScript');
      window.toast(approve ? 'Briefing approved. /radio now shows this text for ' + weekdayName(day) + '.' : 'Draft saved; it is not public.');
      await window.loadRadioProgrammes();
    } catch (error) {
      window.hideLoading();
      window.toast(error.message, 'error');
    }
  };

  window.unpublishRadioScript = async function (programmeId, day) {
    if (!window.confirm('Unpublish this briefing? /radio will stop showing it until it is approved again.')) return;
    const reviewedBy = (bridge.auth && bridge.auth.currentUser && (bridge.auth.currentUser.email || bridge.auth.currentUser.uid)) || 'Administrator';
    window.showLoading();
    try {
      await setDoc(doc(bridge.db, 'radioScripts', programmeId + '-' + day), {
        programmeId,
        weekday: Number(day),
        status: 'draft',
        reviewedBy,
        reviewedAt: new Date().toISOString(),
        updatedAt: serverTimestamp()
      }, { merge: true });
      window.hideLoading();
      window.toast('Briefing unpublished.');
      await window.loadRadioProgrammes();
    } catch (error) {
      window.hideLoading();
      window.toast(error.message, 'error');
    }
  };

  window.approveAllRadioScripts = async function () {
    const select = document.getElementById('radioProgrammeDay');
    const day = select ? Number(select.value) : lusakaWeekday();
    const programmes = programmesForDay(day);
    if (!programmes.length) return window.toast('No programmes scheduled for this day.', 'error');
    if (!window.confirm('Approve the AI-assisted draft for all ' + programmes.length + ' briefings on ' + weekdayName(day) + '? Read them first — this publishes them on /radio.')) return;
    const reviewedBy = (bridge.auth && bridge.auth.currentUser && (bridge.auth.currentUser.email || bridge.auth.currentUser.uid)) || 'Administrator';
    window.showLoading('Publishing reviewed briefings…');
    try {
      // Approve the text that is already saved. Only a programme with no saved
      // briefing at all receives the AI-assisted draft — never overwrite an
      // administrator's corrections with the default text.
      let published = 0;
      let skipped = 0;
      await Promise.all(programmes.map(async (programme) => {
        const ref = doc(bridge.db, 'radioScripts', programme.id + '-' + day);
        let existing = null;
        try {
          const snap = await getDoc(ref);
          existing = snap.exists() ? snap.data() : null;
        } catch (error) { /* fall through to the draft */ }
        if (existing && existing.status === 'approved' && existing.script) { skipped += 1; return; }
        const script = (existing && existing.script) || defaultScript(programme.id, day);
        if (!script) { skipped += 1; return; }
        await setDoc(ref, {
          programmeId: programme.id,
          weekday: day,
          title: programme.title,
          script,
          status: 'approved',
          aiAssisted: !(existing && existing.aiAssisted === false),
          reviewedBy,
          reviewedAt: new Date().toISOString(),
          updatedAt: serverTimestamp()
        }, { merge: true });
        published += 1;
      }));
      window.hideLoading();
      window.toast(published + ' briefing' + (published === 1 ? '' : 's') + ' approved for ' + weekdayName(day) + (skipped ? ' · ' + skipped + ' already approved or unavailable.' : '.'));
      await window.loadRadioProgrammes();
    } catch (error) {
      window.hideLoading();
      window.toast(error.message, 'error');
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('radioProgrammeDay');
    if (select) select.value = String(lusakaWeekday());
  });

  document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'radioProgrammeDay' && typeof window.loadRadioProgrammes === 'function') {
      window.loadRadioProgrammes();
    }
  });
})();
