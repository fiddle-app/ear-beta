'use strict';

// SMILE ANIMATION
// ══════════════════════════════════════════════════════
function smileProgressRow() {
  const row   = $('progress-row');
  const slots = row.querySelectorAll('.prog-slot');
  const n     = slots.length;
  const MAX_LIFT = 12; // px
  const center   = (n - 1) / 2;

  slots.forEach((slot, i) => {
    let offset;
    if (n === 3 && i === 1) {
      offset = 2; // center droop signals curvature
    } else {
      const distNorm = Math.abs(i - center) / (center || 1);
      // n=5: linear gives equal 6px steps → smooth arc; sqrt gives unequal steps → V
      // n=4: sqrt gives [-12,-7,-7,-12] → correct proportions
      const power = (n === 5) ? 1.0 : 0.5;
      offset = -MAX_LIFT * Math.pow(distNorm, power);
    }
    // Outer slots stagger slightly after center (ripple outward)
    const distNorm = Math.abs(i - center) / (center || 1);
    const delay    = Math.round(distNorm * 80);
    slot.style.transition = `transform 0.60s cubic-bezier(0.34,1.28,0.64,1) ${delay}ms`;
    slot.style.transform  = `translateY(${offset.toFixed(1)}px)`;
  });

  row.classList.add('smiling');
}


// PROGRESS INDICATORS
// ══════════════════════════════════════════════════════
function clearProgress() {
const row = $('progress-row');
row.classList.remove('smiling');
row.style.filter = '';
row.innerHTML = '';
for (let i = 0; i < settings.testsPerRound; i++) {
  const slot = document.createElement('div');
  slot.className = 'prog-slot';
  slot.id = 'prog' + i;
  slot.innerHTML = `<div class="prog-circle prog-empty"></div>`;
  row.appendChild(slot);
}
}

function renderProgress() {
const i = roundResults.length - 1;
if (i < 0 || i >= settings.testsPerRound) return;
const slot = $('prog' + i);
if (!slot) return;
if (roundResults[i]==='correct') {
  slot.innerHTML=`<div class="prog-circle prog-correct"><svg width="20" height="20" viewBox="0 0 28 28" fill="none"><use href="#icon-glyph-check"/></svg></div>`;
} else {
  slot.innerHTML=`<div class="prog-circle prog-wrong"><svg width="20" height="20" viewBox="0 0 28 28" fill="none"><use href="#icon-glyph-x"/></svg></div>`;
}
}


