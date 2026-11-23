/*!
 * Prayer Dome — optional voice commands
 * ===========================================================================
 * A small, deliberate microphone control. It never listens in the background:
 * the member opens the panel, reads the disclosure, and taps Start listening.
 * Recognition stops on the first final result, when the panel closes, when the
 * page is hidden, or on Stop. Nothing is recorded, stored or uploaded by
 * Prayer Dome. The browser's own speech-recognition service may process the
 * audio; the disclosure says so before the microphone is opened.
 *
 * Every command also works by typing, and all controls are ordinary buttons.
 * There is no auto-restart and no continuous microphone stream.
 */
(function (global) {
  'use strict';
  if (global.PDVoiceCommands) return;

  var Recognition = global.SpeechRecognition || global.webkitSpeechRecognition;
  var synth = global.speechSynthesis;
  var currentRecognition = null;
  var listening = false;
  var panel = null;
  var floatBtn = null;
  var statusEl = null;
  var heardEl = null;
  var typedInput = null;
  var startBtn = null;
  var stopBtn = null;
  var reading = false;

  var COMMANDS = [
    { match: /\b(open|go to|show|take me to|navigate to)\b.*\bdaily prayer\b|\bdaily prayer\b/, label: 'Open Daily Prayer', target: '/#dailyPrayer' },
    { match: /\b(open|go to|show|take me to|navigate to)\b.*\bbible study\b|\bbible study\b/, label: 'Open Bible Study', target: '/bible.html' },
    { match: /\b(open|go to|show|take me to|navigate to)\b.*\bbible\b|\bbible\b/, label: 'Open the Bible', target: '/bible.html' },
    { match: /\b(open|go to|show|take me to|navigate to)\b.*\bradio\b|\bradio\b/, label: 'Open Radio', target: '/radio.html' },
    { match: /\b(open|go to|show|take me to|navigate to)\b.*\blive\b|\blive service\b|\blive broadcast\b/, label: 'Open Live', target: '/live.html' },
    { match: /\b(open|go to|show|take me to|navigate to)\b.*\bgames?\b|\bgames?\b/, label: 'Open Games', target: '/game.html' },
    { match: /\b(open|go to|show|take me to|navigate to)\b.*\b(my )?profile\b|\baccount\b|\bmy profile\b/, label: 'Open My Profile', target: '/account.html' },
    { match: /\b(open|go to|show|take me to|navigate to)\b.*\bcertificates?\b|\bcertificates?\b/, label: 'Open Certificates', target: '/certificates.html' },
    { match: /\b(open|go to|show|take me to|navigate to)\b.*\bsupport\b|\bsupport\b/, label: 'Open Support', target: '/support.html' },
    { match: /\b(go back|back|previous page)\b/, label: 'Go back', action: 'back' },
    { match: /\b(stop reading|stop the reading|stop speaking)\b/, label: 'Stop reading', action: 'stop-reading' },
    { match: /\b(read this page|read the page|read aloud|read to me)\b/, label: 'Read this page', action: 'read' },
    { match: /\b(stop listening|cancel|never mind)\b/, label: 'Stop listening', action: 'stop-listening' }
  ];

  function norm(text) {
    return String(text || '').toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function injectStyles() {
    if (document.getElementById('pdVoiceStyles')) return;
    var style = document.createElement('style');
    style.id = 'pdVoiceStyles';
    style.textContent = `
      .pdvc-float{position:fixed;right:16px;bottom:calc(88px + env(safe-area-inset-bottom));z-index:1200;display:inline-flex;align-items:center;gap:7px;min-height:46px;padding:10px 14px;border:1px solid rgba(212,175,55,.55);border-radius:12px;background:#0A4D9B;color:#fff;font:800 .78rem/1 'Inter',sans-serif;box-shadow:0 10px 26px rgba(7,36,77,.3);cursor:pointer}
      .pdvc-float i{color:#f6df8a;font-size:1rem}
      .pdvc-float:hover{background:#083b78}
      .pdvc-float:focus-visible{outline:3px solid #d4af37;outline-offset:2px}
      .pdvc-float[hidden]{display:none!important}
      body.game-focus .pdvc-float,body.pd-hide-voice .pdvc-float{display:none!important}
      .pdvc-panel{position:fixed;right:16px;bottom:calc(144px + env(safe-area-inset-bottom));z-index:1201;width:min(360px,calc(100vw - 24px));max-height:min(70vh,520px);overflow:auto;background:#fff;color:#0f172a;border:1px solid #dbe3ee;border-radius:14px;box-shadow:0 24px 60px rgba(7,36,77,.28);padding:16px;font-family:'Inter',sans-serif}
      .pdvc-panel[hidden]{display:none!important}
      .pdvc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:6px}
      .pdvc-head h2{margin:0;font:800 1rem/1.3 'Poppins','Inter',sans-serif;color:#0A4D9B;display:flex;align-items:center;gap:7px}
      .pdvc-close{flex:0 0 auto;width:32px;height:32px;border:1px solid #dbe3ee;border-radius:9px;background:#f8fafc;color:#0f172a;cursor:pointer;font-size:1rem}
      .pdvc-copy{margin:0 0 10px;font-size:.73rem;line-height:1.55;color:#5b6b82}
      .pdvc-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
      .pdvc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:8px 12px;border:1px solid #0A4D9B;border-radius:9px;background:#0A4D9B;color:#fff;font:800 .74rem/1.2 'Inter',sans-serif;cursor:pointer}
      .pdvc-btn.secondary{background:#fff;color:#0A4D9B}
      .pdvc-btn.danger{background:#fff;color:#b91c1c;border-color:#fecaca}
      .pdvc-btn:disabled{opacity:.55;cursor:not-allowed}
      .pdvc-btn:focus-visible{outline:3px solid #d4af37;outline-offset:2px}
      .pdvc-typed{display:flex;gap:6px;margin-top:10px}
      .pdvc-typed input{flex:1;min-width:0;min-height:38px;padding:7px 9px;border:1px solid #cbd5e1;border-radius:8px;font:500 .76rem 'Inter',sans-serif;color:#0f172a;background:#fff}
      .pdvc-typed button{min-height:38px;padding:7px 10px}
      .pdvc-status{margin:10px 0 0;min-height:18px;font-size:.72rem;line-height:1.45;color:#5b6b82}
      .pdvc-status.is-error{color:#b91c1c;font-weight:700}
      .pdvc-heard{margin-top:8px;padding:8px 9px;border:1px dashed rgba(10,77,155,.3);border-radius:8px;background:rgba(10,77,155,.05);font-size:.74rem;color:#16324f}
      .pdvc-heard[hidden]{display:none!important}
      .pdvc-heard strong{display:block;font-size:.6rem;letter-spacing:.8px;text-transform:uppercase;color:#0A4D9B;margin-bottom:2px}
      .pdvc-consent{font-size:.68rem;color:#5b6b82;line-height:1.5;margin:8px 0 0}
      .pdvc-consent a{color:#0A4D9B;font-weight:700}
      .pdvc-listen-dot{width:9px;height:9px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:pdvcPulse 1.5s infinite}
      @keyframes pdvcPulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
      .pdvc-float.is-listening{background:#b91c1c;border-color:#fecaca}
      @media (prefers-reduced-motion:reduce){.pdvc-listen-dot{animation:none}}
      @media (max-width:480px){.pdvc-float{right:10px;bottom:calc(78px + env(safe-area-inset-bottom));padding:9px 11px}.pdvc-panel{right:8px;left:8px;width:auto;bottom:calc(132px + env(safe-area-inset-bottom))}}
    `;
    document.head.appendChild(style);
  }

  function setStatus(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-error', !!isError);
  }

  function setHeard(text) {
    if (!heardEl) return;
    var value = String(text || '').trim();
    heardEl.hidden = !value;
    heardEl.innerHTML = value ? '<strong>I heard</strong>' + escapeHtml(value) : '';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function stopListening(message) {
    if (currentRecognition) {
      try { currentRecognition.onend = null; currentRecognition.onerror = null; currentRecognition.stop(); } catch (error) { /* already stopped */ }
      currentRecognition = null;
    }
    listening = false;
    if (floatBtn) {
      floatBtn.classList.remove('is-listening');
      floatBtn.innerHTML = '<i class="pd-i pd-i-mic" aria-hidden="true"></i> Voice';
      floatBtn.setAttribute('aria-pressed', 'false');
    }
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<i class="pd-i pd-i-mic" aria-hidden="true"></i> Start listening';
    }
    if (stopBtn) stopBtn.disabled = true;
    if (message) setStatus(message);
  }

  function stopReading(message) {
    if (synth) synth.cancel();
    reading = false;
    if (message) setStatus(message);
  }

  function pageText() {
    var root = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    var clone = root.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, nav, aside, footer, header, [aria-hidden="true"], [hidden], .pd-drawer, .pd-bottom-nav, .pd-footer, .pdvc-panel, .pdvc-float').forEach(function (node) { node.remove(); });
    return String(clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function readPage() {
    if (!synth || typeof global.SpeechSynthesisUtterance !== 'function') {
      setStatus('This browser cannot read pages aloud. You can still use the voice commands.', true);
      return;
    }
    stopReading();
    var text = pageText();
    if (!text) { setStatus('There is no readable text on this page.', true); return; }
    var utterance = new SpeechSynthesisUtterance(text.slice(0, 6000));
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.onend = function () { reading = false; setStatus('Finished reading this page.'); };
    utterance.onerror = function () { reading = false; setStatus('Reading stopped.', true); };
    reading = true;
    if (stopBtn) stopBtn.disabled = false;
    setStatus('Reading this page aloud. Tap Stop reading to stop.');
    synth.speak(utterance);
  }

  function normaliseTarget(target) {
    return target === '/#dailyPrayer' && document.getElementById('dailyPrayer') ? '#dailyPrayer' : target;
  }

  function runCommand(command, spoken) {
    if (!command) {
      setStatus('I did not recognise that command. Try “Open Radio”, “Open Daily Prayer”, “Go back” or “Read this page”.', true);
      return;
    }
    setHeard((spoken ? spoken + ' — ' : '') + command.label);
    if (command.action === 'back') {
      setStatus('Going back.');
      if (global.history && global.history.length > 1) global.history.back();
      else global.location.href = '/';
      return;
    }
    if (command.action === 'stop-reading') {
      stopReading('Reading stopped.');
      return;
    }
    if (command.action === 'stop-listening') {
      stopListening('Listening stopped.');
      closePanel();
      return;
    }
    if (command.action === 'read') {
      readPage();
      return;
    }
    if (command.target) {
      setStatus('Opening ' + command.label.replace(/^Open /, '') + '…');
      var target = normaliseTarget(command.target);
      if (target.charAt(0) === '#') {
        var localTarget = document.querySelector(target);
        if (localTarget) {
          localTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setStatus('Daily Prayer is on this page. It has been brought into view.');
          return;
        }
      }
      global.location.href = target;
    }
  }

  function executeTranscript(transcript) {
    var text = norm(transcript);
    setHeard(transcript);
    if (!text) { setStatus('I did not hear a command. Tap Start listening and try again.', true); return; }
    var command = null;
    for (var i = 0; i < COMMANDS.length; i++) {
      if (COMMANDS[i].match.test(text)) { command = COMMANDS[i]; break; }
    }
    runCommand(command, transcript);
  }

  function startListening() {
    if (!Recognition) {
      setStatus('Voice recognition is not supported in this browser. Type a command below instead.', true);
      return;
    }
    if (listening) return;
    stopReading();
    setHeard('');
    setStatus('Listening… say a command such as “Open Radio”.');
    try {
      var recognition = new Recognition();
      currentRecognition = recognition;
      listening = true;
      recognition.lang = 'en-US';
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onstart = function () {
        if (stopBtn) stopBtn.disabled = false;
        if (floatBtn) {
          floatBtn.classList.add('is-listening');
          floatBtn.innerHTML = '<span class="pdvc-listen-dot" aria-hidden="true"></span> Listening…';
          floatBtn.setAttribute('aria-pressed', 'true');
        }
        if (startBtn) {
          startBtn.disabled = true;
          startBtn.innerHTML = '<span class="pdvc-listen-dot" aria-hidden="true"></span> Listening…';
        }
        setStatus('Listening. The microphone stops as soon as one command is heard.');
      };
      recognition.onresult = function (event) {
        if (!event || !event.results) return;
        var transcript = '';
        var isFinal = false;
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var result = event.results[i];
          transcript += result[0] && result[0].transcript ? result[0].transcript : '';
          if (result.isFinal) isFinal = true;
        }
        if (!transcript) return;
        setHeard(transcript);
        setStatus('Heard: “' + transcript.trim() + '”. ' + (isFinal ? 'Running the command…' : 'Waiting for the end of the command…'));
        if (isFinal) {
          stopListening();
          executeTranscript(transcript);
        }
      };
      recognition.onerror = function (event) {
        var code = event && event.error;
        stopListening();
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          setStatus('Microphone permission was denied. You can type a command below instead.', true);
        } else if (code === 'no-speech') {
          setStatus('I did not hear anything. Tap Start listening and try again, or type a command.', true);
        } else {
          setStatus('Voice recognition stopped (' + code + '). You can try again or type a command.', true);
        }
      };
      recognition.onend = function () {
        if (listening) stopListening('Listening stopped. Tap Start listening to try again.');
      };
      recognition.start();
    } catch (error) {
      stopListening('The microphone could not start. Check browser permission or type a command instead.');
    }
  }

  function openPanel() {
    if (!panel) createPanel();
    panel.hidden = false;
    if (floatBtn) floatBtn.setAttribute('aria-expanded', 'true');
    if (typedInput) { try { typedInput.focus({ preventScroll: true }); } catch (error) { typedInput.focus(); } }
    setStatus(Recognition ? 'Choose Start listening, or type a command below.' : 'Voice recognition is not supported here. Type a command below; it works the same way.');
  }

  function closePanel() {
    stopListening();
    if (panel) panel.hidden = true;
    if (floatBtn) floatBtn.setAttribute('aria-expanded', 'false');
    if (floatBtn) { try { floatBtn.focus({ preventScroll: true }); } catch (error) {} }
  }

  function createPanel() {
    panel = document.createElement('section');
    panel.className = 'pdvc-panel';
    panel.id = 'pdVoicePanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'pdVoiceTitle');
    panel.hidden = true;
    panel.innerHTML = '' +
      '<div class="pdvc-head"><h2 id="pdVoiceTitle"><i class="pd-i pd-i-mic" aria-hidden="true"></i> Voice commands</h2>' +
      '<button type="button" class="pdvc-close" aria-label="Close voice commands"><i class="pd-i pd-i-x" aria-hidden="true"></i></button></div>' +
      '<p class="pdvc-copy">Open a section, go back, or have this page read aloud. The microphone is only on while you see Listening.</p>' +
      '<div class="pdvc-actions">' +
        '<button type="button" class="pdvc-btn" data-pdvc-start><i class="pd-i pd-i-mic" aria-hidden="true"></i> Start listening</button>' +
        '<button type="button" class="pdvc-btn danger" data-pdvc-stop hidden><i class="pd-i pd-i-square" aria-hidden="true"></i> Stop</button>' +
      '</div>' +
      '<form class="pdvc-typed" data-pdvc-form><label for="pdVoiceTyped" style="position:absolute;left:-9999px;">Type a voice command</label>' +
        '<input id="pdVoiceTyped" type="text" placeholder="Type a command, e.g. Open Radio" autocomplete="off" />' +
        '<button class="pdvc-btn secondary" type="submit">Run</button></form>' +
      '<p class="pdvc-status" data-pdvc-status role="status" aria-live="polite"></p>' +
      '<div class="pdvc-heard" data-pdvc-heard hidden></div>' +
      '<p class="pdvc-consent">Your browser’s speech service may process the words you say; Prayer Dome does not record, store or upload your voice. <a href="/privacy.html">Privacy</a>. Typing a command never opens the microphone.</p>';
    document.body.appendChild(panel);
    statusEl = panel.querySelector('[data-pdvc-status]');
    heardEl = panel.querySelector('[data-pdvc-heard]');
    typedInput = panel.querySelector('#pdVoiceTyped');
    startBtn = panel.querySelector('[data-pdvc-start]');
    stopBtn = panel.querySelector('[data-pdvc-stop]');
    panel.querySelector('.pdvc-close').addEventListener('click', closePanel);
    startBtn.addEventListener('click', startListening);
    stopBtn.disabled = true;
    stopBtn.addEventListener('click', function () {
      var wasReading = reading;
      stopListening('Listening stopped.');
      if (wasReading) stopReading('Reading stopped.');
    });
    panel.querySelector('[data-pdvc-form]').addEventListener('submit', function (event) {
      event.preventDefault();
      var text = typedInput.value.trim();
      if (!text) { setStatus('Type a command first.', true); return; }
      typedInput.value = '';
      executeTranscript(text);
    });
    panel.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closePanel();
    });
    // Stop is visible but disabled until the microphone or the page reader is
    // active, so its purpose is always clear and it can stop either activity.
    if (stopBtn) stopBtn.hidden = false;
  }

  function createButton() {
    injectStyles();
    floatBtn = document.createElement('button');
    floatBtn.type = 'button';
    floatBtn.className = 'pdvc-float';
    floatBtn.id = 'pdVoiceBtn';
    floatBtn.setAttribute('aria-haspopup', 'dialog');
    floatBtn.setAttribute('aria-expanded', 'false');
    floatBtn.setAttribute('aria-label', 'Voice commands (optional)');
    floatBtn.innerHTML = '<i class="pd-i pd-i-mic" aria-hidden="true"></i> Voice';
    floatBtn.addEventListener('click', function () {
      if (panel && !panel.hidden) closePanel();
      else openPanel();
    });
    document.body.appendChild(floatBtn);
  }

  function init() {
    if (document.body.classList.contains('pd-no-voice')) return;
    createButton();
    if (!Recognition) {
      floatBtn.title = 'Voice recognition is not supported in this browser. Typed commands still work.';
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        stopListening('Listening stopped because the page is hidden.');
        stopReading();
      }
    });
    global.addEventListener('pagehide', function () { stopListening(); stopReading(); });
  }

  global.PDVoiceCommands = {
    supported: !!Recognition,
    open: openPanel,
    close: closePanel,
    stopListening: stopListening,
    stopReading: stopReading,
    execute: executeTranscript
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window);
