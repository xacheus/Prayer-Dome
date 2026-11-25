# Bible Game — mobile layout and Domey conversation upgrade

## Root causes

1. **The game panel was a fixed viewport overlay.** `#panel-talk` used
   `position: fixed`, a `100dvh` height and `overflow: hidden`. Long questions,
   four answers, the text box and the session controls could not all fit, so the
   fourth answer and the bottom controls were clipped and the document behind
   the panel could not scroll.
2. **There was no persistent game navigation.** The game had no tab bar; the
   progress and badge sections sat below a tall hero and were unreachable once
   the fixed panel was open. Nothing told the member where they were.
3. **Voice was a two-step start.** Mounting the mascot with `listenOnTap`
   created a second "Start talking" step after the member had already tapped
   into the game.
4. **The status was not honest.** The host marked permission as granted and the
   UI as "Listening" as soon as `enableMic()` ran, before recognition had
   actually started. A blocked or unsupported microphone could still look live.
5. **There was no text channel during a round.** The typed answer form was only
   revealed by `waitForContinue()`, so a member who could not or would not use
   the microphone had nothing to type into while a question was open.
6. **Conversation could leak or corrupt an answer.** A question such as
   "Who is Moses?" contains an option name and was matched as the answer.
   Explanation text was not tied to the question bank's own verse reference.

## Changes

### `game.html` — the game shell

- A sticky, four-column tab bar (`#gameTabbar`) for **Talk**, **Topics**,
  **Progress** and **Badges**. Every destination stays visible and selectable;
  `initGameTabs()` handles taps and a measured scroll-spy, and each section gets
  a `scroll-margin-top` that includes the tab bar and the safe area.
- `#panel-talk` is now normal document flow on mobile. The page scrolls, so the
  question, all four answer chips, the text box, the log and the hint can all be
  reached. The old fixed height and `overflow: hidden` are gone.
- `body.game-focus` is the in-round arrangement: character card, session
  controls, answers, chips, history and hint in that order. The illustration
  shrinks, answer labels wrap, and the conversation, log and chips are never
  clipped.
- Safe areas are applied at the top, sides and bottom (`env(safe-area-inset-*)`)
  so the shell works under a notch and a home indicator in the installed PWA.
- A single **Talk to Domey** action calls `startDomeyShow('voice')`. The same tap
  calls `enableMic()`, so there is no second "Start talking" step and no
  microphone request on page load. **Type to Domey** starts the same game with
  `listen: false`.
- In-round controls: **Pause listening / Resume listening**, **Mute Domey /
  Unmute Domey**, **Type instead / Use voice**, and **End conversation**. They
  sit inside the conversation, above the answer chips.
- `#domeyLiveStatus` is a `role="status"` / `aria-live="polite"` region with
  real states: Ready, Permission required, Listening, Domey is speaking,
  Processing, Microphone blocked, and Text mode.
- The typed answer box is visible in focused play whenever a question is open,
  including before any answer. A question event opens the keyboard on pointer
  devices; phones keep the choice of voice or typing.
- The hero, topic chips and stats are compact and still keep the existing
  scoring, XP, rounds, streaks and badges. No sections or features were removed.
- Reduced motion is respected, including the new focus-play layout.

### `assets/pd-mascot.js` — the honest conversation host

- `Ears.listenOnce()` now reports `onStart`, `onError` and `onEnd`. Listening is
  announced only after recognition really starts.
- `Host.autoListen`, `_listenPaused`, `micState()`, `pauseListening()` and
  `resumeListening()` separate "voice answers are on" from "the microphone is
  live right now". `disableMic()` emits `listening: false`.
- The answer form submits through one `_submitTyped()` path shared with spoken
  answers. `_questionTalk` and `_continueTalk` let the member ask for the
  passage, a hint, an explanation, or say "next" while the round stays open.
- A question that contains an option name is no longer scored. A bare guessed
  answer ("Noah?", "Noah") is still judged normally.
- `explainLastAnswer()` and the passage replies use only the question bank's
  `verse`/`hints`. When there is no safe reference, Domey says so instead of
  inventing one. Answer requests are refused before the member answers.
- `show()` emits `question` when the answer box appears, and `stop()` clears
  pending questions, typed waits and live status.

### Cache and tests

- `sw.js` cache moved to `prayer-dome-v55` so installed PWAs receive the new
  shell, host and styles.
- `tests/game-ui.test.js` (44 checks) covers the tab layout, safe areas, flow
  scrolling, visible answers, single-tap voice start, honest states, text mode,
  pause/resume, mute, answer safety and a booted page-module integration pass.
  It is wired into `npm test`.

## Verification

| Check | Result |
| --- | --- |
| `node tests/game-ui.test.js` | 44 passed, 0 failed |
| `node tests/mascot.test.js` | 71 passed, 0 failed |
| `node tests/domey.test.js` | 69 passed, 0 failed |
| `node tests/domey3d.test.js` | 55 passed, 0 failed |
| `node tests/lady.test.js` | 38 passed, 0 failed |
| `npm test` | exit 0 |
| `npm run lint` | 0 |
| `npm run build:vercel` | 224 files, 27.37 MiB |

## Constraints kept

- The existing game was upgraded; no new game, page or paid API was added.
- No dependency was added.
- The microphone is never opened on page load, and no second start button is
  needed after **Talk to Domey**.
- Listening is never shown while the microphone is inactive.
- The correct answer is never revealed before the member answers, and Bible
  references are never invented.
- Scoring, XP, rounds, saved progress and badges are preserved.

## Known limit

Automated browser screenshots were not available in this environment
(the Playwright browser download was blocked). Verification used the existing
jsdom suites, the new booted-page integration test and CSS source assertions.
A final pass on a physical phone is still recommended for keyboard and
safe-area behaviour.
