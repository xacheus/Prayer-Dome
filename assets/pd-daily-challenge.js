/*!
 * Prayer Dome — Daily Challenge
 * ===========================================================================
 * A challenge belongs to one calendar day in the ministry's own time zone,
 * Africa/Lusaka (CAT, UTC+2, no daylight saving). Reading the weekday from the
 * visitor's device is wrong for a member travelling or whose phone is set to
 * another region, and it produced "Monday" labels on Sunday challenges. Every
 * label here is derived from a single Intl format in that zone, so the heading,
 * the date, the scheduled challenge and the completion key can never disagree.
 *
 * Administrators can schedule a challenge for a specific date (Firestore
 * `dailyChallenges`, publicly readable only when `published` is true). When no
 * scheduled item exists for today, the built-in seven-day rhythm is used, so
 * the section is never empty or wrong.
 */
(function (global) {
  'use strict';

  var TZ = 'Africa/Lusaka';
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var STORAGE_DONE = 'pd_daily_challenge_done';
  var STORAGE_POINTS = 'pd_daily_challenge_points';

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
      // A browser without Intl time zones: fall back to its local zone rather
      // than refusing to show a challenge at all.
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
    } catch (error) { /* private mode: completion is still shown for this visit */ }
  }

  function completedMap() {
    return readJson(STORAGE_DONE, {});
  }

  function isDone(dateKey) {
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
    if (!item.date || typeof item.date !== 'string') {
      item.date = '';
    }
    item.date = item.date.slice(0, 10);
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

  /** The challenge for a moment: exact date first, then weekday, then built-in. */
  function challengeFor(date) {
    var today = timeZoneParts(date);
    var exact = null;
    var weekdayMatch = null;
    schedule.forEach(function (item) {
      if (item.date === today.dateKey) exact = item;
      else if (!item.date && item.weekday === today.weekdayIndex) weekdayMatch = item;
      else if (item.weekday === today.weekdayIndex && !weekdayMatch) weekdayMatch = item;
    });
    var chosen = exact || weekdayMatch || DEFAULT_PLAN[today.weekdayIndex] || DEFAULT_PLAN[0];
    return {
      today: today,
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
    var result = challengeFor(new Date());
    var today = result.today;
    var challenge = result.challenge;
    var done = isDone(today.dateKey);
    var activities = activityList(challenge.activities);
    lastRenderedKey = today.dateKey;

    root.innerHTML = '' +
      '<div class="dc-card' + (done ? ' is-done' : '') + '">' +
        '<div class="dc-head">' +
          '<span class="dc-ribbon"><i class="pd-i pd-i-flame" aria-hidden="true"></i> ' +
            escapeHtml(today.weekday) + ' Daily Challenge</span>' +
          '<span class="dc-date"><i class="pd-i pd-i-calendar-days" aria-hidden="true"></i> ' +
            escapeHtml(today.dateLabel) + '</span>' +
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
        '<div class="dc-foot">' +
          '<button type="button" class="dc-done-btn' + (done ? ' is-done' : '') + '" id="dcDoneBtn"' +
            (done ? ' disabled aria-disabled="true"' : '') + '>' +
            '<i class="pd-i ' + (done ? 'pd-i-circle-check' : 'pd-i-check') + '" aria-hidden="true"></i> ' +
            (done ? 'Completed today' : 'Mark today’s challenge complete') +
          '</button>' +
          '<span class="dc-total"><i class="pd-i pd-i-medal" aria-hidden="true"></i> ' +
            pointsTotal() + ' challenge points</span>' +
        '</div>' +
        '<p class="dc-tz"><i class="pd-i pd-i-clock" aria-hidden="true"></i> ' +
          'Weekday and date follow ' + TZ + ' (Central Africa Time, UTC+2).' +
          (result.source === 'scheduled' ? ' This challenge was scheduled by the ministry.' : '') +
        '</p>' +
      '</div>';

    var button = document.getElementById('dcDoneBtn');
    if (button && !done) {
      button.addEventListener('click', function () { complete(); });
    }
    scheduleMidnightRefresh();
  }

  function complete() {
    var result = challengeFor(new Date());
    var key = result.today.dateKey;
    if (isDone(key)) { render(); return; }
    var map = completedMap();
    map[key] = true;
    writeJson(STORAGE_DONE, map);
    var total = addPoints(result.challenge.points);
    var button = document.getElementById('dcDoneBtn');
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      button.classList.add('is-done');
      button.innerHTML = '<i class="pd-i pd-i-circle-check" aria-hidden="true"></i> Completed today';
    }
    var card = document.querySelector('#dailyChallenge .dc-card');
    if (card) card.classList.add('is-done');
    var totalEl = document.querySelector('#dailyChallenge .dc-total');
    if (totalEl) {
      totalEl.innerHTML = '<i class="pd-i pd-i-medal" aria-hidden="true"></i> ' + total + ' challenge points';
    }
    if (global.PDApp && typeof global.PDApp.toast === 'function') {
      global.PDApp.toast('Daily challenge complete — ' + result.challenge.points + ' points added.', 'success');
    }
    if (typeof global.CustomEvent === 'function') {
      try {
        global.dispatchEvent(new CustomEvent('pd:daily-challenge', {
          detail: { date: key, points: result.challenge.points, total: total }
        }));
      } catch (error) { /* older browsers: the UI is already updated */ }
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
      if (key !== lastRenderedKey) render();
    }, 30000);
  }

  function init() {
    render();
  }

  var api = {
    TZ: TZ,
    WEEKDAYS: WEEKDAYS,
    DEFAULT_PLAN: DEFAULT_PLAN,
    timeZoneParts: timeZoneParts,
    challengeFor: challengeFor,
    setSchedule: setSchedule,
    isDone: isDone,
    pointsTotal: pointsTotal,
    complete: complete,
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
  }
})(typeof window !== 'undefined' ? window : globalThis);
