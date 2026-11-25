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
  const { collection, getDocs, getDoc, doc, setDoc, deleteDoc, writeBatch, serverTimestamp, query, where } = bridge.firestore;
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


  /* ======================================================================
   * RADIO STUDIO — library, recorded voices, playlists, timetable and
   * presenter access. This is the same admin console and the same Firestore
   * project, not a second radio system.
   * ==================================================================== */

  const GENRES = {
    'gospel-worship': 'Gospel worship',
    'contemporary': 'Contemporary gospel',
    'african': 'African gospel',
    'international': 'International gospel',
    'traditional': 'Traditional gospel',
    'praise': 'Praise',
    'instrumental-worship': 'Instrumental worship',
    'other-christian': 'Other approved Christian music'
  };
  const LICENCES = {
    'licensed': 'Licensed',
    'written-permission': 'Written permission',
    'public-domain': 'Public domain',
    'original': 'Original recording'
  };
  const STREAMING_HOSTS = /(?:youtube\.com|youtu\.be|spotify\.com|soundcloud\.com|music\.apple\.com|apple\.co\/music|deezer\.com|tidal\.com|amazon\.com\/music)/i;
  const state = { tracks: [], voices: [], playlists: [], schedule: [], settings: null, requests: [], active: [] };
  let previewAudio = null;

  function $id(id) { return document.getElementById(id); }
  function number(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }
  function stamp(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (value.seconds) return Number(value.seconds) * 1000;
    const n = new Date(value).getTime();
    return Number.isNaN(n) ? 0 : n;
  }
  function lusaka(value) {
    const ms = stamp(value);
    if (!ms) return '—';
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lusaka', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
    } catch (error) { return new Date(ms).toLocaleString(); }
  }
  function minutesLabel(value) {
    const n = number(value, 0);
    return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  }
  function timeToMinutes(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
    if (!match) return -1;
    const hours = Number(match[1]);
    const mins = Number(match[2]);
    if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return -1;
    return hours * 60 + mins;
  }
  function callRadio(name, data) {
    const fn = bridge.httpsCallable(bridge.cloudFunctions, name);
    return fn(data || {});
  }
  function who() {
    return (bridge.auth && bridge.auth.currentUser && (bridge.auth.currentUser.email || bridge.auth.currentUser.uid)) || 'Administrator';
  }
  function badge(value, tone) {
    return '<span class="badge badge-' + (tone || 'info') + '">' + esc(value) + '</span>';
  }
  function statusBadge(status) {
    const map = { pending: 'warning', approved: 'success', rejected: 'danger', changes: 'warning', revoked: 'danger', expired: '', completed: 'success' };
    return '<span class="badge badge-' + (map[status] || 'info') + '">' + esc(status || 'unknown') + '</span>';
  }

  function fillProgrammeSelects() {
    const options = PROGRAMMES.map(function (programme) {
      return '<option value="' + esc(programme.id) + '">' + esc(programme.title) + '</option>';
    }).join('');
    const voice = $id('radioVoiceProgramme');
    if (voice && voice.options.length <= 1) voice.insertAdjacentHTML('beforeend', options);
  }

  async function uploadAudio(file, kind, statusEl) {
    if (!file) return '';
    const allowed = /^audio\//.test(file.type || '') || /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(file.name || '');
    if (!allowed) throw new Error('Choose an audio file (MP3, M4A, AAC, WAV, OGG or FLAC).');
    if (file.size > 50 * 1024 * 1024) throw new Error('Audio files must be smaller than 50 MB.');
    const safe = String(file.name || 'audio').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(-80) || 'audio';
    const path = 'radioAudio/' + kind + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safe;
    const ref = bridge.storage.storageRef(bridge.storage.storage, path);
    const task = bridge.storage.uploadBytesResumable(ref, file, { contentType: file.type || 'audio/mpeg' });
    if (statusEl) statusEl.textContent = 'Uploading ' + Math.round((file.size / 1024) / 1024 * 10) / 10 + ' MB…';
    await new Promise(function (resolve, reject) {
      task.on('state_changed', function (snapshot) {
        if (!statusEl) return;
        const pct = snapshot.totalBytes ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100) : 0;
        statusEl.textContent = 'Uploading… ' + pct + '%';
      }, reject, resolve);
    });
    const url = await bridge.storage.getDownloadURL(ref);
    if (statusEl) statusEl.textContent = 'Upload complete.';
    return url;
  }

  async function deleteAudioQuietly(url) {
    // A Storage download URL embeds the object path. Only delete objects under
    // radioAudio/, never a podcast or another ministry asset.
    if (!url || typeof url !== 'string') return;
    const match = /\/o\/(radioAudio%2F[^?]+)/i.exec(url);
    if (!match) return;
    try {
      const path = decodeURIComponent(match[1]);
      if (path.indexOf('radioAudio/') !== 0) return;
      await bridge.storage.deleteObject(bridge.storage.storageRef(bridge.storage.storage, path));
    } catch (error) { console.warn('Radio audio cleanup skipped:', error && error.message); }
  }

  function renderCounts(counts) {
    const host = $id('radioAdminCounts');
    if (!host) return;
    const rows = [
      ['Pending requests', counts.pending || 0, 'from-amber-500 to-orange-500'],
      ['Approved requests', counts.approved || 0, 'from-emerald-500 to-teal-500'],
      ['Approved tracks', counts.approvedTracks || 0, ''],
      ['All tracks', counts.tracks || 0, ''],
      ['Approved voices', counts.approvedVoices || 0, ''],
      ['Voices', counts.voices || 0, '']
    ];
    host.innerHTML = rows.map(function (row) {
      return '<div style="min-width:120px;padding:10px 12px;border:1px solid var(--border-color);border-radius:12px;background:var(--bg-card);">' +
        '<strong style="font-size:1.1rem;display:block;">' + esc(String(row[1])) + '</strong>' +
        '<span style="font-size:.7rem;color:var(--text-sub);">' + esc(row[0]) + '</span></div>';
    }).join('');
  }

  function renderHealth(health) {
    const host = $id('radioAdminLiveStatus');
    const checked = $id('radioAdminChecked');
    if (checked) checked.textContent = 'Checked ' + lusaka(health.checkedAt);
    if (host) {
      if (health.live && health.live.status === 'live') {
        host.innerHTML = '<span class="badge badge-danger"><i class="pd-i pd-i-radio"></i> LIVE</span> ' +
          '<strong>' + esc(health.live.programmeTitle || 'Presenter programme') + '</strong> · ' + esc(health.live.presenterName || 'Presenter') +
          ' · started ' + esc(lusaka(health.live.startedAt)) + ' · approved until ' + esc(lusaka(health.live.expiresAt));
      } else {
        host.innerHTML = '<span class="badge badge-success"><i class="pd-i pd-i-circle-check"></i> Automation</span> No presenter is live. Approved tracks and the published timetable continue.';
      }
      if (health.nowPlaying && health.nowPlaying.title) {
        host.innerHTML += '<div style="margin-top:8px;font-size:.75rem;color:var(--text-sub);"><i class="pd-i pd-i-disc-3"></i> ' +
          esc(health.nowPlaying.title) + (health.nowPlaying.artist ? ' · ' + esc(health.nowPlaying.artist) : '') +
          (health.nowPlaying.programmeTitle ? ' · ' + esc(health.nowPlaying.programmeTitle) : '') + '</div>';
      }
    }
    renderCounts(health.counts || {});
    const body = $id('radioAdminHealthList');
    if (body) {
      const rows = (health.health || []).slice(0, 20);
      body.innerHTML = rows.length ? rows.map(function (row) {
        return '<tr><td style="white-space:nowrap;font-size:.72rem;">' + esc(lusaka(row.createdAt)) + '</td>' +
          '<td>' + badge(row.type || 'event', row.type === 'issue' ? 'danger' : row.type === 'session-end' ? 'warning' : 'info') + '</td>' +
          '<td style="max-width:420px;font-size:.75rem;">' + esc(row.message || '') + (row.programmeTitle ? '<br><span style="color:var(--text-sub);">' + esc(row.programmeTitle) + '</span>' : '') + '</td>' +
          '<td style="font-size:.72rem;">' + esc(row.actor || '—') + '</td></tr>';
      }).join('') : '<tr><td colspan="4">No health events recorded yet.</td></tr>';
    }
    state.active = health.activeSessions || [];
    renderActive();
  }

  function renderActive() {
    const host = $id('radioAdminActive');
    if (!host) return;
    if (!state.active.length) {
      host.innerHTML = 'No presenter is live.';
      return;
    }
    host.innerHTML = state.active.map(function (session) {
      return '<div style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border-color);">' +
        '<div><strong>' + esc(session.programmeTitle || 'Presenter programme') + '</strong><span style="color:var(--text-sub);"> · ' + esc(session.presenterName || 'Presenter') + '</span><br>' +
        '<span style="font-size:.72rem;color:var(--text-sub);">Started ' + esc(lusaka(session.startedAt)) + ' · heartbeat ' + esc(lusaka(session.lastHeartbeatAt)) + ' · expires ' + esc(lusaka(session.expiresAt)) + '</span></div>' +
        '<button class="btn btn-danger btn-sm" type="button" onclick="radioAdminStopSession(\'' + esc(session.id) + '\')"><i class="pd-i pd-i-square"></i> Stop &amp; return to automation</button></div>';
    }).join('');
  }

  function renderRequests(requests) {
    state.requests = requests || [];
    const body = $id('radioAdminRequests');
    if (!body) return;
    if (!state.requests.length) {
      body.innerHTML = '<tr><td colspan="6">No presenter requests yet. Approved presenters receive live controls only inside their approved window.</td></tr>';
      return;
    }
    body.innerHTML = state.requests.map(function (row) {
      const actions = [];
      if (row.status === 'pending') {
        actions.push('<button class="btn btn-primary btn-sm" type="button" onclick="radioAdminDecide(\'' + esc(row.id) + '\',\'approve\')"><i class="pd-i pd-i-circle-check"></i> Approve</button>');
        actions.push('<button class="btn btn-outline btn-sm" type="button" onclick="radioAdminDecide(\'' + esc(row.id) + '\',\'changes\')"><i class="pd-i pd-i-message-circle"></i> Changes</button>');
        actions.push('<button class="btn btn-danger btn-sm" type="button" onclick="radioAdminDecide(\'' + esc(row.id) + '\',\'reject\')"><i class="pd-i pd-i-x"></i> Reject</button>');
      } else if (row.status === 'approved') {
        actions.push('<button class="btn btn-danger btn-sm" type="button" onclick="radioAdminDecide(\'' + esc(row.id) + '\',\'revoke\')"><i class="pd-i pd-i-shield-x"></i> Revoke</button>');
        actions.push('<button class="btn btn-outline btn-sm" type="button" onclick="radioAdminStopRequest(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-square"></i> Stop</button>');
      }
      return '<tr><td><strong>' + esc(row.name) + '</strong><br><span style="font-size:.7rem;color:var(--text-sub);">' + esc(row.email || row.uid || '') + '</span></td>' +
        '<td>' + esc(row.programmeTitle) + '<br><span style="font-size:.7rem;color:var(--text-sub);">' + esc((row.description || '').slice(0, 100)) + (row.description && row.description.length > 100 ? '…' : '') + '</span></td>' +
        '<td style="font-size:.75rem;white-space:nowrap;">' + esc(lusaka(row.startAt)) + '<br><span style="color:var(--text-sub);">ends ' + esc(lusaka(row.endAt)) + '</span></td>' +
        '<td>' + esc(String(row.durationMinutes || 0)) + ' min</td>' +
        '<td>' + statusBadge(row.status) + (row.adminNote ? '<br><span style="font-size:.68rem;color:var(--text-sub);">' + esc(row.adminNote) + '</span>' : '') + '</td>' +
        '<td><div style="display:flex;gap:4px;flex-wrap:wrap;">' + (actions.join('') || '<span style="font-size:.72rem;color:var(--text-sub);">No action</span>') + '</div></td></tr>';
    }).join('');
  }

  window.radioAdminDecide = async function (requestId, decision) {
    const labels = { approve: 'approve', reject: 'reject', changes: 'request changes to', revoke: 'revoke' };
    let note = '';
    if (decision !== 'approve') {
      note = String(window.prompt('Reason for ' + labels[decision] + ' this request (the presenter sees this):', '') || '').trim();
      if (!note) return window.toast('Add a short reason so the presenter knows what to do.', 'error');
    }
    if (!window.confirm('Confirm ' + labels[decision] + '? Only an administrator can make this decision.')) return;
    window.showLoading ? window.showLoading('Updating presenter access…') : null;
    try {
      const result = await callRadio('radioPresenterDecision', { requestId: requestId, decision: decision, note: note });
      if (window.hideLoading) window.hideLoading();
      window.toast('Request ' + result.data.status + '. The presenter has been notified in the app' + (result.data.presenterNotified ? ' and by email.' : '.'));
      await window.loadRadioAdmin();
    } catch (error) {
      if (window.hideLoading) window.hideLoading();
      window.toast(error.message || 'The decision could not be saved.', 'error');
    }
  };

  window.radioAdminStopSession = async function (sessionId) {
    if (!window.confirm('Stop this presenter? The LIVE overlay will be removed and listeners return to automation.')) return;
    try {
      await callRadio('radioAdminStop', { sessionId: sessionId, reason: 'Stopped by an administrator' });
      window.toast('Presenter stopped. Listeners are back on automation.');
      await window.loadRadioAdmin();
    } catch (error) { window.toast(error.message || 'The session could not be stopped.', 'error'); }
  };

  window.radioAdminStopRequest = async function (requestId) {
    if (!window.confirm('Stop the active presenter for this request and revoke the approval?')) return;
    try {
      await callRadio('radioAdminStop', { requestId: requestId, reason: 'Stopped by an administrator' });
      window.toast('Presenter stopped and approval revoked.');
      await window.loadRadioAdmin();
    } catch (error) { window.toast(error.message || 'The session could not be stopped.', 'error'); }
  };

  async function loadTracks() {
    const body = $id('radioAdminTracks');
    if (!body) return;
    // The gospel library IS the existing worshipSongs collection. Radio adds
    // genre, licence and approval fields; it does not create a second library.
    const snapshot = await getDocs(collection(bridge.db, 'worshipSongs'));
    state.tracks = snapshot.docs.map(function (entry) {
      const row = entry.data() || {};
      return Object.assign({ id: entry.id }, row, {
        genre: row.genre || 'gospel-worship',
        licenseStatus: row.licenseStatus || '',
        permissionConfirmed: row.permissionConfirmed === true,
        approved: row.approved === true
      });
    }).sort(function (a, b) { return String(a.title || '').localeCompare(String(b.title || '')); });
    body.innerHTML = state.tracks.length ? state.tracks.map(function (row) {
      return '<tr><td><strong>' + esc(row.title) + '</strong><br><span style="font-size:.7rem;color:var(--text-sub);">' + esc(row.album || '') + '</span></td>' +
        '<td>' + esc(row.artist) + '</td><td>' + esc(GENRES[row.genre] || row.genre || '—') + '</td>' +
        '<td>' + badge(LICENCES[row.licenseStatus] || row.licenseStatus || 'Unspecified', row.licenseStatus ? 'success' : 'danger') + '</td>' +
        '<td>' + (row.approved ? badge('Approved', 'success') : badge('Not approved', 'warning')) + '</td>' +
        '<td><div style="display:flex;gap:4px;flex-wrap:wrap;">' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="radioAdminPreview(\'' + esc(row.audioUrl || '') + '\')" ' + (row.audioUrl ? '' : 'disabled') + '><i class="pd-i pd-i-play"></i> Preview</button>' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="radioAdminEditTrack(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-square-pen"></i> Edit</button>' +
        '<button class="btn btn-danger btn-sm" type="button" onclick="radioAdminDeleteTrack(\'' + esc(row.id) + '\')" aria-label="Delete track"><i class="pd-i pd-i-trash"></i></button>' +
        '</div></td></tr>';
    }).join('') : '<tr><td colspan="6">No tracks yet. Add only audio you are licensed to broadcast.</td></tr>';
    renderPlaylistTracks();
  }

  function renderPlaylistTracks(selected) {
    const host = $id('radioPlaylistTracks');
    if (!host) return;
    const picked = new Set(selected || []);
    const approved = state.tracks.filter(function (row) { return row.approved === true; });
    host.innerHTML = approved.length ? approved.map(function (row) {
      return '<label style="display:flex;gap:8px;align-items:center;padding:4px 0;"><input type="checkbox" value="' + esc(row.id) + '"' + (picked.has(row.id) ? ' checked' : '') + '> <span>' + esc(row.title) + ' <span style="color:var(--text-sub);">· ' + esc(row.artist) + '</span></span></label>';
    }).join('') : '<span style="color:var(--text-sub);">Approve at least one licensed track first.</span>';
  }

  window.radioAdminResetTrack = function () {
    const form = $id('radioTrackForm');
    if (form) form.reset();
    $id('radioTrackId').value = '';
    $id('radioTrackUploadStatus').textContent = '';
  };

  window.radioAdminEditTrack = function (id) {
    const row = state.tracks.filter(function (item) { return item.id === id; })[0];
    if (!row) return;
    $id('radioTrackId').value = row.id;
    $id('radioTrackTitle').value = row.title || '';
    $id('radioTrackArtist').value = row.artist || '';
    $id('radioTrackAlbum').value = row.album || '';
    $id('radioTrackGenre').value = row.genre || 'gospel-worship';
    $id('radioTrackSource').value = row.source || '';
    $id('radioTrackSourceUrl').value = row.sourceUrl || '';
    $id('radioTrackLicence').value = row.licenseStatus || 'licensed';
    $id('radioTrackDuration').value = row.durationSeconds || '';
    $id('radioTrackAudioUrl').value = row.audioUrl || '';
    $id('radioTrackNotes').value = row.notes || '';
    $id('radioTrackPermission').checked = row.permissionConfirmed === true;
    $id('radioTrackApproved').checked = row.approved === true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  window.radioAdminSaveTrack = async function (event) {
    if (event && event.preventDefault) event.preventDefault();
    const id = String($id('radioTrackId').value || '').trim();
    const title = String($id('radioTrackTitle').value || '').trim();
    const artist = String($id('radioTrackArtist').value || '').trim();
    const album = String($id('radioTrackAlbum').value || '').trim();
    const genre = String($id('radioTrackGenre').value || 'gospel-worship');
    const source = String($id('radioTrackSource').value || '').trim();
    const sourceUrl = String($id('radioTrackSourceUrl').value || '').trim();
    const licenseStatus = String($id('radioTrackLicence').value || 'licensed');
    const durationSeconds = Math.max(0, number($id('radioTrackDuration').value, 0));
    const notes = String($id('radioTrackNotes').value || '').trim();
    const permission = $id('radioTrackPermission').checked;
    const approved = $id('radioTrackApproved').checked;
    let audioUrl = String($id('radioTrackAudioUrl').value || '').trim();
    if (!title || !artist) return window.toast('A title and artist are required.', 'error');
    if (!source) return window.toast('Record where this recording came from (label, distributor or permission reference).', 'error');
    if (!permission) return window.toast('Confirm that Prayer Dome has permission to broadcast this recording.', 'error');
    if (STREAMING_HOSTS.test(sourceUrl) || STREAMING_HOSTS.test(source)) {
      return window.toast('A YouTube, Spotify or similar link is not a licence. Use a permission record or an authorised distributor; Prayer Dome Radio does not scrape or rebroadcast those services.', 'error');
    }
    if (!Object.prototype.hasOwnProperty.call(GENRES, genre)) return window.toast('Choose an approved gospel genre.', 'error');
    if (!Object.prototype.hasOwnProperty.call(LICENCES, licenseStatus)) return window.toast('Choose a valid licence basis.', 'error');
    const status = $id('radioTrackUploadStatus');
    if (window.showLoading) window.showLoading('Saving the track…');
    try {
      const file = $id('radioTrackFile').files && $id('radioTrackFile').files[0];
      if (file) audioUrl = await uploadAudio(file, 'tracks', status);
      if (!audioUrl) throw new Error('Add an audio URL or upload an audio file.');
      if (STREAMING_HOSTS.test(audioUrl)) throw new Error('A YouTube/Spotify page is not an audio file. Upload the recording you are licensed to broadcast.');
      const ref = id ? doc(bridge.db, 'worshipSongs', id) : doc(collection(bridge.db, 'worshipSongs'));
      const data = {
        title: title.slice(0, 160), artist: artist.slice(0, 160), album: album.slice(0, 160),
        genre: genre, source: source.slice(0, 160), sourceUrl: sourceUrl.slice(0, 400),
        licenseStatus: licenseStatus, durationSeconds: durationSeconds,
        // Keep the existing worship-library fields in step so the public
        // Worship & Music Library and the radio automation see one record.
        category: GENRES[genre] || genre, rights: LICENCES[licenseStatus] || licenseStatus,
        duration: durationSeconds ? (Math.floor(durationSeconds / 60) + ':' + String(durationSeconds % 60).padStart(2, '0')) : '',
        rightsHolder: source.slice(0, 160), description: notes.slice(0, 600),
        audioUrl: audioUrl.slice(0, 600), notes: notes.slice(0, 600),
        permissionConfirmed: true, importApproved: true,
        approved: approved === true, allowDownload: false,
        updatedBy: who(), updatedAt: serverTimestamp()
      };
      if (!id) data.createdAt = serverTimestamp();
      await setDoc(ref, data, { merge: true });
      if (window.hideLoading) window.hideLoading();
      window.toast('Track saved' + (approved ? ' and approved for automation.' : ' as unapproved.'));
      window.radioAdminResetTrack();
      await loadTracks();
      await loadPlaylists();
    } catch (error) {
      if (window.hideLoading) window.hideLoading();
      window.toast(error.message || 'The track could not be saved.', 'error');
    }
  };

  window.radioAdminDeleteTrack = async function (id) {
    if (!window.confirm('Delete this track record? Playlists will no longer contain it.')) return;
    try {
      const row = state.tracks.filter(function (item) { return item.id === id; })[0];
      await deleteDoc(doc(bridge.db, 'worshipSongs', id));
      if (row) await deleteAudioQuietly(row.audioUrl);
      window.toast('Track deleted.');
      await loadTracks();
    } catch (error) { window.toast(error.message || 'The track could not be deleted.', 'error'); }
  };

  window.radioAdminPreview = function (url) {
    if (!url) return;
    if (!previewAudio) {
      previewAudio = new Audio();
      previewAudio.preload = 'none';
      document.body.appendChild(previewAudio);
    }
    if (!previewAudio.paused && previewAudio.src === url) {
      previewAudio.pause();
      return;
    }
    previewAudio.src = url;
    previewAudio.play().then(function () { window.toast('Previewing the recording in this console only. Listeners are unaffected.'); })
      .catch(function () { window.toast('This recording could not be previewed.', 'error'); });
  };

  async function loadVoices() {
    const body = $id('radioAdminVoices');
    if (!body) return;
    const snapshot = await getDocs(collection(bridge.db, 'radioVoices'));
    state.voices = snapshot.docs.map(function (entry) { return Object.assign({ id: entry.id }, entry.data()); })
      .sort(function (a, b) { return String(a.voiceLabel || a.name || '').localeCompare(String(b.voiceLabel || b.name || '')); });
    const programmeName = {};
    PROGRAMMES.forEach(function (programme) { programmeName[programme.id] = programme.title; });
    body.innerHTML = state.voices.length ? state.voices.map(function (row) {
      return '<tr><td><strong>' + esc(row.voiceLabel || row.name) + '</strong><br><span style="font-size:.7rem;color:var(--text-sub);">' + esc(row.name) + '</span></td>' +
        '<td>' + esc(row.gender || '—') + '</td><td>' + esc(programmeName[row.programmeId] || 'Any programme') + '</td>' +
        '<td>' + esc(row.kind || 'programme-intro') + '</td>' +
        '<td>' + (row.approved ? badge('Approved', 'success') : badge('Not approved', 'warning')) + '</td>' +
        '<td><div style="display:flex;gap:4px;flex-wrap:wrap;">' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="radioAdminPreview(\'' + esc(row.audioUrl || '') + '\')" ' + (row.audioUrl ? '' : 'disabled') + '><i class="pd-i pd-i-play"></i> Preview</button>' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="radioAdminEditVoice(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-square-pen"></i> Edit</button>' +
        '<button class="btn btn-danger btn-sm" type="button" onclick="radioAdminDeleteVoice(\'' + esc(row.id) + '\')" aria-label="Delete recorded voice"><i class="pd-i pd-i-trash"></i></button>' +
        '</div></td></tr>';
    }).join('') : '<tr><td colspan="6">No recorded voices yet. Upload a genuine human recording; generated voices are not used.</td></tr>';
    fillProgrammeSelects();
  }

  window.radioAdminResetVoice = function () {
    const form = $id('radioVoiceForm');
    if (form) form.reset();
    $id('radioVoiceId').value = '';
    $id('radioVoiceUploadStatus').textContent = '';
  };

  window.radioAdminEditVoice = function (id) {
    const row = state.voices.filter(function (item) { return item.id === id; })[0];
    if (!row) return;
    $id('radioVoiceId').value = row.id;
    $id('radioVoiceName').value = row.name || '';
    $id('radioVoiceLabel').value = row.voiceLabel || '';
    $id('radioVoiceGender').value = row.gender || 'male';
    $id('radioVoiceProgramme').value = row.programmeId || '';
    $id('radioVoiceKind').value = row.kind || 'programme-intro';
    $id('radioVoiceAudioUrl').value = row.audioUrl || '';
    $id('radioVoiceNotes').value = row.notes || '';
    $id('radioVoiceApproved').checked = row.approved === true;
  };

  window.radioAdminSaveVoice = async function (event) {
    if (event && event.preventDefault) event.preventDefault();
    const id = String($id('radioVoiceId').value || '').trim();
    const name = String($id('radioVoiceName').value || '').trim();
    const voiceLabel = String($id('radioVoiceLabel').value || '').trim();
    const gender = String($id('radioVoiceGender').value || 'male');
    const programmeId = String($id('radioVoiceProgramme').value || '');
    const kind = String($id('radioVoiceKind').value || 'programme-intro');
    const notes = String($id('radioVoiceNotes').value || '').trim();
    const approved = $id('radioVoiceApproved').checked;
    let audioUrl = String($id('radioVoiceAudioUrl').value || '').trim();
    if (!name || !voiceLabel) return window.toast('Give the human presenter and this recording a name.', 'error');
    const status = $id('radioVoiceUploadStatus');
    if (window.showLoading) window.showLoading('Saving the recorded voice…');
    try {
      const file = $id('radioVoiceFile').files && $id('radioVoiceFile').files[0];
      if (file) audioUrl = await uploadAudio(file, 'voices', status);
      if (!audioUrl) throw new Error('Upload a recording or paste its audio URL.');
      if (STREAMING_HOSTS.test(audioUrl)) throw new Error('Use the recorded audio file, not a YouTube/Spotify page.');
      const ref = id ? doc(bridge.db, 'radioVoices', id) : doc(collection(bridge.db, 'radioVoices'));
      const data = {
        name: name.slice(0, 120), voiceLabel: voiceLabel.slice(0, 120), gender: gender,
        programmeId: programmeId, kind: kind, notes: notes.slice(0, 600),
        audioUrl: audioUrl.slice(0, 600), humanRecorded: true,
        approved: approved === true, updatedBy: who(), updatedAt: serverTimestamp()
      };
      if (!id) data.createdAt = serverTimestamp();
      await setDoc(ref, data, { merge: true });
      if (window.hideLoading) window.hideLoading();
      window.toast('Recorded voice saved' + (approved ? ' and approved.' : ' as unapproved.'));
      window.radioAdminResetVoice();
      await loadVoices();
      await loadSchedule();
      await loadSettings();
    } catch (error) {
      if (window.hideLoading) window.hideLoading();
      window.toast(error.message || 'The recorded voice could not be saved.', 'error');
    }
  };

  window.radioAdminDeleteVoice = async function (id) {
    if (!window.confirm('Delete this recorded voice from the library?')) return;
    try {
      const row = state.voices.filter(function (item) { return item.id === id; })[0];
      await deleteDoc(doc(bridge.db, 'radioVoices', id));
      if (row) await deleteAudioQuietly(row.audioUrl);
      window.toast('Recorded voice deleted.');
      await loadVoices();
    } catch (error) { window.toast(error.message || 'The voice could not be deleted.', 'error'); }
  };

  async function loadPlaylists() {
    const body = $id('radioAdminPlaylists');
    if (!body) return;
    const snapshot = await getDocs(collection(bridge.db, 'radioPlaylists'));
    state.playlists = snapshot.docs.map(function (entry) { return Object.assign({ id: entry.id }, entry.data()); })
      .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
    body.innerHTML = state.playlists.length ? state.playlists.map(function (row) {
      return '<tr><td><strong>' + esc(row.name) + '</strong><br><span style="font-size:.7rem;color:var(--text-sub);">' + esc(row.description || '') + '</span></td>' +
        '<td>' + esc(GENRES[row.genre] || 'Mixed') + '</td><td>' + esc(String((row.trackIds || []).length)) + '</td>' +
        '<td>' + (row.isDefault ? badge('Default', 'success') : '—') + '</td>' +
        '<td><div style="display:flex;gap:4px;flex-wrap:wrap;"><button class="btn btn-outline btn-sm" type="button" onclick="radioAdminEditPlaylist(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-square-pen"></i> Edit</button>' +
        '<button class="btn btn-danger btn-sm" type="button" onclick="radioAdminDeletePlaylist(\'' + esc(row.id) + '\')" aria-label="Delete playlist"><i class="pd-i pd-i-trash"></i></button></div></td></tr>';
    }).join('') : '<tr><td colspan="5">No playlists yet. Create one from approved tracks.</td></tr>';
    fillPlaylistSelects();
    renderPlaylistTracks();
  }

  function fillPlaylistSelects() {
    const options = state.playlists.map(function (playlist) {
      return '<option value="' + esc(playlist.id) + '">' + esc(playlist.name) + '</option>';
    }).join('');
    const slot = $id('radioSlotPlaylist');
    if (slot) slot.innerHTML = '<option value="">Default playlist</option>' + options;
    const settings = $id('radioSettingPlaylist');
    if (settings) {
      const current = settings.value;
      settings.innerHTML = '<option value="">Choose a playlist</option>' + options;
      if (current) settings.value = current;
    }
  }

  window.radioAdminResetPlaylist = function () {
    const form = $id('radioPlaylistForm');
    if (form) form.reset();
    $id('radioPlaylistId').value = '';
    renderPlaylistTracks();
  };

  window.radioAdminEditPlaylist = function (id) {
    const row = state.playlists.filter(function (item) { return item.id === id; })[0];
    if (!row) return;
    $id('radioPlaylistId').value = row.id;
    $id('radioPlaylistName').value = row.name || '';
    $id('radioPlaylistGenre').value = row.genre || '';
    $id('radioPlaylistDescription').value = row.description || '';
    $id('radioPlaylistDefault').checked = row.isDefault === true;
    renderPlaylistTracks(row.trackIds || []);
  };

  window.radioAdminSavePlaylist = async function (event) {
    if (event && event.preventDefault) event.preventDefault();
    const id = String($id('radioPlaylistId').value || '').trim();
    const name = String($id('radioPlaylistName').value || '').trim();
    const genre = String($id('radioPlaylistGenre').value || '');
    const description = String($id('radioPlaylistDescription').value || '').trim();
    const isDefault = $id('radioPlaylistDefault').checked;
    const trackIds = Array.from(document.querySelectorAll('#radioPlaylistTracks input[type="checkbox"]:checked')).map(function (input) { return input.value; });
    if (!name) return window.toast('Give the playlist a name.', 'error');
    if (!trackIds.length) return window.toast('Choose at least one approved track. Unapproved audio never enters automation.', 'error');
    if (window.showLoading) window.showLoading('Saving the playlist…');
    try {
      const ref = id ? doc(bridge.db, 'radioPlaylists', id) : doc(collection(bridge.db, 'radioPlaylists'));
      if (isDefault) {
        const batch = writeBatch(bridge.db);
        state.playlists.forEach(function (playlist) {
          if (playlist.id !== id && playlist.isDefault) batch.update(doc(bridge.db, 'radioPlaylists', playlist.id), { isDefault: false, updatedAt: serverTimestamp() });
        });
        await batch.commit();
      }
      const data = { name: name.slice(0, 120), genre: genre, description: description.slice(0, 400), trackIds: trackIds, isDefault: isDefault, approved: true, updatedBy: who(), updatedAt: serverTimestamp() };
      if (!id) data.createdAt = serverTimestamp();
      await setDoc(ref, data, { merge: true });
      if (window.hideLoading) window.hideLoading();
      window.toast('Playlist saved. The automation engine picks it up on the next transition.');
      window.radioAdminResetPlaylist();
      await loadPlaylists();
    } catch (error) {
      if (window.hideLoading) window.hideLoading();
      window.toast(error.message || 'The playlist could not be saved.', 'error');
    }
  };

  window.radioAdminDeletePlaylist = async function (id) {
    if (!window.confirm('Delete this playlist? The timetable may fall back to the default playlist.')) return;
    try {
      await deleteDoc(doc(bridge.db, 'radioPlaylists', id));
      window.toast('Playlist deleted.');
      await loadPlaylists();
    } catch (error) { window.toast(error.message || 'The playlist could not be deleted.', 'error'); }
  };

  async function loadSchedule() {
    const body = $id('radioAdminSchedule');
    if (!body) return;
    const snapshot = await getDocs(collection(bridge.db, 'radioSchedule'));
    state.schedule = snapshot.docs.map(function (entry) { return Object.assign({ id: entry.id }, entry.data()); })
      .sort(function (a, b) { return number(a.start) - number(b.start); });
    const voiceName = {}, playlistName = {};
    state.voices.forEach(function (voice) { voiceName[voice.id] = voice.voiceLabel || voice.name; });
    state.playlists.forEach(function (playlist) { playlistName[playlist.id] = playlist.name; });
    body.innerHTML = state.schedule.length ? state.schedule.map(function (row) {
      return '<tr><td style="white-space:nowrap;">' + esc(minutesLabel(row.start)) + '–' + esc(minutesLabel(row.end)) + '</td>' +
        '<td><strong>' + esc(row.title) + '</strong></td><td>' + esc(row.type || 'music') + '</td>' +
        '<td>' + esc(playlistName[row.playlistId] || 'Default') + '</td>' +
        '<td>' + esc(voiceName[row.voiceId] || 'No recorded intro') + '</td>' +
        '<td>' + esc(Array.isArray(row.days) ? (row.days.length === 7 ? 'Daily' : row.days.map(function (d) { return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]; }).join(', ')) : 'Daily') + '</td>' +
        '<td><div style="display:flex;gap:4px;flex-wrap:wrap;"><button class="btn btn-outline btn-sm" type="button" onclick="radioAdminEditSlot(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-square-pen"></i> Edit</button>' +
        '<button class="btn btn-danger btn-sm" type="button" onclick="radioAdminDeleteSlot(\'' + esc(row.id) + '\')" aria-label="Delete timetable slot"><i class="pd-i pd-i-trash"></i></button></div></td></tr>';
    }).join('') : '<tr><td colspan="7">No custom timetable. The published nine-programme schedule is used until a slot is added.</td></tr>';
    const voiceSelect = $id('radioSlotVoice');
    if (voiceSelect) {
      voiceSelect.innerHTML = '<option value="">No recorded intro</option>' + state.voices.filter(function (v) { return v.approved === true; }).map(function (v) {
        return '<option value="' + esc(v.id) + '">' + esc((v.voiceLabel || v.name) + ' · ' + (v.gender || 'voice')) + '</option>';
      }).join('');
    }
    fillPlaylistSelects();
  }

  function slotDays(value) {
    if (value === 'weekdays') return [1, 2, 3, 4, 5];
    if (value === 'weekend') return [0, 6];
    return [0, 1, 2, 3, 4, 5, 6];
  }

  window.radioAdminResetSlot = function () {
    const form = $id('radioScheduleForm');
    if (form) form.reset();
    $id('radioSlotId').value = '';
    $id('radioSlotEnabled').checked = true;
  };

  window.radioAdminEditSlot = function (id) {
    const row = state.schedule.filter(function (item) { return item.id === id; })[0];
    if (!row) return;
    $id('radioSlotId').value = row.id;
    $id('radioSlotStart').value = minutesLabel(row.start);
    $id('radioSlotEnd').value = minutesLabel(row.end);
    $id('radioSlotTitle').value = row.title || '';
    $id('radioSlotType').value = row.type || 'music';
    $id('radioSlotPlaylist').value = row.playlistId || '';
    $id('radioSlotVoice').value = row.voiceId || '';
    $id('radioSlotDays').value = Array.isArray(row.days) && row.days.length === 7 ? 'daily' : (Array.isArray(row.days) && row.days.indexOf(0) !== -1 && row.days.length === 2 ? 'weekend' : 'weekdays');
    $id('radioSlotEnabled').checked = row.enabled !== false;
  };

  window.radioAdminSaveSlot = async function (event) {
    if (event && event.preventDefault) event.preventDefault();
    const id = String($id('radioSlotId').value || '').trim();
    const start = timeToMinutes($id('radioSlotStart').value);
    const end = timeToMinutes($id('radioSlotEnd').value);
    const title = String($id('radioSlotTitle').value || '').trim();
    const type = String($id('radioSlotType').value || 'music');
    const playlistId = String($id('radioSlotPlaylist').value || '');
    const voiceId = String($id('radioSlotVoice').value || '');
    const days = slotDays(String($id('radioSlotDays').value || 'daily'));
    const enabled = $id('radioSlotEnabled').checked;
    if (start < 0 || end < 0) return window.toast('Choose valid start and end times.', 'error');
    if (end <= start) return window.toast('The end time must be after the start time. Split a programme that crosses midnight into two slots.', 'error');
    if (!title) return window.toast('Give the programme a title.', 'error');
    const overlaps = state.schedule.filter(function (row) { return row.id !== id && row.enabled !== false; }).some(function (row) {
      const sharesDay = (row.days || [0,1,2,3,4,5,6]).some(function (day) { return days.indexOf(day) !== -1; });
      return sharesDay && start < number(row.end) && end > number(row.start);
    });
    if (overlaps) return window.toast('That slot overlaps an existing programme on the same day. Adjust the times first.', 'error');
    if (window.showLoading) window.showLoading('Saving the timetable…');
    try {
      const ref = id ? doc(bridge.db, 'radioSchedule', id) : doc(collection(bridge.db, 'radioSchedule'));
      const data = { start: start, end: end, title: title.slice(0, 120), type: type, playlistId: playlistId, voiceId: voiceId, days: days, enabled: enabled, updatedBy: who(), updatedAt: serverTimestamp() };
      if (!id) data.createdAt = serverTimestamp();
      await setDoc(ref, data, { merge: true });
      if (window.hideLoading) window.hideLoading();
      window.toast('Timetable slot saved. /radio uses Lusaka time.');
      window.radioAdminResetSlot();
      await loadSchedule();
    } catch (error) {
      if (window.hideLoading) window.hideLoading();
      window.toast(error.message || 'The timetable slot could not be saved.', 'error');
    }
  };

  window.radioAdminDeleteSlot = async function (id) {
    if (!window.confirm('Delete this timetable slot?')) return;
    try {
      await deleteDoc(doc(bridge.db, 'radioSchedule', id));
      window.toast('Timetable slot deleted.');
      await loadSchedule();
    } catch (error) { window.toast(error.message || 'The slot could not be deleted.', 'error'); }
  };

  async function loadSettings() {
    let row = null;
    try {
      const snap = await getDoc(doc(bridge.db, 'radioSettings', 'main'));
      row = snap.exists() ? snap.data() : null;
    } catch (error) { /* defaults below */ }
    state.settings = row || {};
    const automation = $id('radioSettingAutomation');
    if (automation) automation.checked = row ? row.automationEnabled !== false : true;
    const playlist = $id('radioSettingPlaylist');
    if (playlist) playlist.value = (row && row.defaultPlaylistId) || '';
    const fallback = $id('radioSettingFallback');
    if (fallback) fallback.value = (row && row.fallbackUrl) || '';
    const stream = $id('radioSettingStream');
    if (stream) stream.value = (row && row.streamUrl) || '';
    fillPlaylistSelects();
    if (playlist) playlist.value = (row && row.defaultPlaylistId) || '';
  }

  window.radioAdminSaveSettings = async function (event) {
    if (event && event.preventDefault) event.preventDefault();
    const automationEnabled = $id('radioSettingAutomation').checked;
    const defaultPlaylistId = String($id('radioSettingPlaylist').value || '');
    let fallbackUrl = String($id('radioSettingFallback').value || '').trim();
    const streamUrl = String($id('radioSettingStream').value || '').trim();
    if (STREAMING_HOSTS.test(fallbackUrl) || STREAMING_HOSTS.test(streamUrl)) {
      return window.toast('Use a licensed stream or a permissioned recording, not a YouTube/Spotify page.', 'error');
    }
    if (window.showLoading) window.showLoading('Saving automation settings…');
    try {
      const fallbackFile = $id('radioSettingFallbackFile').files && $id('radioSettingFallbackFile').files[0];
      if (fallbackFile) fallbackUrl = await uploadAudio(fallbackFile, 'fallback', $id('radioTrackUploadStatus'));
      await setDoc(doc(bridge.db, 'radioSettings', 'main'), {
        automationEnabled: automationEnabled, defaultPlaylistId: defaultPlaylistId,
        fallbackUrl: fallbackUrl.slice(0, 600), streamUrl: streamUrl.slice(0, 600),
        timezone: 'Africa/Lusaka', updatedBy: who(), updatedAt: serverTimestamp()
      }, { merge: true });
      // Keep the existing station grid in step with the public stream URL.
      if (window.PDApp && PDApp.store && streamUrl) {
        const stations = PDApp.store.get('radio', 'DEFAULT_RADIO') || [];
        if (stations.length) {
          stations[0].streamUrl = streamUrl;
          if (stations[0].tagline === 'A licensed stream has not been connected yet') stations[0].tagline = 'Licensed gospel radio';
          PDApp.store.set('radio', stations);
        }
      }
      if (window.hideLoading) window.hideLoading();
      window.toast('Automation settings saved.');
      await loadSettings();
      await window.loadRadioAdmin();
    } catch (error) {
      if (window.hideLoading) window.hideLoading();
      window.toast(error.message || 'The settings could not be saved.', 'error');
    }
  };

  window.loadRadioAdmin = async function () {
    if (!$id('view-radio')) return;
    try {
      const health = (await callRadio('radioAdminHealth')).data || {};
      renderHealth(health);
      renderRequests(health.requests || []);
    } catch (error) {
      console.error('Radio health failed:', error);
      const host = $id('radioAdminLiveStatus');
      if (host) host.innerHTML = '<span class="badge badge-danger">Health unavailable</span> ' + esc(error.message || 'The server could not be reached.');
      const body = $id('radioAdminRequests');
      if (body) body.innerHTML = '<tr><td colspan="6">Presenter requests could not be loaded: ' + esc(error.message || 'unknown error') + '</td></tr>';
    }
    await Promise.allSettled([loadTracks(), loadVoices()]);
    // Settings and the timetable read the voice/playlist labels, so those
    // collections are loaded before the forms are populated.
    await loadPlaylists();
    await loadSchedule();
    await loadSettings();
  };

  // Fill programme choices as soon as the console opens, even before the radio
  // view is visited, so selecting a voice from the timetable is never an empty
  // dropdown.
  fillProgrammeSelects();

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
