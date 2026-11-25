/*
 * Prayer Dome — Bible Game UI and Domey conversation
 * ===========================================================================
 * These promises are member-facing:
 *   1. Every game section has a visible tab on a 320 px phone.
 *   2. Focused play is a normal, scrollable page — no fixed overlay, no
 *      clipped answers, no answer hidden behind a footer.
 *   3. Talk to Domey is one action: it asks for the microphone in that tap and
 *      never shows a second "Start talking" step.
 *   4. The status says Listening only while a recognition session is live.
 *   5. Type to Domey is independent from voice; switching keeps the same
 *      conversation and the same question.
 *   6. A typed or spoken question is conversation, not an answer, and the
 *      correct choice is never revealed before the member answers.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.error('jsdom is not installed. Run:  npm install');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const GAME = read('game.html');
const MASCOT = read('assets/pd-mascot.js');
const MASCOT_CSS = read('assets/pd-mascot.css');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
};

function ruleBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 's'));
  return match ? match[1] : '';
}

(async function run() {
  /* ------------------------------------------------ 1. the visible shell */
  const tabs = [...GAME.matchAll(/data-game-tab="([^"]+)"/g)].map((m) => m[1]);
  t('all four game sections have a visible tab', tabs.length === 4 &&
    ['panel-talk', 'domeyTopics', 'gameProgress', 'domeyBadges'].every((id) => tabs.includes(id)), tabs.join(', '));
  t('every tab points at a section that exists', tabs.every((id) =>
    new RegExp(`id="${id}"`).test(GAME)));
  t('the tab bar is a four-column grid, not a hidden or clipped row',
    /\.game-tabbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4/s.test(GAME) &&
    !/\.game-tab[^}]*display:\s*none/.test(GAME));
  t('the tabs stay out of the question with a measured scroll offset',
    /scroll-margin-top:\s*calc\(var\(--pd-game-sticky/.test(GAME) &&
    /--pd-game-tabbar-h/.test(GAME) && /syncStickyOffset/.test(GAME));
  t('safe areas are respected at the top, sides and bottom',
    /env\(safe-area-inset-top/.test(GAME) && /env\(safe-area-inset-bottom/.test(GAME) &&
    /env\(safe-area-inset-left/.test(GAME) && /env\(safe-area-inset-right/.test(GAME));

  /* --------------------------------------- 2. answers can never be clipped */
  const focusPanel = ruleBlock(GAME, 'body.game-focus #panel-talk');
  t('focused play is not a fixed viewport overlay', !/position:\s*fixed/.test(focusPanel) &&
    /height:\s*auto/.test(focusPanel) && /overflow:\s*visible/.test(focusPanel));
  t('the conversation itself is allowed to grow',
    /body\.game-focus \.pdm-companion \.pdm-dialog\s*\{[^}]*overflow:\s*visible/s.test(GAME) &&
    /max-height:\s*none/.test(ruleBlock(GAME, 'body.game-focus .pdm-companion .pdm-dialog')));
  t('the document still scrolls in focused play', /body\.game-focus\s*\{\s*overflow:\s*visible/.test(GAME));
  t('the illustration shrinks on small screens instead of pushing answers away',
    /body\.game-focus \.pdm-companion \.pdm-stage\s*\{[^}]*clamp\(96px,\s*18dvh,\s*152px\)/s.test(GAME) &&
    /@media \(max-height: 560px\) and \(orientation: landscape\)/.test(GAME));
  t('the typed answer box is visible in focused play (and hidden only when empty)',
    /body\.game-focus \.pdm-answer\s*\{[^}]*display:\s*flex/s.test(GAME) &&
    /body\.game-focus \.pdm-answer\[hidden\]\s*\{\s*display:\s*none/.test(GAME));
  t('answer labels wrap instead of being cut with an ellipsis',
    /\.pdm-chip-label[^}]*overflow-wrap:\s*break-word/.test(MASCOT_CSS) &&
    /\.pdm-chip-label[^}]*white-space:\s*normal/.test(MASCOT_CSS));
  t('the reading pace holds the answer and its verse until Continue',
    /pace:\s*'manual'/.test(GAME) && /waitForContinue/.test(MASCOT));

  /* ----------------------------------------- 3. one-tap start and controls */
  t('Talk to Domey is the deliberate start action',
    /onclick="talkWithDomey\(\)"/.test(GAME) && /window\.talkWithDomey/.test(GAME));
  t('there is no second Start talking / Start the show step',
    !new RegExp('Start Talking', 'i').test(GAME.replace(/<!--[\s\S]*?-->/g, '')) &&
    !/Start the show/.test(GAME.replace(/<!--[\s\S]*?-->/g, '')));
  t('Talk to Domey asks for the microphone in the same gesture',
    /if \(host\.canHear\(\)\) host\.enableMic\(\);/.test(GAME));
  t('a tap on the drawing cannot open the microphone by itself',
    /listenOnTap:\s*false/.test(GAME));
  t('the microphone is never touched while the page is loading',
    !/DOMContentLoaded[\s\S]{0,900}enableMic\(/.test(GAME));
  t('end, mute, pause and resume controls exist and are labelled',
    ['domeyEndBtn', 'domeyMuteBtn', 'domeyPauseListenBtn', 'domeyModeBtn'].every((id) =>
      new RegExp(`id="${id}"`).test(GAME)) &&
    /Pause listening/.test(GAME) && /Resume listening/.test(GAME) &&
    /End conversation/.test(GAME) && /Unmute Domey/.test(GAME));
  t('the status states are spelled out for the member',
    ['Listening', 'Processing', 'Domey is speaking', 'Microphone permission required',
      'Connection error', 'Microphone error'].every((state) => GAME.includes(state)));
  t('Listening is emitted only when recognition really started',
    /recognition\.start\(\)[\s\S]{0,260}notifyStart\(\)/.test(MASCOT) &&
    /onStart:\s*function \(\) \{[\s\S]{0,180}emit\('listening', true\)/.test(MASCOT));
  t('typing and voice share the same question and history',
    /self\._questionTalk = handleTalk/.test(MASCOT) &&
    /this\._continueTalk = function/.test(MASCOT) &&
    /host\.dialog\.insertBefore\(ui\.controls, host\.chips\)/.test(GAME));

  /* ----------------------------------- 4. the conversation in a real DOM */
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>',
    { runScripts: 'outside-only', url: 'https://prayerdome.net/game' });
  const w = dom.window;
  w.eval(MASCOT);
  const M = w.PDMascot;
  const host = M.mount('#stage', { name: 'Domey', layout: 'companion', log: true });
  const hurry = setInterval(() => { try { host.hurry(); } catch (e) {} }, 60);

  const until = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await sleep(40); }
    return false;
  };
  const submit = (text) => {
    host.answerInput.value = text;
    host.answerForm.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  };

  const question = host.ask({
    text: 'Who built the ark?', kind: 'choice',
    choices: ['Noah', 'Moses', 'Abraham', 'Job'],
    correctIndex: 0, verse: 'Genesis 6:14'
  });
  await until(() => !host.answerForm.hasAttribute('hidden'));

  submit('which verse is this?');
  await sleep(250);
  t('asking for the Bible passage keeps the question open',
    !!host.answerResolve && /Genesis 6:14/.test(host.logEl.textContent));
  t('the passage reply never gives the correct choice away',
    !/Noah/.test(host.logEl.textContent));

  submit('tell me the answer');
  await sleep(250);
  t('a direct request for the answer is refused before answering',
    !!host.answerResolve && !/Noah/.test(host.logEl.textContent));

  submit('Who is Moses?');
  await sleep(250);
  t('a real question is answered as a question, not scored as a wrong answer',
    !!host.answerResolve && /choose the answer/.test(host.logEl.textContent));

  submit('Noah');
  const answered = await question;
  t('a real typed answer is still judged and scored', answered.right === true && answered.source === 'typed');

  const continuing = host.waitForContinue({ label: 'Next question' });
  await until(() => !host.answerForm.hasAttribute('hidden'));
  submit('why?');
  await sleep(250);
  t('after answering, Domey explains why the answer is right',
    /correct/.test(host.logEl.textContent) && /Genesis 6:14/.test(host.logEl.textContent));
  submit('next');
  t('typing "next" continues without another button hunt',
    (await continuing) === 'typed');

  /* Text mode is genuinely independent of the microphone. */
  const quiet = M.mount(w.document.createElement('div'), { name: 'Domey', layout: 'companion', log: true });
  quiet.autoListen = false;
  const quietQuestion = quiet.ask({ text: 'Name a book of the Bible.', kind: 'text', listen: false });
  await until(() => !quiet.answerForm.hasAttribute('hidden'));
  t('text mode opens no microphone at all',
    quiet.micEnabled === false && quiet.micState() !== 'active');
  quiet.answerInput.value = 'Genesis';
  quiet.answerForm.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  t('text mode answers through the same input',
    (await quietQuestion).source === 'typed');
  quiet.destroy();

  clearInterval(hurry);
  host.destroy();
  w.close();

  /* ------------------------------------ 5. the real page module, booted once */
  const gameDom = new JSDOM(GAME, {
    url: 'https://prayerdome.net/game',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = window.matchMedia || function () {
        return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} };
      };
      window.scrollTo = () => {};
      let micStarts = 0;
      window.__micStarts = () => micStarts;
      window.SpeechRecognition = function FakeRecognition() {
        const self = this;
        self.started = false;
        self.start = () => { self.started = true; micStarts += 1; };
        self.stop = () => { if (self.onend) self.onend({}); };
        self.abort = () => {};
      };
    }
  });
  const gw = gameDom.window;
  gw.eval(read('assets/pd-domey-questions.js'));
  gw.eval(MASCOT);
  const moduleCode = (GAME.match(/<script type="module">([\s\S]*?)<\/script>/) || [])[1];
  gw.eval(moduleCode);
  await sleep(180);

  const gdoc = gw.document;
  t('the page boots with Domey mounted but the microphone untouched',
    gdoc.getElementById('domeyStage').classList.contains('pd-mascot') && gw.__micStarts() === 0);
  t('the panel starts with two clear ways in and no second Start step',
    /Talk to Domey/.test(gdoc.getElementById('domeyStartChoices').textContent) &&
    /Type to Domey/.test(gdoc.getElementById('domeyStartChoices').textContent));

  gdoc.getElementById('domeyStartBtn').click();
  await sleep(160);
  t('one tap on Talk to Domey opens focused play and asks for the mic',
    gdoc.body.classList.contains('game-focus') && gw.__micStarts() >= 1);
  t('the start choices get out of the way and the live controls appear',
    gdoc.getElementById('domeyStartChoices').hidden === true &&
    gdoc.getElementById('domeyGameControls').hidden === false);
  t('the controls live inside the conversation, above the answer options',
    gdoc.getElementById('domeyGameControls').closest('.pdm-dialog') !== null &&
    gdoc.getElementById('domeyGameControls').nextElementSibling &&
    gdoc.getElementById('domeyGameControls').nextElementSibling.classList.contains('pdm-chips'));
  t('the live status is a real, announced state',
    gdoc.getElementById('domeyLiveStatus').getAttribute('role') === 'status' &&
    gdoc.getElementById('domeyLiveStatus').getAttribute('aria-live') === 'polite' &&
    gdoc.getElementById('domeyLiveStatus').getAttribute('data-state') !== null);

  gdoc.getElementById('domeyMuteBtn').click();
  t('Mute Domey becomes Unmute Domey', /Unmute Domey/.test(gdoc.getElementById('domeyMuteBtn').textContent));
  gdoc.getElementById('domeyMuteBtn').click();
  t('unmuting restores the spoken voice control', /Mute Domey/.test(gdoc.getElementById('domeyMuteBtn').textContent));

  gdoc.getElementById('domeyPauseListenBtn').click();
  await sleep(60);
  t('Pause listening stops the ears without ending the conversation',
    /Resume listening/.test(gdoc.getElementById('domeyPauseListenBtn').textContent) &&
    gdoc.body.classList.contains('game-focus'));
  gdoc.getElementById('domeyPauseListenBtn').click();
  await sleep(60);
  t('Resume listening opens them again', /Pause listening/.test(gdoc.getElementById('domeyPauseListenBtn').textContent));

  gdoc.getElementById('domeyEndBtn').click();
  await sleep(80);
  t('End conversation leaves focused play and offers the two ways in again',
    !gdoc.body.classList.contains('game-focus') &&
    gdoc.getElementById('domeyStartChoices').hidden === false &&
    gdoc.getElementById('domeyGameControls').hidden === true);

  const beforeType = gw.__micStarts();
  gdoc.getElementById('domeyTypeBtn').click();
  await sleep(120);
  t('Type to Domey starts the same game without asking for the microphone',
    gdoc.body.classList.contains('game-focus') && gw.__micStarts() === beforeType &&
    gdoc.getElementById('domeyPauseListenBtn').hidden === true);
  t('the switch to voice is offered inside the conversation',
    /Use voice/.test(gdoc.getElementById('domeyModeBtn').textContent));
  // Skip the greeting dialogue so the test reaches the open question quickly.
  const textHurry = setInterval(() => {
    const bubble = gdoc.querySelector('.pdm-bubble');
    if (bubble) bubble.click();
  }, 60);
  gdoc.getElementById('domeyModeBtn').click();
  const switched = await until(() => gw.__micStarts() > beforeType &&
    gdoc.getElementById('domeyPauseListenBtn').hidden === false &&
    /Type instead/.test(gdoc.getElementById('domeyModeBtn').textContent), 8000);
  clearInterval(textHurry);
  t('switching to voice opens the ears without restarting the question',
    switched === true);
  gdoc.getElementById('domeyEndBtn').click();
  try { gw.PDMascot.stopped(); } catch (e) {}
  gameDom.window.close();

  console.log(`\nGame UI checks: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
