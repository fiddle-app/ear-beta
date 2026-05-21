'use strict';

// Resolver consumed by _shared/js/audio-ctx.js. Sets the master-gain
// default used by ensureAudio (initial) and unmuteMasterGain (visibility
// regain). Ear-tuner drives masterGain directly from settings.volume —
// the shared module's notifyVol fallback would otherwise pin gain to 1.0.
function getMasterGainForSettings() {
  return (typeof settings !== 'undefined' && settings) ? settings.volume : 1.0;
}

// Resolver consumed by _shared/js/audio-ctx.js (ensureAudio) and
// _shared/js/mic.js (releaseMic). Returns true when the app needs mic
// access — drives the dynamic audio-session category. Ear-tuner only
// needs mic when voice recognition is engaged for THIS session
// (sessionUseVoice). Without VR, returning false lets the shared
// module use 'playback' category, which routes output through
// Bluetooth A2DP / car stereo / AirPlay (the routing 'play-and-record'
// blocks).
function appWantsMic() {
  return typeof sessionUseVoice !== 'undefined' && !!sessionUseVoice;
}

// Audio output destination — masterGain (when audioCtx exists) lets the
// Volume setting scale every tone, beep, and chime in one place. Falls back
// to ctx.destination if masterGain is not yet built.
function audioOut() {
  if (typeof masterGain !== 'undefined' && masterGain) {
    masterGain.gain.value = settings.volume;
    return masterGain;
  }
  return audioCtx.destination;
}

// SOUNDFONT LOADING via soundfont-player
// sfInstruments: sfName → Soundfont instrument object
// ══════════════════════════════════════════════════════
const sfInstruments = {};
const sfLoadingP    = {};

async function loadSfInstrument(sfName) {
if (sfInstruments[sfName]) return sfInstruments[sfName];
if (sfLoadingP[sfName])    return sfLoadingP[sfName];
sfLoadingP[sfName] = Soundfont.instrument(audioCtx, sfName, {
  from: 'sounds/',
  gain: 1.0,
  destination: audioOut(),
}).then(inst => {
  sfInstruments[sfName] = inst;
  return inst;
});
return sfLoadingP[sfName];
}

// ══════════════════════════════════════════════════════
// PLAY FUNCTIONS — all return a handle with stopAt()
// ══════════════════════════════════════════════════════
function playSfNote(inst, midiF, startTime, duration, gain) {
// Refresh instrument destination to current masterGain — handles instruments
// loaded before audioCtx existed AND syncs masterGain.gain.value to settings.volume.
const dest = audioOut();
if (inst && 'destination' in inst) inst.destination = dest;
// soundfont-player: inst.play(note, time, options) — accepts fractional midi for detuning
const node = inst.play(midiF, startTime, { duration: duration, gain: gain, destination: dest });
return {
  stopAt(t) { try { node.stop(t); } catch(e){} }
};
}

function playSynthViolin(freqHz, startTime, duration) {
const ctx    = audioCtx;
const atk    = ATK_PRESETS[settings.attack][1];
const rel    = DEC_PRESETS[settings.decay][1];
const peak   = 0.137, sus=0.65, dec=0.10;

const mg = ctx.createGain(); mg.connect(audioOut());
mg.gain.setValueAtTime(0,startTime);
mg.gain.linearRampToValueAtTime(peak, startTime+atk);
mg.gain.linearRampToValueAtTime(peak*sus, startTime+atk+dec);
mg.gain.setValueAtTime(peak*sus, startTime+duration-rel);
mg.gain.linearRampToValueAtTime(0, startTime+duration);

const vLFO=ctx.createOscillator(), vG=ctx.createGain();
vLFO.frequency.setValueAtTime(0,startTime); vLFO.frequency.linearRampToValueAtTime(5.5,startTime+0.38);
vG.gain.setValueAtTime(0,startTime); vG.gain.linearRampToValueAtTime(freqHz*0.008,startTime+0.38);
vLFO.connect(vG); vLFO.start(startTime); vLFO.stop(startTime+duration+0.05);

[[1,1.00],[2,0.58],[3,0.40],[4,0.22],[5,0.16],[6,0.09],[7,0.06],[8,0.04]].forEach(([m,g])=>{
  const osc=ctx.createOscillator(),hg=ctx.createGain(),bp=ctx.createBiquadFilter();
  osc.type='sawtooth'; osc.frequency.setValueAtTime(freqHz*m,startTime);
  vG.connect(osc.frequency);
  bp.type='bandpass'; bp.frequency.setValueAtTime(freqHz*m,startTime); bp.Q.setValueAtTime(1.8,startTime);
  hg.gain.setValueAtTime(g,startTime);
  osc.connect(bp); bp.connect(hg); hg.connect(mg);
  osc.start(startTime); osc.stop(startTime+duration+0.1);
});

const bLen=Math.ceil(ctx.sampleRate*(duration+0.2));
const bBuf=ctx.createBuffer(1,bLen,ctx.sampleRate);
const bd=bBuf.getChannelData(0);
for(let i=0;i<bLen;i++) bd[i]=(Math.random()*2-1)*0.025;
const bs=ctx.createBufferSource(),bf=ctx.createBiquadFilter(),bg=ctx.createGain();
bs.buffer=bBuf; bf.type='bandpass'; bf.frequency.setValueAtTime(freqHz,startTime); bf.Q.setValueAtTime(3,startTime);
bg.gain.setValueAtTime(0,startTime); bg.gain.linearRampToValueAtTime(0.5,startTime+atk);
bg.gain.setValueAtTime(0.5,startTime+duration-rel); bg.gain.linearRampToValueAtTime(0,startTime+duration);
bs.connect(bf); bf.connect(bg); bg.connect(mg);
bs.start(startTime); bs.stop(startTime+duration+0.1);

return { gain:mg, stopAt(t){ mg.gain.cancelScheduledValues(t); mg.gain.setValueAtTime(mg.gain.value,t); mg.gain.linearRampToValueAtTime(0,t+0.06); } };
}

