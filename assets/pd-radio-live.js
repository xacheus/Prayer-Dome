/*!
 * Prayer Dome Radio — automation, LIVE takeover and Presenter Studio
 * ---------------------------------------------------------------------------
 * One listener player, one station. This module never creates a second audio
 * element: automation, announcements, fallback audio and a presenter's WebRTC
 * MediaStream all use PDApp.radio's shared <audio> element.
 *
 * Security model:
 *   • Only radioPresenterStart (Admin SDK) can create a session or LIVE state.
 *   • Only an administrator can approve a request (radioPresenterDecision).
 *   • A browser cannot write radioLiveState or radioPresenterSessions.
 *   • WebRTC signalling is limited by Firestore rules to one offer per viewer
 *     and an answer written only by the approved presenter.
 *   • The station URL and any provider secret stay in server/admin config.
 */
(function (global) {
  'use strict';

  var CONFIG = {
    apiKey: 'AIzaSyCxvql0r_aeerphxTA0UUedRppdBxGf7wo',
    authDomain: 'prayer-dome.firebaseapp.com',
    projectId: 'prayer-dome',
    storageBucket: 'prayer-dome.firebasestorage.app',
    messagingSenderId: '198295153196',
    appId: '1:198295153196:web:1222b31948d7974ba3bf89'
  };
  var STUN = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  var GENRE_LABEL = {
    'gospel-worship': 'Gospel worship', contemporary: 'Contemporary gospel',
    african: 'African gospel', international: 'International gospel',
    traditional: 'Traditional gospel', praise: 'Praise',
    'instrumental-worship': 'Instrumental worship', 'other-christian': 'Other approved Christian music'
  };
  var state = {
    fb: null, ready: false, loading: null, tracks: [], voices: [], playlists: [],
    schedule: [], settings: {}, slotKey: '', slot: null, currentTrack: null,
    currentVoice: null, wantsPlay: false, playing: false, mode: 'idle',
    live: null, liveSessionId: '', livePc: null, liveUnsubs: [], joiningLive: false,
    liveFailed: false, liveFallbackMode: false, queue: [], recentTracks: [], recentVoices: [], transitioning: false,
    cancelPlay: null, errorCount: 0, lastNowKey: ''
  };
  var presenter = {
    user: null, status: null, active: null, stream: null, pcs: [], unsubs: [],
    heartbeat: null, expiry: null, starting: false, bound: false
  };
  var icePromise = null;
  var iceExpiry = 0;

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function stamp(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (value.seconds) return Number(value.seconds) * 1000;
    var n = new Date(value).getTime();
    return Number.isNaN(n) ? 0 : n;
  }
  function lusaka(value) {
    var ms = stamp(value);
    if (!ms) return '—';
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lusaka', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
    } catch (error) { return new Date(ms).toLocaleString(); }
  }
  function lusakaClock() {
    if (global.PD_CONTENT && typeof global.PD_CONTENT.radioClock === 'function') return global.PD_CONTENT.radioClock(new Date());
    var d = new Date();
    return { weekday: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes(), label: d.toTimeString().slice(0, 5) };
  }
  function setText(id, text) { var node = $(id); if (node) node.textContent = text; }
  function setStatus(text, kind) {
    var node = $('radioStationStatus');
    if (!node) return;
    node.classList.toggle('is-playing', kind === 'playing');
    node.classList.toggle('is-error', kind === 'error');
    node.innerHTML = '<span class="dot" aria-hidden="true"></span><span>' + esc(text) + '</span>';
  }
  function setNote(text, isError) {
    var node = $('radioStatusNote');
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('is-error', !!isError);
  }
  function nowPlaying(title, meta, live) {
    setText('radioNowTitle', title || 'Prayer Dome Radio');
    setText('radioNowMeta', meta || '');
    var badge = $('radioLiveBadge');
    if (badge) badge.hidden = !(live || (state.live && state.liveFallbackMode));
    document.body.classList.toggle('pd-radio-live', !!(live || (state.live && state.liveFallbackMode)));
  }
  function updateToggle() {
    var toggle = $('radioMainToggle');
    if (!toggle) return;
    if (state.live) {
      toggle.disabled = false;
      toggle.innerHTML = '<i class="pd-i pd-i-pause" aria-hidden="true"></i> <span>' + (state.playing ? 'Pause live' : 'Join live broadcast') + '</span>';
      return;
    }
    if (!available()) {
      toggle.disabled = true;
      toggle.innerHTML = '<i class="pd-i pd-i-play" aria-hidden="true"></i> <span>No approved audio yet</span>';
      return;
    }
    toggle.disabled = false;
    toggle.innerHTML = '<i class="pd-i ' + (state.playing ? 'pd-i-pause' : 'pd-i-play') + '" aria-hidden="true"></i> <span>' + (state.playing ? 'Pause radio' : 'Listen to automation') + '</span>';
  }
  function available() {
    if (state.settings.automationEnabled === false) return !!state.live;
    return !!(state.live || state.tracks.length || state.settings.fallbackUrl || state.settings.streamUrl);
  }
  function ownsAudio() {
    return state.mode === 'live' || (state.mode === 'automation' && (state.playing || state.wantsPlay));
  }

  /* ----------------------------------------------------------- Firebase --- */
  async function loadFirebase() {
    if (state.fb) return state.fb;
    var appMod = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js');
    var fs = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    var authMod = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
    var fnMod = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js');
    var apps = typeof appMod.getApps === 'function' ? appMod.getApps() : [];
    var app = apps.length ? apps[0] : appMod.initializeApp(CONFIG);
    var db = fs.getFirestore(app);
    var auth = authMod.getAuth(app);
    state.fb = {
      app: app, db: db, auth: auth, fs: fs, authMod: authMod,
      functions: fnMod.getFunctions(app), httpsCallable: fnMod.httpsCallable,
      collection: fs.collection, doc: fs.doc, getDoc: fs.getDoc, getDocs: fs.getDocs,
      query: fs.query, where: fs.where, limit: fs.limit, setDoc: fs.setDoc,
      onSnapshot: fs.onSnapshot, serverTimestamp: fs.serverTimestamp
    };
    return state.fb;
  }

  async function loadLibrary() {
    if (state.loading) return state.loading;
    state.loading = (async function () {
      var fb = await loadFirebase();
      var fs = fb.fs;
      var reads = await Promise.all([
        fb.getDocs(fb.query(fb.collection(fb.db, 'worshipSongs'), fb.limit(500))).catch(function () { return { docs: [] }; }),
        fb.getDocs(fb.query(fb.collection(fb.db, 'radioVoices'), fb.limit(500))).catch(function () { return { docs: [] }; }),
        fb.getDocs(fb.query(fb.collection(fb.db, 'radioPlaylists'), fb.limit(200))).catch(function () { return { docs: [] }; }),
        fb.getDocs(fb.query(fb.collection(fb.db, 'radioSchedule'), fb.limit(200))).catch(function () { return { docs: [] }; }),
        fb.getDoc(fb.doc(fb.db, 'radioSettings', 'main')).catch(function () { return { exists: function () { return false; } }; })
      ]);
      state.tracks = reads[0].docs.map(function (entry) { return Object.assign({ id: entry.id }, entry.data()); })
        .filter(function (row) {
          // The existing worshipSongs record is the single library. Radio only
          // automates a row that an administrator explicitly approved, and the
          // legacy rights field is accepted only when it names a real basis.
          if (!row.audioUrl || row.approved !== true) return false;
          if (row.licenseStatus) return true;
          return /^(licensed|public domain|original|written permission)/i.test(String(row.rights || ''));
        });
      state.voices = reads[1].docs.map(function (entry) { return Object.assign({ id: entry.id }, entry.data()); })
        .filter(function (row) { return row.approved === true && row.audioUrl; });
      state.playlists = reads[2].docs.map(function (entry) { return Object.assign({ id: entry.id }, entry.data()); })
        .filter(function (row) { return row.approved !== false; });
      state.schedule = reads[3].docs.map(function (entry) { return Object.assign({ id: entry.id }, entry.data()); })
        .filter(function (row) { return row.enabled !== false && Number(row.end) > Number(row.start); })
        .sort(function (a, b) { return Number(a.start) - Number(b.start); });
      state.settings = reads[4].exists && reads[4].exists() ? (reads[4].data() || {}) : {};
      global.PD_RADIO_TIMETABLE = state.schedule;
      if (typeof global.PD_RADIO_REFRESH_SCHEDULE === 'function') global.PD_RADIO_REFRESH_SCHEDULE();
      try { state.recentTracks = JSON.parse(localStorage.getItem('pd_radio_recent_tracks') || '[]'); } catch (e) { state.recentTracks = []; }
      try { state.recentVoices = JSON.parse(localStorage.getItem('pd_radio_recent_voices') || '[]'); } catch (e) { state.recentVoices = []; }
      state.ready = true;
      updateReadyUI();
      return state;
    })().finally(function () { state.loading = null; });
    return state.loading;
  }

  function updateReadyUI() {
    updateToggle();
    if (state.live) return;
    if (state.settings.automationEnabled === false && !state.live) {
      setStatus('Automation paused by admin', 'idle');
      setNote('An administrator has paused station automation. A presenter may still be approved for a live session.', false);
      nowPlaying('Automation is paused', 'An administrator controls when automated gospel programming resumes.');
      return;
    }
    if (!available()) {
      setStatus('No approved audio yet', 'idle');
      setNote('An administrator must approve licensed gospel recordings and create a playlist before automation can play. Nothing is substituted or scraped.', true);
      nowPlaying('Automation is waiting for approved audio', 'No licensed track has been approved yet.');
      return;
    }
    var stationLabel = $('radioHeroStation');
    if (stationLabel && /No radio station is configured/i.test(stationLabel.textContent || '')) {
      stationLabel.textContent = 'Prayer Dome Radio · approved gospel automation';
    }
    setStatus(state.playing ? 'Playing automation' : 'Ready to listen', state.playing ? 'playing' : 'idle');
    if (!state.playing) {
      setNote('Press play to join the continuous gospel broadcast. Approval and scheduling are managed by the ministry.', false);
      nowPlaying('Automation is ready', state.tracks.length + ' approved track' + (state.tracks.length === 1 ? '' : 's') + ' available.');
    }
  }

  /* --------------------------------------------------------- Schedule ----- */
  function slotForNow() {
    var clock = lusakaClock();
    var custom = state.schedule;
    if (custom.length) {
      for (var i = 0; i < custom.length; i++) {
        var slot = custom[i];
        var days = Array.isArray(slot.days) && slot.days.length ? slot.days : [0, 1, 2, 3, 4, 5, 6];
        if (days.indexOf(clock.weekday) === -1) continue;
        if (clock.minutes < Number(slot.start) || clock.minutes >= Number(slot.end)) continue;
        return Object.assign({}, slot, {
          programmeId: slot.programmeId || slot.id,
          type: slot.type || 'music',
          title: slot.title || 'Prayer Dome Radio',
          start: Number(slot.start), end: Number(slot.end), days: days
        });
      }
      return { id: 'automation-gap', programmeId: '', title: 'Prayer Dome Radio', type: 'music', start: clock.minutes, end: clock.minutes + 1, days: [clock.weekday], gap: true };
    }
    var fallback = global.PD_CONTENT && typeof global.PD_CONTENT.currentRadioProgramme === 'function'
      ? global.PD_CONTENT.currentRadioProgramme(new Date()).programme : null;
    if (fallback) {
      return {
        id: 'default-' + fallback.id, programmeId: fallback.id, title: fallback.title,
        type: 'music', start: fallback.start, end: fallback.end, days: fallback.days || []
      };
    }
    return { id: 'default-automation', programmeId: '', title: 'Prayer Dome Radio', type: 'music' };
  }

  function playlistFor(slot) {
    var playlist = null;
    if (slot && slot.playlistId) playlist = state.playlists.filter(function (row) { return row.id === slot.playlistId; })[0] || null;
    if (!playlist && state.settings.defaultPlaylistId) playlist = state.playlists.filter(function (row) { return row.id === state.settings.defaultPlaylistId; })[0] || null;
    if (!playlist) playlist = state.playlists.filter(function (row) { return row.isDefault === true; })[0] || null;
    if (!playlist) playlist = state.playlists.filter(function (row) { return Array.isArray(row.trackIds) && row.trackIds.length; })[0] || null;
    return playlist;
  }

  function tracksForSlot(slot) {
    var playlist = playlistFor(slot);
    var chosen = [];
    if (playlist && Array.isArray(playlist.trackIds) && playlist.trackIds.length) {
      var byId = {};
      state.tracks.forEach(function (track) { byId[track.id] = track; });
      chosen = playlist.trackIds.map(function (id) { return byId[id]; }).filter(Boolean);
    }
    if (!chosen.length) {
      chosen = state.tracks.filter(function (track) {
        return !playlist || !playlist.genre || track.genre === playlist.genre;
      });
    }
    if (!chosen.length) chosen = state.tracks.slice();
    return chosen;
  }

  function remember(key, id, max) {
    var list = key === 'track' ? state.recentTracks : state.recentVoices;
    list = list.filter(function (item) { return item !== id; });
    list.unshift(id);
    list = list.slice(0, max || 8);
    if (key === 'track') state.recentTracks = list; else state.recentVoices = list;
    try { localStorage.setItem(key === 'track' ? 'pd_radio_recent_tracks' : 'pd_radio_recent_voices', JSON.stringify(list)); } catch (e) {}
  }

  function buildQueue(slot) {
    var tracks = tracksForSlot(slot);
    if (!tracks.length) return [];
    var recent = state.recentTracks;
    // Least-recently-played first, then shuffle, so a small library still
    // rotates instead of repeating the same opening track every session.
    var fresh = tracks.filter(function (track) { return recent.indexOf(track.id) === -1; });
    var old = tracks.filter(function (track) { return recent.indexOf(track.id) !== -1; });
    fresh.sort(function () { return Math.random() - 0.5; });
    old.sort(function (a, b) { return recent.indexOf(a.id) - recent.indexOf(b.id); });
    return fresh.concat(old);
  }

  /* --------------------------------------------------------- Playback ----- */
  function audioElement() {
    return global.PDApp && global.PDApp.radio ? global.PDApp.radio.ensureAudio() : null;
  }

  function cancelCurrentPlay() {
    if (state.cancelPlay) {
      var resolve = state.cancelPlay;
      state.cancelPlay = null;
      resolve({ cancelled: true });
    }
  }

  function playOne(url, name, meta) {
    return new Promise(function (resolve, reject) {
      if (!url) return reject(new Error('No audio URL'));
      if (!state.wantsPlay || (state.live && !state.liveFallbackMode)) return resolve({ cancelled: true });
      var audio = audioElement();
      if (!audio) return reject(new Error('The listener player is unavailable.'));
      var settled = false;
      var cleanup = function () {
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        state.cancelPlay = null;
      };
      var onEnded = function () { if (settled) return; settled = true; cleanup(); resolve({ ended: true }); };
      var onError = function () { if (settled) return; settled = true; cleanup(); reject(new Error('This recording could not be played.')); };
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      state.cancelPlay = function (value) { if (settled) return; settled = true; cleanup(); resolve(value || { cancelled: true }); };
      global.PDApp.radio.playUrl(url, name, meta).catch(function (error) {
        if (settled) return; settled = true; cleanup(); reject(error);
      });
    });
  }

  function reportNowPlaying(kind, row, slot) {
    var fb = state.fb;
    if (!fb) return;
    var key = kind + ':' + (row && (row.id || row.audioUrl)) + ':' + (slot && slot.id);
    if (key === state.lastNowKey) return;
    state.lastNowKey = key;
    try {
      fb.setDoc(fb.doc(fb.db, 'radioNowPlaying', 'current'), {
        source: kind,
        trackId: (row && row.id) || '',
        title: (row && (row.title || row.voiceLabel || row.name)) || 'Prayer Dome Radio',
        artist: (row && (row.artist || row.name)) || 'Prayer Dome',
        album: (row && row.album) || '',
        genre: (row && row.genre) || '',
        licence: (row && row.licenseStatus) || '',
        programmeTitle: (slot && slot.title) || '',
        programmeId: (slot && slot.programmeId) || '',
        startedAt: fb.serverTimestamp(),
        updatedAt: fb.serverTimestamp()
      }, { merge: true }).catch(function () { /* public now-playing is best effort */ });
    } catch (e) { /* never interrupt audio for metadata */ }
  }

  async function playTrack(track, slot) {
    state.currentTrack = track;
    state.mode = 'automation';
    state.playing = true;
    remember('track', track.id, 12);
    state.errorCount = 0;
    setStatus('Playing automation', 'playing');
    setNote('Continuous approved gospel automation. ' + (slot && slot.title ? 'Scheduled programme: ' + slot.title + '.' : ''), false);
    nowPlaying(track.title || 'Prayer Dome Radio', [track.artist, track.album, GENRE_LABEL[track.genre] || track.genre].filter(Boolean).join(' · '), false);
    setText('radioProgramme', (slot && slot.title) || 'Prayer Dome Radio');
    reportNowPlaying('automation', track, slot);
    updateToggle();
    try {
      if ('mediaSession' in navigator && global.MediaMetadata) {
        navigator.mediaSession.metadata = new global.MediaMetadata({
          title: track.title || 'Prayer Dome Radio', artist: track.artist || 'Prayer Dome',
          album: track.album || 'Gospel Radio', artwork: [{ src: '/assets/logo.png', sizes: '512x512', type: 'image/png' }]
        });
      }
    } catch (e) {}
    await playOne(track.audioUrl, track.title || 'Prayer Dome Radio', {
      title: track.title, artist: track.artist, album: track.album, genre: track.genre, licence: track.licenseStatus
    });
  }

  function chooseVoice(slot, kind) {
    if (!state.voices.length) return null;
    var direct = slot && slot.voiceId ? state.voices.filter(function (voice) { return voice.id === slot.voiceId; })[0] : null;
    if (direct) return direct;
    var candidates = state.voices.filter(function (voice) {
      if (voice.programmeId && slot && voice.programmeId !== slot.programmeId && voice.programmeId !== slot.id) return false;
      return true;
    });
    var exactKind = candidates.filter(function (voice) { return !voice.kind || voice.kind === kind; });
    if (!exactKind.length) return null;
    candidates = exactKind;
    var notRecent = candidates.filter(function (voice) { return state.recentVoices.indexOf(voice.id) === -1; });
    return (notRecent.length ? notRecent : candidates)[0] || null;
  }

  async function playAnnouncement(voice, slot, kind) {
    if (!voice || !voice.audioUrl) return false;
    state.currentVoice = voice;
    state.mode = 'automation';
    state.playing = true;
    remember('voice', voice.id, 12);
    nowPlaying((kind === 'station-id' ? 'Station identification' : (slot && slot.title) || 'Prayer Dome Radio'),
      (voice.voiceLabel || voice.name) + ' · recorded human announcement', false);
    setStatus('Announcement', 'playing');
    reportNowPlaying('announcement', voice, slot);
    try {
      await playOne(voice.audioUrl, voice.voiceLabel || voice.name || 'Prayer Dome Radio', {
        title: voice.voiceLabel || voice.name, artist: voice.name, album: 'Recorded announcement'
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  async function playFallback(slot, reason) {
    var url = state.settings.fallbackUrl || state.settings.streamUrl;
    if (!url) {
      state.playing = false;
      state.mode = 'idle';
      setStatus('Automation unavailable', 'error');
      setNote((reason || 'No approved track could be played.') + ' Add an approved track or a licensed fallback in Radio Studio.', true);
      nowPlaying('Automation needs audio', 'No approved track or fallback is available.');
      updateToggle();
      return false;
    }
    state.mode = 'automation';
    state.playing = true;
    state.currentTrack = null;
    setStatus('Fallback audio', 'playing');
    setNote('The scheduled playlist is unavailable. A licensed fallback is playing instead.', false);
    nowPlaying('Fallback audio', 'Licensed fallback for Prayer Dome Radio', false);
    reportNowPlaying('fallback', { title: 'Fallback audio', artist: 'Prayer Dome Radio' }, slot);
    updateToggle();
    try {
      await playOne(url, 'Prayer Dome Radio — fallback', { title: 'Prayer Dome Radio', artist: 'Prayer Dome' });
      if (state.wantsPlay && !state.live) return playFallback(slot, reason);
      return true;
    } catch (error) {
      state.playing = false;
      setStatus('Fallback unavailable', 'error');
      setNote('The licensed fallback could not be played. Check the fallback URL in Radio Studio.', true);
      updateToggle();
      return false;
    }
  }

  async function playNext(force) {
    if (state.transitioning) return;
    if (!state.wantsPlay) return;
    if (state.live && !state.liveFallbackMode) return;
    if (state.settings.automationEnabled === false && !state.liveFallbackMode) return;
    state.transitioning = true;
    try {
      var slot = slotForNow();
      var changed = !state.slot || state.slot.id !== slot.id;
      state.slot = slot;
      state.slotKey = slot.id;
      if (changed && !force) {
        var intro = chooseVoice(slot, 'programme-intro');
        if (intro) await playAnnouncement(intro, slot, 'programme-intro');
        if (!state.wantsPlay || state.live) return;
      }
      if (!state.queue.length || force) state.queue = buildQueue(slot);
      var track = state.queue.shift();
      if (!track) {
        await playFallback(slot, 'No approved gospel track is available for this programme.');
        return;
      }
      await playTrack(track, slot);
      if (!state.wantsPlay || state.live) return;
      // A station identification is optional and only plays when a genuine
      // human recording exists. It is never synthesised.
      if (state.currentTrack && Math.random() < 0.18) {
        var stationVoice = chooseVoice(slot, 'station-id');
        if (stationVoice) await playAnnouncement(stationVoice, slot, 'station-id');
      }
      state.transitioning = false;
      if (state.wantsPlay && !state.live) playNext(false);
      return;
    } catch (error) {
      state.errorCount += 1;
      console.warn('Radio playback error:', error && error.message);
      if (!state.wantsPlay || state.live) return;
      if (state.errorCount >= 2) {
        state.errorCount = 0;
        await playFallback(state.slot || slotForNow(), 'Two approved tracks could not be played.');
        return;
      }
      state.transitioning = false;
      setTimeout(function () { if (state.wantsPlay && !state.live) playNext(false); }, 1200);
      return;
    } finally {
      state.transitioning = false;
    }
  }

  function startPlayback() {
    if (state.live && !state.liveFallbackMode) { joinLive(state.live); return; }
    if (state.settings.automationEnabled === false) {
      setStatus('Automation paused by admin', 'idle');
      setNote('An administrator has paused station automation.', false);
      return;
    }
    state.wantsPlay = true;
    state.mode = state.mode === 'idle' ? 'automation' : state.mode;
    if (!state.ready) {
      loadLibrary().then(function () { if (state.wantsPlay) playNext(true); }).catch(showLoadError);
      return;
    }
    if (!available()) {
      updateReadyUI();
      return;
    }
    playNext(true);
  }

  function stopPlayback() {
    state.wantsPlay = false;
    state.playing = false;
    cancelCurrentPlay();
    if (state.mode === 'live') { closeLivePeer(); state.mode = 'idle'; }
    else state.mode = 'idle';
    if (global.PDApp && global.PDApp.radio) global.PDApp.radio.stop();
    state.queue = [];
    state.slot = null;
    updateToggle();
    if (!state.live) {
      setStatus('Paused', 'idle');
      setNote('Playback is paused. The station automation continues for other listeners.', false);
    }
  }

  function togglePlayback() {
    if (state.playing || state.wantsPlay) stopPlayback();
    else startPlayback();
  }

  /* ------------------------------------------------------------- LIVE ----- */
  async function getIceServers() {
    if (icePromise && Date.now() < iceExpiry) return icePromise;
    iceExpiry = Date.now() + 60 * 1000;
    icePromise = fetch('/api/live-ice', { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var list = data && Array.isArray(data.iceServers) ? data.iceServers : [];
        var ttl = Number(data && data.expiresInSeconds);
        if (isFinite(ttl) && ttl > 60) iceExpiry = Date.now() + (ttl - 60) * 1000;
        return list.length ? list : STUN;
      })
      .catch(function () { iceExpiry = 0; return STUN; });
    return icePromise;
  }

  function waitForIce(pc, ms) {
    if (!pc || pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () {
        if (done) return; done = true;
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      var check = function () { if (pc.iceGatheringState === 'complete') finish(); };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(finish, ms || 3000);
    });
  }

  function closeLivePeer() {
    state.liveUnsubs.forEach(function (unsub) { try { unsub(); } catch (e) {} });
    state.liveUnsubs = [];
    if (state.livePc) {
      try { state.livePc.close(); } catch (e) {}
      state.livePc = null;
    }
    state.joiningLive = false;
  }

  function leaveLive(resume) {
    var wasLiveAudio = state.mode === 'live' && !state.liveFallbackMode;
    closeLivePeer();
    state.live = null;
    state.liveSessionId = '';
    state.liveFallbackMode = false;
    state.transitioning = false;
    if (state.mode === 'live') state.mode = state.wantsPlay ? 'automation' : 'idle';
    var badge = $('radioLiveBadge');
    if (badge) badge.hidden = true;
    document.body.classList.remove('pd-radio-live');
    if (resume && state.wantsPlay && (wasLiveAudio || !state.playing)) {
      state.slot = null;
      state.queue = [];
      state.playing = false;
      playNext(true);
    }
  }

  async function joinLive(live) {
    if (!live || !live.sessionId) return;
    if (state.joiningLive || (state.livePc && state.liveSessionId === live.sessionId)) return;
    if (!state.wantsPlay) { state.live = live; updateToggle(); return; }
    closeLivePeer();
    state.live = live;
    state.liveSessionId = live.sessionId;
    state.mode = 'live';
    state.joiningLive = true;
    state.playing = false;
    cancelCurrentPlay();
    setStatus('Connecting to presenter', 'idle');
    setNote('Joining the approved presenter on the same station player. Automation resumes automatically when the session ends.', false);
    setText('radioNowTitle', live.programmeTitle || 'Prayer Dome Radio');
    setText('radioNowMeta', (live.presenterName || 'Presenter') + ' · connecting live audio…');
    var badge = $('radioLiveBadge');
    if (badge) badge.hidden = false;
    document.body.classList.add('pd-radio-live');
    updateToggle();
    try {
      var fb = await loadFirebase();
      var ice = await getIceServers();
      var pc = new RTCPeerConnection({ iceServers: ice });
      state.livePc = pc;
      var remote = new MediaStream();
      pc.ontrack = function (event) {
        if (event.streams && event.streams[0]) remote = event.streams[0];
        else if (event.track) remote.addTrack(event.track);
        if (!state.wantsPlay) return;
        state.playing = true;
        state.mode = 'live';
        global.PDApp.radio.playStream(remote, (live.programmeTitle || 'Prayer Dome Radio') + ' — LIVE', {
          title: live.programmeTitle || 'Prayer Dome Radio — LIVE',
          artist: live.presenterName || 'Prayer Dome presenter',
          album: 'Presenter session'
        }).then(function () {
          setStatus('LIVE — presenter', 'playing');
          setNote('A presenter is live on the station you already have open. The same player returns to automation when the session ends.', false);
          nowPlaying(live.programmeTitle || 'Prayer Dome Radio', (live.presenterName || 'Presenter') + ' · live presenter audio', true);
          updateToggle();
        }).catch(function (error) {
          setNote('The live audio was received but the browser blocked playback. Press play once more.', true);
        });
      };
      pc.onconnectionstatechange = function () {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          if (!state.liveFailed) liveFallback(live, 'The presenter audio connection dropped.');
        }
      };
      pc.addTransceiver('audio', { direction: 'recvonly' });
      var offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc, 3000);
      var viewerId = 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
      var viewerRef = fb.doc(fb.db, 'radioLive', live.sessionId, 'viewers', viewerId);
      state.liveUnsubs.push(fb.onSnapshot(fb.doc(fb.db, 'radioLive', live.sessionId, 'viewers', viewerId), function (snap) {
        var row = snap.exists() ? snap.data() : null;
        if (row && row.answer && pc.signalingState !== 'stable' && !pc.remoteDescription) {
          pc.setRemoteDescription(new RTCSessionDescription(row.answer)).catch(function (error) {
            console.warn('Presenter answer failed:', error);
          });
        }
      }, function () {}));
      state.liveUnsubs.push(fb.onSnapshot(fb.collection(fb.db, 'radioLive', live.sessionId, 'viewers', viewerId, 'presenterCandidates'), function (snap) {
        snap.docChanges().forEach(function (change) {
          if (change.type === 'removed') return;
          var candidate = change.doc.data() && change.doc.data().candidate;
          if (candidate && pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(function () {});
        });
      }, function () {}));
      await fb.setDoc(viewerRef, {
        viewerId: viewerId,
        offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        userAgent: String(navigator.userAgent || '').slice(0, 200),
        createdAt: fb.serverTimestamp()
      });
      setTimeout(function () {
        if (state.mode === 'live' && !state.playing && state.liveSessionId === live.sessionId) {
          liveFallback(live, 'The presenter connection did not complete in time.');
        }
      }, 15000);
    } catch (error) {
      console.warn('Live join failed:', error && error.message);
      liveFallback(live, 'The live audio could not be reached.');
    }
  }

  function liveFallback(live, message) {
    if (state.liveFailed) return;
    state.liveFailed = true;
    state.liveFallbackMode = true;
    state.transitioning = false;
    setStatus('Presenter audio unavailable', 'error');
    setNote(message + ' Automation is resuming on the same player; you will not be left in silence.', true);
    closeLivePeer();
    state.mode = state.wantsPlay ? 'automation' : 'idle';
    state.playing = false;
    if (state.wantsPlay) {
      state.slot = null;
      state.queue = [];
      playNext(true);
    }
    if (presenter.user) {
      callPresenter('radioReportIssue', { message: 'Listener could not receive the presenter stream: ' + message, sessionId: live.sessionId }).catch(function () {});
    }
    setTimeout(function () {
      state.liveFailed = false;
      if (state.live && state.wantsPlay) {
        state.liveFallbackMode = false;
        joinLive(state.live);
      }
    }, 60000);
  }

  function subscribeLive() {
    var fb = state.fb;
    if (!fb) return;
    fb.onSnapshot(fb.doc(fb.db, 'radioLiveState', 'current'), function (snap) {
      var row = snap.exists() ? snap.data() : null;
      if (row && row.status === 'live' && row.sessionId) {
        var changed = state.liveSessionId !== row.sessionId;
        state.live = row;
        state.liveSessionId = row.sessionId;
        if (changed) { state.liveFailed = false; state.liveFallbackMode = false; }
        var badge = $('radioLiveBadge');
        if (badge) badge.hidden = false;
        document.body.classList.add('pd-radio-live');
        if (state.wantsPlay) joinLive(row);
        else {
          setStatus('LIVE now', 'playing');
          setText('radioNowTitle', row.programmeTitle || 'Prayer Dome Radio');
          setText('radioNowMeta', (row.presenterName || 'Presenter') + ' · press play to join the live broadcast');
          updateToggle();
        }
      } else if (state.live || state.mode === 'live') {
        leaveLive(state.wantsPlay);
        state.liveFailed = false;
        setStatus(state.wantsPlay ? 'Automation resumed' : 'Automation ready', state.wantsPlay ? 'playing' : 'idle');
        if (state.wantsPlay) setNote('The presenter session ended. The same player returned to scheduled automation automatically.', false);
        updateReadyUI();
      }
    }, function (error) {
      console.warn('Live state unavailable:', error && error.message);
    });
  }

  /* ---------------------------------------------------------- Presenter --- */
  function callPresenter(name, data) {
    if (!state.fb || !state.fb.auth.currentUser) return Promise.reject(new Error('Sign in first.'));
    var fn = state.fb.httpsCallable(state.fb.functions, name);
    return fn(data || {});
  }

  function setAccess(text, kind) {
    var node = $('presenterAccessState');
    if (!node) return;
    node.classList.toggle('is-playing', kind === 'playing');
    node.classList.toggle('is-error', kind === 'error');
    node.innerHTML = '<span class="dot" aria-hidden="true"></span><span>' + esc(text) + '</span>';
  }

  function requestRow(row) {
    var start = stamp(row.startAt);
    var approvedStart = stamp(row.accessStartsAt);
    var canStart = row.status === 'approved' && Date.now() >= approvedStart;
    var action = canStart
      ? '<button class="btn btn-primary btn-sm" type="button" onclick="PDRadioPresenter.start(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-mic"></i> Start</button>'
      : '';
    return '<div style="display:flex;gap:10px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border-color);">' +
      '<div><strong>' + esc(row.programmeTitle) + '</strong> <span class="badge badge-' + (row.status === 'approved' ? 'success' : row.status === 'pending' ? 'warning' : row.status === 'rejected' ? 'danger' : 'info') + '">' + esc(row.status) + '</span><br>' +
      '<span style="font-size:.72rem;color:var(--text-sub);">' + esc(lusaka(start)) + ' · ' + esc(String(row.durationMinutes || 0)) + ' minutes' +
      (row.adminNote ? '<br>Administrator: ' + esc(row.adminNote) : '') + '</span></div>' + action + '</div>';
  }

  function renderPresenter() {
    var signedOut = $('presenterSignedOut');
    var body = $('presenterStudioBody');
    if (!signedOut || !body) return;
    if (!presenter.user) {
      signedOut.hidden = false;
      body.hidden = true;
      setAccess('Sign in required', 'idle');
      return;
    }
    signedOut.hidden = true;
    body.hidden = false;
    var data = presenter.status || {};
    var requests = data.requests || [];
    var live = data.live;
    var active = (data.sessions || [])[0] || presenter.active || null;
    presenter.active = active;
    var approved = requests.filter(function (row) { return row.status === 'approved'; });
    var current = active || (live && live.sessionId ? { programmeTitle: live.programmeTitle, presenterName: live.presenterName } : null);
    var access = 'No live access';
    var kind = 'idle';
    if (active) { access = 'Your session is LIVE'; kind = 'playing'; }
    else if (live) { access = 'Another presenter is live'; kind = 'error'; }
    else if (approved.length) {
      var ready = approved.filter(function (row) { return Date.now() >= stamp(row.accessStartsAt) && Date.now() <= stamp(row.accessEndsAt); });
      access = ready.length ? 'Approved — controls open' : 'Approved — window not open yet';
      kind = ready.length ? 'playing' : 'idle';
    } else if (requests.some(function (row) { return row.status === 'pending'; })) {
      access = 'Waiting for administrator';
    } else if (requests.some(function (row) { return row.status === 'changes'; })) {
      access = 'Changes requested';
      kind = 'error';
    }
    setAccess(access, kind);
    var list = $('presenterRequestList');
    if (list) list.innerHTML = requests.length ? requests.map(requestRow).join('') : 'No requests yet. Submit one above; no live control exists until it is approved.';
    var controls = $('presenterLiveControls');
    if (controls) controls.style.display = (active || approved.length) ? 'block' : 'none';
    var hint = $('presenterLiveHint');
    if (hint) hint.textContent = active
      ? 'You are approved and live. End the session here or close the page; the server watchdog returns listeners to automation if your heartbeat stops.'
      : approved.length ? 'Your approval is for the proposed window only. Start inside the window; the server checks the time and ownership again.'
        : 'Live controls appear only for an approved request.';
    var startBtn = $('presenterStartBtn');
    if (startBtn) {
      startBtn.style.display = active ? 'none' : '';
      startBtn.disabled = !approved.length || !!live;
      startBtn.title = live ? 'Another presenter is live' : (!approved.length ? 'No approved session' : 'Start your approved session');
    }
    var stopBtn = $('presenterStopBtn');
    if (stopBtn) stopBtn.style.display = active ? '' : 'none';
    var liveState = $('presenterLiveState');
    if (liveState) liveState.textContent = active
      ? 'Session ' + active.id + ' · expires ' + lusaka(active.expiresAt) + '.'
      : (live ? 'Presenter: ' + (live.presenterName || 'Approved presenter') + ' · ' + (live.programmeTitle || '') : '');
  }

  async function refreshPresenter() {
    if (!state.fb) return;
    if (!state.fb.auth.currentUser) { presenter.user = null; presenter.status = null; renderPresenter(); return; }
    presenter.user = state.fb.auth.currentUser;
    try {
      var result = await callPresenter('radioPresenterStatus', {});
      presenter.status = result.data || {};
      renderPresenter();
    } catch (error) {
      renderPresenter();
      setAccess('Access check failed', 'error');
    }
  }

  function lusakaInputToIso(value) {
    var text = String(value || '').trim();
    if (!text) return '';
    // Zambia is UTC+02:00 all year. Interpret the datetime-local value as
    // Lusaka wall time instead of the browser's possibly different zone.
    var withSeconds = text.length === 16 ? text + ':00' : text;
    var date = new Date(withSeconds + '+02:00');
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function minimumStartValue() {
    var d = new Date(Date.now() + 60 * 60 * 1000);
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lusaka', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d).reduce(function (acc, part) { if (part.type !== 'literal') acc[part.type] = part.value; return acc; }, {});
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + (parts.hour === '24' ? '00' : parts.hour) + ':' + parts.minute;
  }

  async function submitRequest(event) {
    if (event && event.preventDefault) event.preventDefault();
    if (!presenter.user) return toast('Sign in before requesting a presenter session.', 'error');
    var name = String(($('presenterName') || {}).value || '').trim();
    var title = String(($('presenterProgrammeTitle') || {}).value || '').trim();
    var startAt = lusakaInputToIso(($('presenterStart') || {}).value || '');
    var durationMinutes = Number(($('presenterDuration') || {}).value || 60);
    var description = String(($('presenterDescription') || {}).value || '').trim();
    if (!name || !title) return toast('Enter the presenter name and programme title.', 'error');
    if (!startAt) return toast('Choose a proposed start time.', 'error');
    if (description.length < 20) return toast('Describe the programme in at least 20 characters.', 'error');
    var note = $('presenterRequestNote');
    if (note) note.textContent = 'Sending the request to an administrator…';
    try {
      var result = await callPresenter('radioPresenterRequest', {
        name: name, programmeTitle: title, startAt: startAt, durationMinutes: durationMinutes, description: description
      });
      if (note) note.textContent = result.data.adminsNotified ? 'Request sent. An administrator has been notified in the dashboard.' : 'Request saved. An administrator will review it in Radio Studio.';
      toast('Presenter request submitted. Live controls stay locked until an administrator approves it.');
      await refreshPresenter();
    } catch (error) {
      if (note) note.textContent = error.message || 'The request could not be sent.';
      toast(error.message || 'The request could not be sent.', 'error');
    }
  }

  async function answerViewer(sessionId, viewerId, data) {
    if (!presenter.stream || !data.offer) return;
    if (presenter.pcs.length >= 30) return;
    var fb = state.fb;
    var pc = new RTCPeerConnection({ iceServers: await getIceServers() });
    presenter.pcs.push(pc);
    presenter.stream.getTracks().forEach(function (track) { pc.addTrack(track, presenter.stream); });
    pc.onicecandidate = function (event) {
      if (!event.candidate) return;
      fb.setDoc(fb.doc(fb.db, 'radioLive', sessionId, 'viewers', viewerId, 'presenterCandidates', 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)), {
        candidate: event.candidate.toJSON(), createdAt: fb.serverTimestamp()
      }).catch(function () {});
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        try { pc.close(); } catch (e) {}
        presenter.pcs = presenter.pcs.filter(function (item) { return item !== pc; });
      }
    };
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      var answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIce(pc, 3000);
      await fb.setDoc(fb.doc(fb.db, 'radioLive', sessionId, 'viewers', viewerId), {
        answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        answeredAt: fb.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      console.warn('Presenter answer failed:', error && error.message);
      try { pc.close(); } catch (e) {}
      presenter.pcs = presenter.pcs.filter(function (item) { return item !== pc; });
    }
  }

  async function startPresenter(requestId) {
    if (!presenter.user || presenter.starting) return;
    if (!requestId && presenter.status) {
      var approved = (presenter.status.requests || []).filter(function (row) { return row.status === 'approved'; })[0];
      requestId = approved && approved.id;
    }
    if (!requestId) { toast('No approved request is available to start.', 'error'); return; }
    presenter.starting = true;
    setAccess('Opening the approved session…', 'idle');
    var started = null;
    try {
      var result = await callPresenter('radioPresenterStart', { requestId: requestId || '' });
      started = result.data || {};
      if (!started.sessionId) throw new Error('The server did not create a session.');
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      presenter.stream = stream;
      presenter.active = started;
      var fb = await loadFirebase();
      var sessionId = started.sessionId;
      presenter.unsubs.forEach(function (unsub) { try { unsub(); } catch (e) {} });
      presenter.unsubs = [];
      var viewers = new Set();
      presenter.unsubs.push(fb.onSnapshot(fb.collection(fb.db, 'radioLive', sessionId, 'viewers'), function (snap) {
        snap.docChanges().forEach(function (change) {
          if (change.type === 'removed') return;
          var data = change.doc.data() || {};
          if (!data.offer || data.answer) return;
          if (viewers.has(change.doc.id)) return;
          viewers.add(change.doc.id);
          answerViewer(sessionId, change.doc.id, data);
        });
      }, function (error) {
        console.warn('Viewer signalling unavailable:', error && error.message);
      }));
      presenter.heartbeat = setInterval(async function () {
        try {
          var beat = await callPresenter('radioPresenterHeartbeat', { sessionId: sessionId });
          if (beat.data && beat.data.active === false) stopPresenterLocal('The approved session window ended.');
        } catch (error) { console.warn('Heartbeat failed:', error && error.message); }
      }, 20000);
      var expires = stamp(started.expiresAt);
      if (expires) presenter.expiry = setTimeout(function () {
        stopPresenterLocal('The approved session window ended.');
      }, Math.max(1000, expires - Date.now()));
      presenter.bound = true;
      setAccess('You are LIVE', 'playing');
      renderPresenter();
      toast('You are live. Listeners on /radio stay on the same player.');
    } catch (error) {
      if (started && started.sessionId) {
        callPresenter('radioPresenterEnd', { sessionId: started.sessionId, reason: 'Presenter could not open microphone' }).catch(function () {});
      }
      setAccess('Could not start', 'error');
      toast(error.message || 'The presenter session could not start. Allow microphone access and try again.', 'error');
    } finally {
      presenter.starting = false;
    }
  }

  function stopPresenterLocal(reason) {
    presenter.unsubs.forEach(function (unsub) { try { unsub(); } catch (e) {} });
    presenter.unsubs = [];
    presenter.pcs.forEach(function (pc) { try { pc.close(); } catch (e) {} });
    presenter.pcs = [];
    if (presenter.heartbeat) clearInterval(presenter.heartbeat);
    if (presenter.expiry) clearTimeout(presenter.expiry);
    presenter.heartbeat = null;
    presenter.expiry = null;
    if (presenter.stream) presenter.stream.getTracks().forEach(function (track) { track.stop(); });
    presenter.stream = null;
    presenter.active = null;
    if (presenter.bound) toast(reason || 'Presenter session ended. Listeners have returned to automation.');
    presenter.bound = false;
    refreshPresenter();
  }

  async function stopPresenter() {
    var sessionId = presenter.active && presenter.active.sessionId;
    if (sessionId) {
      try { await callPresenter('radioPresenterEnd', { sessionId: sessionId, reason: 'Presenter ended the programme' }); }
      catch (error) { console.warn('End call failed:', error && error.message); }
    }
    stopPresenterLocal('You ended the session. Listeners are back on automation.');
  }

  async function reportIssue() {
    if (!presenter.user) return toast('Sign in first.', 'error');
    var message = String(prompt('What is wrong with the audio? Do not include passwords or stream keys.', '') || '').trim();
    if (message.length < 4) return;
    try {
      await callPresenter('radioReportIssue', { message: message, sessionId: presenter.active && presenter.active.sessionId });
      toast('Issue reported to the radio administrators.');
    } catch (error) { toast(error.message || 'The issue could not be reported.', 'error'); }
  }

  function bindPresenter() {
    var startInput = $('presenterStart');
    if (startInput) { startInput.min = minimumStartValue(); if (!startInput.value) startInput.value = minimumStartValue(); }
    window.addEventListener('pagehide', function () {
      if (presenter.active && presenter.active.sessionId && presenter.user) {
        callPresenter('radioPresenterEnd', { sessionId: presenter.active.sessionId, reason: 'Presenter page closed' }).catch(function () {});
      }
    });
  }

  function bindAudioEvents() {
    if (!global.PDApp || !global.PDApp.on) return;
    global.PDApp.on('radio:stopped', function (event) {
      if (state.mode === 'live') return;
      if (state.wantsPlay && !state.transitioning && event && event.detail && event.detail.ended) {
        // playOne owns the normal transition. This is a safety net for a
        // player that reports ended outside that promise.
        setTimeout(function () { if (state.wantsPlay && !state.playing) playNext(false); }, 250);
      }
    });
  }

  async function boot() {
    if (!$('radioNowPlaying')) return;
    bindPresenter();
    bindAudioEvents();
    try {
      await loadLibrary();
    } catch (error) {
      showLoadError(error);
    }
    subscribeLive();
    var fb = state.fb;
    fb.authMod.onAuthStateChanged(fb.auth, function () {
      refreshPresenter();
    });
    refreshPresenter();
    setInterval(function () {
      if (!state.wantsPlay || state.live) return;
      var slot = slotForNow();
      if (slot && state.slot && slot.id !== state.slot.id) {
        state.slot = slot;
        state.queue = [];
        state.transitioning = false;
        playNext(true);
      }
    }, 20000);
    setInterval(function () { loadLibrary().catch(function () {}); }, 5 * 60 * 1000);
  }

  function showLoadError(error) {
    setStatus('Radio data unavailable', 'error');
    setNote('The approved radio library could not be loaded. Check the connection and try again. ' + (error && error.message ? error.message : ''), true);
  }

  function toast(message, type) {
    if (global.PDApp && typeof global.PDApp.toast === 'function') global.PDApp.toast(message, type);
    else if (typeof global.toast === 'function') global.toast(message, type);
  }

  global.PDRadioEngine = {
    start: startPlayback,
    stop: stopPlayback,
    toggle: togglePlayback,
    available: available,
    ownsAudio: ownsAudio,
    refresh: function () { return loadLibrary(); },
    state: state
  };
  global.PDRadioPresenter = {
    submitRequest: submitRequest,
    start: startPresenter,
    stop: stopPresenter,
    reportIssue: reportIssue,
    refresh: refreshPresenter
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
