'use strict';
// =================================================
// SHARED AUDIOCONTEXT MANAGER
// Used by: microbreaker, ear-tuner
// =================================================
// Exposed globals: audioCtx, audioCtxGeneration, audioUnlocked, masterGain,
//                  nukeAudioCtx(), ensureAudio(), muteMasterGain(),
//                  unmuteMasterGain(), isAudioContextHealthy(), logAudioSession()
// Each app's audio.js may add its own synth functions that reference audioCtx,
// and optionally a getMasterGainForSettings() global (see _resolveMasterGain).
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
// CORRECTION (2026-06-02): an earlier version of this block claimed that
// 'play-and-record' "routes to device speaker / HFP mono only — NOT to A2DP,
// NOT to car stereo," and that being in that category is what makes the app
// quiet. BOTH CLAIMS ARE FALSE and they misdirected two debugging sessions.
// Full write-up + sources:
// microbreaker/research/26-06-02-0143_ios-mic-capture-output-ducking.md
// The corrected facts:
//   - WebKit's 'play-and-record' explicitly sets AllowBluetooth +
//     AllowBluetoothA2DP + AllowAirPlay (AudioSessionIOS.mm). A2DP / AirPlay /
//     car stereo ARE permitted output routes. (Confirmed by a car test:
//     Ear Tuner with voice on played out the car's Bluetooth A2DP.)
//   - The "everything gets quiet while recording" effect is NOT the category.
//     It's ACTIVE MIC CAPTURE ducking WebAudio output — WebKit bug 218012,
//     unresolved through iOS 18.6. Plain WebAudio playback (our bells, review
//     playback) is reduced and biased toward the receiver/earpiece whenever an
//     input is live, whatever category string we set.
//   - Separately, A2DP can't do full duplex, so while an input is active iOS
//     drops Bluetooth to HFP (mono) — a quality hit, distinct from the loudness
//     hit above.
//
// `navigator.audioSession.type` controls iOS's AVAudioSession category
// — independent from AudioContext state but managed here because the
// two interact (getUserMedia on the wrong category throws). Two values:
//
//   'playback'         — output only. getUserMedia REJECTS from this category
//                        on iOS 18+ (InvalidStateError).
//   'play-and-record'  — full duplex; required for getUserMedia. Allows A2DP /
//                        AirPlay / car as output routes, BUT active capture
//                        ducks WebAudio output (bug 218012) and forces
//                        Bluetooth to HFP mono.
//
// Dynamic switch policy: ensureAudio reads `appWantsMic()` (resolver
// pattern — each app defines it) and sets the right category. acquireMic
// forces 'play-and-record' just before getUserMedia (belt-and-suspenders
// for the case where appWantsMic flipped true after the last ensureAudio).
// releaseMic re-evaluates and may drop back to 'playback'. We still prefer
// 'playback' when no mic is wanted — not because 'play-and-record' blocks the
// car (it doesn't), but because dropping capture is what lets WebAudio output
// return to full level (the bug-218012 workaround #1).
//
// Diagnostic: logAudioSession() records the live `navigator.audioSession.type`
// readback at each set-point so we can verify what mode we're actually in.
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

// Resolves the desired iOS audio session category. Each app can define
// a global `appWantsMic()` returning true/false. See the corrected doctrine
// block above and research/26-06-02-0143_ios-mic-capture-output-ducking.md —
// in short, 'play-and-record' does NOT block A2DP/car; the reason to prefer
// 'playback' when no mic is wanted is that ending capture lets WebAudio output
// return to full volume (WebKit bug 218012):
//
//   'playback'         — output-only. Allows A2DP / AirPlay / car. iOS 18+
//                        REJECTS getUserMedia from this category.
//   'play-and-record'  — full duplex; required for getUserMedia on iOS 18+.
//                        Also allows A2DP / AirPlay as output routes, but
//                        active capture ducks WebAudio output and drops
//                        Bluetooth to HFP mono.
//
// We use 'playback' when the app doesn't need mic and switch to
// 'play-and-record' when mic is actually needed (VR engaged, recording
// active). acquireMic() in mic.js also forces 'play-and-record' just
// before getUserMedia as a belt-and-suspenders measure.
//
// Apps without the override default to 'play-and-record' (current
// behaviour preserved — safe choice for an unknown app that may or
// may not need mic).
function _resolveAudioSessionType() {
  if (typeof appWantsMic === 'function') {
    try { return appWantsMic() ? 'play-and-record' : 'playback'; } catch (_) {}
  }
  return 'play-and-record';
}

