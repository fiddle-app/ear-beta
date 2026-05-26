'use strict';
// NOTE SELECTION
// ══════════════════════════════════════════════════════
function isRegressed(noteName) {
const st = stats[noteName];
return st && st.bestCents != null && st.lastFailureCents != null && st.lastFailureCents >= st.bestCents;
}

function pickNote() {
if (retestNote) return ALL_NOTES.find(n=>n.name===retestNote);

const pool = ALL_NOTES.slice(settings.lowestNote, settings.highestNote+1);
const untested = pool.filter(n => !stats[n.name] || stats[n.name].attempts == null || stats[n.name].attempts === 0);
if (untested.length > 0) {
  return untested[Math.floor(Math.random()*untested.length)];
}
const weights = pool.map(n => noteWeight(n.name));
const total = weights.reduce((a,b)=>a+b, 0);
let r = Math.random() * total;
for (let i=0; i<pool.length; i++) {
  r -= weights[i];
  if (r <= 0) return pool[i];
}
return pool[pool.length-1];
}

function markAttempt(noteName) {
if (!stats[noteName]) stats[noteName] = {};
stats[noteName].attempts = (stats[noteName].attempts || 0) + 1;
}

// ══════════════════════════════════════════════════════
// GAME LOGIC
// ══════════════════════════════════════════════════════
function noteDur() { return DUR_STEPS[settings.noteDurIdx]; }

function startRound() {
awaiting=false; roundFailed=false;
roundAttempts=0; roundResults=[];
$('round-actions').style.display='none'; hideRetestEndActions();
clearProgress();

const prevNote = currentNote;
const note = pickNote(); currentNote=note;
markAttempt(note.name);
saveStats();
logEvent(`startRound | note=${note.name} | cents=${fmtC(CENTS_SEQ[centsIdx])} | retest=${retestNote||'none'}`);

if (!retestNote) {
  const bestCents = stats[note.name]?.bestCents;
  if (bestCents != null) {
    let idx = CENTS_SEQ.findIndex(c => c <= bestCents);
    if (idx < 0) idx = CENTS_SEQ.length - 1;
    centsIdx = idx;
  } else if (prevNote === null) {
    centsIdx = settings.startCentsIdx;
  }
}

setupAttempt();
}

function setupAttempt() {
const cents = CENTS_SEQ[centsIdx];
const offIsSecond  = Math.random() < 0.5;
const offIsHigher  = Math.random() < 0.5;
currentRound.offIsSecond = offIsSecond;
currentRound.offIsHigher = offIsHigher;
currentRound.secondIsHigher = offIsSecond ? offIsHigher : !offIsHigher;

const baseHz  = midiToHz(currentNote.midi);
const offHz   = offIsHigher ? centsToHz(baseHz, cents) : centsToHz(baseHz, -cents);
currentRound.note1Midi = offIsSecond ? currentNote.midi : hzToMidi(offHz);
currentRound.note2Midi = offIsSecond ? hzToMidi(offHz)  : currentNote.midi;
currentRound.cents     = cents;

const nd = dn(currentNote.name);
$('note-left-name').textContent   = nd;
$('note-left-detail').innerHTML   = '<span style="font-size:1.6em;opacity:0.55;">?</span>';
$('note-right-name').textContent   = nd;
$('note-right-detail').innerHTML  = '<span style="font-size:1.6em;opacity:0.55;">?</span>';
$('note-left').className  = 'note-circle';
$('note-right').className = 'note-circle';
$('status-msg').textContent = '';
$('status-msg').style.color = '#e8d5b0';
$('diff-value').textContent = fmtC(CENTS_SEQ[centsIdx]);
$('swipe-hint').style.display='';
playBothNotes();
}

let playTimers = [];
function clearPlayTimers() { playTimers.forEach(clearTimeout); playTimers=[]; }

async function playBothNotes() {
stopAllSounds();
await ensureAudio();
// If SF instrument was cleared by context nuke, reload before scheduling so
// we don't fall back to synth violin (which is much louder than the samples).
const _snd = SOUNDS[settings.soundIdx];
if (_snd.type === 'sf' && !sfInstruments[_snd.sfName]) {
  try { await loadSfInstrument(_snd.sfName); } catch(e){ showToast(`Could not download ${_snd.label}. Using synth.`); }
}
logEvent(`playBothNotes | audioCtx.state=${audioCtx.state} | note=${currentNote?.name} | cents=${fmtC(CENTS_SEQ[centsIdx])}`);
const dur = noteDur();
const now = audioCtx.currentTime + 0.06;
const t2  = now + dur + NOTE_GAP;

const t1ms    = 60;
const t1endMs = t1ms + dur*1000;
const t2ms    = t1ms + (dur+NOTE_GAP)*1000;
const t2endMs = t2ms + dur*1000;

$('note-left').classList.remove('playing','flash-correct','flash-wrong');
$('note-right').classList.remove('playing','flash-correct','flash-wrong');

playTimers.push(setTimeout(()=>$('note-left').classList.add('playing'), t1ms));
playTimers.push(setTimeout(()=>$('note-left').classList.remove('playing'), t1endMs));
playTimers.push(setTimeout(()=>{
  $('note-right').classList.add('playing');
  if (!roundFailed) awaiting=true;
}, t2ms));
playTimers.push(setTimeout(()=>{
  $('note-right').classList.remove('playing');
}, t2endMs));

playNote(currentRound.note1Midi, now, dur).then(h=>{ playingNode1=h; });
playNote(currentRound.note2Midi, t2, dur).then(h=>{ playingNode2=h; });
}

