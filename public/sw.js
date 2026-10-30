/**
 * sw.js — Service Worker untuk PWA absensi offline-first
 *
 * Strategy:
 *  - Cache-first untuk assets statis lokal dan runtime CDN yang sudah pernah dibuka
 *  - Network-first untuk halaman dan API GET
 *  - POST absensi offline tetap ditangani client-side oleh IndexedDB
 */
const CACHE_VERSION = 'v8';
const STATIC_CACHE = `okt-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `okt-runtime-${CACHE_VERSION}`;

// CDN yang wajib tersedia offline. Di-fetch eksplisit dengan mode CORS supaya
// response-nya bukan opaque: response opaque tidak bisa divalidasi dan dihitung
// dengan padding besar (~7MB/entri) terhadap kuota storage browser.
const CDN_PRECACHE_URLS = [
    'https://cdn.tailwindcss.com/',
    'https://cdn.jsdelivr.net/npm/daisyui@4.12.13/dist/full.min.css',
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.7.4',
    'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css'
];

// Hanya origin CDN yang dikenal yang boleh masuk runtime cache. Request
// cross-origin lain dibiarkan ditangani browser (tidak di-intercept sama sekali).
const CDN_ORIGINS = new Set([
    'https://cdn.tailwindcss.com',
    'https://cdn.jsdelivr.net',
    'https://cdnjs.cloudflare.com',
    'https://cdn.datatables.net',
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com'
]);

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
    '/public/js/absensi-v2.js',
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

// Halaman capture yang disimpan juga dengan key generik (tanpa ?k=) supaya kategori
// apa pun tetap bisa dibuka offline; kategori dibaca client-side dari query string.
const CAPTURE_PATHS = new Set(['/absensi/capture', '/absensi-v2/capture']);

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

function offlineFallbackPage() {
    return new Response(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Offline</title>
</head>
<body style="font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f0f9ff;color:#0c4a6e">
  <div style="text-align:center;padding:24px;max-width:420px">
    <div style="font-size:44px;margin-bottom:8px">📴</div>
    <h1 style="font-size:20px;margin:0 0 8px">Halaman ini belum tersedia offline</h1>
    <p style="font-size:14px;opacity:.8;margin:0 0 20px">Sambungkan ke jaringan, atau buka menu Absensi yang bisa dipakai tanpa koneksi.</p>
    <a href="/absensi" style="display:inline-block;background:#0284c7;color:#fff;text-decoration:none;padding:10px 18px;border-radius:9999px;font-size:14px">Buka Absensi Offline</a>
  </div>
</body>
</html>`, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(STATIC_CACHE);
        // Aset lokal wajib ada — kalau gagal, install memang harus gagal.
        await cache.addAll(PRECACHE_URLS);
        // CDN best-effort: satu CDN down tidak boleh menggagalkan seluruh install.
        await Promise.all(CDN_PRECACHE_URLS.map(async (url) => {
            try {
                const resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
                if (resp.ok) await cache.put(url, resp);
            } catch (e) {
                console.warn('[sw] precache CDN gagal:', url, e && e.message);
            }
        }));
        await self.skipWaiting();
    })());
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

/**
 * Simpan ke cache tanpa memblokir response ke halaman.
 *
 * Response yang TIDAK boleh masuk cache:
 *  - `redirected` → kalau disajikan ulang untuk request navigasi, Chrome menolaknya
 *    (ERR_FAILED) dan PWA gagal dibuka sama sekali
 *  - opaque / opaqueredirect → tidak bisa divalidasi & memakan kuota dengan padding
 *  - no-store / non-2xx
 *
 * Clone diambil sinkron (sebelum body sempat dibaca pemanggil), lalu put-nya async
 * dengan catch supaya kegagalan kuota tidak jadi unhandled rejection yang tak terlihat.
 */
function safeCachePut(cacheName, key, resp) {
    if (!resp || !resp.ok || resp.redirected) return;
    if (resp.type === 'opaque' || resp.type === 'opaqueredirect') return;
    if ((resp.headers.get('Cache-Control') || '').includes('no-store')) return;

    let copy;
    try {
        copy = resp.clone();
    } catch (e) {
        return;
    }
    caches.open(cacheName)
        .then(cache => cache.put(key, copy))
        .catch(e => console.warn('[sw] cache put dilewati:', e && e.message));
}

