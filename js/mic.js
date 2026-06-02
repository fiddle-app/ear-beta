'use strict';

// =================================================
// MIC — shared across fiddle apps
// -----------------------------------------------------------------
// Bare microphone-acquisition helpers. Owns the persistent-mute auto-
// release pattern that mitigates iOS's lock-screen beep storm; does
// NOT own MediaRecorder or any app-specific lifecycle (recording-blob
// assembly, memory snapshots, review playback). Apps that need those
// live in their own app-local module (e.g. microbreaker/js/mic-recording.js).
//
// EXPERIMENT (beep-storm mitigation): when iOS prepares for screen lock,
// it cycles the mic track mute → unmute → mute within ~1s, and each
// transition appears to fire an iOS microphone-indicator beep. The first
// mute event leads the cascade by ~700-900ms — that's our warning shot.
// On a sustained mute (no unmute within DEBOUNCE_MS), we voluntarily
// release the mic so iOS doesn't need to keep cycling a stream we still
// hold. If our hypothesis is right, this reduces 3 beeps to 0 or 1; if
// wrong, beep count is unchanged and we paid for a Resume modal on regain.
// Cost regardless: the next foreground requires a user gesture to
// re-acquire — i.e. the Resume modal fires every lock-and-return.
//
// Globals exposed: micStream, acquireMic, releaseMic, micStreamIsLive.
// Globals consumed: audioCtx, audioUnlocked (from audio-ctx.js).
// =================================================

let micStream     = null;
const _MIC_PERSISTENT_MUTE_MS = 300;
let _micPersistentMuteTimer   = null;
// Foreground ("half-flip") recovery tuning — see _maybeRecoverForegroundMic.
// The delay MUST exceed the observed auto-release→background lag (~0.9s,
// 2026-06-02) so that a real screen-lock has already fired
// visibilitychange→hidden by the time we check — otherwise we'd wrongly
// "recover" the mic while a lock is mid-flight. Cooldown guards against a
// mute→release→reacquire thrash loop if iOS keeps re-muting.
const _MIC_FG_RECOVERY_DELAY_MS    = 1500;
const _MIC_FG_RECOVERY_COOLDOWN_MS = 4000;
let   _micFgRecoveryAt             = 0;
// In-flight getUserMedia promise — concurrent callers share this so we
// don't double-prompt on iOS or leak the first stream when two paths
// (e.g., a pointerdown warm-up + a click handler) both call acquireMic
// in the same gesture. Cleared after the call resolves.
let _micAcquireP  = null;

// Release listeners — apps that own auxiliary state tied to the stream
// (e.g. MediaRecorder in microbreaker/js/mic-recording.js) register a
// callback here. We fire each listener BEFORE we stop the tracks so
// the consumer has a chance to flush state cleanly. Listeners must be
// idempotent and cheap.
const _micReleaseListeners = [];
function onMicWillRelease(cb) { _micReleaseListeners.push(cb); }

