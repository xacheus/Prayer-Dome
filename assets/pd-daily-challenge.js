/*!
 * Prayer Dome — Daily Prayer
 * ===========================================================================
 * A prayer belongs to one calendar day in the ministry's own time zone,
 * Africa/Lusaka (CAT, UTC+2, no daylight saving). Reading the weekday from the
 * visitor's device is wrong for a member travelling or whose phone is set to
 * another region, so every label, the selected weekday and the saved prayer
 * date come from that one zone.
 *
 * The page opens on today's weekday, scrolls that tab into view and shows that
 * day's prayer. A signed-in member can record “I’ve Prayed” once for today:
 * the check-in is stored in Firestore under a deterministic id
 * (`<uid>_<YYYY-MM-DD>`), so a double tap, a refresh or a second device can
 * never create a duplicate for the same day. The history is retained and the
 * streak is calculated from those local dates, never from the device clock.
 *
 * Administrators can schedule a challenge for a specific date (Firestore
 * `dailyChallenges`, publicly readable only when published). When no scheduled
 * item exists, the built-in seven-day rhythm is used, so the section is never
 * empty or wrong.
 */
(function (global) {
  'use strict';

  var TZ = 'Africa/Lusaka';
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var STORAGE_DONE = 'pd_daily_prayer_done';
  var STORAGE_POINTS = 'pd_daily_prayer_points';
  var CHECKIN_COLLECTION = 'dailyPrayerCheckins';

  var DEFAULT_PLAN = [
    {
      weekday: 0,
      title: 'Sunday — Gather and Worship',
      description: 'Set this day apart. Worship with the family of God, then write down one thing you want to thank Him for before the week begins.',
      activities: 'Attend or stream the Sunday service\nPray for every branch: Chama, Mahlabane and Hluthi\nShare one word of encouragement with someone',
      verse: 'Psalm 122:1',
      points: 20
    },
    {
      weekday: 1,
      title: 'Monday — Begin with Thanksgiving',
      description: 'Start the week with gratitude instead of pressure. Give thanks before you ask for anything.',
      activities: 'Name three specific things God did last week\nPray for your work or studies\nRead Psalm 100 slowly, out loud',
      verse: 'Psalm 100:4',
      points: 20
    },
    {
      weekday: 2,
      title: 'Tuesday — Stand in the Gap',
      description: 'Intercede for someone who cannot pray for themselves today. Carry one name before the Lord.',
      activities: 'Write one name on a piece of paper\nPray for that person for five minutes\nSend them a message to say you prayed',
      verse: 'Ezekiel 22:30',
      points: 20
    },
    {
      weekday: 3,
      title: 'Wednesday — Feed on the Word',
      description: 'Midweek is where the Word steadies the heart. Read a passage slowly and let one verse stay with you.',
      activities: 'Read a full chapter without rushing\nWrite out the verse that spoke loudest\nAsk one person what they are learning',
      verse: 'Matthew 4:4',
      points: 25
    },
    {
      weekday: 4,
      title: 'Thursday — Forgive and Release',
      description: 'Unforgiveness is a heavy load to carry into a weekend. Release it deliberately, in prayer.',
      activities: 'Name the hurt honestly before God\nPray for the person who caused it\nChoose to release them, out loud',
      verse: 'Ephesians 4:32',
      points: 25
    },
    {
      weekday: 5,
      title: 'Friday — Serve Somebody',
      description: 'Faith becomes visible when it serves. Do one practical, quiet act of kindness today.',
      activities: 'Choose one act of service that costs you time\nDo it without announcing it\nPray that the receiver meets Jesus',
      verse: 'Galatians 5:13',
      points: 25
    },
    {
      weekday: 6,
      title: 'Saturday — Rest and Remember',
      description: 'Stop long enough to remember what God has done. Rest is an act of trust.',
      activities: 'Put the phone down for an hour\nReview the week and thank God for one answer\nPray a blessing over your family',
      verse: 'Exodus 20:8',
      points: 20
    }
  ];

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * Calendar facts for a moment, read in Africa/Lusaka regardless of the
   * device's own zone. `weekday` is the long English name; `weekdayIndex`
   * is 0 = Sunday … 6 = Saturday.
   */
  function timeZoneParts(date) {
    var when = date instanceof Date ? date : new Date(date || Date.now());
    if (isNaN(when.getTime())) when = new Date();
    var formatter;
    try {
      formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
    } catch (error) {
      formatter = new Intl.DateTimeFormat('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });
    }
    var parts = formatter.formatToParts(when).reduce(function (acc, part) {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
    var weekday = parts.weekday || WEEKDAYS[when.getDay()];
    var weekdayIndex = WEEKDAYS.indexOf(weekday);
    if (weekdayIndex < 0) weekdayIndex = when.getDay();
    var day = parts.day || pad(when.getDate());
    var monthName = parts.month || '';
    var year = parts.year || String(when.getFullYear());
    var monthNumber = monthNameToNumber(monthName);
    return {
      weekday: weekday,
      weekdayIndex: weekdayIndex,
      day: Number(day),
      month: monthName,
      monthNumber: monthNumber,
      year: Number(year),
      dateKey: year + '-' + pad(monthNumber) + '-' + pad(Number(day)),
      dateLabel: weekday + ', ' + Number(day) + ' ' + monthName + ' ' + year,
      shortDate: Number(day) + ' ' + monthName + ' ' + year
    };
  }

  function monthNameToNumber(name) {
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    var index = months.indexOf(String(name || '').trim());
    return index >= 0 ? index + 1 : 1;
  }

  /** Move a YYYY-MM-DD key by whole calendar days without touching the device zone. */
  function shiftDateKey(key, delta) {
    var bits = String(key || '').split('-').map(Number);
    if (bits.length !== 3 || bits.some(function (part) { return !isFinite(part); })) return '';
    var date = new Date(Date.UTC(bits[0], bits[1] - 1, bits[2] + Number(delta || 0)));
    return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
  }

  /* -------------------------------------------------------------- storage */
  function readJson(key, fallback) {
    try {
      var raw = global.localStorage && localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      if (global.localStorage) localStorage.setItem(key, JSON.stringify(value));
    } catch (error) { /* private mode: the server record is still authoritative */ }
  }

  function completedMap() {
    return readJson(STORAGE_DONE, {});
  }

  function isLocallyDone(dateKey) {
    return !!completedMap()[dateKey];
  }

  function pointsTotal() {
    var value = Number(readJson(STORAGE_POINTS, { total: 0 }).total);
    return Number.isFinite(value) ? value : 0;
  }

  function addPoints(amount) {
    var total = pointsTotal() + Number(amount || 0);
    writeJson(STORAGE_POINTS, { total: total });
    return total;
  }

  /* ------------------------------------------------------------ scheduling */
  var schedule = [];

  function normaliseScheduled(raw) {
    if (!raw) return null;
    var item = Object.assign({}, raw);
    item.date = typeof item.date === 'string' ? item.date.slice(0, 10) : '';
    item.title = item.title || '';
    item.description = item.description || '';
    item.activities = item.activities || '';
    item.verse = item.verse || '';
    item.points = Number(item.points || 0) || 20;
    item.weekday = Number(item.weekday);
    return item;
  }

  function setSchedule(list) {
    if (!Array.isArray(list)) return;
    schedule = list.map(normaliseScheduled).filter(function (item) {
      return item && (item.published !== false) && item.title;
    });
    render();
  }

  /** The plan for a moment (or a viewed weekday): exact date first, then weekday, then built-in. */
  function challengeFor(date, weekdayIndex) {
    var today = timeZoneParts(date);
    var target = Number.isInteger(weekdayIndex) && weekdayIndex >= 0 && weekdayIndex <= 6
      ? weekdayIndex : today.weekdayIndex;
    var exact = null;
    var weekdayMatch = null;
    schedule.forEach(function (item) {
      if (target === today.weekdayIndex && item.date === today.dateKey) exact = item;
      else if (!item.date && item.weekday === target && !weekdayMatch) weekdayMatch = item;
    });
    var chosen = exact || weekdayMatch || DEFAULT_PLAN[target] || DEFAULT_PLAN[0];
    return {
      today: today,
      weekdayIndex: target,
      isToday: target === today.weekdayIndex,
      source: exact ? 'scheduled' : weekdayMatch ? 'weekday' : 'default',
      challenge: {
        title: chosen.title,
        description: chosen.description,
        activities: chosen.activities,
        verse: chosen.verse,
        points: Number(chosen.points) || 20
      }
    };
  }

  /* --------------------------------------------------------- check-in state */
  var checkinState = {
    uid: '',
    loadedFor: '',
    loading: false,
    records: [],
    error: ''
  };
  var selectedWeekday = null;
  var renderedDayKey = '';
  var busy = false;

  function firebaseBindings() {
    var fb = global.PDApp && global.PDApp._fb;
    if (!fb || !fb.db || !fb.auth) return null;
    if (!fb.collection || !fb.query || !fb.where || !fb.getDocs || !fb.doc || !fb.setDoc || !fb.getDoc) return null;
    return fb;
  }

  function currentUser() {
    var fb = firebaseBindings();
    return fb && fb.auth.currentUser ? fb.auth.currentUser : null;
  }

  function recordKeys() {
    var map = {};
    checkinState.records.forEach(function (record) {
      if (record && record.dateKey) map[record.dateKey] = record;
    });
    return map;
  }

  function serverKnowsToday(dateKey) {
    return !!recordKeys()[dateKey];
  }

  function doneForToday(today) {
    var user = currentUser();
    if (user && checkinState.loadedFor === user.uid) return serverKnowsToday(today.dateKey);
    return isLocallyDone(today.dateKey);
  }

  function streakFromRecords(records, today) {
    var keys = {};
    (records || []).forEach(function (record) {
      if (record && record.dateKey) keys[record.dateKey] = true;
    });
    var cursor = keys[today.dateKey] ? today.dateKey : shiftDateKey(today.dateKey, -1);
    var streak = 0;
    while (cursor && keys[cursor] && streak < 366) {
      streak += 1;
      cursor = shiftDateKey(cursor, -1);
    }
    return streak;
  }

  async function loadCheckins(force) {
    var user = currentUser();
    if (!user) {
      checkinState.uid = '';
      checkinState.loadedFor = '';
      checkinState.records = [];
      checkinState.loading = false;
      checkinState.error = '';
      return;
    }
    if (!force && (checkinState.loadedFor === user.uid || checkinState.loading)) return;
    var fb = firebaseBindings();
    if (!fb) return;
    checkinState.uid = user.uid;
    checkinState.loading = true;
    checkinState.error = '';
    render();
    try {
      var snap = await fb.getDocs(fb.query(
        fb.collection(fb.db, CHECKIN_COLLECTION),
        fb.where('userId', '==', user.uid),
        fb.limit(500)
      ));
      if (checkinState.uid !== user.uid) return;
      var rows = [];
      snap.forEach(function (entry) {
        var data = entry.data() || {};
        rows.push(Object.assign({ id: entry.id }, data));
      });
      rows.sort(function (a, b) { return String(b.dateKey || '').localeCompare(String(a.dateKey || '')); });
      checkinState.records = rows;
      checkinState.loadedFor = user.uid;
    } catch (error) {
      checkinState.error = error && error.message ? error.message : 'Your saved prayers could not be loaded.';
    } finally {
      checkinState.loading = false;
      render();
    }
  }

  /* --------------------------------------------------------------- render */
  var refreshTimer = null;
  var lastRenderedKey = null;

  function activityList(text) {
    return String(text || '')
      .split(/\r?\n|•/)
      .map(function (line) { return line.trim(); })
      .filter(Boolean);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function render() {
    var root = document.getElementById('dailyChallenge');
    if (!root) return;
    var today = timeZoneParts(new Date());

    // A new Lusaka day always returns the card to the current weekday and
    // re-reads the saved check-ins, even when the page stayed open overnight.
    if (renderedDayKey && renderedDayKey !== today.dateKey) {
      selectedWeekday = null;
      checkinState.loadedFor = '';
    }
    if (selectedWeekday === null) selectedWeekday = today.weekdayIndex;
    renderedDayKey = today.dateKey;
    lastRenderedKey = today.dateKey;

    var result = challengeFor(new Date(), selectedWeekday);
    var challenge = result.challenge;
    var isToday = selectedWeekday === today.weekdayIndex;
    var activities = activityList(challenge.activities);
    var user = currentUser();
    var done = isToday && doneForToday(today);
    var streak = user && checkinState.loadedFor === user.uid
      ? streakFromRecords(checkinState.records, today) : 0;
    var historyCount = user && checkinState.loadedFor === user.uid ? checkinState.records.length : 0;
    var loadingHistory = checkinState.loading && user;
    // The strip runs Sunday→Saturday, so map each tab onto the current Lusaka
    // week instead of counting forwards from today (which marked future days as
    // “Prayed” after Sunday).
    var weekStartKey = shiftDateKey(today.dateKey, -today.weekdayIndex);
    var dayTabs = WEEKDAYS.map(function (name, index) {
      var active = index === today.weekdayIndex;
      var selected = index === selectedWeekday;
      var prayed = user && checkinState.loadedFor === user.uid &&
        Object.prototype.hasOwnProperty.call(recordKeys(), shiftDateKey(weekStartKey, index));
      return '<button type="button" role="tab" class="dc-day' +
        (selected ? ' is-selected' : '') + (active ? ' is-today' : '') + '"' +
        ' data-weekday="' + index + '" aria-selected="' + (selected ? 'true' : 'false') + '"' +
        ' aria-label="' + escapeHtml(name + (active ? ', today' : '') + (prayed ? ', prayed' : '')) + '">' +
        '<span>' + escapeHtml(WEEKDAYS_SHORT[index]) + '</span>' +
        '<small>' + (active ? 'Today' : (prayed ? 'Prayed' : 'Plan')) + '</small>' +
        (prayed ? '<i class="pd-i pd-i-circle-check" aria-hidden="true"></i>' : '') +
        '</button>';
    }).join('');

    root.innerHTML = '' +
      '<div class="dc-card' + (done ? ' is-done' : '') + '" data-weekday="' + selectedWeekday + '">' +
        '<div class="dc-days-head">' +
          '<span><i class="pd-i pd-i-calendar-days" aria-hidden="true"></i> Daily Prayer · week in ' + TZ + '</span>' +
          '<span class="dc-streak" id="dcStreak"><i class="pd-i pd-i-flame" aria-hidden="true"></i> ' +
            (!user ? 'Sign in to keep a streak' : loadingHistory ? 'Checking your streak…' : streak + '-day streak') +
          '</span>' +
        '</div>' +
        '<div class="dc-days" id="dcWeekdays" role="tablist" aria-label="Choose a weekday">' + dayTabs + '</div>' +
        '<div class="dc-head">' +
          '<span class="dc-ribbon"><i class="pd-i pd-i-hands-praying" aria-hidden="true"></i> ' +
            escapeHtml(isToday ? 'Today · ' + today.weekday : today.weekday + '’s week') + '</span>' +
          '<span class="dc-date"><i class="pd-i pd-i-calendar-days" aria-hidden="true"></i> ' +
            escapeHtml(isToday ? today.dateLabel : today.shortDate) + '</span>' +
          '<span class="dc-points"><i class="pd-i pd-i-star" aria-hidden="true"></i> ' +
            challenge.points + ' points</span>' +
        '</div>' +
        '<h3 class="dc-title">' + escapeHtml(challenge.title) + '</h3>' +
        '<p class="dc-desc">' + escapeHtml(challenge.description) + '</p>' +
        (activities.length
          ? '<ul class="dc-activities">' + activities.map(function (line) {
              return '<li><i class="pd-i pd-i-circle-check" aria-hidden="true"></i><span>' + escapeHtml(line) + '</span></li>';
            }).join('') + '</ul>'
          : '') +
        (challenge.verse
          ? '<p class="dc-verse"><i class="pd-i pd-i-book" aria-hidden="true"></i> ' + escapeHtml(challenge.verse) + '</p>'
          : '') +
        (isToday
          ? '<div class="dc-foot">' +
              '<button type="button" class="dc-done-btn' + (done ? ' is-done' : '') + '" id="dcDoneBtn"' +
                (done || busy ? ' disabled aria-disabled="true"' : '') + '>' +
                '<i class="pd-i ' + (done ? 'pd-i-circle-check' : 'pd-i-check') + '" aria-hidden="true"></i> ' +
                (done ? 'I’ve Prayed today' : busy ? 'Saving your prayer…' : 'I’ve Prayed') +
              '</button>' +
              '<span class="dc-total"><i class="pd-i pd-i-medal" aria-hidden="true"></i> ' +
                pointsTotal() + ' prayer points</span>' +
            '</div>' +
            '<p class="dc-pray-status" id="dcPrayStatus" role="status">' +
              (!user
                ? 'Sign in to save today’s prayer and build an accurate streak. <a href="/account.html">Sign in or create an account</a>.'
                : loadingHistory ? 'Loading your saved prayers…'
                : checkinState.error ? escapeHtml(checkinState.error)
                : done ? 'Saved for ' + escapeHtml(today.dateLabel) + ' in ' + TZ + '.'
                : 'Your prayer will be saved once for today, ' + escapeHtml(today.dateLabel) + '.') +
            '</p>' +
            (user && checkinState.loadedFor === user.uid
              ? '<p class="dc-history">' + (historyCount
                  ? '<i class="pd-i pd-i-clock" aria-hidden="true"></i> ' + historyCount + ' day' + (historyCount === 1 ? '' : 's') + ' of prayer recorded on this account.'
                  : '<i class="pd-i pd-i-clock" aria-hidden="true"></i> No saved prayers yet — today can be the first.') + '</p>'
              : '')
          : '<p class="dc-pray-status"><i class="pd-i pd-i-info" aria-hidden="true"></i> You are viewing another weekday. Return to <strong>' + escapeHtml(today.weekday) + '</strong> to record today’s prayer.</p>') +
        '<p class="dc-tz"><i class="pd-i pd-i-clock" aria-hidden="true"></i> ' +
          'Weekday and saved date follow ' + TZ + ' (Central Africa Time, UTC+2).' +
          (result.source === 'scheduled' ? ' This plan was scheduled by the ministry.' : '') +
        '</p>' +
      '</div>';

    var button = document.getElementById('dcDoneBtn');
    if (button && !done && !busy) button.addEventListener('click', function () { complete(); });
    root.querySelectorAll('#dcWeekdays .dc-day').forEach(function (tab) {
      tab.addEventListener('click', function () {
        selectedWeekday = Number(tab.getAttribute('data-weekday'));
        render();
      });
      tab.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        var next = (selectedWeekday + (event.key === 'ArrowRight' ? 1 : 6)) % 7;
        selectedWeekday = next;
        render();
        var target = root.querySelector('#dcWeekdays .dc-day[data-weekday="' + next + '"]');
        if (target) target.focus();
      });
    });
    var activeTab = root.querySelector('#dcWeekdays .dc-day[data-weekday="' + today.weekdayIndex + '"]');
    if (activeTab && root.querySelector('#dcWeekdays').scrollWidth > root.querySelector('#dcWeekdays').clientWidth) {
      try { activeTab.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (error) { /* older browser */ }
    }
    if (!checkinState.loading && user && checkinState.loadedFor !== user.uid && !checkinState.error) {
      loadCheckins(false);
    }
    scheduleMidnightRefresh();
  }

  async function complete() {
    if (busy) return;
    var today = timeZoneParts(new Date());
    var result = challengeFor(new Date(), today.weekdayIndex);
    var key = today.dateKey;
    var user = currentUser();
    if (!user) {
      var status = document.getElementById('dcPrayStatus');
      if (status) status.innerHTML = 'Sign in to save this prayer for ' + escapeHtml(today.dateLabel) + '. <a href="/account.html">Sign in or create an account</a>.';
      if (global.PDApp && typeof global.PDApp.toast === 'function') {
        global.PDApp.toast('Sign in to save today’s prayer and keep your streak.', 'info');
      }
      return;
    }
    // A signed-in check-in is authoritative in Firestore. The local map is a
    // courtesy cache and is shared by every account on the device, so it must
    // never block a different member from recording their own prayer.
    if (serverKnowsToday(key)) {
      render();
      return;
    }
    var fb = firebaseBindings();
    if (!fb) {
      var message = 'Saving is unavailable right now. Check your connection and try again.';
      checkinState.error = message;
      render();
      return;
    }
    busy = true;
    render();
    try {
      var ref = fb.doc(fb.db, CHECKIN_COLLECTION, user.uid + '_' + key);
      var existing = await fb.getDoc(ref);
      if (!existing.exists()) {
        await fb.setDoc(ref, {
          userId: user.uid,
          email: user.email || '',
          dateKey: key,
          weekday: today.weekday,
          weekdayIndex: today.weekdayIndex,
          timezone: TZ,
          source: 'home-daily-prayer',
          prayedAt: fb.serverTimestamp(),
          createdAt: fb.serverTimestamp()
        });
      }
      checkinState.records = checkinState.records.filter(function (record) { return record.dateKey !== key; });
      checkinState.records.unshift({ id: user.uid + '_' + key, dateKey: key, weekday: today.weekday, userId: user.uid });
      checkinState.loadedFor = user.uid;
      checkinState.error = '';
      var map = completedMap();
      map[key] = true;
      writeJson(STORAGE_DONE, map);
      addPoints(result.challenge.points);
      if (global.PDApp && typeof global.PDApp.toast === 'function') {
        global.PDApp.toast('Prayer saved for ' + today.dateLabel + '.', 'success');
      }
      if (typeof global.CustomEvent === 'function') {
        try {
          global.dispatchEvent(new CustomEvent('pd:daily-prayer', {
            detail: { date: key, weekday: today.weekday, timezone: TZ }
          }));
        } catch (error) { /* UI already updated */ }
      }
    } catch (error) {
      checkinState.error = error && error.code === 'permission-denied'
        ? 'Your account cannot save this prayer yet. Please sign in again.'
        : 'Your prayer could not be saved. Check your connection and try again.';
    } finally {
      busy = false;
      render();
    }
  }

  /**
   * Re-render when the Lusaka day changes. Checking once a minute is enough for
   * a page that can stay open overnight, and it costs nothing while the tab is
   * hidden (browsers throttle timers there).
   */
  function scheduleMidnightRefresh() {
    if (refreshTimer) return;
    refreshTimer = global.setInterval(function () {
      var key = timeZoneParts(new Date()).dateKey;
      if (key !== lastRenderedKey) {
        selectedWeekday = null;
        checkinState.loadedFor = '';
        render();
      }
    }, 30000);
  }

  /** Called when sign-in state settles (or when a member returns to the tab). */
  function refresh() {
    checkinState.uid = '';
    checkinState.loadedFor = '';
    checkinState.records = [];
    checkinState.error = '';
    checkinState.loading = false;
    selectedWeekday = null;
    render();
    if (currentUser()) loadCheckins(true);
  }

  function init() {
    render();
    if (currentUser()) loadCheckins(false);
  }

  var api = {
    TZ: TZ,
    WEEKDAYS: WEEKDAYS,
    DEFAULT_PLAN: DEFAULT_PLAN,
    timeZoneParts: timeZoneParts,
    challengeFor: challengeFor,
    setSchedule: setSchedule,
    isDone: function (dateKey) {
      var user = currentUser();
      if (user && checkinState.loadedFor === user.uid) return serverKnowsToday(dateKey);
      return isLocallyDone(dateKey);
    },
    pointsTotal: pointsTotal,
    streak: function () {
      return streakFromRecords(checkinState.records, timeZoneParts(new Date()));
    },
    preview: function (weekdayIndex) {
      return challengeFor(new Date(), weekdayIndex);
    },
    complete: complete,
    refresh: refresh,
    render: render,
    init: init
  };

  global.PDDaily = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
    global.addEventListener('load', function () {
      if (currentUser()) refresh();
    }, { once: true });
    document.addEventListener('pd:ready', function () {
      if (currentUser()) refresh();
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
