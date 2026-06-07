'use strict';
// =================================================
// SHARED AUDIOCONTEXT MANAGER
// Used by: microbreaker, ear-tuner
// =================================================
// Exposed globals: audioCtx, audioCtxGeneration, audioUnlocked, masterGain,
//                  masterLimiter, nukeAudioCtx(), ensureAudio(),
//                  muteMasterGain(), unmuteMasterGain(), isAudioContextHealthy()
// Each app's audio.js may add its own synth functions that reference audioCtx,
// and optionally a getMasterGainForSettings() global (see _resolveMasterGain)
// and a getMasterLimiterOptions() global (see ensureAudio — opt-in master
// limiter; apps that don't define it keep the direct masterGain→destination
// wiring unchanged).
//
// =================================================
// DOCTRINE — read this before changing recovery code
// =================================================
//
// iOS Safari's AudioContext is a hostile environment. Four distinct
// failure modes exist; we use four different mechanisms to handle them.
// History below explains why we don't have a single "is this context
// usable?" predicate.
//
// ── Failure modes and their detectors ──
//
// 1. SUSPENDED (the normal case after construction).
//    Detector: `audioCtx.state === 'suspended'`. Reliable.
//    Recovery: `resume()`, must run inside a user-gesture frame on first
//    unlock; resume() outside a gesture is empirically permitted once
//    the session has had at least one earlier gesture.
//
// 2. INTERRUPTED (Safari-only state, fires on iOS audio-session
//    takeover — phone calls, Siri, mic acquisition, AudioWorklet
//    attachment, system sounds, AirPods reconnect).
//    Detector: `audioCtx.state === 'interrupted'`. Reliable.
//    Recovery: `resume()` succeeds without a gesture in our tests.
//    Handled in two places:
//      - statechange listener in ensureAudio (passive: catches mid-
//        session interruptions even without user interaction)
//      - ensureAudio() body (active: any gesture-frame path through
//        ensureAudio re-resumes the context — this is the "while you're
//        in here anyway" insurance)
//
// 3. ZOMBIE — FROZEN CLOCK (WebKit bug 263627). State reads 'running'
//    but `currentTime` is frozen at t0 forever; nothing reaches output.
//    Detector: `isAudioContextHealthy()` — 100ms wall-clock probe of
//    currentTime advancement. Reliable for this specific shape.
//    Recovery: `nukeAudioCtx()` + `ensureAudio()`.
//
// 4. ZOMBIE — RUNNING-BUT-SILENT. State reads 'running', currentTime
//    advances normally, no audio reaches output. NO RELIABLE DETECTOR
//    EXISTS — the API lies on all surfaces.
//    Recovery: the doctrine policy below + unconditional re-assertion
//    of `navigator.audioSession.type` inside ensureAudio (see comment
//    in that function). One known trigger: cross-PWA audio-session
//    handoff. When two fiddle-family PWAs (or our PWA + another audio
//    app) are both backgrounding-and-foregrounding, iOS reassigns the
//    hardware audio session to whichever is foregrounded. The OS
//    surfaces no 'interrupted' state to JavaScript — `audioCtx.state`
//    stays `'running'` even though `audioCtx.destination` produces
//    nothing audible. AudioWorklet processing (e.g., voice recognition
//    consuming mic input) continues to work because that path doesn't
//    flow through the lost hardware route. Re-asserting the session
//    type forces iOS to re-claim the hardware for us.
//
// ── Doctrine: gesture-frame paths always rebuild; silent paths probe ──
//
// User-gesture-frame recovery (Resume modal close, Start tap):
//   → ALWAYS `nukeAudioCtx() + ensureAudio()`. Do not consult any
//     probe. The user already paid the gesture cost; a fresh context
//     (~10–30 ms) is cheap insurance against failure mode 4 which we
//     cannot detect. See each app's `closeResume` and
//     `_shared/js/visibility-recovery.md` Phase 3.
//
// Silent visibility-regain recovery (no modal, branches B and C of the
// orchestrator):
//   → USE `isAudioContextHealthy()`. If healthy, leave the context;
//     if not, silent nuke + rebuild. Cost of a false-positive here
//     (failure mode 4 sneaks through) is only an extra silent rebuild
//     after the next genuinely-broken cycle — not a dead app today.
//     Avoiding the unconditional always-nuke saves the user a fresh
//     context creation on every backgrounding round-trip.
//
// ── iOS audio session category (separate concern, same module) ──
//
// `navigator.audioSession.type` controls iOS's AVAudioSession category
// — independent from AudioContext state but managed here because the
// two interact (getUserMedia on the wrong category throws). Two values:
//
//   'playback'         — output only. Routes to Bluetooth A2DP, AirPlay,
//                        car stereo, AirPods (stereo music quality).
//                        getUserMedia REJECTS from this category on
//                        iOS 18+ (InvalidStateError).
//   'play-and-record'  — full duplex. Required for getUserMedia. Routes
//                        output to device speaker / HFP mono Bluetooth
//                        only — NOT to A2DP, NOT to AirPlay, NOT to
//                        car stereo. The "voice call" category.
//
// Two write disciplines, by the value being written:
//
// HARDCODED writes — definitionally correct for their call site:
//   1. Module init (audio-ctx.js bottom): 'playback' at page load.
//   2. acquireMic() (mic.js): 'play-and-record' BEFORE getUserMedia
//      (iOS 18+ rejects it from 'playback') and again after success.
//   3. releaseMic() (mic.js): 'playback' immediately.
//
// INTENT-BASED writes — go through _resolveAudioSessionType(), which is
// safe to call at any lifecycle point without risking a transitional
// wrong value:
//   4. ensureAudio() (this file): re-assert after create/resume. Re-claims
//      the hardware session for a fresh context (failure mode 4) and lands
//      'play-and-record' ahead of the concurrent acquireMic on rebuild.
//   5. _onMaybeForegrounded() (ui.js): re-assert on visibility-regain for
//      failure-mode-4 cross-PWA session recovery.
//
// NOTE on (5): it is intentionally NOT a blind _resolveAudioSessionType()
// write. When VC is on but the mic is not yet live (screen-lock release),
// it leaves the type UNTOUCHED — the flow is heading for Resume +
// acquireMic, which will set 'play-and-record' with a real mic. Writing
// 'play-and-record' there would route to the iPhone earpiece at inaudible
// volume for the whole Resume-modal window — 'play-and-record' WITHOUT a
// live mic does this, confirmed 2026-06-02. Never use it as a base state.
// (This is why ensureAudio's intent-based write is safe but the foreground
// re-assert needs the extra mic-live guard: ensureAudio always runs with a
// mic present or being acquired in the same frame; the foreground path may
// not be.)
//
// ── Things we tried that did NOT work ──
//
// • Flag-based "needs reset on next gesture" (April 2026). Race window
//   between the flag write and the next ensureAudio meant the flag
//   often never fired. Replaced by unconditional nukeAudioCtx().
//
// • `await audioCtx.close()` inside the gesture handler. The await
//   broke the iOS user-gesture call stack — the recreated AudioContext
//   was created outside gesture context and could not be resumed.
//   Replaced by synchronous nuke + fire-and-forget `old.close()`.
//
// • `resume()` as the universal recovery. State='running' zombies are
//   no-ops for resume(); needs a full nuke + rebuild.
//
// • Trusting `isAudioContextHealthy()` to gate the Resume rebuild
//   (May 13, 2026 morning). Probe returned `healthy` for a context
//   that produced no audio — failure mode 4 above. Doctrine split:
//   Resume always nukes; silent paths still probe.
//
// • Doing nothing on `'interrupted'` (May 13, 2026 afternoon — Casey's
//   iPad logs caught it). iOS would interrupt the freshly-rebuilt
//   context within the same second as Resume's nuke + ensureAudio,
//   probably from the audio-session reconfiguration triggered by mic
//   acquire / worklet attach. The statechange listener now auto-resumes.
//
// ── Cross-references ──
//
// _shared/js/visibility-recovery.md   — Branch A/B/C orchestration for
//                                       backgrounding + Resume modal flow.
// _shared/js/version-update-flow.md   — SW update + upgrade-screen flow
//                                       (separate concern; shares only
//                                       the broader "iOS PWAs are hostile"
//                                       mental model).
// <app>/js/ui.js  → closeResume       — Doctrine in action for the
//                                       gesture-frame path.
// <app>/js/ui.js  → _onMaybeForegrounded
//                                     — Doctrine in action for the
//                                       silent Branches B and C.
//
// =================================================

