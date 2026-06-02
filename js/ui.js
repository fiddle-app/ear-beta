'use strict';
// iOS sometimes caches font sizes across orientation changes — force recalc
window.addEventListener('orientationchange', () => {
setTimeout(() => {
  document.querySelectorAll('.hint-text').forEach(el => {
    el.style.fontSize = '';
  });
}, 100);
});

// Wake-lock activity hook — any tap anywhere resets the 30-min idle timer
// and, if we lost the sentinel after a background, re-requests it from
// within the current gesture frame. Bails fast if intent isn't set, so
// the cost outside an active session is one boolean check.
document.addEventListener('pointerdown',
  () => { if (typeof wlOnActivity === 'function') wlOnActivity('pointerdown'); },
  { passive: true });

// SWIPE + SHAKE
// ══════════════════════════════════════════════════════
let touchStartY=0, touchStartX=0;
document.getElementById('app').addEventListener('touchstart', e=>{
touchStartY=e.touches[0].clientY; touchStartX=e.touches[0].clientX;
}, {passive:true});
document.getElementById('app').addEventListener('touchend', e=>{
const dy=touchStartY-e.changedTouches[0].clientY;
const dx=touchStartX-e.changedTouches[0].clientX;
const absDx=Math.abs(dx), absDy=Math.abs(dy);

if (absDx > 45 && absDx > absDy) {
  if (dx < 0 && roundFailed) {
    const actionsVisible = $('round-actions').style.display === 'flex';
    const continueVisible = actionsVisible && $('continue-action-btn').style.display !== 'none';
    const backVisible = actionsVisible && $('back-action-btn').style.display !== 'none';
    if (continueVisible || backVisible) { continueAfterFail(); return; }
  }
  if (dx > 0 && roundFailed && retestNote) {
    const retryVisible = $('retry-action-btn').style.display !== 'none' &&
      $('round-actions').style.display === 'flex';
    if (retryVisible) { retryRound(); return; }
  }
}

if (roundFailed||!awaiting) return;
if (absDy<45||absDx>absDy) return;
handleAnswer(dy>0);
}, {passive:true});


function openResetDefaults() { $('reset-overlay').classList.add('open'); }
function closeResetDefaults() { $('reset-overlay').classList.remove('open'); }
function confirmResetDefaults() {
$('reset-overlay').classList.remove('open');
// Iterate DEFAULTS so newly-added settings keys auto-reset — avoids the
// drift bug microbreaker hit where Reset silently ignored vcKeepLastWord.
// Array values get shallow-cloned so the reset doesn't share the DEFAULTS
// reference. Ear-tuner has no user-edited lists to preserve, so this is a
// single-path destructive reset (unlike microbreaker's two-branch UI).
for (const key of Object.keys(DEFAULTS)) {
  const val = DEFAULTS[key];
  settings[key] = Array.isArray(val) ? [...val] : val;
}
saveSettings();
centsIdx = settings.startCentsIdx;
renderSettings();
// Propagate VR-relevant changes to the recognizer (analogous to the
// onLimitVrToggle / onVcKeepToggle handlers above).
if (typeof vcOnSettingChange === 'function') {
  vcOnSettingChange('vcKeepLastWord');
}
}

// ══════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════
let previewTimer=null;
function adjustSetting(key,dir) {
if      (key==='lowestNote')    settings.lowestNote    = Math.max(0, Math.min(settings.highestNote-1, settings.lowestNote+dir));
else if (key==='highestNote')   settings.highestNote   = Math.max(settings.lowestNote+1, Math.min(ALL_NOTES.length-1, settings.highestNote+dir));
else if (key==='startCentsIdx') settings.startCentsIdx = Math.max(0, Math.min(CENTS_SEQ.length-1, settings.startCentsIdx+dir));
else if (key==='testsPerRound') settings.testsPerRound = Math.max(1, Math.min(7, settings.testsPerRound+dir));
else if (key==='noteDurIdx')    settings.noteDurIdx    = Math.max(0, Math.min(DUR_STEPS.length-1, settings.noteDurIdx+dir));
else if (key==='attack') { settings.attack=Math.max(0,Math.min(ATK_PRESETS.length-1,settings.attack+dir)); schedulePreview(); }
else if (key==='decay')  { settings.decay =Math.max(0,Math.min(DEC_PRESETS.length-1,settings.decay+dir));  schedulePreview(); }
saveSettings(); renderSettings();
// Note-range changes invalidate the VR octave vocabulary — cheap rebuild.
if ((key === 'lowestNote' || key === 'highestNote') && typeof vcOnSettingChange === 'function') {
  vcOnSettingChange(key);
}
}

function schedulePreview() {
if (previewTimer) clearTimeout(previewTimer);
previewTimer=setTimeout(async ()=>{ await ensureAudio(); const dur=noteDur(); playNote(69, audioCtx.currentTime+0.04, dur); }, 150);
}

function renderSettings() {
$('s-lowest').textContent      = dn(ALL_NOTES[settings.lowestNote].name);
$('s-highest').textContent     = dn(ALL_NOTES[settings.highestNote].name);
$('s-start-cents').textContent = fmtC(CENTS_SEQ[settings.startCentsIdx]);
$('s-tests-per-round').textContent = settings.testsPerRound;
$('s-note-dur').textContent    = DUR_STEPS[settings.noteDurIdx].toFixed(1)+'s';
$('s-attack').textContent      = ATK_PRESETS[settings.attack][0];
$('s-decay').textContent       = DEC_PRESETS[settings.decay][0];
$('s-build-date').textContent  = 'build ' + BUILD_DATE;
const volPct = Math.round(settings.volume * 100);
$('s-volume-slider').value     = volPct;
$('s-volume-val').textContent  = volPct + '%';
renderSoundGrid();
renderVoiceSettings();
}

// Voice Recognition settings row sync.
function renderVoiceSettings() {
const chk = $('s-voice-chk');
if (chk) chk.checked = !!settings.voiceCommands;
const row = $('s-vc-status-row');
if (row) row.style.display = settings.voiceCommands ? '' : 'none';
// Diagnostic toggles only meaningful when voice is enabled.
const limitRow = $('s-limit-vr-row');
if (limitRow) limitRow.style.display = settings.voiceCommands ? '' : 'none';
const keepRow = $('s-vc-keep-row');
if (keepRow) keepRow.style.display = settings.voiceCommands ? '' : 'none';
const limitChk = $('s-limit-vr');
if (limitChk) limitChk.checked = !!settings.limitVrVocab;
const keepChk = $('s-vc-keep');
if (keepChk) keepChk.checked = !!settings.vcKeepLastWord;
}

function onLimitVrToggle(enabled) {
settings.limitVrVocab = !!enabled;
saveSettings();
if (typeof vcOnSettingChange === 'function') vcOnSettingChange('limitVrVocab');
}

function onVcKeepToggle(enabled) {
settings.vcKeepLastWord = !!enabled;
saveSettings();
if (typeof vcOnSettingChange === 'function') vcOnSettingChange('vcKeepLastWord');
}