function nukeAudioCtx(reason) {
  // Abandon old context synchronously — no await, preserves user-gesture stack on iOS.
  if (!audioCtx) return;
  const old = audioCtx;
  audioCtx   = null;
  masterGain = null;
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

// ── Diagnostic: snapshot the page's audio-session mode into the diag log ──
// console.log is persisted by diag-log.js → Settings → Diagnostics → Error log.
// Reads navigator.audioSession BACK after we set it, which answers "is the page
// actually in play-and-record, or did the set silently no-op?":
//   api=NO    → navigator.audioSession unsupported; we never set a category and
//               WebKit chooses one implicitly (it picks play-and-record when an
//               input is active, playback otherwise).
//   type=auto → API present but we are NOT forcing a category — WebKit decides.
//   type=play-and-record / playback → what the page is actually requesting.
// The Web Platform does NOT expose the iOS output ROUTE name to JS, so pair the
// logged type with the observed route (e.g. the car's Bluetooth screen) to learn
// whether play-and-record actually reaches A2DP. Context: WebKit bug 218012 —
// active mic capture ducks WebAudio output regardless of category.
function logAudioSession(tag) {
  try {
    const as  = navigator.audioSession;
    const trk = (typeof micStream !== 'undefined' && micStream)
      ? (micStream.getAudioTracks()[0] || null) : null;
    console.log('[session] ' + (tag || '') +
      ' api=' + (as ? 'yes' : 'NO') +
      ' type=' + (as ? as.type : 'n/a') +
      ' state=' + (as ? (as.state || 'n/a') : 'n/a') +
      ' wantMic=' + (typeof appWantsMic === 'function' ? appWantsMic() : '?') +
      ' ctx=' + (audioCtx ? audioCtx.state : 'none') +
      ' micTrack=' + (trk ? trk.readyState : 'none'));
  } catch (e) {
    console.log('[session] ' + (tag || '') + ' probe-failed: ' + (e && e.message));
  }
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
    masterGain.connect(audioCtx.destination);
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
  // Set the audio session category — UNCONDITIONALLY (re-assign even
  // when navigator.audioSession.type already reads the desired value).
  //
  // Why unconditional: the `audioSession.type` field is per-document.
  // When the user switches between two fiddle-family PWAs (or our PWA
  // and another audio app), iOS hands the hardware session to whichever
  // is foregrounded. Our document's type field stays at its last
  // setting because we never wrote anything else — but the iOS
  // hardware path is owned by the other app. The conditional skip
  // ("type already matches") would miss the cross-PWA case and
  // AudioContext.destination would silently produce no output.
  // (Confirmed by Casey 2026-05-13 16:20: ear-tuner → microbreaker →
  // ear-tuner produced state='running' but no audible output until
  // we dropped the conditional. Failure mode 4 in the doctrine block.)
  //
  // The TYPE itself is dynamic — see _resolveAudioSessionType. Apps
  // that need mic (VR active, recording active) get 'play-and-record';
  // apps in playback-only mode get 'playback', which routes through
  // Bluetooth A2DP / AirPlay / car stereo. Casey's 2026-05-13 car
  // test caught this: 'play-and-record' had been the unconditional
  // category, so notes played through the device speaker instead of
  // car Bluetooth.
  //
  // The setter is cheap on iOS when the value already matches; the
  // idempotent re-assignment serves as our session-claim re-assertion.
  //
  // Pre-iOS-18, 'playback' worked even when mic was needed because
  // getUserMedia didn't enforce a category match. iOS 18 made the
  // category strict: getUserMedia on a 'playback' session rejects with
  // InvalidStateError. The dynamic switch is how we keep both worlds
  // working — see mic.js acquireMic for the gesture-frame switch
  // ahead of getUserMedia.
  if (navigator.audioSession) {
    try { navigator.audioSession.type = _resolveAudioSessionType(); } catch(e){}
  }
  logAudioSession('ensureAudio');
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

// iOS/iPadOS: unlock audio context on any touch, in case ensureAudio()
// was never called (e.g. foot pedal was first interaction)
document.addEventListener('touchstart', () => {
  ensureAudio();
}, { once: false, passive: true });