let audioCtx          = null;
let audioCtxGeneration = 0;   // bumped on every recreate — stale refs detect zombie
let audioUnlocked     = false;

let masterGain = null;
// Optional master limiter (DynamicsCompressor) inserted between masterGain and
// destination when the app defines getMasterLimiterOptions(). null when unused.
let masterLimiter = null;

// Default master-gain resolver. Each app can define a global
// `getMasterGainForSettings()` to return the right initial gain for its
// settings model — microbreaker uses notifyVol/0.35, ear-tuner uses
// settings.volume directly. The fallback preserves the original
// microbreaker formula so an app without the override still works.
// Called from ensureAudio (initial setup) and unmuteMasterGain
// (visibility-regain restore); apps that drive volume via their own
// settings-change handlers (e.g. microbreaker.updateMasterGain) still
// own those paths.
function _resolveMasterGain() {
  if (typeof getMasterGainForSettings === 'function') {
    try { return getMasterGainForSettings(); } catch (_) {}
  }
  // Fallback for apps without the override. Guards against a missing
  // `settings` global so a third app syncing this module without one
  // doesn't ReferenceError before its own getMasterGainForSettings can
  // be defined.
  if (typeof settings === 'undefined' || !settings) return 1.0;
  return (parseFloat(settings.notifyVol) || 0.35) / 0.35;
}

