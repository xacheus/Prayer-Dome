/*!
 * Prayer Dome — game sound engine
 * ===========================================================================
 * Clear, warm, "arcade but church" cues for the Domey game, synthesised live
 * in the browser. There are no audio files to download, so every sound is
 * instant, works offline, and never clashes with the voice.
 *
 *   PDSFX.play('correct');
 *   PDSFX.toggle();          // returns the new enabled state
 *   PDSFX.setEnabled(true);
 *
 * Design notes
 *   • A compressor + a short algorithmic room keep cues smooth instead of
 *     piercing, and the master level is deliberately polite.
 *   • Envelopes are exponential (as the ear expects), with a tiny attack so
 *     nothing clicks.
 *   • Correct answers get a bright major arpeggio; wrong answers get a soft,
 *     kind "not quite" — never a harsh buzzer.
 *   • Everything is unlocked by the first real tap, as mobile browsers require.
 * ===========================================================================
 */
(function (global) {
  'use strict';

  var KEY = 'pd_game_sfx';
  var MASTER = 0.34;

  var enabled = true;
  try {
    var saved = global.localStorage && global.localStorage.getItem(KEY);
    if (saved === '0') enabled = false;
  } catch (e) { /* private mode */ }

  var ctx = null;
  var master = null;
  var comp = null;
  var room = null;
  var roomGain = null;

  function ensureContext() {
    if (ctx) return ctx;
    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) return null;
    try { ctx = new Ctor(); } catch (e) { ctx = null; return null; }

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 22;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.24;

    master = ctx.createGain();
    master.gain.value = MASTER;
    master.connect(comp);
    comp.connect(ctx.destination);

    // Small, bright room — enough to make a cue feel like it is in the room
    // with Domey, not in an empty metal box.
    try {
      room = ctx.createConvolver();
      var rate = ctx.sampleRate;
      var length = Math.floor(rate * 0.55);
      var impulse = ctx.createBuffer(2, length, rate);
      for (var channel = 0; channel < 2; channel += 1) {
        var data = impulse.getChannelData(channel);
        for (var i = 0; i < length; i += 1) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.1);
        }
      }
      room.buffer = impulse;
      roomGain = ctx.createGain();
      roomGain.gain.value = 0.17;
      room.connect(roomGain);
      roomGain.connect(master);
    } catch (e) { room = null; }
    return ctx;
  }

  function unlock() {
    var c = ensureContext();
    if (c && c.state === 'suspended') { try { c.resume(); } catch (e) {} }
  }

  function tone(options) {
    var c = ensureContext();
    if (!c || !enabled) return;
    if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    var now = c.currentTime + (options.at || 0);
    var osc = c.createOscillator();
    var gain = c.createGain();
    var filter = c.createBiquadFilter();
    osc.type = options.type || 'sine';
    osc.frequency.setValueAtTime(options.freq, now);
    if (options.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.to), now + (options.glide || options.dur));
    if (options.detune) osc.detune.value = options.detune;
    filter.type = options.filter || 'lowpass';
    filter.frequency.value = options.cutoff || 6200;
    filter.Q.value = 0.7;
    var peak = (options.gain == null ? 0.16 : options.gain);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + (options.attack || 0.012));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (options.dur || 0.28));
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    if (room) gain.connect(room);
    osc.start(now);
    osc.stop(now + (options.dur || 0.28) + 0.05);
  }

  /* Shaped noise: a shaker, a swoosh, applause. Short, filtered, soft edges. */
  function noise(options) {
    var c = ensureContext();
    if (!c || !enabled) return;
    if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    var now = c.currentTime + (options.at || 0);
    var dur = options.dur || 0.2;
    var frames = Math.max(1, Math.floor(c.sampleRate * (dur + 0.06)));
    var buffer = c.createBuffer(1, frames, c.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < frames; i += 1) {
      var t = i / frames;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, options.decay || 2.2);
    }
    var src = c.createBufferSource();
    src.buffer = buffer;
    var filter = c.createBiquadFilter();
    filter.type = options.filter || 'bandpass';
    filter.frequency.setValueAtTime(options.freq || 1800, now);
    if (options.to) filter.frequency.exponentialRampToValueAtTime(Math.max(80, options.to), now + dur);
    filter.Q.value = options.q == null ? 0.9 : options.q;
    var gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(options.gain == null ? 0.11 : options.gain, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    if (room) gain.connect(room);
    src.start(now);
  }

  var CUES = {
    /* UI ------------------------------------------------------------------ */
    tap: function () {
      tone({ freq: 880, to: 1040, dur: 0.075, gain: 0.055, type: 'sine' });
    },
    select: function () {
      tone({ freq: 660, dur: 0.06, gain: 0.05, type: 'triangle' });
      tone({ freq: 990, at: 0.04, dur: 0.08, gain: 0.04, type: 'sine' });
    },
    pop: function () {
      tone({ freq: 520, to: 880, dur: 0.11, gain: 0.075, type: 'sine' });
    },
    swoosh: function () {
      noise({ freq: 2600, to: 420, dur: 0.3, gain: 0.075, q: 0.7, decay: 1.7 });
    },
    tick: function () {
      noise({ freq: 2400, dur: 0.035, gain: 0.04, q: 2.4, decay: 4 });
      tone({ freq: 1450, dur: 0.04, gain: 0.028, type: 'triangle' });
    },

    /* The show ------------------------------------------------------------ */
    start: function () {
      noise({ freq: 900, to: 5200, dur: 0.34, gain: 0.05, q: 0.65, decay: 1.6 });
      [523.25, 659.25, 783.99, 1046.5].forEach(function (freq, index) {
        tone({ freq: freq, at: 0.06 + index * 0.085, dur: 0.24, gain: 0.1, type: 'triangle', cutoff: 5200 });
      });
    },
    question: function () {
      tone({ freq: 392, dur: 0.16, gain: 0.07, type: 'sine' });
      tone({ freq: 587.33, at: 0.09, dur: 0.22, gain: 0.075, type: 'sine' });
    },
    listen: function () {
      tone({ freq: 640, to: 760, dur: 0.1, gain: 0.05, type: 'sine' });
    },
    correct: function () {
      // A bright, smiling major arpeggio with a little shimmer on top.
      [1046.5, 1318.5, 1568, 2093].forEach(function (freq, index) {
        tone({ freq: freq, at: index * 0.055, dur: 0.22, gain: 0.1, type: 'triangle', cutoff: 7000 });
        tone({ freq: freq * 2, at: index * 0.055 + 0.01, dur: 0.16, gain: 0.028, type: 'sine', cutoff: 9000 });
      });
      noise({ freq: 5200, dur: 0.26, gain: 0.026, q: 0.5, decay: 2.6, at: 0.02 });
    },
    wrong: function () {
      // Kind, not punishing: a marimba "hmm" under a soft low chime.
      tone({ freq: 329.63, to: 293.66, dur: 0.3, gain: 0.09, type: 'triangle', cutoff: 1800 });
      tone({ freq: 220, at: 0.16, dur: 0.38, gain: 0.07, type: 'sine', cutoff: 1200 });
      noise({ freq: 700, dur: 0.1, gain: 0.02, q: 1.2, decay: 3 });
    },
    streak: function () {
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach(function (freq, index) {
        tone({ freq: freq, at: index * 0.06, dur: 0.2, gain: 0.085, type: 'triangle', cutoff: 6800 });
      });
    },
    celebrate: function () {
      [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568].forEach(function (freq, index) {
        tone({ freq: freq, at: index * 0.07, dur: 0.34, gain: 0.1, type: 'triangle', cutoff: 7600 });
      });
      tone({ freq: 261.63, at: 0, dur: 0.65, gain: 0.05, type: 'sine', cutoff: 900 });
      noise({ freq: 3400, dur: 0.5, gain: 0.03, q: 0.5, decay: 2.2 });
    },
    finish: function () {
      // Applause is shaped noise — it reads as a room full of people instantly.
      for (var burst = 0; burst < 9; burst += 1) {
        noise({ at: 0.04 + burst * 0.1, dur: 0.05, gain: 0.028 + Math.random() * 0.014, freq: 1500 + Math.random() * 1900, q: 0.8, decay: 3 });
      }
      noise({ freq: 2100, dur: 1.1, gain: 0.02, q: 0.4, decay: 1.6 });
      [523.25, 659.25, 783.99, 1046.5].forEach(function (freq, index) {
        tone({ freq: freq, at: index * 0.1, dur: 0.5, gain: 0.09, type: 'triangle', cutoff: 6400 });
      });
    },
    badge: function () {
      tone({ freq: 1568, dur: 0.3, gain: 0.06, type: 'sine', cutoff: 8000 });
      tone({ freq: 2093, at: 0.09, dur: 0.42, gain: 0.05, type: 'sine', cutoff: 9000 });
      tone({ freq: 1046.5, at: 0.02, dur: 0.4, gain: 0.04, type: 'triangle', cutoff: 5200 });
    },
    levelup: function () {
      [392, 523.25, 659.25, 783.99, 1046.5, 1318.5].forEach(function (freq, index) {
        tone({ freq: freq, at: index * 0.075, dur: 0.3, gain: 0.1, type: 'triangle', cutoff: 8000 });
      });
    },
    heart: function () {
      tone({ freq: 523.25, dur: 0.18, gain: 0.06, type: 'sine' });
      tone({ freq: 783.99, at: 0.12, dur: 0.24, gain: 0.05, type: 'sine' });
    }
  };

  var ALIAS = {
    fanfare: 'celebrate', applause: 'finish', dance: 'streak', sad: 'wrong',
    ding: 'badge', whoosh: 'swoosh', boing: 'pop', question: 'question'
  };

  /* A short, phone-native buzz that matches the audio cue. Vibration is the
     one extra sense an installed app has over a web page, and it makes a
     correct answer feel instant on a phone in the hand. */
  var HAPTICS = {
    correct: 26, streak: [18, 34, 18], celebrate: [22, 40, 22, 40, 34],
    finish: [26, 50, 26], badge: 22, levelup: [18, 30, 18, 30, 26],
    wrong: [14, 42, 14], start: 18, select: 10, tap: 7, pop: 9
  };
  function haptic(name) {
    if (!enabled) return;
    var pattern = HAPTICS[name];
    if (!pattern || !global.navigator || typeof global.navigator.vibrate !== 'function') return;
    try { global.navigator.vibrate(pattern); } catch (e) { /* unsupported */ }
  }

  function play(name) {
    if (!enabled) return false;
    var cueName = ALIAS[name] || name;
    var cue = CUES[cueName] || CUES.tap;
    try { cue(); } catch (e) { /* audio is a bonus */ }
    haptic(cueName);
    return true;
  }

  function setEnabled(value) {
    enabled = !!value;
    try { global.localStorage.setItem(KEY, enabled ? '1' : '0'); } catch (e) {}
    if (enabled) { unlock(); play('pop'); }
    global.dispatchEvent(new CustomEvent('pd:sfx', { detail: { enabled: enabled } }));
    return enabled;
  }

  function toggle() { return setEnabled(!enabled); }

  global.PDSFX = {
    play: play,
    unlock: unlock,
    setEnabled: setEnabled,
    toggle: toggle,
    enabled: function () { return enabled; },
    cues: function () { return Object.keys(CUES); }
  };

  // Mobile browsers create/resume audio only from a real gesture. Bind once,
  // capture, and quietly remove after the first tap.
  function firstGesture() {
    unlock();
    global.removeEventListener('pointerdown', firstGesture, true);
    global.removeEventListener('keydown', firstGesture, true);
    global.removeEventListener('touchstart', firstGesture, true);
  }
  global.addEventListener('pointerdown', firstGesture, true);
  global.addEventListener('keydown', firstGesture, true);
  global.addEventListener('touchstart', firstGesture, true);
})(window);
