'use strict';

/*
 * Radio programming checks.
 *
 * The schedule is published content, never a claim of a live studio. These
 * tests protect the honest programme block, the approved-only briefing rule,
 * the rights gate on the worship library and the admin review console.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const content = require('../assets/pd-content-data.js');
const radio = fs.readFileSync('radio.html', 'utf8');
const admin = fs.readFileSync('admin.html', 'utf8');
const rules = fs.readFileSync('firestore.rules', 'utf8');

const PROGRAMMES = content.RADIO_PROGRAMMES;

test('the daily schedule is a complete, non-overlapping 24-hour block', () => {
  assert.ok(PROGRAMMES.length >= 9, 'every hour of the day needs a named slot');
  assert.equal(new Set(PROGRAMMES.map((row) => row.id)).size, PROGRAMMES.length, 'programme ids must be unique');

  for (const programme of PROGRAMMES) {
    assert.ok(programme.title && programme.host && programme.kind, `${programme.id} needs title, host and kind`);
    assert.ok(Number.isInteger(programme.start) && Number.isInteger(programme.end), `${programme.id} must use whole minutes`);
    assert.ok(programme.start >= 0 && programme.start < 1440, `${programme.id} start is outside the day`);
    assert.ok(programme.end >= 0 && programme.end < 1440, `${programme.id} end is outside the day`);
    assert.ok(programme.start !== programme.end, `${programme.id} has zero length`);
    assert.ok(Array.isArray(programme.days) && programme.days.length, `${programme.id} needs days`);
  }

  for (let minute = 0; minute < 1440; minute += 1) {
    const matches = PROGRAMMES.filter((row) => {
      const inSlot = row.end > row.start
        ? minute >= row.start && minute < row.end
        : minute >= row.start || minute < row.end;
      return inSlot;
    });
    assert.equal(matches.length, 1, `minute ${minute} should belong to exactly one programme, found ${matches.length}`);
  }
});

test('the current programme follows Africa/Lusaka, including the midnight watch', () => {
  // Lusaka is UTC+2 year round. 03:00Z = 05:00 Monday morning.
  const morning = content.currentRadioProgramme(new Date('2026-11-23T03:00:00Z'));
  assert.equal(morning.programme.id, 'morning-prayer');
  // 23:30Z on Monday = 01:30 Tuesday: inside the cross-midnight Night Watch.
  const night = content.currentRadioProgramme(new Date('2026-11-23T23:30:00Z'));
  assert.equal(night.programme.id, 'night-watch');
  assert.equal(night.clock.weekday, 2);
});

test('every programme has an AI-assisted draft that is longer than a sentence', () => {
  global.window = global;
  require('../assets/pd-radio-scripts.js');
  const scripts = global.PD_RADIO_SCRIPTS;
  assert.ok(scripts && scripts.aiAssisted === true);
  assert.equal(scripts.ids().length, PROGRAMMES.length, 'one script per programme');
  for (const programme of PROGRAMMES) {
    const text = scripts.scriptFor(programme.id, 1);
    assert.ok(text.length >= 200, `${programme.id} brief is too thin to review`);
    assert.match(text, /Prayer Dome Radio/, `${programme.id} must name the station`);
    assert.doesNotMatch(text, /live (studio|presenter)|call now|send money/i, `${programme.id} must not invent a live show or money ask`);
  }
});

test('the public page renders only an approved briefing and never fakes one', () => {
  assert.match(radio, /row\.status !== 'approved'\) row = null/);
  assert.match(radio, /awaiting administrator review/);
  assert.match(radio, /not a live broadcast claim/);
  assert.match(radio, /if \(row\) briefingCache\[key\] = row;/);
});

test('no sample or unlicensed audio ships as a station or podcast', () => {
  assert.doesNotMatch(radio, /SoundHelix/i);
  assert.doesNotMatch(content.DEFAULT_RADIO.map((row) => row.streamUrl).join(' '), /soundhelix|sample\.mp3/i);
  assert.equal(content.DEFAULT_PODCASTS.length, 0, 'episodes are published from admin after rights are recorded');
  const station = content.DEFAULT_RADIO[0];
  assert.equal(station.streamUrl, '', 'a real licensed stream must be configured by an administrator');
});

test('the worship library withholds audio whose rights are not recorded', () => {
  assert.match(radio, /Rights not recorded/);
  assert.match(radio, /Rights not confirmed/);
  assert.match(radio, /const cleared = \/\^\(licensed\|public domain\|original\|ai-generated\|written permission\)\/i/);
  assert.match(radio, /esc\(s\.rightsHolder\)/);
});

test('the schema and rules let only an administrator publish a script', () => {
  assert.match(rules, /match \/radioScripts\/\{scriptId\} \{/);
  assert.match(rules, /allow read: if true;/);
  assert.match(rules, /request\.resource\.data\.status in \['approved', 'draft', 'rejected'\]/);
  assert.match(rules, /request\.resource\.data\.script\.size\(\) <= 6000/);
  assert.match(rules, /request\.resource\.data\.weekday >= 0/);
  assert.match(rules, /status != 'approved'/);
});

test('the admin console is wired in and can approve or unpublish', () => {
  for (const id of ['radioProgrammeDay', 'radioProgrammeList', 'modalRadioScript', 'radioScriptProgrammeId', 'radioScriptText']) {
    assert.ok(admin.includes('id="' + id + '"'), `admin is missing #${id}`);
  }
  assert.match(admin, /<script type="module" src="\/assets\/pd-radio-admin\.js"><\/script>/);
  assert.match(admin, /<script src="\/assets\/pd-radio-scripts\.js" defer><\/script>/);
  assert.match(admin, /loadRadioProgrammes\(\)/);
  const consoleSource = fs.readFileSync('assets/pd-radio-admin.js', 'utf8');
  assert.match(consoleSource, /window\.saveRadioScript/);
  assert.match(consoleSource, /status: approve \? 'approved' : 'draft'/);
  assert.match(consoleSource, /window\.unpublishRadioScript/);
  assert.match(consoleSource, /never overwrite an[\s\S]{0,20}administrator's corrections/);
});

/* ==========================================================================
 * Prayer Dome Radio upgrade — library, recorded voices, presenter approval,
 * LIVE takeover and automatic return. These are structural checks on the
 * shipped implementation; the browser scenarios are exercised separately.
 * ======================================================================== */

