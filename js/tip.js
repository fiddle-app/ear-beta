// ══════════════════════════════════════════════════════
// tip.js — Stripe tip modal
// ══════════════════════════════════════════════════════

const TIP_URL            = 'https://donate.stripe.com/6oU4gz0RR56j9pwauG4ow00';
const TIP_FALLBACK_EMAIL = 'caseymullen63+EarTipper@gmail.com';

function openTipModal() {
  $('tip-anon-check').checked = true;   // default: anonymous (use fallback email)
  $('tip-modal').classList.add('open');
}

function closeTipModal() {
  $('tip-modal').classList.remove('open');
}

function submitTip() {
  const anon = $('tip-anon-check').checked;
  const url  = anon
    ? TIP_URL + '?prefilled_email=' + encodeURIComponent(TIP_FALLBACK_EMAIL)
    : TIP_URL;
  window.open(url, '_blank', 'noopener,noreferrer');
  closeTipModal();
}