// Toggle Voice Recognition on/off (Settings → Voice Recognition).
// Turning it ON: flip persisted setting AND engage VR for THIS session —
// the change-handler runs inside the user-gesture frame, so we can kick
// off acquireMic() + vcKickOffLoad() synchronously. Don't make the user
// wait until next cold launch to actually use voice they just enabled.
// Turning it OFF: stop the recognizer and disable Resume modal for the
// rest of this session.
function onVoiceToggle(enabled) {
settings.voiceCommands = !!enabled;
saveSettings();
renderVoiceSettings();
if (enabled) {
  sessionUseVoice = true;
  // Synchronous gesture-frame kick: mic + audio first, then vc load.
  // iOS Safari closes the getUserMedia() permission window after the
  // first async boundary, so acquireMic MUST be called before any await.
  const audioP = (typeof ensureAudio === 'function') ? ensureAudio() : Promise.resolve();
  const micP   = (typeof acquireMic === 'function')   ? acquireMic()   : Promise.resolve(false);
  if (typeof vcKickOffLoad === 'function') vcKickOffLoad();
  Promise.all([audioP, micP]).then(([_, micOk]) => {
    if (!micOk) {
      console.warn('[settings] mic acquire failed — voice will not engage this session');
      sessionUseVoice = false;
      return;
    }
    if (typeof wlAcquire === 'function') wlAcquire('settings-voice-on');
  }).catch(e => console.warn('[settings] voice engage failed:', e));
} else {
  sessionUseVoice = false;
  if (typeof vcStop === 'function') vcStop();
  // Release the mic too — vcStop() only stops the recognizer. Without
  // this the stream stays live and the session stays 'play-and-record'
  // (mic indicator on, wrong category for a now-VC-off session) until the
  // next background. releaseMic() stops the tracks and drops to
  // 'playback'; toggling VC back on re-acquires. Symmetric with enable.
  if (typeof releaseMic === 'function') releaseMic();
}
if (typeof vcOnSettingChange === 'function') vcOnSettingChange('voiceCommands');
}

function adjustVolume(percentStr) {
const pct = Math.max(0, Math.min(200, parseInt(percentStr, 10) || 0));
settings.volume = pct / 100;
saveSettings();
$('s-volume-val').textContent = pct + '%';
if (typeof masterGain !== 'undefined' && masterGain) {
  masterGain.gain.value = settings.volume;
}
schedulePreview();
}

function renderSoundGrid() {
const grid=$('sound-grid'); grid.innerHTML='';
SOUNDS.forEach((s,idx)=>{
  const btn=document.createElement('button');
  btn.className='sound-btn'+(idx===settings.soundIdx?' active':'');
  btn.textContent=s.label;
  if (s.type==='sf'&&!sfInstruments[s.sfName]) btn.classList.add('loading');
  btn.onclick=()=>selectSound(idx);
  grid.appendChild(btn);
});
}

async function selectSound(idx) {
settings.soundIdx=idx; saveSettings(); renderSoundGrid();
await ensureAudio();
const sound=SOUNDS[idx];
if (sound.type==='sf'&&!sfInstruments[sound.sfName]) {
  try { await loadSfInstrument(sound.sfName); } catch(e){ console.warn('SF load failed:',e); }
  renderSoundGrid();
}
const dur=noteDur();
playNote(69, audioCtx.currentTime+0.06, dur);
}

let settingsOpenTestsPerRound = 3;

async function openSettings() {
await ensureAudio();
settingsOpenTestsPerRound = settings.testsPerRound;
const s=SOUNDS[settings.soundIdx];
if (s.type==='sf'&&!sfInstruments[s.sfName]) loadSfInstrument(s.sfName).then(()=>renderSoundGrid()).catch(()=>{});
renderSettings();
renderSwStatus();
renderMemStatus();
applyDebugReveal();
const sbd = $('settings-build-date');
if (sbd) sbd.textContent = 'build ' + BUILD_DATE;
setBg('#1a1a1a');
$('settings-overlay').classList.add('open');
$('info-btn').style.visibility = 'hidden';
$('settings-btn').style.visibility = 'hidden';
}
function closeSettings() {
$('settings-overlay').classList.remove('open');
$('info-btn').style.visibility = '';
$('settings-btn').style.visibility = '';
if (welcomeIsOpen) { setBg('#f5efe6'); return; }
setBg(retestNote ? '#0d2a1a' : '#4d1903');
if (settings.testsPerRound !== settingsOpenTestsPerRound) {
  clearProgress();
  roundResults = [];
  roundAttempts = 0;
  roundFailed = false;
  awaiting = false;
  $('round-actions').style.display = 'none'; hideRetestEndActions();
  $('status-msg').textContent = '';
  setTimeout(setupAttempt, 300);
}
}

// ══════════════════════════════════════════════════════

// WELCOME
// ══════════════════════════════════════════════════════
let welcomeIsOpen = false;

function openWelcome() {
showStartScreen();
welcomeIsOpen = true;
setBg('#f5efe6');
const wbd = $('welcome-build-date');
if (wbd) wbd.textContent = 'build ' + (typeof BUILD_DATE === 'string' ? BUILD_DATE : '(unknown)');
$('welcome-overlay').classList.add('open');
$('app').style.visibility = 'hidden';
$('swipe-hint').style.visibility = 'hidden';
// Hide info/settings affordances — they're faintly visible through the
// parchment overlay edges and shouldn't be accessible until the user
// clears the launch gate.
$('info-btn').style.visibility = 'hidden';
$('settings-btn').style.visibility = 'hidden';
}

function closeWelcome() {
welcomeIsOpen = false;
try { localStorage.setItem('vio4-seen-welcome', '1'); } catch(e) {}
$('welcome-overlay').classList.remove('open');
// Route through Hello when VR is opted in; otherwise straight to Start.
if (settings.voiceCommands) {
  openHello();
  return;
}
$('app').style.visibility = '';
$('swipe-hint').style.visibility = '';
$('info-btn').style.visibility = '';
$('settings-btn').style.visibility = '';
setBg('#4d1903');
}

function resetWelcome() {
try { localStorage.removeItem('vio4-seen-welcome'); } catch(e) {}
const btn = $('welcome-reset-btn');
if (!btn) return;
btn.textContent = 'Done!';
btn.disabled = true;
setTimeout(() => { btn.textContent = 'Reset'; btn.disabled = false; }, 1500);
}

// ══════════════════════════════════════════════════════
// HELLO — daily voice-recognition opt-in
// ══════════════════════════════════════════════════════
// Shown on every cold launch when `settings.voiceCommands` is true.
// The user picks Yes/No for the session. Yes triggers the iOS gesture
// frame for both `ensureAudio()` and `acquireMic()` — those must be
// kicked off synchronously inside the click handler (no `await`
// before either call) or iOS Safari closes the permission window on
// the first async boundary.
function openHello() {
  setBg('#f5efe6');
  const hbd = $('hello-build-date');
  if (hbd) hbd.textContent = 'build ' + (typeof BUILD_DATE === 'string' ? BUILD_DATE : '(unknown)');
  $('hello-overlay').classList.add('open');
  $('app').style.visibility = 'hidden';
  $('swipe-hint').style.visibility = 'hidden';
  $('info-btn').style.visibility = 'hidden';
  $('settings-btn').style.visibility = 'hidden';
}