async function acquireMic() {
  if (micStream) return true;  // reuse existing stream
  if (_micAcquireP) return _micAcquireP;
  _micAcquireP = (async () => {
    try {
      // Pre-set 'play-and-record' BEFORE getUserMedia. iOS 18+ rejects
      // getUserMedia from a 'playback' session with InvalidStateError,
      // and the session may well be 'playback' here: ensureAudio() no
      // longer sets the type, so on the initial VC-on path (onHelloYes /
      // onVoiceToggle) the only prior write is the module-init 'playback'
      // baseline. acquireMic now owns the guarantee that the category is
      // correct when getUserMedia evaluates it.
      if (navigator.audioSession) {
        try { navigator.audioSession.type = 'play-and-record'; } catch (_) {}
      }
      // Mic constraints come from the app via appMicConstraints() (app-local,
      // like appWantsMic). Fiddle apps disable iOS voice processing
      // (echoCancellation / noiseSuppression / autoGainControl) because the
      // default-on processing engages the voice-processing I/O unit (VPIO),
      // which reroutes output to the iPhone earpiece at attenuated volume and
      // STICKS for the whole AVAudioSession with no web API to undo it
      // (confirmed 2026-06-02; microbreaker avoids the trap exactly this way).
      // Default to plain audio if the app defines no hook.
      const _micConstraints = (typeof appMicConstraints === 'function')
        ? appMicConstraints()
        : { audio: true, video: false };
      micStream = await navigator.mediaDevices.getUserMedia(_micConstraints);
      // Re-confirm session type immediately on successful acquisition —
      // do NOT wait for the next ensureAudio() call (which may never come
      // in VC gameplay since the user never touches the screen). This is
      // the authoritative moment: mic is live, session must be
      // 'play-and-record'. Symmetric with releaseMic() → 'playback'.
      if (navigator.audioSession) {
        try { navigator.audioSession.type = 'play-and-record'; } catch (_) {}
      }
      const tracks = micStream.getAudioTracks();
      console.log('[mic] acquired tracks=' + tracks.length +
                  ' visible=' + (document.visibilityState === 'visible'));
      // Listen to tracks[0] only, NOT forEach. Rationale: the persistent-mute
      // debounce timer (_micPersistentMuteTimer) is module-scoped — a multi-track
      // listener model would race against it (track A mute → timer armed; track B
      // unmute → timer cleared even though A is still muted). getUserMedia with
      // { audio: true } returns exactly one audio track, so single-track is
      // load-bearing. If we ever request constraints that could yield multiple
      // audio tracks, key the timer by track index instead.
      //
      // ended fires when iOS yanks the source mid-session; mute/unmute fire
      // when iOS suspends/resumes data flow (notably, the pre-lock cascade
      // that fires 3 iOS microphone-indicator beeps — see persistent-mute
      // auto-release below).
      const track = tracks[0];
      if (track) {
        track.addEventListener('ended', () => {
          console.log('[mic] track ended visible=' + (document.visibilityState === 'visible'));
        });
        track.addEventListener('mute', () => {
          console.log('[mic] track mute visible=' + (document.visibilityState === 'visible'));
          // Persistent-mute = pre-lock cascade. Arm release timer; cancel on unmute.
          if (_micPersistentMuteTimer) clearTimeout(_micPersistentMuteTimer);
          _micPersistentMuteTimer = setTimeout(() => {
            _micPersistentMuteTimer = null;
            console.log('[mic] auto-release on persistent mute (experiment)');
            releaseMic();
            _maybeRecoverForegroundMic();
          }, _MIC_PERSISTENT_MUTE_MS);
        });
        track.addEventListener('unmute', () => {
          console.log('[mic] track unmute visible=' + (document.visibilityState === 'visible'));
          if (_micPersistentMuteTimer) {
            clearTimeout(_micPersistentMuteTimer);
            _micPersistentMuteTimer = null;
            console.log('[mic] persistent-mute timer cancelled by unmute');
          }
        });
      }
      // getUserMedia can suspend the AudioContext on iPad — resume it
      if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      if (typeof audioUnlocked !== 'undefined') {
        audioUnlocked = true;
      }
      return true;
    } catch(e) {
      console.warn('getUserMedia failed:', e);
      micStream = null;
      // Undo the pre-set 'play-and-record' from above. With no mic stream
      // it would route output to the iPhone earpiece at inaudible volume
      // (confirmed 2026-06-02). Callers (onHelloYes / onVoiceToggle /
      // handleStart) drop sessionUseVoice on failure but do NOT call
      // releaseMic(), so this is the only cleanup point for the pre-set.
      if (navigator.audioSession) {
        try { navigator.audioSession.type = 'playback'; } catch (_) {}
      }
      return false;
    } finally {
      _micAcquireP = null;
    }
  })();
  return _micAcquireP;
}