// Resolves the desired iOS audio session category. The category controls
// iOS hardware routing:
//
//   'playback'         — output-only. Routes to Bluetooth A2DP (stereo
//                        music quality), AirPlay, headphones, car audio.
//                        Uses the MEDIA volume rail. CONFIRMED 2026-06-02:
//                        VC-off output is tightly + bidirectionally coupled
//                        to the media rail (moving the YouTube/media slider
//                        moves our volume and vice-versa). iOS 18+ REJECTS
//                        getUserMedia from this category.
//   'play-and-record'  — full duplex (output + input). Required for
//                        getUserMedia on iOS 18+. Routes output to
//                        device speaker / HFP mono Bluetooth only —
//                        NOT to A2DP, NOT to AirPlay. The "voice call"
//                        category. Uses the SPEAKERPHONE volume rail.
//                        CONFIRMED 2026-06-02: VC-on output is tightly +
//                        bidirectionally coupled to the speakerphone rail
//                        (a voicemail played on speakerphone moves our
//                        volume and vice-versa). It is NOT the media rail
//                        and NOT the Ringtones & Alerts rail — even with
//                        "Change with Buttons" on. Not readable from a PWA;
//                        only a native plugin can normalize it.
//
// Policy: intent-based — 'play-and-record' when VC is on (sessionUseVoice),
// 'playback' otherwise. NOT keyed on micStreamIsLive(): the mic is never
// live at the moments this is called (fresh context / foreground after a
// mic-releasing background), so a ground-truth check would collapse to
// 'playback' every time. See _resolveAudioSessionType + the doctrine block.
//
// 'playback' → media volume rail, A2DP / car stereo / AirPlay routing.
// 'play-and-record' → required for active getUserMedia on iOS 18+.
//
// Volume inconsistency between VC-on and VC-off is a known iOS limitation:
// iOS voice processing (activated when a mic stream is live) boosts the
// output path regardless of what the web page does. This cannot be
// controlled via the Web API. Known fixes:
//   • Capacitor native plugin: set AVAudioSessionMode.measurement to
//     disable iOS voice processing, read outputVolume to normalize.
//   • Web: no solution — accept the difference or use the in-app
//     volume slider to compensate per-mode.
//
// 'play-and-record' WITHOUT a live mic stream routes to the iPhone
// earpiece at inaudible volume — do NOT use it as a base state.
//
// History: unconditional play-and-record → dynamic appWantsMic() →
// micStreamIsLive() → always playback → always play-and-record (earpiece
// routing — unusable) → micStreamIsLive() → intent-based (sessionUseVoice).
// Each experiment is documented in the session log. 2026-06-02.
function _resolveAudioSessionType() {
  // Intent-based, via the appWantsMic() callback each app defines in its
  // app-local audio.js (NOT a synced file). This is the shared contract —
  // ear-tuner answers with sessionUseVoice; microbreaker answers with
  // (recording || voiceCommands). When the app wants the mic we need
  // 'play-and-record'; otherwise 'playback'. Guard for shared-module use in
  // an app that never defines the callback (defaults to playback). Do NOT
  // hardcode a single app's gate (e.g. sessionUseVoice) here — that breaks
  // every sibling app that gates the mic differently.
  if (typeof appWantsMic === 'function' && appWantsMic()) {
    return 'play-and-record';
  }
  return 'playback';
}