function stopAllSounds() {
const t = audioCtx ? audioCtx.currentTime : 0;
if (playingNode1) { try{ playingNode1.stopAt(t); }catch(e){} playingNode1=null; }
if (playingNode2) { try{ playingNode2.stopAt(t); }catch(e){} playingNode2=null; }
clearPlayTimers();
$('note-left').classList.remove('playing');
$('note-right').classList.remove('playing');
}

function replayBoth() {
if (!currentRound.note1Midi) return;
stopAllSounds();
playBothNotes();
}

async function playOneNote(side) {
await ensureAudio();
const _snd2 = SOUNDS[settings.soundIdx];
if (_snd2.type === 'sf' && !sfInstruments[_snd2.sfName]) {
  try { await loadSfInstrument(_snd2.sfName); } catch(e){ showToast(`Could not download ${_snd2.label}. Using synth.`); }
}
stopAllSounds();
const dur = noteDur();
const now = audioCtx.currentTime + 0.02;
const midiF = (side==='left') ? currentRound.note1Midi : currentRound.note2Midi;

if (side==='left') {
  setTimeout(()=>{ $('note-left').classList.add('playing'); }, 10);
  setTimeout(()=>{ $('note-left').classList.remove('playing'); }, 10+dur*1000);
  playNote(midiF, now, dur).then(h=>{ playingNode1=h; });
} else {
  setTimeout(()=>{ $('note-right').classList.add('playing'); }, 10);
  setTimeout(()=>{ $('note-right').classList.remove('playing'); }, 10+dur*1000);
  playNote(midiF, now, dur).then(h=>{ playingNode2=h; });
}
}

function handleTapArea() {
if ($('start-btn').style.display === 'block') { handleStart(); return; }
replayBoth();
}

function handleTap(side) {
if (roundFailed) { playOneNote(side); return; }
if (!awaiting) return;
handleAnswer(side==='right');
}

