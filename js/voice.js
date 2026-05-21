'use strict';
// ============================================
// VOICE — ear-tuner integration
// ============================================
// Wires the shared voice-commands library (synced from
// _shared/js/voice-commands.js) into ear-tuner's context-dispatch map.
// Listens whenever sessionUseVoice is true and the Vosk model is ready;
// recognized commands route through dispatchCommand() in
// context-dispatch.js so the dispatch layer is shared with the keyboard
// handler.
//
// Vocabulary:
//   - Standard navigation: start, info, information, settings, close,
//     replay, continue, higher, lower, retry, back, exit
//   - Note letters: a, b, c, d, e, f, g
//   - Modifier: sharp
//   - Octave words: derived from settings.lowestNote / .highestNote
//     at vocab-build time (e.g. "three", "four", "five")
//   - Action word: retest
//
// Note + octave dispatch is bag-of-words: "C sharp four", "retest C sharp
// four", or even "four sharp C" all parse to the same retest action. The
// parser scans for exactly one note letter and exactly one octave word;
// 'sharp' and 'retest' are optional. Ambiguous parses (multiple letters
// or multiple octaves) are ignored to avoid guessing.

const VC_MODEL_URL =
  'https://fiddle-app.github.io/voice-models/vosk-model-small-en-us-0.15.tar.gz';
const VC_WORKLET_URL = 'js/voice-commands-worklet.js';

const _OCTAVE_WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine'];
const _NOTE_LETTERS = ['a','b','c','d','e','f','g'];

// Built-in navigation commands. Each bucket is a list of recognized
// phrases; the bucket name is matched against context-dispatch handlers.
const VC_NAV_COMMANDS = {
  cmdStart:    ['start'],
  cmdReady:    ['ready'],
  cmdInfo:     ['info', 'information'],
  cmdSettings: ['settings'],
  cmdClose:    ['close'],
  cmdReplay:   ['replay'],
  cmdContinue: ['continue', 'next'],
  cmdRetry:    ['retry'],
  cmdHigher:   ['higher'],
  cmdLower:    ['lower'],
  cmdBack:     ['back'],
  cmdExit:     ['exit'],
};

let vc = null;
let _voskScriptPromise = null;
let _vcTranscriptClearTimer = null;
let _vcLastState = null;

// Compute the set of octave words covered by the user's note range.
function _activeOctaveWords() {
  const lo = ALL_NOTES[settings.lowestNote];
  const hi = ALL_NOTES[settings.highestNote];
  if (!lo || !hi) return ['three','four','five'];
  const loOct = parseInt(lo.name.replace(/[^0-9]/g, ''), 10);
  const hiOct = parseInt(hi.name.replace(/[^0-9]/g, ''), 10);
  const out = [];
  for (let o = loOct; o <= hiOct; o++) {
    if (o >= 0 && o < _OCTAVE_WORDS.length) out.push(_OCTAVE_WORDS[o]);
  }
  return out;
}

// Build the full strict-grammar vocabulary. The shared lib accepts a
// commands object: bucket → phrase[]. We add a synthetic 'cmdNote'
// bucket that contains every note letter, "sharp", every active octave
// word, and "retest". When any of these words is heard, vcOnCommand
// receives the matched phrase and we parse the broader transcript via
// onTranscript to detect a complete note+octave combination.
function vcBuildCommands() {
  const octWords = _activeOctaveWords();
  const out = Object.assign({}, VC_NAV_COMMANDS);
  out.cmdNoteWord = [..._NOTE_LETTERS, 'sharp', ...octWords, 'retest'];
  return out;
}

// Lazy-load vosk-browser.js (5.5 MB UMD). Same pattern as microbreaker.
function loadVoskScript() {
  if (window.Vosk) return Promise.resolve();
  if (_voskScriptPromise) return _voskScriptPromise;
  _voskScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src   = 'js/vosk-browser.js';
    s.async = true;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error('vosk-browser.js failed to load'));
    document.head.appendChild(s);
  });
  return _voskScriptPromise;
}