// Forcefully release the mic stream. Apps that hold a MediaRecorder
// must stop and tear that down BEFORE calling this — this helper does
// not know about recorders.
function releaseMic() {
  // Notify auxiliary state owners (recorder, etc.) BEFORE we drop the
  // stream — they may need to flush or stop. Failures here are logged
  // and swallowed so a flaky listener doesn't strand the stream.
  for (const cb of _micReleaseListeners) {
    try { cb(); } catch (e) { console.warn('[mic] release listener threw:', e); }
  }
  if (_micPersistentMuteTimer) {
    clearTimeout(_micPersistentMuteTimer);
    _micPersistentMuteTimer = null;
  }
  if (micStream) {
    try { micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    micStream = null;
  }
  // Always drop to 'playback' on release. The mic stream is gone, so
  // 'play-and-record' (duplex/HFP mode) serves no purpose. 'playback'
  // routes output through Bluetooth A2DP / AirPlay / car stereo and
  // uses the media volume rail. On re-acquire, acquireMic() will force
  // 'play-and-record' back before getUserMedia.
  if (navigator.audioSession) {
    try { navigator.audioSession.type = 'playback'; } catch (e) {}
  }
}

// Half-flip recovery. The persistent-mute auto-release above exists for the
// pre-lock cascade (screen lock → app backgrounds → the foreground/Resume
// path rebuilds the mic). But iOS also briefly mutes the mic on an
// *incomplete* app-switch gesture ("half-flip") while the app stays
// foreground. There the auto-release stops the stream but NO visibilitychange
// fires — so the app's Resume recovery never runs, and in voice-command mode
// (no taps) the mic stays dead until a full app round-trip. Confirmed repro
// 2026-06-02 17:41.
//
// Detect that case — still visible a beat after the release — and hand it to
// the app's onMicAutoReleasedWhileForeground() hook. The app routes to its
// Resume/gesture flow: a gesture-less acquireMic() here pops an iOS mic
// permission prompt mid-app-carousel (confirmed 2026-06-02), so recovery MUST
// happen inside a user gesture. A real lock is excluded because by
// _MIC_FG_RECOVERY_DELAY_MS the app has already gone hidden (the normal
// foreground/Resume path owns that). The cooldown prevents thrash.
function _maybeRecoverForegroundMic() {
  setTimeout(() => {
    if (document.visibilityState !== 'visible') return;  // real lock → leave for the Resume path
    if (micStream) return;                               // already recovered (iOS un-muted / gesture path)
    if (!(typeof appWantsMic === 'function' && appWantsMic())) return;
    const now = Date.now();
    if (now - _micFgRecoveryAt < _MIC_FG_RECOVERY_COOLDOWN_MS) {
      console.log('[mic] fg-recovery skipped — cooldown');
      return;
    }
    _micFgRecoveryAt = now;
    if (typeof onMicAutoReleasedWhileForeground === 'function') {
      console.log('[mic] fg-recovery — handing to app (half-flip)');
      onMicAutoReleasedWhileForeground();
    } else {
      // No app handler: a gesture-less acquireMic() pops an iOS mic permission
      // prompt mid-app-carousel (confirmed 2026-06-02), so don't — the app
      // must own recovery and route it through a user gesture.
      console.log('[mic] fg-recovery — no app handler; cannot recover without a gesture');
    }
  }, _MIC_FG_RECOVERY_DELAY_MS);
}

// True if our cached micStream is still usable. iOS may end the
// underlying audio source during a long background — that transitions
// each track's readyState to 'ended'. Calling code (Resume) uses this
// as a pre-flight before trusting the cached stream; if false, drop
// and re-acquire inside the user-gesture frame.
function micStreamIsLive() {
  if (!micStream) return false;
  const tracks = micStream.getAudioTracks();
  if (tracks.length === 0) return false;
  return tracks.every(t => t.readyState === 'live');
}