function nukeAudioCtx(reason) {
  // Abandon old context synchronously — no await, preserves user-gesture stack on iOS.
  if (!audioCtx) return;
  const old = audioCtx;
  audioCtx   = null;
  masterGain = null;
  masterLimiter = null;
  audioUnlocked = false;
  audioCtxGeneration++;
  // Soundfont instruments are bound to the old context — clear so they reload on next play.
  // (sfInstruments/sfLoadingP only exist in apps using soundfont-player)
  if (typeof sfInstruments !== 'undefined') {
    Object.keys(sfInstruments).forEach(k => delete sfInstruments[k]);
  }
  if (typeof sfLoadingP !== 'undefined') {
    Object.keys(sfLoadingP).forEach(k => delete sfLoadingP[k]);
  }
  // Fire-and-forget close so the OS reclaims hardware eventually
  try { old.close(); } catch(e){}
}

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    console.log('[ctx] created gen=' + audioCtxGeneration + ' state=' + audioCtx.state);
    // Surface every AudioContext state transition (running/suspended/interrupted/closed).
    // iOS fires 'interrupted' on phone calls, screen lock, audio-session conflicts;
    // those events are otherwise invisible. Capture ctx + generation in the closure
    // so a late-firing statechange on an already-nuked context reports its OWN
    // identity, not whatever the audioCtx global has been swapped to — crucial for
    // diagnosing transitions that happen across a nukeAudioCtx() cycle. The
    // listener is GC'd with the old context after old.close() in nukeAudioCtx.
    const ctx = audioCtx;
    const gen = audioCtxGeneration;
    ctx.addEventListener('statechange', () => {
      console.log('[ctx] statechange gen=' + gen + ' state=' + ctx.state);
      // Auto-recover from iOS audio-session interruption. Safari fires
      // 'interrupted' when the OS takes the session — phone calls,
      // Siri, AirPods reconnect, system sounds, and (most commonly for
      // us) the brief session reconfiguration that follows mic
      // acquisition or worklet attachment on a fresh context. Without
      // this, the context stays interrupted forever and no audio
      // reaches the speaker. Guard against resuming a context we've
      // already nuked — only auto-resume if this is still the live one.
      if (ctx.state === 'interrupted' && ctx === audioCtx) {
        ctx.resume().catch(() => {});
      }
    });
    masterGain = audioCtx.createGain();
    masterGain.gain.value = _resolveMasterGain();
    // Optional app-provided master limiter. If the app defines
    // getMasterLimiterOptions() returning a config object, insert a
    // DynamicsCompressor (brick-wall) between masterGain and destination —
    // lets an app run hot per-voice gains (and a >1 volume/boost) without
    // clipping transients. Apps that don't define it keep the original
    // direct wiring, so siblings are unaffected.
    let limOpts = null;
    if (typeof getMasterLimiterOptions === 'function') {
      try { limOpts = getMasterLimiterOptions(); } catch (_) {}
    }
    if (limOpts) {
      masterLimiter = audioCtx.createDynamicsCompressor();
      masterLimiter.threshold.value = limOpts.threshold ?? -2;
      masterLimiter.knee.value      = limOpts.knee      ?? 0;
      masterLimiter.ratio.value     = limOpts.ratio     ?? 20;
      masterLimiter.attack.value    = limOpts.attack    ?? 0.003;
      masterLimiter.release.value   = limOpts.release   ?? 0.10;
      masterGain.connect(masterLimiter);
      masterLimiter.connect(audioCtx.destination);
    } else {
      masterGain.connect(audioCtx.destination);
    }
  }
  // 'suspended' is the normal post-create state (resumes via user
  // gesture). 'interrupted' is Safari-only: an in-flight iOS audio
  // session takeover that resume() can also clear. Either way, try
  // resume() — if we're inside a gesture frame iOS will honour it,
  // and if not the statechange auto-resume above will catch up.
  if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
    try { await audioCtx.resume(); } catch(e){}
  }
  audioUnlocked = true;
  // Re-assert the session category through the single source of truth.
  // Re-writing a consistent value is harmless (WebKit's setCategoryOverride
  // is idempotent for our purposes) and earns its keep twice: (1) after a
  // fresh AudioContext following old.close(), it re-claims the hardware
  // session (failure mode 4); (2) on the VC-on rebuild paths it lands
  // 'play-and-record' ahead of the concurrent acquireMic(). It never
  // creates a *sustained* mic-less 'play-and-record': every VC-on caller
  // of ensureAudio() either already holds the mic (Branch B/C) or acquires
  // it concurrently (onHelloYes / onVoiceToggle / _performResumeRebuild).
  if (navigator.audioSession) {
    try { navigator.audioSession.type = _resolveAudioSessionType(); } catch (e) {}
  }
}

