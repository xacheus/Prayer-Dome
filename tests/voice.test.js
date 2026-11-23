/*
 * Prayer Dome — optional voice commands
 * ---------------------------------------------------------------------------
 * These checks drive the real module in JSDOM with a stubbed browser speech
 * API. They prove the microphone is only opened after an explicit tap, that a
 * final phrase is shown and executed once, and that Stop / refusal / page
 * reading all leave the microphone closed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'assets/pd-voice-commands.js'), 'utf8');
let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
};

function environment(withRecognition = true) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main><h1>Radio</h1><p>Worship around the clock.</p></main><div id="dailyPrayer">Daily prayer</div></body></html>', {
    url: 'https://prayerdome.net/radio.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = function () { this.dataset.scrolled = 'yes'; };
  const spoken = [];
  const cancelled = [];
  function Utterance(text) { this.text = text; }
  window.SpeechSynthesisUtterance = Utterance;
  window.speechSynthesis = {
    speak(utterance) { spoken.push(utterance); },
    cancel() { cancelled.push(true); },
    get speaking() { return spoken.length > 0; }
  };
  let instances = 0;
  let starts = 0;
  let stops = 0;
  let last = null;
  if (withRecognition) {
    window.SpeechRecognition = class Recognition {
      constructor() { instances += 1; last = this; }
      start() { starts += 1; if (this.onstart) this.onstart(); }
      stop() { stops += 1; if (this.onend) this.onend(); }
    };
  }
  window.eval(source);
  // JSDOM can still be in the loading phase after eval; the module waits for
  // DOMContentLoaded so the page controls are not half-built.
  if (!window.document.getElementById('pdVoiceBtn')) {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }
  return {
    window,
    spoken,
    cancelled,
    counts: () => ({ instances, starts, stops }),
    get recognition() { return last; }
  };
}

function result(recognition, transcript, final = true) {
  const list = [Object.assign([{ transcript }], { isFinal: final })];
  list.item = (index) => list[index];
  recognition.onresult({ resultIndex: 0, results: list });
}

(function run() {
  /* --- panel is opt-in -------------------------------------------------- */
  const env = environment();
  const { window } = env;
  const api = window.PDVoiceCommands;
  const float = window.document.getElementById('pdVoiceBtn');
  let panel = window.document.getElementById('pdVoicePanel');

  t('the module exposes the documented API',
    api && typeof api.open === 'function' && typeof api.execute === 'function' &&
    typeof api.stopListening === 'function' && typeof api.stopReading === 'function');
  t('a Voice control is visible on the page', !!float && float.textContent.includes('Voice'));
  t('the microphone is not opened on page load',
    env.counts().instances === 0 && env.counts().starts === 0 && !!panel === false);
  t('typed commands work without speech support',
    typeof api.execute === 'function');

  float.click();
  panel = window.document.getElementById('pdVoicePanel');
  t('the panel opens only after the member taps Voice',
    !!panel && panel.hidden === false && panel.getAttribute('role') === 'dialog');
  t('the disclosure is readable before permission is requested',
    panel.textContent.includes('does not record, store or upload your voice') &&
    panel.querySelector('a[href="/privacy.html"]') !== null);
  t('the panel starts with Stop disabled', window.document.querySelector('[data-pdvc-stop]').disabled === true);
  t('no microphone starts when the panel opens', env.counts().started === undefined && env.counts().starts === 0);

  /* --- explicit start, recognised words, one execution ------------------ */
  window.document.querySelector('[data-pdvc-start]').click();
  t('Start listening opens exactly one recognition session',
    env.counts().instances === 1 && env.counts().starts === 1);
  t('the listening state is visible on the button and in the panel',
    float.classList.contains('is-listening') && panel.textContent.includes('Listening'));
  result(env.recognition, 'Read this page');
  t('the recognised words are shown back to the member',
    panel.textContent.includes('I heard') && panel.textContent.includes('Read this page'));
  t('a final phrase stops the microphone immediately',
    env.counts().stops === 1 && !float.classList.contains('is-listening'));
  t('“Read this page” speaks the visible page text',
    env.spoken.length === 1 && /Radio/.test(env.spoken[0].text) &&
    panel.textContent.includes('Reading this page aloud'));

  api.execute('stop reading');
  t('“Stop reading” cancels speech immediately',
    env.cancelled.length >= 1 && panel.textContent.includes('Reading stopped'));

  /* --- Daily Prayer is a real on-page anchor ---------------------------- */
  api.execute('Open Daily Prayer');
  const prayer = window.document.getElementById('dailyPrayer');
  t('Daily Prayer scrolls into view when it is on the current page',
    prayer.dataset.scrolled === 'yes' && panel.textContent.includes('brought into view'));

  /* --- microphone refusal is explained and leaves it closed ------------- */
  window.document.querySelector('[data-pdvc-start]').click();
  env.recognition.onerror({ error: 'not-allowed' });
  t('a denied microphone is explained with a typed fallback',
    panel.textContent.includes('permission was denied') &&
    panel.textContent.includes('type a command') &&
    env.counts().stops === 2 && !float.classList.contains('is-listening'));

  /* --- closing the panel also releases the microphone ------------------- */
  window.document.querySelector('[data-pdvc-start]').click();
  window.document.querySelector('.pdvc-close').click();
  t('closing the panel stops listening and hides it',
    env.counts().stops === 3 && panel.hidden === true && !float.classList.contains('is-listening'));

  /* --- unsupported browsers still get typed commands -------------------- */
  const plain = environment(false);
  t('unsupported speech recognition degrades to typed commands',
    plain.window.PDVoiceCommands.supported === false);
  plain.window.document.getElementById('pdVoiceBtn').click();
  t('the unsupported message never opens a microphone',
    plain.window.document.getElementById('pdVoicePanel').textContent.includes('not supported') &&
    plain.counts().starts === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
