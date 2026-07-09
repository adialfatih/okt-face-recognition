/**
 * sw.js — Service Worker untuk PWA absensi offline-first
 *
 * Strategy:
 *  - Cache-first untuk assets statis lokal dan runtime CDN yang sudah pernah dibuka
 *  - Network-first untuk halaman dan API GET
 *  - POST absensi offline tetap ditangani client-side oleh IndexedDB
 */
const CACHE_VERSION = 'v3';
const STATIC_CACHE = `okt-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `okt-runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
    '/public/css/styles.css?v=3',
    '/public/js/ui.js',
    '/public/js/offline-db.js',
    '/public/js/offline-match.js',
    '/public/js/sync-manager.js',
    '/public/js/login-offline-status.js',
    '/public/js/offline-session.js',
    '/public/js/face-common.js',
    '/public/js/absensi.js',
    '/public/error.mp3',
    '/public/ping.mp3',
    '/public/models/tiny_face_detector_model-weights_manifest.json',
    '/public/models/tiny_face_detector_model-shard1',
    '/public/models/face_landmark_68_model-weights_manifest.json',
    '/public/models/face_landmark_68_model-shard1',
    '/public/models/face_recognition_model-weights_manifest.json',
    '/public/models/face_recognition_model-shard1',
    '/public/models/face_recognition_model-shard2'
];

const ABSENSI_KATEGORI = [
    ['Masuk Shift Pagi', 'Masuk Pagi'],
    ['Keluar Shift Pagi', 'Keluar Pagi'],
    ['Masuk Shift Siang', 'Masuk Siang'],
    ['Keluar Shift Siang', 'Keluar Siang'],
    ['Masuk Shift Malam', 'Masuk Malam'],
    ['Keluar Shift Malam', 'Keluar Malam'],
    ['Masuk DS', 'Masuk DS'],
    ['Keluar DS', 'Keluar DS'],
    ['Masuk Driver', 'Masuk Driver'],
    ['Keluar Driver', 'Keluar Driver'],
    ['Masuk Security', 'Masuk Security'],
    ['Keluar Security', 'Keluar Security'],
    ['Masuk Terlambat', 'Masuk Terlambat'],
    ['Ijin Keluar', 'Ijin Keluar']
];

function offlineAbsensiPage() {
    const buttons = ABSENSI_KATEGORI.map(([kategori, label]) => `
        <a class="btn bg-white border border-sky-100 text-sky-700 flex flex-col py-3 shadow-sm"
           href="/absensi/capture?k=${encodeURIComponent(kategori)}">
          <i class="fa-regular fa-clock text-xl mb-1"></i>
          ${label}
        </a>`).join('');

    return new Response(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Absensi Offline</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.13/dist/full.min.css" rel="stylesheet" />
  <link rel="stylesheet" href="/public/css/styles.css?v=3" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
</head>
<body class="min-h-screen font-[Inter] bg-gradient-to-br from-sky-50 via-sky-100 to-white">
  <main class="p-3 sm:p-6 max-w-6xl mx-auto w-full pb-24">
    <section class="space-y-4">
      <div class="rounded-2xl bg-gradient-to-r from-sky-400 via-sky-500 to-sky-600 text-white p-5 shadow-lg">
        <h1 class="text-2xl font-bold mb-1"><i class="fa-solid fa-clock mr-2"></i>Absensi Offline</h1>
        <p class="opacity-90 text-sm">Pilih kategori absensi. Data akan disimpan di device lalu disinkronkan saat online.</p>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">${buttons}</div>
      <a href="/login" class="btn btn-outline btn-sm">Kembali ke Login</a>
    </section>
  </main>
</body>
</html>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

async function cacheFirst(req) {
    const cached = await caches.match(req);
    if (cached) return cached;

    const resp = await fetch(req);
    if (resp && (resp.ok || resp.type === 'opaque')) {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(req, resp.clone());
    }
    return resp;
}

async function networkFirst(req, fallbackUrl) {
    try {
        const resp = await fetch(req);
        if (resp && (resp.ok || resp.type === 'opaque')) {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(req, resp.clone());
            const url = new URL(req.url);
            if (url.origin === self.location.origin && url.pathname === '/absensi/capture') {
                cache.put('/absensi/capture', resp.clone());
            }
        }
        return resp;
    } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        const url = new URL(req.url);
        if (url.origin === self.location.origin && url.pathname === '/absensi') {
            return offlineAbsensiPage();
        }
        if (url.origin === self.location.origin && url.pathname === '/absensi/capture') {
            const genericCapture = await caches.match('/absensi/capture');
            if (genericCapture) return genericCapture;
        }
        if (fallbackUrl) {
            const fallback = await caches.match(fallbackUrl);
            if (fallback) return fallback;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
}

async function networkOnly(req) {
    try {
        return await fetch(req);
    } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: 'offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);

    if (req.method !== 'GET') return;

    if (url.origin !== self.location.origin) {
        event.respondWith(cacheFirst(req));
        return;
    }

    if (url.pathname === '/login' && (url.searchParams.has('online_check') || url.searchParams.has('offline_session_check'))) {
        event.respondWith(networkOnly(req));
        return;
    }

    if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health' || url.pathname === '/api/sync/manifest') {
            event.respondWith(networkFirst(req));
        } else {
            event.respondWith(networkOnly(req));
        }
        return;
    }

    if (url.pathname.startsWith('/public/')) {
        event.respondWith(cacheFirst(req));
        return;
    }

    if (req.mode === 'navigate') {
        event.respondWith(networkFirst(req, '/'));
        return;
    }

    event.respondWith(cacheFirst(req));
});

self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});
