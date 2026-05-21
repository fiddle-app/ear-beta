'use strict';
// ============================================
// CONTEXT DISPATCH — ear-tuner
// ============================================
// A small per-screen command dispatch shared between two input modes:
// the keyboard handler in ui.js and the voice handler in voice.js.
// Each "context" maps a stable command name (cmdHigher, cmdReplay, etc.)
// to a thunk that fires the equivalent button click or game action.
//
// Why this lives in its own module:
//   - The keyboard shortcuts ship without needing voice; they consume
//     the map directly via dispatchCommand(name).
//   - The voice handler (later) plugs its `onCommand` callback into
//     the same dispatchCommand. Adding/removing commands is one place.
//   - Per the 2026-05-08 plan's Q6 — the abstraction stays app-local
//     until ear-tuner + microbreaker show a clear shared shape.
//
// Context resolution is "top-of-stack wins": confirm/reset overlays
// (when open) take precedence over Settings/Info, which take precedence
// over the in-game state. Voice commands for confirm/reset overlays
// were intentionally dropped per Casey's Iteration-2 decision — those
// overlays still resolve to a context, but their command maps are empty,
// so voice/keyboard simply route nothing.

function vcCurrentContext() {
  if ($('confirm-overlay') && $('confirm-overlay').classList.contains('open')) return 'confirm';
  if ($('reset-overlay')   && $('reset-overlay').classList.contains('open'))   return 'reset';
  if ($('settings-overlay').classList.contains('open')) return 'settings';
  if ($('info-overlay').classList.contains('open'))     return 'info';
  if ($('hello-overlay') && $('hello-overlay').classList.contains('open'))     return 'hello';
  if (welcomeIsOpen) return 'welcome';
  if ($('start-btn').style.display === 'block') return 'startScreen';
  if (retestNote) {
    if (retestEnding) return 'retestEnd';
    if (roundFailed)  return 'retestFailed';
    if (awaiting)     return 'retestAwaiting';
    return 'retestListening';
  }
  if (roundFailed) return 'roundFailed';
  if (awaiting)    return 'awaiting';
  return 'listening';
}

// Replay action — replayBoth() lives in game.js. Keep this wrapper so the
// dispatch map doesn't depend on the global existing at file-parse time.
function _replayCurrent() {
  if (typeof replayBoth === 'function') replayBoth();
}

const VOICE_CONTEXT_HANDLERS = {
  welcome: {
    // Voice can't reach welcome — no gesture has fired yet.
  },
  hello: {
    // Hello's two buttons require a user gesture for mic acquisition;
    // voice/keyboard dispatch doesn't have that gesture. No commands here.
  },
  startScreen: {
    cmdStart:    () => $('start-btn').click(),
    cmdInfo:     () => $('info-btn').click(),
    cmdSettings: () => $('settings-btn').click(),
  },
  listening: {
    cmdReplay:   () => _replayCurrent(),
    cmdInfo:     () => $('info-btn').click(),
    cmdSettings: () => $('settings-btn').click(),
  },
  awaiting: {
    cmdHigher:   () => handleAnswer(true),   // "the 2nd note is higher"
    cmdLower:    () => handleAnswer(false),  // "the 2nd note is lower"
    cmdReplay:   () => _replayCurrent(),
    cmdInfo:     () => $('info-btn').click(),
    cmdSettings: () => $('settings-btn').click(),
  },
  roundFailed: {
    cmdContinue: () => continueAfterFail(),
    cmdRetry:    () => retryRound(),
    cmdReplay:   () => _replayCurrent(),
    cmdInfo:     () => $('info-btn').click(),
    cmdSettings: () => $('settings-btn').click(),
  },
  // 3.2s auto-advance — no commands.
  roundSuccess: {},
  retestListening: {
    cmdReplay:   () => _replayCurrent(),
    cmdRetry:    () => retryRound(),
    cmdClose:    () => closeRetest(),
    cmdExit:     () => exitRetest(),
    cmdInfo:     () => $('info-btn').click(),
    cmdSettings: () => $('settings-btn').click(),
  },
  retestAwaiting: {
    cmdHigher:   () => handleAnswer(true),
    cmdLower:    () => handleAnswer(false),
    cmdReplay:   () => _replayCurrent(),
    cmdRetry:    () => retryRound(),
    cmdClose:    () => closeRetest(),
    cmdExit:     () => exitRetest(),
    cmdInfo:     () => $('info-btn').click(),
    cmdSettings: () => $('settings-btn').click(),
  },
  retestFailed: {
    cmdContinue: () => continueAfterFail(),
    cmdRetry:    () => retryRound(),
    cmdReplay:   () => _replayCurrent(),
    cmdClose:    () => closeRetest(),
    cmdExit:     () => exitRetest(),
    cmdInfo:     () => $('info-btn').click(),
    cmdSettings: () => $('settings-btn').click(),
  },
  retestEnd: {
    cmdBack:     () => exitRetest(),
    cmdRetry:    () => retryRound(),
    cmdClose:    () => closeRetest(),
    cmdExit:     () => exitRetest(),
    cmdInfo:     () => $('info-btn').click(),
    cmdSettings: () => $('settings-btn').click(),
  },
  info: {
    cmdClose:    () => closeInfo(),
    // cmdNoteRetest is dispatched from voice.js after parsing
    // a note-letter + optional 'sharp' + octave-word phrase.
  },
  settings: {
    cmdClose:    () => closeSettings(),
  },
  // confirm and reset overlays intentionally have NO commands per
  // Casey's Iteration-2 decision. They still resolve to a context
  // so vcCurrentContext() reports state, but voice/keyboard route
  // nothing. The user must tap.
  confirm: {},
  reset:   {},
};

// Fire the handler for a command name in the current context, if it
// exists. Returns true iff a handler was found and called — callers
// (the keyboard handler) use this to decide whether to e.preventDefault.
function dispatchCommand(name, arg) {
  const ctx = vcCurrentContext();
  const map = VOICE_CONTEXT_HANDLERS[ctx];
  if (!map) return false;
  const fn = map[name];
  if (typeof fn !== 'function') return false;
  try {
    fn(arg);
  } catch (e) {
    console.warn('[dispatch] handler threw ctx=' + ctx + ' cmd=' + name, e);
  }
  return true;
}
