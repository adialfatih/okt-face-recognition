require('dotenv').config();
const express = require('express');
//const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { Server } = require('socket.io');
const ejsMate = require('ejs-mate');
const cron = require('node-cron');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { pool } = require('./db');
const { fullSyncFromHR } = require('./services/karyawanCache');
const { syncKaryawan } = require('./services/karyawanSync');

const app = express();
const httpsOptions = {
    key: fs.readFileSync(path.join(__dirname, 'certs/192.168.200.5+1-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'certs/192.168.200.5+1.pem')),
};
//const server = http.createServer(app);
const server = https.createServer(httpsOptions, app);
const io = new Server(server);

// CRON: full sync setiap 02:30 WIB
cron.schedule('30 2 * * *', async () => {
    try {
        const r = await fullSyncFromHR();
        console.log('[cron] karyawan full sync OK:', r);
    } catch (e) {
        console.error('[cron] karyawan full sync FAIL:', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

cron.schedule('0 */6 * * *', async () => {
    const r = await syncKaryawan();
    console.log("[cron-sync] Karyawan:", r);
}, { timezone: 'Asia/Jakarta' });

app.engine('ejs', ejsMate);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'public/sw.js'));
});

// Snapshot absensi disimpan di luar project (hasil migrasi base64 -> file webp).
// URL di DB berbentuk /storage/snapshots/2026/06/<id>.webp dan dipetakan ke folder fisik.
const SNAPSHOT_STORAGE_ROOT = process.env.SNAPSHOT_STORAGE_ROOT
    || '/home/rindang/Downloads/automasi/home/adish/_2026/fotoabsen';
app.use('/storage', express.static(SNAPSHOT_STORAGE_ROOT));

// Sesi disimpan di MySQL, bukan MemoryStore bawaan express-session.
// Dengan MemoryStore, setiap restart server menghapus SEMUA sesi sekaligus:
// seluruh PWA terinstall langsung kena redirect '/' → '/login', dan itu jalur
// yang dulu membuat service worker menyajikan response redirect untuk navigasi
// sehingga aplikasi gagal dibuka. MemoryStore juga bocor memori di sisi server.
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 hari

const sessionStore = new MySQLStore({
    createDatabaseTable: true,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    expiration: SESSION_MAX_AGE,
    schema: { tableName: 'table_sessions' }
}, pool.pool); // mysql2/promise → pakai pool callback di baliknya

sessionStore.on('error', (err) => {
    console.error('[session] store error:', err.message);
});

app.use(session({
    secret: process.env.SESSION_SECRET || 'rjs-face-dev-secret',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true, // perpanjang selama user aktif, jangan putus di tengah shift
    cookie: {
        maxAge: SESSION_MAX_AGE,
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto'
    }
}));
app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    next();
});

// Global locals
app.locals.APP_NAME = 'Rindang Jati';
app.locals.formatDate = (d) => dayjs(d).format('DD MMM YYYY');


// Socket.IO (for toasts or live events if needed)
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);
});
app.set('io', io);
function ensureAuth(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    return res.redirect('/login');
}

// Routes
const authRoutes = require('./routes/auth');
const pages = require('./routes/pages');
const api = require('./routes/api');
// PENTING: '/api' harus dipasang SEBELUM `app.use('/', ensureAuth, pages)`.
// Mount di '/' itu berlaku untuk semua path, termasuk /api/*, jadi sebelumnya
// setiap panggilan API tanpa sesi dibalas redirect 302 ke /login — bukan JSON.
// Akibatnya dua hal rusak diam-diam untuk device yang login offline:
//  - checkServer() menembak /api/health, dapat HTML login, resp.json() gagal →
//    device selalu menyimpulkan dirinya offline meski jaringan hidup
//  - uploadPending() menembak /api/absen/sync dan tidak pernah bisa mengosongkan
//    antrian, sehingga antrian tumbuh terus (pemicu utama OOM di client)
//
// Dua endpoint itu kini sengaja dibuka; sisanya membalas 401 JSON yang bisa
// ditangani client, bukan halaman HTML.
//  - /health     : probe liveness, dipanggil justru untuk menentukan status online
//  - /absen/sync : device login-offline memang belum punya sesi server saat
//                  mengirim antriannya. Payload tetap divalidasi ulang di server
//                  (NRP harus ada, status harus aktif, duplikat ditolak).
const API_PUBLIC_PATHS = new Set(['/health', '/absen/sync']);

function ensureApiAuth(req, res, next) {
    if (API_PUBLIC_PATHS.has(req.path)) return next();
    if (req.session && req.session.user) return next();
    return res.status(401).json({ ok: false, error: 'unauthorized' });
}

app.use('/', authRoutes);
app.use('/api', ensureApiAuth, api);
app.use('/', ensureAuth, pages);



const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on https://0.0.0.0:${PORT}`);
});