// Silence the master gain immediately, cancelling any future scheduled
// gain envelopes. Call this on backgrounding to prevent in-flight or
// queued oscillator audio from reaching iOS audio output across the
// focus-change boundary. Closing the context mid-decay produces audible
// click/pop artifacts; muting the gain is graceful and reversible —
// scheduled oscillators continue running but inaudibly, and natural
// .stop() times will clean them up.
function muteMasterGain() {
  if (!audioCtx || !masterGain) return;
  try {
    masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
    masterGain.gain.setValueAtTime(0, audioCtx.currentTime);
  } catch (e) {}
}

// Restore master gain to the user's current notifyVol setting. Called on
// visibility-regain when the AudioContext is healthy and we want to keep
// playing without forcing the user through a Resume modal.
function unmuteMasterGain() {
  if (!audioCtx || !masterGain) return;
  try {
    const v = _resolveMasterGain();
    masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
    masterGain.gain.setValueAtTime(v, audioCtx.currentTime);
  } catch (e) {}
}

// Liveness probe: distinguishes a healthy AudioContext from the iOS
// "zombie" state where state reads 'running' but currentTime is frozen
// (WebKit bug 263627, still open as of late 2024). Two-signal check:
//
//   1. Safari-only state === 'interrupted' (set on phone calls, screen
//      lock, some backgrounding paths) — recoverable via resume() but
//      requires the gesture chain.
//   2. currentTime advancement: a healthy context advances ~0.1s of clock
//      in 100ms wall time; a zombie stays exactly at t0 forever. No event
//      fires for the zombie case — polling is the only signal.
//
// Returns true if the context is usable, false if a nuke + rebuild is
// the right move. Always call this AFTER any in-flight resume() promise
// settles. ~100ms latency is the cost of detection; acceptable inside
// the visibility-regain handler since we'd otherwise be opening a modal.
async function isAudioContextHealthy() {
  if (!audioCtx) return false;
  if (audioCtx.state === 'interrupted') {
    try { await audioCtx.resume(); } catch (e) { return false; }
  }
  if (audioCtx.state !== 'running') return false;
  const t0 = audioCtx.currentTime;
  await new Promise(r => setTimeout(r, 100));
  return (audioCtx.currentTime - t0) > 0.05;
}