function closeHelloAndGo() {
  $('hello-overlay').classList.remove('open');
  $('app').style.visibility = '';
  $('swipe-hint').style.visibility = '';
  $('info-btn').style.visibility = '';
  $('settings-btn').style.visibility = '';
  setBg('#4d1903');
  showStartScreen();
}

// Hello → "Yes, use voice today". Synchronously kicks audio + mic.
function onHelloYes() {
  sessionUseVoice = true;
  const audioP = (typeof ensureAudio === 'function') ? ensureAudio() : Promise.resolve();
  const micP   = (typeof acquireMic === 'function') ? acquireMic() : Promise.resolve(false);
  Promise.all([audioP, micP]).then(([_, micOk]) => {
    if (!micOk) {
      console.warn('[hello] mic acquisition failed — proceeding without VR for this session');
      sessionUseVoice = false;
    } else if (typeof vcKickOffLoad === 'function') {
      // Lazy-load the Vosk bundle now that the user has opted in.
      try { vcKickOffLoad(); } catch (e) { console.warn('[hello] vcKickOffLoad threw:', e); }
    }
    if (typeof wlAcquire === 'function') wlAcquire('hello-yes');
    closeHelloAndGo();
  }).catch(e => {
    console.warn('[hello] yes-path error:', e);
    closeHelloAndGo();
  });
}

// Hello → "No, not today". Only unlocks the audio context.
function onHelloNo() {
  sessionUseVoice = false;
  const audioP = (typeof ensureAudio === 'function') ? ensureAudio() : Promise.resolve();
  audioP.then(() => {
    if (typeof wlAcquire === 'function') wlAcquire('hello-no');
    closeHelloAndGo();
  }).catch(e => {
    console.warn('[hello] no-path error:', e);
    closeHelloAndGo();
  });
}

// ══════════════════════════════════════════════════════
// VISIBILITY RECOVERY + RESUME MODAL
// ══════════════════════════════════════════════════════
// Probe-and-rebuild model — only getUserMedia truly needs a fresh
// user-gesture frame. AudioContext, audioCtx.resume(), Vosk reload,
// and AudioWorkletNode construction all work outside a gesture once
// the session has had at least one earlier gesture. So the Resume
// modal is reserved for the case where iOS invalidated the mic stream
// AND we still want VR. See _shared/js/visibility-recovery.md.
//
// _wasBackgrounded latches across pagehide/visibilitychange so we
// don't double-run the recovery cycle when multiple events fire for
// the same transition. blur/focus deliberately NOT used — iOS system
// overlays (mic permission prompt, Control Center) trigger blur and
// would cause spurious Resume modals.
let _wasBackgrounded = false;
let _resumeReason = null;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden')      _onMaybeBackgrounded();
  else if (document.visibilityState === 'visible') _onMaybeForegrounded();
});
window.addEventListener('pagehide', _onMaybeBackgrounded);
window.addEventListener('pageshow', _onMaybeForegrounded);

function _onMaybeBackgrounded() {
  if (_wasBackgrounded) return;
  _wasBackgrounded = true;
  console.log('[gate] backgrounded');
  if (typeof muteMasterGain === 'function') muteMasterGain();
  if (typeof vcStop === 'function') vcStop();
}

