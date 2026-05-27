// Ear Tuner — Service Worker
// Pre-caches the app shell; runtime-caches sound samples.

const CACHE_VER    = '2026-05-27 14:20';  // stamped by deploy.sh — do not edit manually
const STATIC_CACHE = `ear-tuner-static-${CACHE_VER}`;
const FONT_CACHE   = 'ear-tuner-fonts';
const SOUND_CACHE  = 'ear-tuner-sounds';

// Paths are relative to this sw.js file. In prod (sw.js at /ear/sw.js) they
// resolve under /ear/; in dev (sw.js at /sw.js) they resolve under root.
// One set of strings works for both.
const PRECACHE = [
  './',
  'index.html',
  'style.css',
  'design-tokens.css',
  'design-tokens-app.css',
  'glyph-disc.css',
  'resume-modal.css',
  'soundfont-player.min.js',
  'fonts/fonts.css',
  'fonts/inconsolata-latin.woff2',
  'fonts/nunito-latin.woff2',
  'js/constants.js',
  'js/persistence.js',
  'js/diag-log.js',
  'js/audio-ctx.js',
  'js/mic.js',
  'js/wakelock.js',
  'js/chime-success.js',
  'js/audio.js',
  'js/game.js',
  'js/safe-area.js',
  'js/render.js',
  'js/context-dispatch.js',
  'js/ui.js',
  'js/tip.js',
  // vosk-browser.js intentionally omitted — voice.js lazy-loads it on first
  // opt-in (Hello → Yes). The fetch handler below will populate STATIC_CACHE
  // on first use, so subsequent launches still serve it offline.
  'js/voice-commands.js',
  'js/voice-commands-worklet.js',
  'js/voice.js',
  'js/platform.js',
  'js/register-sw.js',
  'js/boot.js',
  'resources/app-icon-180.png',
];

// ── Install: pre-cache app shell, tolerantly ─────────────────────────────────
// A single 404 used to doom the entire install (cache.addAll is atomic — one
// rejection rolls back all), leaving the user permanently stuck on the prior
// SW. Per-file try/catch localises the failure: missing files get logged and
// the install completes; the runtime fetch handler will network-fetch + cache
// them on first request.
//
// Catastrophic-failure guard: if EVERY entry failed (CDN outage during the
// install window, full server-side disaster), throw — that rejects the
// install, which preserves the prior working SW rather than replacing it
// with a corpse cache.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const failed = [];
      for (const url of PRECACHE) {
        try { await cache.add(url); }
        catch (e) { failed.push(url + ' (' + (e && e.message) + ')'); }
      }
      if (failed.length) console.warn('[sw] install: failed to precache:', failed);
      if (failed.length === PRECACHE.length) {
        throw new Error('SW install: every PRECACHE entry failed; aborting to keep prior SW in charge');
      }
      await self.skipWaiting();
    })
  );
});

// Allow the page to push a waiting SW into activation immediately
// (covers the case where a previous install is sitting in 'waiting').
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  const keep = [STATIC_CACHE, FONT_CACHE, SOUND_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !keep.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Sound samples — cache-first after first load
  // (not in PRECACHE — too large for first install; cached on demand)
  if (url.pathname.includes('/sounds/')) {
    event.respondWith(cacheFirst(event.request, SOUND_CACHE));
    return;
  }

  // Everything else (app shell, JS, fonts) — cache-first
  event.respondWith(cacheFirst(event.request, STATIC_CACHE));
});

// ── Strategies ────────────────────────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}