async function cacheFirst(req) {
    const cached = await caches.match(req);
    if (cached) return cached;

    const resp = await fetch(req);
    safeCachePut(RUNTIME_CACHE, req, resp);
    return resp;
}

async function networkFirst(req) {
    try {
        const resp = await fetch(req);
        safeCachePut(RUNTIME_CACHE, req, resp);
        return resp;
    } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response(JSON.stringify({ ok: false, error: 'offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Handler khusus request navigasi (buka PWA, klik link, reload).
 *
 * Kasus yang dulu bikin PWA tidak bisa dibuka: `start_url` = '/', dan '/' ada di
 * balik ensureAuth. Begitu sesi server habis, '/' me-redirect ke '/login'. `fetch()`
 * mengikuti redirect itu, hasilnya response ber-flag `redirected` yang (a) tidak
 * boleh disajikan untuk navigasi dan (b) dulu ikut ter-cache dengan key '/',
 * sehingga error-nya menetap sampai storage dibersihkan manual.
 *
 * Sekarang redirect diteruskan sebagai response 302 baru agar browser sendiri yang
 * menavigasi ke URL tujuan, dan tidak pernah disimpan ke cache.
 */
async function navigationHandler(req) {
    try {
        const resp = await fetch(req);

        if (resp.redirected) {
            if (resp.body) resp.body.cancel().catch(() => { });
            return Response.redirect(resp.url, 302);
        }

        safeCachePut(RUNTIME_CACHE, req, resp);
        const url = new URL(req.url);
        if (url.origin === self.location.origin && CAPTURE_PATHS.has(url.pathname)) {
            safeCachePut(RUNTIME_CACHE, url.pathname, resp);
        }
        return resp;
    } catch (e) {
        return navigationFallback(req);
    }
}

async function navigationFallback(req) {
    const url = new URL(req.url);

    const cached = await caches.match(req);
    if (cached && !cached.redirected) return cached;

    if (url.origin === self.location.origin && url.pathname === '/absensi') {
        return offlineAbsensiPage();
    }
    if (url.origin === self.location.origin && CAPTURE_PATHS.has(url.pathname)) {
        const genericCapture = await caches.match(url.pathname);
        if (genericCapture) return genericCapture;
    }

    const root = await caches.match('/');
    if (root && !root.redirected) return root;

    return offlineFallbackPage();
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

    if (req.method !== 'GET') return;

    let url;
    try {
        url = new URL(req.url);
    } catch (e) {
        return;
    }
    // Abaikan skema non-http (chrome-extension:, blob:, dll) — Cache API menolaknya.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    // Navigasi ditangani lebih dulu; mode 'navigate' bisa muncul lintas origin juga.
    if (req.mode === 'navigate') {
        event.respondWith(navigationHandler(req));
        return;
    }

    if (url.origin !== self.location.origin) {
        // Selain CDN yang dikenal, jangan di-intercept: biarkan browser yang urus
        // supaya response opaque tidak menumpuk di cache dan menghabiskan kuota.
        if (CDN_ORIGINS.has(url.origin)) {
            event.respondWith(cacheFirst(req));
        }
        return;
    }

    if (url.pathname === '/login' && (url.searchParams.has('online_check') || url.searchParams.has('offline_session_check'))) {
        event.respondWith(networkOnly(req));
        return;
    }

    if (url.pathname.startsWith('/api/')) {
        // /api/health adalah probe liveness — TIDAK boleh di-cache, karena versi
        // cache-nya akan membalas ok:true saat offline dan merusak deteksi online.
        if (url.pathname === '/api/sync/manifest') {
            event.respondWith(networkFirst(req));
        } else {
            event.respondWith(networkOnly(req));
        }
        return;
    }

    // Foto snapshot absensi: besar dan hanya dipakai di laporan (online).
    // Biarkan browser yang urus supaya tidak menggelembungkan cache.
    if (url.pathname.startsWith('/storage/')) return;

    if (url.pathname.startsWith('/public/')) {
        event.respondWith(cacheFirst(req));
        return;
    }

    // Sisanya (halaman HTML yang di-prefetch, dll): utamakan jaringan supaya tidak
    // menyajikan HTML basi setelah deploy, dengan cache sebagai cadangan offline.
    event.respondWith(networkFirst(req));
});

self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});