async function _onMaybeForegrounded() {
  if (!_wasBackgrounded) return;
  _wasBackgrounded = false;
  if (document.visibilityState !== 'visible') return;

  // Failure-mode-4 recovery: re-assert session type on every visibility-
  // regain. iOS may hand the hardware audio session to another app while
  // we're backgrounded; writing to navigator.audioSession.type forces
  // iOS to re-claim it for us (WebKit calls setCategoryOverride regardless
  // of whether the value changed). This is the ONLY place we re-assert
  // session type outside of acquire/release — visibility-regain is the
  // correct trigger for cross-PWA session loss, not every tap.
  //
  // We do NOT set 'playback' when VC is on and mic is not yet live —
  // that case is heading for Resume + acquireMic(), which will set
  // 'play-and-record' after getUserMedia succeeds. Setting 'playback'
  // here would be wrong and would persist until mic acquisition.
  if (navigator.audioSession) {
    try {
      const micLive = typeof micStreamIsLive === 'function' && micStreamIsLive();
      const before = navigator.audioSession.type;
      let action;
      if (micLive) {
        navigator.audioSession.type = 'play-and-record';
        action = 'play-and-record (mic live)';
      } else if (!sessionUseVoice) {
        navigator.audioSession.type = 'playback';
        action = 'playback (VC off)';
      } else {
        // VC on + mic not live: don't touch — heading for Resume +
        // acquireMic(), which will set 'play-and-record' with a real mic.
        action = 'left untouched (VC on, mic not live)';
      }
      console.log('[gate] fg session-type: was=' + before + ' → ' + action);
    } catch (_) {}
  }

  // ── Probe both health signals ────────────────────────────────────
  const audioOk = (typeof isAudioContextHealthy === 'function')
    ? await isAudioContextHealthy()
    : false;
  const wantMic = !!sessionUseVoice;
  const micOk   = !wantMic || (typeof micStreamIsLive === 'function' && micStreamIsLive());
  console.log('[gate] foregrounded — audioOk=' + audioOk + ' micOk=' + micOk);

  // ── Branch A: mic invalidated → Resume modal (gesture needed) ────
  if (!micOk) {
    if (typeof micStream !== 'undefined' && micStream) {
      try { micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      micStream = null;
    }
    if (!audioOk && typeof nukeAudioCtx === 'function') {
      nukeAudioCtx('regain-unhealthy');
    }
    const reasonA = audioOk ? 'mic-stale' : 'audio-and-mic';
    if (typeof isNative === 'function' && isNative()) {
      _performResumeRebuild(reasonA);
    } else {
      showResume(reasonA);
    }
    return;
  }

  // ── Branch B: audio unhealthy, mic alive → silent audio rebuild ──
  if (!audioOk) {
    console.log('[gate] silent rebuild — audio unhealthy');
    if (typeof nukeAudioCtx === 'function') nukeAudioCtx('regain-unhealthy');
    await ensureAudio();
    const audioOk2 = (typeof isAudioContextHealthy === 'function')
      ? await isAudioContextHealthy()
      : true;
    if (!audioOk2) {
      console.log('[gate] silent audio rebuild failed — escalating to Resume');
      if (typeof isNative === 'function' && isNative()) {
        _performResumeRebuild('audio-unhealthy');
      } else {
        showResume('audio-unhealthy');
      }
      return;
    }
  }

  // From here on, audio + mic are both healthy (either survived bg or
  // were silently rebuilt). Restore output gain.
  if (typeof unmuteMasterGain === 'function') unmuteMasterGain();

  // Reset wake-lock idle timer; best-effort re-acquire outside a gesture.
  if (typeof wlOnActivity === 'function') wlOnActivity('visibility-regain');

  if (!sessionUseVoice) return;

  // ── Branch C: voice resume ───────────────────────────────────────
  if (typeof vcStart === 'function') {
    const vrOk = await vcStart();
    if (vrOk) return;

    // vcStart failed — typically DataCloneError on the worklet port
    // transfer (iOS suspends the AudioWorklet processor independently
    // of the AudioContext rendering thread). Tear down vc and rebuild
    // silently. Model reads from /vosk IDB cache (~0.6s, no network).
    console.log('[gate] silent rebuild — vc failed (worklet zombie)');
    if (typeof vcDestroy === 'function') vcDestroy();
    if (typeof nukeAudioCtx === 'function') nukeAudioCtx('vcStart-failed-silent');
    await ensureAudio();
    const audioOk3 = (typeof isAudioContextHealthy === 'function')
      ? await isAudioContextHealthy()
      : true;
    if (!audioOk3) {
      console.log('[gate] silent vc rebuild — fresh audioCtx still unhealthy, escalating to Resume');
      if (typeof isNative === 'function' && isNative()) {
        _performResumeRebuild('vc-failure');
      } else {
        showResume('vc-failure');
      }
      return;
    }
    if (typeof vcKickOffLoad === 'function') vcKickOffLoad();
    // Auto-start in vcOnStateChange fires vcStart on loading→ready.
  }
}

function showResume(reason) {
  const ov = $('resume-overlay');
  if (!ov) return;
  if (!sessionUseVoice) return;
  _resumeReason = reason || 'unknown';
  ov.classList.add('open');
}

// Half-flip mic recovery hook — invoked by _shared/js/mic.js
// (_maybeRecoverForegroundMic) when the persistent-mute auto-release stopped
// the stream but the app stayed foreground (incomplete app-switch). No
// visibilitychange fires, so the normal foreground/Resume path never runs and
// VC dies silently. We CANNOT re-acquire gesture-lessly — iOS pops a mic
// permission prompt mid-app-carousel (confirmed 2026-06-02) — so route to the
// SAME Resume flow as a real foreground regain; the re-acquire then happens
// inside the user's Resume tap (a gesture frame, no prompt). Collision-guard:
// if a real background+return already opened Resume (racing this timer), or
// the mic somehow recovered, do nothing.
function onMicAutoReleasedWhileForeground() {
  if (typeof sessionUseVoice === 'undefined' || !sessionUseVoice) return;
  if (typeof micStream !== 'undefined' && micStream) return;       // already recovered
  const ov = $('resume-overlay');
  if (ov && ov.classList.contains('open')) return;                 // normal Resume already up
  console.log('[gate] half-flip recovery → Resume');
  if (typeof isNative === 'function' && isNative()) {
    _performResumeRebuild('mic-fg-stale');
  } else {
    showResume('mic-fg-stale');
  }
}

// Resume tap — fresh user gesture frame. Per Casey's report, the
// "probe-and-conditional-nuke" approach was returning healthy probes
// for contexts that were actually dead, leaving audio silent after
// Resume even with unmuteMasterGain. Always nuke + rebuild the audio
// context here — the user already paid the cost of tapping Resume, and
// a fresh context is guaranteed not to be zombied. Matches the
// pre-probe-and-rebuild behavior.
function closeResume() {
  $('resume-overlay').classList.remove('open');
  const reason = _resumeReason;
  _resumeReason = null;
  _performResumeRebuild(reason);
}

// Body of the rebuild work, callable WITHOUT showing the overlay.
// On PWA, only closeResume() invokes this (after the user taps the
// Resume button, which provides the gesture frame iOS requires for
// getUserMedia). On Cap, _onMaybeForegrounded invokes it directly,
// bypassing the modal — native permission grant means getUserMedia
// outside a gesture is permitted.
function _performResumeRebuild(reason) {
  // Pre-flight: drop a dead micStream so acquireMic fires fresh. On
  // PWA the call site is the Resume button, which provides the gesture
  // frame Safari requires for getUserMedia. On Cap the call site is
  // _onMaybeForegrounded — no gesture, but native permission grant
  // makes getUserMedia outside a gesture permitted there. Live stream
  // is reused to avoid iOS's mic-toggle ping.
  if (typeof micStream !== 'undefined' && micStream &&
      typeof micStreamIsLive === 'function' && !micStreamIsLive()) {
    try { micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    micStream = null;
  }

  // Force a fresh AudioContext. nukeAudioCtx + ensureAudio inside the
  // gesture frame so iOS accepts the new context's resume().
  if (typeof nukeAudioCtx === 'function') nukeAudioCtx('resume-rebuild');
  const audioP = (typeof ensureAudio === 'function') ? ensureAudio() : Promise.resolve();
  const wantMic = !!sessionUseVoice;
  const micP   = (wantMic && (typeof micStream === 'undefined' || !micStream) &&
                  typeof acquireMic === 'function')
    ? acquireMic()
    : Promise.resolve(true);

  console.log('[gate] resume rebuild — reason=' + reason + ' voiceArmed=' + sessionUseVoice);

  if (sessionUseVoice && typeof vcKickOffLoad === 'function') {
    vcKickOffLoad();
  }
  Promise.all([audioP, micP]).then(([_, micOk]) => {
    if (wantMic && !micOk) {
      console.warn('[resume] mic re-acquire failed — disabling VR for the rest of this session');
      sessionUseVoice = false;
    }
    if (typeof wlAcquire === 'function') wlAcquire('resume');
    if (sessionUseVoice && typeof vc !== 'undefined' && vc && vc.state === 'ready'
        && typeof vcStart === 'function') {
      vcStart().catch(e => console.warn('[resume] vcStart failed:', e));
    }
  }).catch(e => {
    console.warn('[resume] error:', e);
  });
}

// ══════════════════════════════════════════════════════

// INFO / STATS
// ══════════════════════════════════════════════════════
function toggleInfoMore() {
const content = $('info-more-content');
const btn = $('info-more-btn');
const isOpen = content.classList.toggle('open');
btn.innerHTML = isOpen ? '▲ <span>Show less</span>' : '… more';
}

function openInfo() {
setBg('#f5efe6');
const bd = $('build-date-display');
if (bd) bd.textContent = 'build ' + BUILD_DATE;
$('info-overlay').classList.add('open');
$('app').style.visibility = 'hidden';
$('swipe-hint').style.visibility = 'hidden';
$('info-btn').style.visibility = 'hidden';
$('settings-btn').style.visibility = 'hidden';
$('info-more-content').classList.remove('open');
$('info-more-btn').innerHTML = '… more';
setTimeout(() => requestAnimationFrame(() => {
  renderStats();
  const wrap = $('stats-chart-wrap');
  const canvas = $('stats-chart');
  if (wrap && canvas) {
    canvas.style.width = wrap.offsetWidth + 'px';
  }
}), 80);
}
function closeInfo() {
$('info-overlay').classList.remove('open');
$('info-btn').style.visibility = '';
$('settings-btn').style.visibility = '';
if (welcomeIsOpen) { setBg('#f5efe6'); return; }
$('app').style.visibility = '';
$('swipe-hint').style.visibility = '';
$('phase-label').textContent = 'Listen';
setBg(retestNote ? '#0d2a1a' : '#4d1903');
if (!awaiting && !roundFailed && !retestNote &&
  $('start-btn').style.display !== 'block') {
  setTimeout(startRound, 200);
}
}

function noteWeight(noteName) {
const bc = stats[noteName]?.bestCents;
const base = (bc == null) ? MAX_CENTS : bc;
return isRegressed(noteName) ? base * 1.25 : base;
}

function renderStats() {
const tbody=$('stats-tbody'); tbody.innerHTML='';

const noteInfo = {};
ALL_NOTES.forEach(n => { noteInfo[n.name] = { midi: n.midi, hz: midiToHz(n.midi) }; });

const lowestHz  = midiToHz(ALL_NOTES[settings.lowestNote].midi);
const highestHz = midiToHz(ALL_NOTES[settings.highestNote].midi);

const inRangeWithData = Object.keys(stats).filter(name => {
  const info = noteInfo[name];
  if (!info) return false;
  if (info.hz < lowestHz - 0.01 || info.hz > highestHz + 0.01) return false;
  const st = stats[name];
  return st && (st.bestCents != null || st.lastFailureCents != null || st.attempts);
});

const sorted = inRangeWithData
  .map(name => ({ name, hz: noteInfo[name].hz, midi: noteInfo[name].midi }))
  .sort((a, b) => a.hz - b.hz);

const pool = ALL_NOTES.slice(settings.lowestNote, settings.highestNote+1);
const untested = pool.filter(n => !stats[n.name] || stats[n.name].attempts == null || stats[n.name].attempts === 0);
const allTested = untested.length === 0;
let totalWeight = 0;
if (allTested) {
  totalWeight = pool.reduce((s, n) => s + noteWeight(n.name), 0);
}

const allWithBest = ALL_NOTES.filter(n => {
  const hz = midiToHz(n.midi);
  return hz >= lowestHz - 0.01 && hz <= highestHz + 0.01 && stats[n.name]?.bestCents != null;
});
if (allWithBest.length > 0) {
  const avg = allWithBest.reduce((s, n) => s + stats[n.name].bestCents, 0) / allWithBest.length;
  $('overall-score').textContent = avg.toFixed(1) + '¢';
} else {
  $('overall-score').textContent = '—';
}

if (!sorted.length) {
  tbody.innerHTML='<tr><td colspan="3" style="opacity:.45;font-style:italic;padding:10px 8px">No data yet</td></tr>';
} else {
  sorted.forEach(note=>{
    const st=stats[note.name];
    const best    = (st?.bestCents!=null)       ? fmtC(st.bestCents)        : '—';
    const regressed = isRegressed(note.name);
    const noBest = st?.lastFailureCents != null && st?.bestCents == null;
    const tr=document.createElement('tr');
    if (regressed) tr.classList.add('stat-row-regressed');
    else if (noBest) tr.classList.add('stat-row-no-best');
    tr.innerHTML=`<td class="stat-note-name">${dn(note.name)}</td> <td class="stat-best">${best}</td> <td><button class="stat-btn stat-retest-btn" onclick="startNoteTest('${note.name}')">Retest</button></td>`;
    tbody.appendChild(tr);
  });
}
drawChart(sorted);
}

function drawChart(notes) {
const canvas = $('stats-chart');
const ctx    = canvas.getContext('2d');
const dpr    = window.devicePixelRatio || 1;

const pn = notes.filter(n => stats[n.name]?.bestCents != null);

const parent = canvas.parentElement;
const W = parent.getBoundingClientRect().width ||
  parent.offsetWidth ||
  window.innerWidth || 300;
const rowH = 22;
const pad  = { l: 44, r: 36, t: 10, b: 20 };
const H    = Math.max(120, pad.t + pn.length * rowH + pad.b);

canvas.width  = W * dpr;
canvas.height = H * dpr;
canvas.style.width  = W + 'px';
canvas.style.height = H + 'px';
ctx.scale(dpr, dpr);
ctx.clearRect(0, 0, W, H);

if (!pn.length) {
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.font = '13px Inconsolata,monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Play some rounds to see progress', W / 2, H / 2);
  return;
}

const cW   = W - pad.l - pad.r;
const worstScore = Math.max(...pn.map(n => stats[n.name].bestCents));
const xMax = CENTS_SEQ.slice().reverse().find(c => c >= worstScore) || worstScore;
const xFor = c => pad.l + (c / xMax) * cW;

const allGridCandidates = [1, 2, 3, 5, 7, 10, 15, 20, 25, 50, 75, 100];
const gridLines = allGridCandidates.filter(c => c <= xMax);
const step = Math.ceil(gridLines.length / 5);
const filteredGrid = gridLines.filter((_, i) => i % step === 0 || gridLines[i] === xMax);
ctx.strokeStyle = 'rgba(0,0,0,0.10)';
ctx.lineWidth   = 1;
filteredGrid.forEach(c => {
  const x = xFor(c);
  ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
  ctx.fillStyle  = 'rgba(0,0,0,0.38)';
  ctx.font       = '9px Inconsolata,monospace';
  ctx.textAlign  = 'center';
  ctx.fillText(fmtC(c), x, H - pad.b + 12);
});

ctx.strokeStyle = 'rgba(0,0,0,0.15)';
ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.stroke();

const bh = Math.min(14, rowH - 6);

pn.forEach((note, i) => {
  const y  = pad.t + i * rowH + rowH / 2;
  const c  = stats[note.name].bestCents;
  const bw = xFor(c) - pad.l;
  const regressed = isRegressed(note.name);

  ctx.fillStyle = regressed ? '#b87c00' : '#c94a0a';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(pad.l, y - bh/2, bw, bh, 3);
  else ctx.rect(pad.l, y - bh/2, bw, bh);
  ctx.fill();

  ctx.fillStyle  = 'rgba(0,0,0,0.65)';
  ctx.font       = '10px Inconsolata,monospace';
  ctx.textAlign  = 'right';
  ctx.fillText(dn(note.name), pad.l - 5, y + 4);

  ctx.fillStyle  = 'rgba(0,0,0,0.50)';
  ctx.textAlign  = 'left';
  ctx.fillText(fmtC(c), pad.l + bw + 4, y + 4);
});
}

async function startRetest(n) {
if ($('start-btn').style.display === 'block') {
  await ensureAudio();
  hideStartScreen();
  const s = SOUNDS[settings.soundIdx];
  if (s.type === 'sf') {
    $('status-msg').textContent = 'Loading…';
    $('status-msg').style.color = 'rgba(255,255,255,0.45)';
    loadSfInstrument(s.sfName)
      .then(() => { renderSoundGrid(); $('status-msg').textContent = ''; _startRetestInner(n); })
      .catch(() => { $('status-msg').textContent = ''; showToast(`Could not download ${s.label}. Using synth.`); _startRetestInner(n); });
    return;
  }
}
_startRetestInner(n);
}

function _startRetestInner(n) {
if (typeof wlAcquire === 'function') wlAcquire('retest-start');
retestNote               = n;
logEvent(`retestStart | note=${n}`);
firstRoundOfRetest       = true;
atLeastOneSuccessfulRetest = false;
roundAttempts = 0; roundResults = [];
closeInfo();
updateRetestUI();
const bestCents = stats[n]?.bestCents;
if (bestCents != null) {
  let idx = CENTS_SEQ.findIndex(c => c <= bestCents);
  if (idx < 0) idx = CENTS_SEQ.length - 1;
  centsIdx = idx;
} else {
  centsIdx = settings.startCentsIdx;
}
currentNote = ALL_NOTES.find(note => note.name === n);
startRound();
}

function exitRetest(silent=false) {
logEvent(`retestExit | note=${retestNote} | silent=${silent}`);
retestNote               = null;
firstRoundOfRetest       = false;
atLeastOneSuccessfulRetest = false;
retestEnding             = false;
roundAttempts = 0; roundResults = [];
$('round-actions').style.display = 'none'; hideRetestEndActions();
$('status-msg').textContent = '';
updateRetestUI();
if (!silent) startRound();
}

function startNoteTest(n) { startRetest(n); }
function endNoteTest()    { exitRetest(); }

// Exit retest and return to the Info screen — used by the top-right X
// button and the "close" voice command. Mirrors the post-retest-end
// flow in continueAfterFail() so both routes land in the same place.
function closeRetest() {
  exitRetest(true);
  setTimeout(() => {
    openInfo();
    setTimeout(() => {
      const scoresEl = document.getElementById('stats-table');
      if (scoresEl) scoresEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  }, 200);
}

function updateRetestUI() {
if (retestNote) {
  $('phase-label').textContent = 'Re-testing ' + dn(retestNote);
  $('app').classList.add('retest-mode');
  setBg('#0d2a1a');
  // Explicit display value (not '') because CSS default is `display: none` —
  // setting style.display = '' would fall back to that and keep it hidden.
  $('retest-close-btn').style.display = 'block';
} else {
  $('phase-label').textContent = 'Listen';
  $('app').classList.remove('retest-mode');
  setBg('#4d1903');
  $('retest-close-btn').style.display = 'none';
}
}

// ══════════════════════════════════════════════════════

// CONFIRM
// ══════════════════════════════════════════════════════
let confirmCb=null;
function showConfirm(t,m,cb){ $('confirm-title').textContent=t; $('confirm-msg').textContent=m; confirmCb=cb; $('confirm-overlay').classList.add('open'); }
function closeConfirm(){ $('confirm-overlay').classList.remove('open'); confirmCb=null; }
$('confirm-yes').addEventListener('click',()=>{ const cb=confirmCb; closeConfirm(); if(cb) cb(); });
$('confirm-no').addEventListener('click',closeConfirm);
function confirmResetNote(n){ showConfirm('Reset '+dn(n),'Erase scores for '+dn(n)+'?',()=>{ delete stats[n]; saveStats(); renderStats(); }); }
function confirmResetAll(){   showConfirm('Reset All','Erase scores for every note?',()=>{ stats={}; try{localStorage.removeItem('vio4-stats');}catch(e){} renderStats(); }); }

function fakeHistory() {
const validCents = CENTS_SEQ.filter(c => c >= 5 && c <= MAX_CENTS);
const rand = arr => arr[Math.floor(Math.random() * arr.length)];
ALL_NOTES.forEach(note => {
  if (!stats[note.name]) stats[note.name] = {};
  stats[note.name].attempts = Math.floor(Math.random() * 20) + 3;
  const best = rand(validCents);
  stats[note.name].bestCents = best;
  if (Math.random() < 0.40) {
    const harderOptions = validCents.filter(c => c < best);
    stats[note.name].lastFailureCents = harderOptions.length > 0 ? rand(harderOptions) : best;
  } else {
    const easierOrSame = validCents.filter(c => c >= best);
    stats[note.name].lastFailureCents = rand(easierOrSame);
  }
});
saveStats();
renderStats();
}

function confirmRandomizeScores() {
showConfirm('Randomize Scores', 'This will erase all existing scores and replace them with random data.', fakeHistory);
}

function copyScores() {
const lowestHz  = midiToHz(ALL_NOTES[settings.lowestNote].midi);
const highestHz = midiToHz(ALL_NOTES[settings.highestNote].midi);
const scored = ALL_NOTES
  .filter(n => {
    const hz = midiToHz(n.midi);
    return hz >= lowestHz - 0.01 && hz <= highestHz + 0.01 && stats[n.name]?.bestCents != null;
  })
  .sort((a, b) => midiToHz(a.midi) - midiToHz(b.midi));

const btn = $('info-copy-scores-btn');
if (!scored.length) {
  btn.textContent = 'No scores yet';
  setTimeout(() => { btn.textContent = 'Copy Scores'; }, 2000);
  return;
}

const avg   = scored.reduce((s, n) => s + stats[n.name].bestCents, 0) / scored.length;
const worst = Math.max(...scored.map(n => stats[n.name].bestCents));

const introText = 'These are my Ear Tuner scores. Each score is the smallest pitch gap I can reliably hear at that note\u2019s frequency, measured in cents (hundredths of a semitone). Lower is better. Check out https://fiddle-app.github.io/ear to test your own aural acuity.';
const introHtml = introText.replace('https://fiddle-app.github.io/ear', '<a class="et-link" href="https://fiddle-app.github.io/ear" style="color:#8f2d06;">https://fiddle-app.github.io/ear</a>');

const rows = scored.map(n => {
  const c   = stats[n.name].bestCents;
  const pct = Math.round((c / worst) * 100);
  return `<tr>
    <td class="et-note" style="font-size:14px;font-weight:600;padding:4px 12px 4px 0;border-bottom:1px solid rgba(0,0,0,0.07);width:52px;">${dn(n.name)}</td>
    <td class="et-score" style="font-size:14px;font-weight:600;color:#8f2d06;padding:4px 12px 4px 0;border-bottom:1px solid rgba(0,0,0,0.07);width:48px;">${fmtC(c)}</td>
    <td style="font-size:14px;width:100%;padding:4px 0 4px 4px;border-bottom:1px solid rgba(0,0,0,0.07);vertical-align:middle;">
      <div class="et-bar-track" style="background:rgba(0,0,0,0.07);border-radius:3px;height:8px;width:100%;">
        <div class="et-bar-fill" style="background:#b83c08;border-radius:3px;height:8px;width:${pct}%;"></div>
      </div>
    </td>
  </tr>`;
}).join('');

// Resolve both font tokens live so the copied email mirrors the in-app tokens.
// The wrapper is treated like an info/welcome page (Nunito body); the
// average-score pill and the scores table opt into --font-scores.
const cs = getComputedStyle(document.documentElement);
const infoFont       = (cs.getPropertyValue('--font-info').trim()       || "'Nunito', sans-serif");
const infoBodySize   = (cs.getPropertyValue('--font-info-body').trim()  || 'clamp(14px, 3.5vw, 16px)');
const scoresFont     = (cs.getPropertyValue('--font-scores').trim()     || "'Inconsolata', monospace");

const html = `<style>
  @media (prefers-color-scheme: dark) {
    .et-wrap  { background-color:#1c1c1e !important; color:#e8ddd0 !important; }
    .et-intro { color:#c8bfb5 !important; }
    .et-link  { color:#e87a50 !important; }
    .et-avg   { background:rgba(184,60,8,0.25) !important; border-left-color:#e87a50 !important; color:#f0a080 !important; }
    .et-note  { color:#e8ddd0 !important; border-bottom-color:rgba(255,255,255,0.08) !important; }
    .et-score { color:#f0a080 !important; border-bottom-color:rgba(255,255,255,0.08) !important; }
    .et-bar-track { background:rgba(255,255,255,0.12) !important; }
    .et-bar-fill  { background:#e87a50 !important; }
    .et-footer    { color:rgba(255,255,255,0.35) !important; }
    .et-th { color:rgba(255,255,255,0.38) !important; border-bottom-color:rgba(255,255,255,0.15) !important; }
  }
</style>
<div class="et-wrap" style="font-family:${infoFont};color:#2a2018;font-size:${infoBodySize};">
  <p class="et-intro" style="color:#2a2018;line-height:1.65;margin:0 0 16px;">${introHtml}</p>
  <div class="et-avg" style="font-family:${scoresFont};background:rgba(184,60,8,0.12);border-left:3px solid #b83c08;padding:8px 14px;border-radius:0 6px 6px 0;margin-bottom:18px;font-size:14px;color:#8f2d06;font-weight:600;display:inline-block;">Average score: ${avg.toFixed(1)}\u00a2</div>
  <table style="font-family:${scoresFont};border-collapse:collapse;width:100%;max-width:440px;">
    <thead><tr>
      <th class="et-th" style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(0,0,0,0.38);text-align:left;padding:0 12px 6px 0;border-bottom:2px solid rgba(0,0,0,0.15);font-weight:600;">Note</th>
      <th class="et-th" style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(0,0,0,0.38);text-align:left;padding:0 12px 6px 0;border-bottom:2px solid rgba(0,0,0,0.15);font-weight:600;">Score</th>
      <th class="et-th" style="width:100%;border-bottom:2px solid rgba(0,0,0,0.15);padding-bottom:6px;"> </th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="et-footer" style="margin-top:14px;font-size:12px;color:rgba(0,0,0,0.35);">Ear Tuner \u00b7 fiddle-app.github.io/ear</p>
</div>`;

const noteColW = Math.max(...scored.map(n => dn(n.name).length));
const plainRows = scored.map(n => dn(n.name).padEnd(noteColW + 2) + fmtC(stats[n.name].bestCents)).join('\n');
const plain = `${introText}\n\nAverage: ${avg.toFixed(1)}\u00a2\n\nNote${''.padEnd(noteColW - 2)}  Score\n${'─'.repeat(noteColW + 8)}\n${plainRows}`;

try {
  const item = new ClipboardItem({
    'text/html':  new Blob([html],  { type: 'text/html' }),
    'text/plain': new Blob([plain], { type: 'text/plain' }),
  });
  navigator.clipboard.write([item]).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Scores'; }, 2000);
  }).catch(() => {
    navigator.clipboard.writeText(plain).then(() => {
      btn.textContent = 'Copied (text)';
      setTimeout(() => { btn.textContent = 'Copy Scores'; }, 2000);
    });
  });
} catch(e) {
  navigator.clipboard.writeText(plain).then(() => {
    btn.textContent = 'Copied (text)';
    setTimeout(() => { btn.textContent = 'Copy Scores'; }, 2000);
  });
}
}

// ══════════════════════════════════════════════════════
// IMPORT SCORES
// ══════════════════════════════════════════════════════
function openImportScores() {
  const ta = $('import-textarea');
  if (ta) ta.value = '';
  const st = $('import-status');
  if (st) { st.textContent = ''; st.className = ''; }
  $('import-overlay').classList.add('open');
  if (ta) setTimeout(() => ta.focus(), 50);
}
function closeImportScores() {
  $('import-overlay').classList.remove('open');
}

// Parse scores from raw clipboard input and return { name -> bestCents } or null.
// Works against three input shapes:
//   (1) The original HTML produced by copyScores() — classes intact
//   (2) Gmail-mangled HTML — classes stripped, visible structure preserved
//   (3) Plain text rendering of either of the above
// Strategy: if the input looks like HTML, extract text content via DOMParser
// (innerText preserves table cell separators); then scan lines for the
// `<note> <value>¢?` pattern. Anchoring at line start/end prevents prose
// false-positives like "Average score: 7.0¢".
function parseImportedScores(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw;
  if (/<[a-z][^>]*>/i.test(raw)) {
    try {
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      const body = doc && doc.body;
      if (body) text = body.innerText || body.textContent || raw;
    } catch (e) { /* fall back to raw */ }
  }
  const rowRe = /^\s*([A-G])([#♯])?(\d)\s+(-?\d+(?:\.\d+)?)\s*¢?\s*$/;
  const result = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = rowRe.exec(line);
    if (!m) continue;
    const noteName = m[1] + (m[2] ? '#' : '') + m[3];
    if (!ALL_NOTES.some(n => n.name === noteName)) continue;
    const cents = parseFloat(m[4]);
    if (!isFinite(cents) || cents < 0) continue;
    result[noteName] = cents;
  }
  return Object.keys(result).length ? result : null;
}

function confirmImportScores() {
  const ta  = $('import-textarea');
  const st  = $('import-status');
  const raw = ta ? ta.value : '';
  const parsed = parseImportedScores(raw);
  if (!parsed) {
    if (st) {
      st.textContent = 'Could not find any scores. Paste the full content copied from "Copy Scores".';
      st.className = 'error';
    }
    return;
  }
  // Merge into stats. Preserve existing fields; overwrite bestCents only.
  Object.keys(parsed).forEach(name => {
    if (!stats[name]) stats[name] = {};
    stats[name].bestCents = parsed[name];
    if (stats[name].attempts == null) stats[name].attempts = 1;
  });
  saveStats();
  renderStats();
  const count = Object.keys(parsed).length;
  if (st) {
    st.textContent = 'Imported ' + count + ' score' + (count === 1 ? '' : 's') + '.';
    st.className = 'success';
  }
  setTimeout(closeImportScores, 900);
}

(function() {
const u = 'eartunerapp', d = 'gmail.com';
const el = document.getElementById('feedback-email');
if (el) { el.href = 'mailto:' + u + '@' + d; el.textContent = u + '@' + d; }
})();


// ══════════════════════════════════════════════════════
// KEYBOARD SUPPORT
// ══════════════════════════════════════════════════════
// Desktop shortcuts. Every keypress also resets the wake-lock idle
// timer. Action keys (arrows, space, enter, esc) route through
// context-dispatch.js so voice and keyboard share the same command
// handlers per-screen. Other keys are ignored.
document.addEventListener('keydown', e => {
if (typeof wlOnActivity === 'function') wlOnActivity('keydown');
const k = e.key;

// Esc → close top overlay
if (k === 'Escape' || k === 'Esc') {
  if (dispatchCommand('cmdClose')) { e.preventDefault(); }
  return;
}

// Arrow keys + space — only consumed in game contexts where they map.
// Space/Enter on the StartScreen still triggers Start (legacy behavior).
const onStartScreen = $('start-btn').style.display !== 'none' && $('start-btn').style.display !== '';
if (onStartScreen && (k === ' ' || k === 'Enter')) {
  e.preventDefault();
  handleStart();
  return;
}

let cmd = null;
if (k === 'ArrowUp')        cmd = 'cmdHigher';
else if (k === 'ArrowDown') cmd = 'cmdLower';
else if (k === 'ArrowLeft') cmd = 'cmdReplay';
else if (k === 'ArrowRight' || k === ' ' || k === 'Enter') cmd = 'cmdContinue';
if (cmd && dispatchCommand(cmd)) {
  e.preventDefault();
  return;
}
});

// ══════════════════════════════════════════════════════
// DIAGNOSTICS (Settings → Diagnostics)
// ══════════════════════════════════════════════════════

// SW + cache version visibility. Shows what's currently active vs. what
// would activate on next reload. When they diverge, it's a nudge to hit
// Reload (or Hard reset, if Reload won't take).
async function renderSwStatus() {
  const el = $('s-sw-status');
  if (!el) return;
  if (!('serviceWorker' in navigator) || !window.caches) {
    el.textContent = 'service worker: unavailable';
    return;
  }
  try {
    const keys = await caches.keys();
    const staticKey = keys.find(k => k.startsWith('ear-tuner-static-'));
    const activeVer = staticKey ? staticKey.replace('ear-tuner-static-', '') : '(none)';
    const reg = await navigator.serviceWorker.getRegistration();
    const waiting = reg && (reg.waiting || reg.installing);
    let line = 'cache: ' + activeVer;
    if (activeVer !== BUILD_DATE) line += ' ⚠ mismatched';
    if (waiting) line += ' · update pending';
    // Second line: inline-script's view of the same state. When all three
    // sources (cache, last-seen, meta) agree, the system is coherent.
    let lastSeen = null;
    try { lastSeen = localStorage.getItem('et-last-build'); } catch (_) {}
    let metaBuild = null;
    const metaEl = document.querySelector('meta[name="ear-tuner-build"]');
    if (metaEl) metaBuild = metaEl.content;
    line += '\nlast-seen: ' + (lastSeen || '(unset)') +
            ' · meta: ' + (metaBuild || '(missing)');
    // Third line: most recent boot decision from the inline coherence
    // check. Action values: mismatch / first-seen / same / no-info.
    let decision = null;
    try { decision = JSON.parse(localStorage.getItem('et-boot-decision') || 'null'); } catch (_) {}
    if (decision) {
      line += '\nboot decision: ' + decision.action +
              ' (last=' + (decision.last || 'null') +
              ' current=' + (decision.current || 'null') + ')';
    }
    el.textContent = line;
  } catch (e) {
    el.textContent = 'cache: (error)';
  }
}

// performance.memory snapshot. Chrome-only — Safari (incl. iOS PWA)
// does not expose it. On Safari the line still shows app-state sizes so
// the panel gives some signal.
function renderMemStatus() {
  const el = $('s-mem-status');
  if (!el) return;
  const parts = [];
  if (typeof performance !== 'undefined' && performance.memory) {
    const m = performance.memory;
    parts.push(
      'JS heap: ' + (m.usedJSHeapSize / 1048576).toFixed(1) +
      ' / ' + (m.totalJSHeapSize / 1048576).toFixed(1) +
      ' MB (limit ' + (m.jsHeapSizeLimit / 1048576).toFixed(0) + ' MB)'
    );
  } else {
    parts.push('JS heap: not exposed by this browser (Chrome desktop only)');
  }
  if (typeof vc !== 'undefined' && vc) {
    parts.push('vc model: ' + (vc.state || 'unknown'));
  }
  el.textContent = parts.join(' · ');
}

if ($('s-mem-refresh')) {
  $('s-mem-refresh').addEventListener('click', renderMemStatus);
}

// Hard reset — order matters:
//   1. SW unregister first — no in-flight fetches against caches we're about to delete.
//   2. Caches second.
//   3. localStorage third — settings, boot watchdog state, last-build all go.
//   4. IndexedDB last — Vosk's worker connections resolve best after the
//      other state is gone.
async function hardReset() {
  if (!confirm('Hard reset will delete ALL local data (settings, log, voice cache, service worker) and require internet on next launch. Continue?')) return;
  const btn = $('s-hard-reset-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Resetting…'; }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    try { localStorage.clear(); } catch (_) {}
    if (window.indexedDB) {
      try {
        if (indexedDB.databases) {
          const dbs = await indexedDB.databases();
          await Promise.all(dbs.map(({ name }) => name && new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          })));
        } else {
          // Safari historically lacked indexedDB.databases() — fall back to
          // the known DB names used by the Vosk voice library.
          ['/vosk', 'voice-models'].forEach(n => { try { indexedDB.deleteDatabase(n); } catch (_) {} });
        }
      } catch (_) {}
    }
    // location.replace (not reload) — back-button history shouldn't return here.
    window.location.replace(window.location.pathname);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Hard reset'; }
    alert('Hard reset failed: ' + (e && e.message) + ' — try again, or remove the home-screen icon and re-add from Safari.');
  }
}