// Visibility / pageshow handlers (audio side):
//
// The previous design called nukeAudioCtx() unconditionally on every
// visibility-regain because we couldn't distinguish a zombie from a
// healthy context. With isAudioContextHealthy() above, we have a probe
// — so the nuke moves to the orchestration layer (the app's UI handler
// that knows about MediaRecorder / voice / Resume modal) and only fires
// when the probe says the context is genuinely broken.
//
// All this layer does now is mute master gain on hidden, so any in-flight
// or scheduled oscillators don't bleed across the boundary. Unmute is
// driven by the orchestrator after the health probe passes (or by
// ensureAudio() on the next gesture, post-nuke).
document.addEventListener('visibilitychange', () => {
  console.log('[bg] visibilitychange state=' + document.visibilityState);
  if (document.visibilityState === 'hidden') {
    muteMasterGain();
  }
});

window.addEventListener('pageshow', (e) => {
  console.log('[bg] pageshow persisted=' + (e && e.persisted));
  // iOS BFCache restores DOM inline styles including visibility:hidden set by openInfo/openSettings.
  // Always reset to ensure app content is visible on restore.
  const appEl   = document.getElementById('app');
  const swipeEl = document.getElementById('swipe-hint');
  const infoEl  = document.getElementById('info-overlay');
  if (appEl)   appEl.style.visibility   = '';
  if (swipeEl) swipeEl.style.visibility = '';
  if (infoEl)  infoEl.classList.remove('open');
});

// Beep-storm diagnostics — log every lifecycle signal we don't already
// instrument elsewhere. We've never confirmed which event(s) actually fire
// during the multi-beep regression, so log them all and let the diag-log
// transcript expose the real sequence post-incident. No functional change:
// these handlers ONLY log. Removable once the root cause is known.
window.addEventListener('pagehide',  (e) => { console.log('[bg] pagehide persisted=' + (e && e.persisted)); });
window.addEventListener('blur',      () => { console.log('[bg] window-blur'); });
window.addEventListener('focus',     () => { console.log('[bg] window-focus'); });
// Page Lifecycle API — Safari ships these on some iOS versions; cheap to listen even when no-op.
document.addEventListener('freeze',  () => { console.log('[bg] freeze'); });
document.addEventListener('resume',  () => { console.log('[bg] resume'); });

// Baseline session type: 'playback' at page load. This is the correct
// state before any mic is acquired. acquireMic() overrides to
// 'play-and-record' on success; releaseMic() resets to 'playback'.
// Failure-mode-4 re-assertion is handled in _onMaybeForegrounded()
// (ui.js), not here — visibility-regain is the right trigger for
// cross-PWA session loss, not every tap.
if (navigator.audioSession) {
  try { navigator.audioSession.type = 'playback'; } catch (_) {}
}

// iOS/iPadOS: unlock audio context on any touch, in case ensureAudio()
// was never called (e.g. foot pedal was first interaction)
document.addEventListener('touchstart', () => {
  ensureAudio();
}, { once: false, passive: true });
