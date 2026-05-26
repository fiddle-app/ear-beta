// ══════════════════════════════════════════════════════
// tip.js — Stripe tip modal
// ══════════════════════════════════════════════════════

const TIP_URL            = 'https://donate.stripe.com/6oU4gz0RR56j9pwauG4ow00';
const TIP_FALLBACK_EMAIL = 'caseymullen63+EarTipper@gmail.com';

function openTipModal() {
  $('tip-anon-check').checked = false;
  $('tip-email-input').value = '';
  $('tip-email-input').style.display = '';
  $('tip-email-input').style.borderColor = '';
  $('tip-modal').classList.add('open');
  setTimeout(() => $('tip-email-input').focus(), 80);
}

function closeTipModal() {
  $('tip-modal').classList.remove('open');
}

function handleTipCheckbox() {
  const anon = $('tip-anon-check').checked;
  $('tip-email-input').style.display = anon ? 'none' : '';
  $('tip-email-input').style.borderColor = '';
  if (!anon) setTimeout(() => $('tip-email-input').focus(), 50);
}

function submitTip() {
  const anon = $('tip-anon-check').checked;
  let email;
  if (anon) {
    email = TIP_FALLBACK_EMAIL;
  } else {
    email = ($('tip-email-input').value || '').trim();
    if (!email || !email.includes('@')) {
      $('tip-email-input').style.borderColor = '#c0392b';
      $('tip-email-input').focus();
      return;
    }
  }
  window.open(TIP_URL + '?prefilled_email=' + encodeURIComponent(email), '_blank', 'noopener,noreferrer');
  closeTipModal();
}
