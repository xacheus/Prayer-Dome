/*!
 * Prayer Dome Radio — AI presenter announcements (free, open-source TTS)
 * ---------------------------------------------------------------------------
 * Announcement *texts* are generated here from the live programme, time of
 * day, current track and next programme. The *voice* is produced by a free
 * open-source engine, in this order:
 *
 *   1. Piper TTS (MIT, offline neural, CPU) running on the radio server or
 *      locally — generated audio is cached in Cloudflare R2 / Firebase
 *      Storage and played as a normal audio file (best quality, works
 *      everywhere, no per-listener cost).
 *   2. The browser's built-in Web Speech synthesiser — free, no server, used
 *      only when no cached Piper file exists and the administrator has
 *      enabled announcements. It is a real TTS engine, not a fake voice.
 *
 * If neither is available the station simply continues with music. This
 * module never invents audio and never blocks playback.
 *
 * Shared between browser and Node (Vercel / scripts) — no dependencies.
 */
(function (global) {
  'use strict';

  var STATION = 'Prayer Dome Radio';

  /* Six presenter personas. `piper` is the Piper voice model name
   * (see radio/tts/README.md); `browserHints` help pick a matching
   * Web Speech voice by gender/name when Piper audio is not cached. */
  var PERSONAS = [
    { id: 'warm-female', label: 'Warm female', gender: 'female', piper: 'en_GB-amy-medium', browserHints: ['female', 'zira', 'samantha', 'victoria', 'karen', 'moira', 'fiona', 'serena'], programmeIds: ['morning-prayer', 'gospel-worship'] },
    { id: 'energetic-male', label: 'Energetic male', gender: 'male', piper: 'en_GB-ryan-high', browserHints: ['male', 'david', 'daniel', 'alex', 'fred', 'thomas', 'jorge'], programmeIds: ['gospel-worship', 'afternoon-worship'] },
    { id: 'friendly-female', label: 'Friendly female', gender: 'female', piper: 'en_US-lessac-medium', browserHints: ['female', 'samantha', 'zira', 'allison', 'ava', 'joana'], programmeIds: ['encouragement', 'afternoon-worship'] },
    { id: 'calm-male', label: 'Calm male', gender: 'male', piper: 'en_US-ryan-medium', browserHints: ['male', 'david', 'daniel', 'fred', 'aaron', 'arthur'], programmeIds: ['evening-prayer', 'scripture-reflection'] },
    { id: 'gentle-female', label: 'Gentle female', gender: 'female', piper: 'en_GB-jenny_dioco-medium', browserHints: ['female', 'serena', 'victoria', 'karen', 'fiona', 'catherine'], programmeIds: ['night-watch', 'morning-prayer'] },
    { id: 'deep-male', label: 'Deep male', gender: 'male', piper: 'en_US-joe-medium', browserHints: ['male', 'alex', 'thomas', 'jorge', 'david'], programmeIds: ['bible-teaching', 'announcements'] }
  ];

  function personaById(id) {
    for (var i = 0; i < PERSONAS.length; i++) if (PERSONAS[i].id === id) return PERSONAS[i];
    return null;
  }

  function personaForProgramme(programmeId, fallbackId) {
    var found = null;
    for (var i = 0; i < PERSONAS.length; i++) {
      if (PERSONAS[i].programmeIds.indexOf(programmeId) !== -1) { found = PERSONAS[i]; break; }
    }
    if (found) return found;
    return personaById(fallbackId) || PERSONAS[0];
  }

  function greetingForHour(hour) {
    var h = Number(hour);
    if (h >= 5 && h < 12) return 'Good morning';
    if (h >= 12 && h < 17) return 'Good afternoon';
    if (h >= 17 && h < 21) return 'Good evening';
    // Through the night watch a greeting, not a farewell.
    return 'Greetings in this night hour';
  }

  function pick(list, seed) {
    if (!list || !list.length) return '';
    var n = Math.abs(Number(seed) || 0);
    return list[n % list.length];
  }

  /* Deterministic-ish variation: the same programme at a different hour
   * gets a different line, so listeners do not hear one looped sentence. */
  function announcementText(options) {
    var opts = options || {};
    var kind = opts.kind || 'programme-intro';
    var programme = opts.programme || {};
    var title = programme.title || 'gospel music and worship';
    var seed = opts.seed != null ? opts.seed : (opts.hour || 0) * 7 + (opts.day || 0);
    var hour = opts.hour != null ? Number(opts.hour) : 9;
    var greeting = greetingForHour(hour);
    var track = opts.track || null;
    var next = opts.nextProgramme || null;

    if (kind === 'station-id') {
      return pick([
        'You are listening to ' + STATION + '. Gospel music, worship and inspiration, day and night.',
        STATION + '. A house of prayer for all nations. Thank you for listening with us.',
        'This is ' + STATION + ', bringing you gospel worship and encouragement throughout the day.'
      ], seed);
    }
    if (kind === 'transition') {
      var songLine = track && track.title
        ? ' We continue with ' + track.title + (track.artist ? ' by ' + track.artist : '') + '.'
        : ' We continue with beautiful gospel worship and uplifting Christian music.';
      return pick([
        'You are listening to ' + STATION + '.' + songLine + ' Stay with us.',
        'Thank you for making ' + STATION + ' part of your day.' + songLine,
        'We are glad you are here.' + songLine + ' Stay with us.'
      ], seed);
    }
    if (kind === 'closing') {
      return pick([
        'Thank you for listening to ' + STATION + '. Go in peace, keep the Word of God close, and remember that you are prayed for.',
        'That brings this programme to a close. Thank you for listening to ' + STATION + '. We will be here with more worship and encouragement.'
      ], seed);
    }
    /* programme-intro (default) */
    var desc = programme.description || programme.kind || 'gospel music, worship and inspiration';
    var nextLine = next && next.title ? ' Coming up next is ' + next.title + '.' : '';
    return pick([
      greeting + ' and welcome to ' + STATION + '. We are beginning ' + title + ': ' + desc + '.' + nextLine + ' Thank you for making us part of your day.',
      greeting + ' from ' + STATION + '. You are listening to ' + title + ', with ' + desc + '.' + nextLine,
      'Welcome to ' + STATION + '. ' + greeting + '! This is ' + title + ' — ' + desc + '.' + nextLine + ' Settle in and worship with us.'
    ], seed);
  }

  /* Cache key for generated audio: same text + same voice = same file in R2,
   * so a repeated announcement is generated once and reused. */
  function cacheKey(text, personaId) {
    var s = String(text || '') + '|' + String(personaId || '');
    var hash = 0;
    for (var i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return 'radio/announcements/' + String(personaId || 'warm-female') + '/' +
      (hash >>> 0).toString(36) + '.mp3';
  }

  function pickBrowserVoice(voices, personaId) {
    if (!Array.isArray(voices) || !voices.length) return null;
    var persona = personaById(personaId) || PERSONAS[0];
    var hints = persona.browserHints || [];
    var english = voices.filter(function (v) {
      return v && /^en/i.test(v.lang || '') && v.localService !== true ? true : (v && /^en/i.test(v.lang || ''));
    });
    var pool = english.length ? english : voices;
    for (var h = 0; h < hints.length; h++) {
      for (var i = 0; i < pool.length; i++) {
        var name = String((pool[i] && pool[i].name) || '').toLowerCase();
        if (name.indexOf(hints[h]) !== -1) return pool[i];
      }
    }
    /* Gender is not reliably exposed by every browser; fall back to the
     * first English voice rather than failing the announcement. */
    return pool[0] || voices[0] || null;
  }

  var api = {
    STATION: STATION,
    PERSONAS: PERSONAS,
    personaById: personaById,
    personaForProgramme: personaForProgramme,
    greetingForHour: greetingForHour,
    announcementText: announcementText,
    cacheKey: cacheKey,
    pickBrowserVoice: pickBrowserVoice
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PD_RADIO_ANNOUNCEMENTS = api;
})(typeof window !== 'undefined' ? window : globalThis);