async function vcKickOffLoad() {
  if (typeof createVoiceCommands !== 'function') {
    console.warn('[voice] shared lib not present — feature disabled');
    vcUpdateStatus('Not available');
    return;
  }
  if (vc && (vc.state === 'loading' || vc.state === 'ready' || vc.state === 'listening')) return;
  try {
    await loadVoskScript();
  } catch (e) {
    console.warn('[voice]', e.message);
    vcUpdateStatus('Error — script load failed');
    return;
  }
  if (!vc) {
    vc = createVoiceCommands({
      modelUrl:      VC_MODEL_URL,
      workletUrl:    VC_WORKLET_URL,
      commands:      vcBuildCommands(),
      strictGrammar: !!settings.limitVrVocab,
      onCommand:     vcOnCommand,
      onTranscript:  vcOnTranscript,
      onStateChange: vcOnStateChange,
      onError:       vcOnError,
    });
    if (!vc.supported) {
      console.warn('[voice] not supported in this browser');
      vcUpdateStatus('Not supported');
      vc = null;
      return;
    }
  }
  vc.load();
}

function vcOnStateChange(state) {
  const prev = _vcLastState;
  _vcLastState = state;
  const labels = {
    idle:      'Not loaded',
    loading:   'Loading…',
    ready:     'Ready',
    listening: 'Listening',
    error:     'Error — check console',
  };
  vcUpdateStatus(labels[state] || state);
  if (state === 'loading') {
    vcShowLoader();
    return;
  }
  vcHideLoader();
  // Auto-start ONLY on 'loading' → 'ready' (model just finished after opt-in).
  const justFinishedLoading = state === 'ready' && prev === 'loading';
  const shouldAutoStart = justFinishedLoading && micStream && sessionUseVoice;
  console.log('[voice] state ' + prev + '→' + state +
              (shouldAutoStart ? ' (auto-start)' : ''));
  if (shouldAutoStart) vcStart();
}

function vcShowLoader() {
  const el = $('vc-loader');
  if (el) el.hidden = false;
}
function vcHideLoader() {
  const el = $('vc-loader');
  if (el) el.hidden = true;
}
function vcUpdateStatus(text) {
  const el = $('s-vc-status');
  if (el) el.textContent = text;
}

// Live transcript echo. Captures partials + finals. Strict-mode '[unk]'
// is replaced with '?' for user-readability.
let _vcLastTranscript = '';
function vcOnTranscript(text, isFinal) {
  if (!text) return;
  _vcLastTranscript = text;
  const el = $('vc-transcript');
  if (!el) return;
  const display = text.replace(/\[unk\]/g, '?');
  el.textContent = display;
  el.classList.add('visible');
  if (_vcTranscriptClearTimer) {
    clearTimeout(_vcTranscriptClearTimer);
    _vcTranscriptClearTimer = null;
  }
  if (!isFinal || !settings.vcKeepLastWord) {
    _vcTranscriptClearTimer = setTimeout(() => {
      el.classList.remove('visible');
      _vcTranscriptClearTimer = null;
    }, 2000);
  }
  // Note+octave parse: only meaningful in the info context.
  if (isFinal && typeof vcCurrentContext === 'function' && vcCurrentContext() === 'info') {
    _tryParseNoteRetest(text);
  }
}

// Parse a transcript like "C sharp four" / "retest c sharp four" /
// "four sharp c" into a note id ("C#4"). Order doesn't matter; sharp
// and retest are optional. Returns the matched note name or null.
function _parseNoteFromTranscript(text) {
  if (!text) return null;
  const tokens = String(text).toLowerCase().split(/\s+/).filter(Boolean);
  let letter = null, octIdx = null, sawTwoLetters = false, sawTwoOctaves = false, sharp = false;
  for (const tok of tokens) {
    if (_NOTE_LETTERS.includes(tok)) {
      if (letter && letter !== tok) sawTwoLetters = true;
      letter = tok;
    } else if (tok === 'sharp') {
      sharp = true;
    } else {
      const oi = _OCTAVE_WORDS.indexOf(tok);
      if (oi >= 0) {
        if (octIdx != null && octIdx !== oi) sawTwoOctaves = true;
        octIdx = oi;
      }
    }
  }
  if (sawTwoLetters || sawTwoOctaves) return null;
  if (!letter || octIdx == null) return null;
  // 'b sharp' and 'e sharp' aren't standard sharps; ear-tuner's ALL_NOTES
  // doesn't include them. Filter those out by looking up the candidate.
  const candidate = letter.toUpperCase() + (sharp ? '#' : '') + octIdx;
  return ALL_NOTES.find(n => n.name === candidate) ? candidate : null;
}