function handleAnswer(guessSecondHigher) {
if (!awaiting||roundFailed) return;
awaiting=false;

const correct = (guessSecondHigher === currentRound.secondIsHigher);
const cents   = CENTS_SEQ[centsIdx];

if (correct) beepCorrect(); else beepWrong();

const sym = currentRound.offIsHigher ? '♯' : '♭';
const offLabel = `${sym}${fmtC(cents)}`;
if (currentRound.offIsSecond) {
  $('note-left-detail').textContent  = '';
  $('note-right-detail').textContent = offLabel;
} else {
  $('note-left-detail').textContent  = offLabel;
  $('note-right-detail').textContent = '';
}

const cls = correct ? 'flash-correct' : 'flash-wrong';
$('note-left').classList.add(cls);
$('note-right').classList.add(cls);

roundAttempts++;
roundResults.push(correct?'correct':'wrong');
renderProgress();

if (correct) {
  $('status-msg').textContent='Correct'; $('status-msg').style.color='#a0f0a0';
} else {
  const higherNote = currentRound.secondIsHigher ? 'The second note was higher.' : 'The first note was higher.';
  $('status-msg').textContent=`Wrong. ${higherNote}`; $('status-msg').style.color='#f09090';
}

if (!correct) {
  roundFailed=true;
  const key = currentNote.name;
  if (!stats[key]) stats[key]={};
  stats[key].lastFailureCents = cents;
  saveStats();
  logEvent(`roundFail | note=${key} | cents=${fmtC(cents)} | retest=${retestNote||'none'}`);

  if (retestNote) {
    if (firstRoundOfRetest) {
      firstRoundOfRetest = false;
      pendingCentsStep = -1;
    } else if (atLeastOneSuccessfulRetest) {
      retestEnding = true;
      const bestCents = stats[key]?.bestCents;
      const bestStr   = bestCents != null ? fmtC(bestCents) : '—';
      $('status-msg').textContent = `New best for ${dn(key)}: ${bestStr}`;
      $('status-msg').style.color = '#a0f0a0';
      setTimeout(()=>{ showRetestEndActions(); }, 1400);
      return;
    } else {
      pendingCentsStep = -1;
    }
  } else {
    pendingCentsStep = -1;
  }
  setTimeout(()=>{
    $('retry-action-btn').style.display = retestNote ? '' : 'none';
    $('round-actions').style.display='flex';
    $('swipe-hint').textContent='Tap a note to play it.';
  }, 1400);
  return;
}

if (roundResults.length===settings.testsPerRound && roundResults.every(x=>x==='correct')) {
  logEvent(`roundSuccess | note=${currentNote.name} | cents=${fmtC(cents)} | retest=${retestNote||'none'}`);
  stopAllSounds();
  setTimeout(() => chimeSuccess(audioCtx, audioOut()), 150);
  setTimeout(smileProgressRow, 250);
  const key = currentNote.name;
  if (!stats[key]) stats[key]={};
  if (stats[key].bestCents==null || cents < stats[key].bestCents) {
    stats[key].bestCents = cents;
  }
  if (stats[key].lastFailureCents != null && cents >= stats[key].lastFailureCents) {
    delete stats[key].lastFailureCents;
  }
  saveStats();

  if (retestNote) {
    firstRoundOfRetest = false;
    atLeastOneSuccessfulRetest = true;
    if (centsIdx < CENTS_SEQ.length-1) {
      centsIdx++;
      const newDiff = fmtC(CENTS_SEQ[centsIdx]);
      $('status-msg').textContent=`Good job! Going harder… Trying ${newDiff}, next!`;
      setTimeout(()=>{ $('diff-value').textContent = newDiff; clearProgress(); startRound(); }, 3200);
    } else {
      $('status-msg').textContent='Master level!';
      setTimeout(()=>{ clearProgress(); exitRetest(); }, 3200);
    }
  } else {
    if (centsIdx < CENTS_SEQ.length-1) {
      centsIdx++;
      const newDiff = fmtC(CENTS_SEQ[centsIdx]);
      $('status-msg').textContent=`Good job! Trying ${newDiff}, next!`;
    } else {
      $('status-msg').textContent='Master level!';
    }
    setTimeout(()=>{
      $('diff-value').textContent = fmtC(CENTS_SEQ[centsIdx]);
      clearProgress(); roundResults=[]; roundAttempts=0; setupAttempt();
    }, 3200);
  }
  return;
}

setTimeout(()=>{
  awaiting=false;
  $('note-left').className='note-circle'; $('note-right').className='note-circle';
  $('status-msg').textContent='';
  setupAttempt();
}, 1600);
}

// ══════════════════════════════════════════════════════
// FAILED ROUND STATE
// ══════════════════════════════════════════════════════
function continueAfterFail() {
roundFailed=false;
$('round-actions').style.display='none'; hideRetestEndActions();
$('status-msg').textContent='';
$('swipe-hint').textContent='Tap the higher note, or swipe up/down to indicate that the 2nd note is higher/lower.';
clearProgress();
if (pendingCentsStep !== 0) {
  centsIdx = Math.max(0, Math.min(CENTS_SEQ.length-1, centsIdx + pendingCentsStep));
  pendingCentsStep = 0;
}
if (retestEnding) {
  retestEnding = false;
  exitRetest(true);
  setTimeout(() => {
    openInfo();
    setTimeout(() => {
      const scoresEl = document.getElementById('stats-table');
      if (scoresEl) scoresEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  }, 200);
} else if (retestNote) {
  setTimeout(startRound, 200);
} else {
  const hasBest = currentNote && stats[currentNote.name]?.bestCents != null;
  if (hasBest) {
    setTimeout(startRound, 200);
  } else {
    roundAttempts = 0;
    roundResults = [];
    clearProgress();
    setTimeout(setupAttempt, 200);
  }
}
}

function showRetestEndActions() {
$('continue-action-btn').style.display = 'none';
$('back-action-btn').style.display = '';
$('round-actions').style.display = 'flex';
$('swipe-hint').textContent = 'Tap a note to play it.';
}

function hideRetestEndActions() {
$('retry-action-btn').style.display = retestNote ? '' : 'none';
$('continue-action-btn').style.display = '';
$('back-action-btn').style.display = 'none';
}

function retryRound() {
roundFailed = false;
retestEnding = false;
roundResults = [];
roundAttempts = 0;
$('round-actions').style.display = 'none'; hideRetestEndActions();
$('status-msg').textContent = '';
$('swipe-hint').textContent = 'Tap the higher note, or swipe up/down to indicate that the 2nd note is higher/lower.';
clearProgress();
pendingCentsStep = 0;
firstRoundOfRetest = true;
atLeastOneSuccessfulRetest = false;
const bestCents = stats[currentNote?.name]?.bestCents;
if (bestCents != null) {
  let idx = CENTS_SEQ.findIndex(c => c <= bestCents);
  centsIdx = idx >= 0 ? idx : CENTS_SEQ.length - 1;
}
setTimeout(setupAttempt, 200);
}


