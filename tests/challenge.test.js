/*
 * Daily Prayer (formerly the home-page weekly challenge).
 *
 * Runs assets/pd-daily-challenge.js against the real index.html DOM with a
 * small Firestore stand-in. It verifies the Africa/Lusaka weekday, automatic
 * current-day selection, the "I've Prayed" record and duplicate protection.
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, ok, extra) {
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
}

try {
  require('jsdom');
} catch (e) {
  console.log('SKIP  jsdom not installed — run: npm install --no-save jsdom');
  process.exit(0);
}

const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'assets/pd-daily-challenge.js'), 'utf8');

const dom = new JSDOM(html, {
  url: 'https://prayerdome.net/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.matchMedia = window.matchMedia || function () {
      return { matches: false, addListener() {}, removeListener() {} };
    };
    window.scrollTo = () => {};
    window.confetti = () => {};
    window.moment = (d) => ({ format: () => String(d), toDate: () => new Date(d) });
    try { window.HTMLElement.prototype.scrollIntoView = function () {}; } catch (e) {}
  }
});
const w = dom.window;
const d = w.document;

const writes = [];
const today = (() => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lusaka', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return parts.year + '-' + parts.month + '-' + parts.day;
})();

w.PDApp = {
  _fb: {
    db: {}, auth: { currentUser: { uid: 'member-1', email: 'member@example.com' } },
    doc: (db, collection, id) => ({ path: collection + '/' + id }),
    collection: (db, name) => ({ name }),
    query: (ref) => ref,
    where: () => ({}),
    limit: () => ({}),
    getDocs: async () => ({ forEach() {} }),
    getDoc: async () => ({ exists: () => false }),
    setDoc: async (ref, data) => { writes.push({ ref, data }); },
    serverTimestamp: () => 'SERVER_TS'
  },
  toast: () => {}
};

(async () => {
  try {
    w.eval(script);
    const daily = w.PDDaily;
    if (daily && daily.init) daily.init();
    t('PDDaily engine exposed', typeof daily === 'object');
    t('weekly challenge card is gone from the home page', !d.getElementById('weeklyChallenge'));
    t('Daily Prayer card exists', !!d.getElementById('dailyChallenge'));
    t('today is selected automatically', d.querySelectorAll('#dcWeekdays .dc-day.is-selected').length === 1);
    t('all seven weekdays are available', d.querySelectorAll('#dcWeekdays .dc-day[role="tab"]').length === 7);
    t('the selected tab is the Lusaka weekday, not a hardcoded Monday',
      Number(d.querySelector('#dcWeekdays .dc-day.is-selected')?.getAttribute('data-weekday')) ===
      daily.timeZoneParts(new Date()).weekdayIndex);
    t('all seven plans match their weekday',
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        .every((day, index) => daily.preview(index).challenge.title.startsWith(day)));
    // UTC Sunday 22:30 is Monday 00:30 in Lusaka (CAT, UTC+2).
    const tz = daily.timeZoneParts(new Date('2026-11-22T22:30:00Z'));
    t('Lusaka calendar rolls over before the UTC day does',
      tz.weekday === 'Monday' && tz.dateKey === '2026-11-23');
    t('the prayer button is labelled', (d.getElementById('dcDoneBtn')?.textContent || '').includes('I’ve Prayed'));

    await daily.complete();
    await new Promise(resolve => setTimeout(resolve, 0));
    t('I’ve Prayed writes one Firestore check-in',
      writes.length === 1 && writes[0].ref.path === 'dailyPrayerCheckins/member-1_' + today);
    t('the check-in carries the Lusaka date, not a device date',
      writes[0] && writes[0].data.dateKey === today && writes[0].data.timezone === 'Africa/Lusaka');
    t('completion is remembered locally for the same day',
      JSON.parse(w.localStorage.getItem('pd_daily_prayer_done') || '{}')[today] === true);

    await daily.complete();
    await new Promise(resolve => setTimeout(resolve, 0));
    t('a second tap cannot create a duplicate check-in', writes.length === 1);
    t('the button shows the saved state', (d.getElementById('dcDoneBtn')?.textContent || '').includes('I’ve Prayed today'));
  } catch (e) {
    fail++;
    console.log('FAIL  exception: ' + e.stack);
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