function playSineTone(freqHz, startTime, duration) {
const ctx = audioCtx;
const atk = ATK_PRESETS[settings.attack][1];
const rel = DEC_PRESETS[settings.decay][1];
const osc=ctx.createOscillator(), g=ctx.createGain();
osc.type='sine'; osc.frequency.setValueAtTime(freqHz,startTime);
g.gain.setValueAtTime(0,startTime); g.gain.linearRampToValueAtTime(0.112,startTime+atk);
g.gain.setValueAtTime(0.112,startTime+duration-rel); g.gain.linearRampToValueAtTime(0,startTime+duration);
osc.connect(g); g.connect(audioOut());
osc.start(startTime); osc.stop(startTime+duration+0.1);
return { gain:g, stopAt(t){ g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value,t); g.gain.linearRampToValueAtTime(0,t+0.04); try{osc.stop(t+0.05);}catch(e){} } };
}

// Unified play — returns a handle with stopAt()
async function playNote(midiF, startTime, duration) {
const sound = SOUNDS[settings.soundIdx];
const hz    = midiToHz(midiF);
if (sound.type==='synth') return playSynthViolin(hz, startTime, duration);
if (sound.type==='sine')  return playSineTone(hz, startTime, duration);
// SF via soundfont-player
const inst = sfInstruments[sound.sfName];
if (inst) return playSfNote(inst, midiF, startTime, duration, VOICE_GAIN[sound.id] ?? 8.0);
return playSynthViolin(hz, startTime, duration); // fallback while loading
}

// ══════════════════════════════════════════════════════
// FEEDBACK BEEPS
// ══════════════════════════════════════════════════════
function beepCorrect() {
const ctx=audioCtx,t=ctx.currentTime+0.02,dest=audioOut();
[523.25,659.25].forEach((f,i)=>{ const o=ctx.createOscillator(),g=ctx.createGain(); o.type='sine'; o.frequency.setValueAtTime(f,t+i*0.12); g.gain.setValueAtTime(0.16,t+i*0.12); g.gain.exponentialRampToValueAtTime(0.001,t+i*0.12+0.22); o.connect(g); g.connect(dest); o.start(t+i*0.12); o.stop(t+i*0.12+0.25); });
}
// chimeSuccess() lives in js/chime-success.js (shared from _shared/js/).
// Called from game.js — pass audioOut() so the chime is gain-scaled by the
// Volume setting, same as every other tone/beep.

function beepWrong() {
const ctx=audioCtx,t=ctx.currentTime+0.02,dest=audioOut();
[220,196].forEach((f,i)=>{ const o=ctx.createOscillator(),g=ctx.createGain(); o.type='triangle'; o.frequency.setValueAtTime(f,t+i*0.15); g.gain.setValueAtTime(0.16,t+i*0.15); g.gain.exponentialRampToValueAtTime(0.001,t+i*0.15+0.42); o.connect(g); g.connect(dest); o.start(t+i*0.15); o.stop(t+i*0.15+0.48); });
}