const radioLive = fs.readFileSync('assets/pd-radio-live.js', 'utf8');
const radioAdmin = fs.readFileSync('assets/pd-radio-admin.js', 'utf8');
const storageRules = fs.readFileSync('storage.rules', 'utf8');
const functionsRadio = fs.readFileSync('functions/radio.js', 'utf8');
const functionsIndex = fs.readFileSync('functions/index.js', 'utf8');
const notifications = fs.readFileSync('functions/notifications.js', 'utf8');

test('the listener uses one shared player for automation, announcements and LIVE', () => {
  assert.match(radioLive, /PDApp\.radio\.playUrl/);
  assert.match(radioLive, /PDApp\.radio\.playStream/);
  assert.doesNotMatch(radioLive, /new Audio\(/, 'the listener must never create a second player');
  assert.match(radioLive, /playsinline|shared <audio>|<audio>/i);
  assert.match(radioLive, /cancelCurrentPlay/);
});

test('only approved, licensed tracks can enter the automation queue', () => {
  assert.match(radioLive, /if \(!row\.audioUrl \|\| row\.approved !== true\) return false;/);
  assert.match(radioLive, /row\.approved === true && row\.audioUrl/);
  assert.match(radioLive, /tracksForSlot/);
  assert.match(radioLive, /recentTracks/);
  assert.match(radioLive, /Least-recently-played first/);
  assert.match(radioLive, /fallbackUrl/);
});

test('recorded human announcements are selected per programme and never generated', () => {
  assert.match(radioLive, /chooseVoice\(slot, 'programme-intro'\)/);
  assert.match(radioLive, /voiceLabel \|\| voice\.name/);
  assert.match(radioLive, /recorded human announcement/);
  assert.doesNotMatch(radioLive, /speechSynthesis|SpeechSynthesisUtterance|text-to-speech|tts/i);
  assert.match(admin, /Genuine human recordings only/);
  assert.match(rules, /request\.resource\.data\.humanRecorded == true/);
});

test('presenter requests, decisions and sessions are server-authoritative', () => {
  assert.match(functionsIndex, /exports\.radioPresenterRequest = radioModule\.radioPresenterRequest/);
  assert.match(functionsRadio, /async function requireAdmin/);
  assert.match(functionsRadio, /if \(request\.uid !== uid\) fail\('permission-denied'/);
  assert.match(functionsRadio, /request\.status !== 'approved'/);
  assert.match(functionsRadio, /now < stampMs\(request\.accessStartsAt\)/);
  assert.match(functionsRadio, /now > stampMs\(request\.accessEndsAt\)/);
  assert.match(functionsRadio, /radioSessionWatchdog/);
  assert.match(functionsRadio, /ACTIVE_SESSION_MS/);
  assert.match(functionsRadio, /set\(liveRef/);
  assert.match(rules, /match \/radioPresenterRequests\/\{requestId\} \{[\s\S]{0,220}allow write: if false;/);
  assert.match(rules, /match \/radioPresenterSessions\/\{sessionId\} \{[\s\S]{0,220}allow write: if false;/);
  assert.match(rules, /match \/radioLiveState\/\{stateId\} \{[\s\S]{0,120}allow write: if false;/);
});

test('the LIVE signal channel cannot be taken over by a stranger', () => {
  assert.match(rules, /function radioSessionPresenter\(sessionId\)/);
  assert.match(rules, /radioSessionPresenter\(sessionId\)/);
  assert.match(rules, /allow create: if radioSessionIsLive\(sessionId\)/);
  assert.match(functionsRadio, /radioLive/);
  assert.match(radioLive, /RTCPeerConnection/);
  assert.match(radioLive, /presenterCandidates/);
  assert.match(radioLive, /The presenter audio connection dropped/);
});

test('a presenter disconnect or expiry returns the station to automation', () => {
  assert.match(radioLive, /leaveLive\(state\.wantsPlay\)/);
  assert.match(radioLive, /The presenter session ended\. The same player returned to scheduled automation automatically/);
  assert.match(radioLive, /liveFallback/);
  assert.match(radioLive, /heartbeat/i);
  assert.match(functionsRadio, /Presenter heartbeat stopped/);
  assert.match(functionsRadio, /Approved session window ended/);
});

test('a presenter request notifies administrators and a decision notifies the presenter', () => {
  const events = require('../functions/notifications.js').EVENTS;
  assert.ok(events.radio_presenter_request, 'admin request event is missing');
  assert.ok(events.radio_presenter_decision, 'presenter decision event is missing');
  assert.match(notifications, /radio_presenter_request/);
  assert.match(notifications, /radio_presenter_decision/);
  assert.match(functionsRadio, /notifyAdmins/);
  assert.match(functionsRadio, /notifyPresenter/);
});

test('the admin Radio Studio exposes the real library, voice, timetable and presenter controls', () => {
  for (const id of ['view-radio', 'radioAdminRequests', 'radioAdminActive', 'radioAdminTracks', 'radioAdminVoices',
    'radioAdminPlaylists', 'radioAdminSchedule', 'radioTrackForm', 'radioVoiceForm', 'radioPlaylistForm',
    'radioScheduleForm', 'radioSettingAutomation', 'radioTrackGenre', 'radioTrackLicence', 'radioVoiceGender']) {
    assert.ok(admin.includes('id="' + id + '"'), 'admin is missing #' + id);
  }
  assert.match(admin, /getStorage/);
  assert.match(admin, /storageRef/);
  assert.match(admin, /radioAdminSaveTrack/);
  assert.match(radioAdmin, /STREAMING_HOSTS/);
  assert.match(radioAdmin, /does not scrape or rebroadcast/);
  assert.match(radioAdmin, /uploadAudio\(file, 'tracks'/);
  assert.match(radioAdmin, /uploadAudio\(file, 'voices'/);
  assert.match(radioAdmin, /radioPresenterDecision/);
  assert.match(radioAdmin, /radioAdminStop/);
});

test('radio audio and public metadata stay in Storage/Firestore safely', () => {
  assert.match(storageRules, /match \/radioAudio\/\{kind\}\/\{fileName\}/);
  assert.match(storageRules, /kind in \['tracks', 'voices', 'announcements', 'fallback'\]/);
  assert.match(storageRules, /request\.resource\.contentType\.matches\('audio\/\.\*'\)/);
  assert.match(rules, /match \/worshipSongs\/\{id\}/);
  assert.match(radioAdmin, /licenseStatus: licenseStatus/);
  assert.match(radioAdmin, /category: GENRES\[genre\]/);
  assert.match(radioAdmin, /permissionConfirmed: true/);
  assert.match(rules, /match \/radioNowPlaying\/\{stationId\}/);
  assert.doesNotMatch(radioAdmin, /localStorage\.setItem\('pd_radio_library'/i);
});

test('the presenter studio and listener states are visible on /radio', () => {
  for (const id of ['presenterStudioBody', 'presenterRequestForm', 'presenterRequestList', 'presenterLiveControls',
    'presenterStartBtn', 'presenterStopBtn', 'radioNowPlaying', 'radioLiveBadge', 'radioNowTitle']) {
    assert.ok(radio.includes('id="' + id + '"'), '/radio is missing #' + id);
  }
  assert.match(radio, /Africa\/Lusaka/);
  assert.match(radio, /sign in to request a presenter session|Sign in to request a presenter session/i);
  assert.match(radio, /same player|never need a second one/i);
});
