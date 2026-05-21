'use strict';
// BOOT
// ══════════════════════════════════════════════════════
loadState();
centsIdx=settings.startCentsIdx;
renderSettings();
updateRetestUI();
$('status-msg').textContent = '';
setBg('#4d1903');

function checkFirstRun() {
// If the upgrade modal from index.html's inline boot script is open,
// hold off on Welcome / Hello / StartScreen until the user dismisses it
// (the OK button reloads, so checkFirstRun runs again post-reload on
// a coherent version).
const upgrade = $('upgrade-overlay');
if (upgrade && upgrade.classList.contains('open')) return;
if (!localStorage.getItem('vio4-seen-welcome')) {
  openWelcome();
  return;
}
// Returning user. If voice is opted in globally, show the Hello daily
// opt-in; otherwise go straight to StartScreen.
if (settings.voiceCommands) {
  openHello();
} else {
  showStartScreen();
}
}
document.addEventListener('DOMContentLoaded', checkFirstRun);
if (document.readyState !== 'loading') checkFirstRun();

// Init-complete marker — pair with the watchdog in index.html. If the
// app stays alive 2s past initial render without crashing, write the
// clean-shutdown marker. Compensates for iOS force-kill (no pagehide
// fires) so a normal use-kill-relaunch cycle isn't misclassified as a
// bad boot. Genuine boot-time crashes die well before 2s and never
// reach this timer.
setTimeout(function () {
  try {
    if (localStorage.getItem('et-test-suppress-clean') !== '1') {
      localStorage.setItem('et-clean-shutdown', '1');
    }
  } catch (e) {}
}, 2000);

function showStartScreen() {
$('app').style.visibility  = '';
$('swipe-hint').style.visibility = '';
$('info-overlay').classList.remove('open');
$('settings-overlay').classList.remove('open');
retestNote = null;
retestEnding = false;
firstRoundOfRetest = false;
atLeastOneSuccessfulRetest = false;
roundFailed = false;
roundResults = []; roundAttempts = 0;
pendingCentsStep = 0;
updateRetestUI();
$('round-actions').style.display = 'none'; hideRetestEndActions();
$('status-msg').textContent = '';
$('note-row').style.display        = 'none';
$('replay-btn').style.display      = 'none';
$('swipe-hint').style.display      = 'none';
$('start-btn').style.display       = 'block';
$('upper-half').style.visibility   = 'hidden';
$('lower-half').style.visibility   = 'hidden';
}

function hideStartScreen() {
$('note-row').style.display        = '';
$('replay-btn').style.display      = '';
$('swipe-hint').style.display      = '';
$('start-btn').style.display       = 'none';
$('upper-half').style.visibility   = 'visible';
$('lower-half').style.visibility   = 'visible';
$('diff-value').textContent = fmtC(CENTS_SEQ[centsIdx]);
}

// Start tap. Synchronous gesture-frame entry — kicks off audio (and mic
// when VR is engaged this session) synchronously and resolves the rest
// in a .then. iOS Safari closes the permission window on the first
// async boundary inside a click handler, so the kick MUST happen before
// any await. Mirrors microbreaker's start-btn-inner pattern.
function handleStart() {
const audioP = ensureAudio();
let micP = Promise.resolve(true);
// Re-acquire mic if the user opted into voice this session but the
// stream was invalidated (e.g., persistent-mute auto-release after a
// background). Idempotent if the stream is already live.
if (sessionUseVoice && typeof acquireMic === 'function') {
  micP = acquireMic();
}
Promise.all([audioP, micP]).then(([_, micOk]) => {
  if (sessionUseVoice && !micOk) {
    console.warn('[start] mic acquisition failed — voice will be unavailable for this round');
    sessionUseVoice = false;
  }
  if (typeof wlAcquire === 'function') wlAcquire('start');
  _handleStartContinue();
}).catch(e => {
  console.warn('[start] error:', e);
  _handleStartContinue();
});
}

// Post-gesture continuation. Soundfont load + round start.
function _handleStartContinue() {
hideStartScreen();
const s = SOUNDS[settings.soundIdx];
if (s.type === 'sf') {
  $('status-msg').textContent = 'Loading…';
  $('status-msg').style.color = 'rgba(255,255,255,0.45)';
  loadSfInstrument(s.sfName)
    .then(() => {
      renderSoundGrid();
      $('status-msg').textContent = '';
      startRound();
    })
    .catch(() => {
      $('status-msg').textContent = '';
      showToast(`Could not download ${s.label}. Using synth.`);
      startRound();
    });
} else {
  startRound();
}
}

// App icon (apple-touch-icon + info/welcome overlays) is served from
// resources/app-icon-180.png, referenced statically from index.html.
// Do not re-introduce canvas-drawn or data:-URL icons here — iOS Safari
// "Add to Home Screen" does not reliably accept them. Source of truth for
// the icon is resources/app-icon.svg; regenerate the PNG via the svg-to-png
// skill. See research/pwa-home-screen-icon-plan.md.

// SW registration delegated to _shared/js/register-sw.js — Capacitor-aware
// (skips under capacitor:// scheme), localhost-aware (unregisters any
// leftover SW in dev), and consistent across the family. The
// controllerchange→reload flow lives in the inline <head> script in
// index.html (with safe-phase deferral) — keep it there to avoid a race
// where a listener attached inside register().then() misses an early
// controllerchange.
registerSW();