function _tryParseNoteRetest(text) {
  const note = _parseNoteFromTranscript(text);
  if (!note) return;
  // Verify the note is in the user's active range.
  const inRange = ALL_NOTES.slice(settings.lowestNote, settings.highestNote + 1)
    .some(n => n.name === note);
  if (!inRange) {
    console.log('[voice] heard "' + text + '" → ' + note + ' (out of range, ignoring)');
    return;
  }
  console.log('[voice] note retest: ' + note);
  if (typeof startRetest === 'function') startRetest(note);
}

function vcOnCommand(name, phrase) {
  console.debug('[voice] command "' + name + '" from "' + phrase + '"');
  if (typeof wlOnActivity === 'function') wlOnActivity('voice:' + name);
  // cmdNoteWord is a synthetic bucket; the real action happens in the
  // transcript parser (vcOnTranscript). Don't dispatch the bucket itself.
  if (name === 'cmdNoteWord') return;
  if (typeof dispatchCommand === 'function') dispatchCommand(name);
}

function vcOnError(err) {
  console.warn('[voice] error:', err);
}

// Start the recognizer. Returns true if it reached the listening state.
// Callers in the visibility-regain path use the boolean to decide whether
// silent recovery succeeded.
async function vcStart() {
  if (!vc || !sessionUseVoice) return false;
  if (vc.state !== 'ready') return false;
  // Defense-in-depth: vcStart is invoked from non-gesture contexts
  // (auto-start on loading→ready, closeResume's .then) — never let it
  // attempt mic re-acquisition outside a gesture frame. The Welcome /
  // Hello / Resume gesture handlers own that.
  if (!micStream) {
    console.warn('[voice] vcStart skipped — no micStream (not in gesture frame)');
    return false;
  }
  await ensureAudio();
  if (!vc || vc.state !== 'ready') return false;
  try {
    await vc.start(audioCtx, micStream);
    return !!vc && vc.state === 'listening';
  } catch (e) {
    console.warn('[voice] start failed:', e);
    return false;
  }
}

function vcStop() {
  if (!vc) return;
  if (vc.state === 'listening') vc.stop();
  const el = $('vc-transcript');
  if (el) el.classList.remove('visible');
}

// Tear down the voice-commands instance entirely, freeing the ~80MB
// Vosk WASM heap. Used by the visibility-regain Branch C silent
// rebuild — discarding vc forces vcKickOffLoad to rebuild from scratch,
// reading the model from the /vosk IDB cache (~0.6s, no network).
// Idempotent.
function vcDestroy() {
  if (!vc) return;
  try { vc.destroy(); } catch (_) {}
  vc = null;
  _vcLastState = null;
  if (_vcTranscriptClearTimer) {
    clearTimeout(_vcTranscriptClearTimer);
    _vcTranscriptClearTimer = null;
  }
  const el = $('vc-transcript');
  if (el) el.classList.remove('visible');
  vcUpdateStatus('Idle');
}

// Rebuild the recognizer's command list (cheap — Phase 1 recognizer-only
// rebuild). Called when settings affecting the vocabulary change
// (lowestNote / highestNote / limitVrVocab).
function vcRebuildCommands() {
  if (!vc) return;
  try {
    vc.setCommands(vcBuildCommands(), !!settings.limitVrVocab);
  } catch (e) {
    console.warn('[voice] setCommands failed:', e);
  }
}

function vcOnSettingChange(name) {
  if (name === 'voiceCommands') {
    if (settings.voiceCommands) {
      // Will engage on next Hello prompt; nothing to do here.
    } else {
      vcStop();
    }
    return;
  }
  if (name === 'vcKeepLastWord') {
    // No recognizer rebuild. If toggling off while a final word is held
    // on-screen, schedule a normal 2s clear so it fades naturally.
    if (!settings.vcKeepLastWord && !_vcTranscriptClearTimer) {
      const el = $('vc-transcript');
      if (el && el.classList.contains('visible')) {
        _vcTranscriptClearTimer = setTimeout(() => {
          el.classList.remove('visible');
          _vcTranscriptClearTimer = null;
        }, 2000);
      }
    }
    return;
  }
  if (name === 'limitVrVocab' || name === 'lowestNote' || name === 'highestNote') {
    vcRebuildCommands();
    return;
  }
}