if ($('s-hard-reset-btn')) {
  $('s-hard-reset-btn').addEventListener('click', hardReset);
}

// Debug reveal — 7 taps within the #s-debug-tap-zone (Reset button +
// build-date footer area) toggles the Diagnostics section's visibility.
// Persisted in 'et-debug-revealed' so it survives reloads.
function applyDebugReveal() {
  const revealed = localStorage.getItem('et-debug-revealed') === '1';
  const sec = document.getElementById('diagnostics-section');
  if (sec) sec.style.display = revealed ? '' : 'none';
}

function toggleDebugReveal() {
  const revealed = localStorage.getItem('et-debug-revealed') === '1';
  if (revealed) localStorage.removeItem('et-debug-revealed');
  else          localStorage.setItem('et-debug-revealed', '1');
  applyDebugReveal();
}

(function () {
  const zone = document.getElementById('s-debug-tap-zone');
  if (!zone) return;
  let taps = 0;
  let lastTapAt = 0;
  const REQUIRED = 7;
  // Consecutive taps must land within 3s of each other. Tapping the
  // Reset-to-defaults button opens the reset overlay which covers the
  // zone — dismissing takes longer than the window, so Reset taps
  // effectively don't accumulate. Empty-area / build-date taps do.
  const WINDOW_MS = 3000;
  zone.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTapAt > WINDOW_MS) taps = 0;
    lastTapAt = now;
    taps++;
    if (taps >= REQUIRED) {
      taps = 0;
      toggleDebugReveal();
    }
  });
})();

// Bulletproof "I want the latest" — unregister all SWs and delete every
// cache so the reload hits raw network. Critical safety check: probe the
// origin BEFORE wiping. If offline, abort — never strand the user with
// no SW + no cache + no network. navigator.onLine is unreliable on iOS,
// so we use a real cache-busted fetch.
async function reloadFromServer() {
  try {
    const probe = await fetch('sw.js?reload-probe=' + Date.now(), { cache: 'no-store' });
    if (!probe.ok) throw new Error('probe non-ok: ' + probe.status);
  } catch (_) {
    alert('Cannot reach the server right now. Reload aborted — reconnect to the internet and try again.');
    return;
  }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (e) { /* ignore — reload anyway */ }
  window.location.replace(window.location.pathname);
}

// ── Toast ──────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 4000);
}

