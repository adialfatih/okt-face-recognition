const KATEGORI = [
    'Masuk Shift Pagi', 'Keluar Shift Pagi',
    'Masuk Shift Siang', 'Keluar Shift Siang',
    'Masuk Shift Malam', 'Keluar Shift Malam',
    'Masuk DS', 'Keluar DS',
    'Masuk Driver', 'Keluar Driver',
    'Masuk Security', 'Keluar Security',
    'Masuk Terlambat', 'Ijin Keluar'
];


const SHIFT_RULES = {
    pagi: { start: '06:00', end: '14:00', lateGraceMin: 5 },
    siang: { start: '14:00', end: '22:00', lateGraceMin: 5 },
    malam: { start: '22:00', end: '06:00', lateGraceMin: 5 },
    ds8h: { start: null, end: null, hours: 8 } // fleksibel, minimal 8 jam
};

const express = require('express');
const dayjs = require('dayjs');
const jwt = require('jsonwebtoken');
const { q, pool, hrq } = require('../db');
const router = express.Router();
const { mapCacheToUI, ensureInCache, fullSyncFromHR, invalidateNRP, ACTIVE_STATUSES } = require('../services/karyawanCache');
const absensiRouter = require('./api-absensi');

// const FACE_THRESHOLD = Number(process.env.FACE_DISTANCE_THRESHOLD || 0.5);
// const FACE_MARGIN_MIN = Number(process.env.FACE_MARGIN_MIN || 0.08);

const FACE_THRESHOLD = Number(process.env.FACE_DISTANCE_THRESHOLD || 0.45);
const FACE_MARGIN_MIN = Number(process.env.FACE_MARGIN_MIN || 0.05);

// ==== Token sync offline ====
// /api/absen/sync sengaja tidak di belakang sesi (device yang login offline belum
// punya sesi server), jadi wajib dilindungi token yang diterbitkan saat device
// mengunduh data master dalam keadaan login online (GET /api/sync/data).
const SYNC_TOKEN_SECRET = process.env.SYNC_TOKEN_SECRET || process.env.SESSION_SECRET || 'rjs-face-dev-secret';
const SYNC_TOKEN_TTL = '30d';
// Rentang tanggal absensi offline yang masih diterima server.
const OFFLINE_SYNC_MAX_AGE_DAYS = 30;
const OFFLINE_SYNC_MAX_FUTURE_DAYS = 1; // toleransi jam device yang sedikit maju

function issueSyncToken(user) {
    return jwt.sign({ uid: user.id, username: user.username }, SYNC_TOKEN_SECRET, { expiresIn: SYNC_TOKEN_TTL });
}

async function isSyncAuthorized(req) {
    if (req.session && req.session.user) return true;

    const m = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!m) return false;

    let payload;
    try {
        payload = jwt.verify(m[1], SYNC_TOKEN_SECRET);
    } catch (e) {
        return false;
    }
    // User yang sudah dihapus tidak boleh lagi mengirim data.
    const rows = await q('SELECT id FROM table_users WHERE id=? LIMIT 1', [payload.uid]);
    return rows.length > 0;
}

function isValidOfflineTimestamp(tanggal, jam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tanggal || ''))) return false;
    if (!/^\d{2}:\d{2}:\d{2}$/.test(String(jam || ''))) return false;
    const t = dayjs(`${tanggal} ${jam}`);
    if (!t.isValid()) return false;
    const now = dayjs();
    if (t.isBefore(now.subtract(OFFLINE_SYNC_MAX_AGE_DAYS, 'day'))) return false;
    if (t.isAfter(now.add(OFFLINE_SYNC_MAX_FUTURE_DAYS, 'day'))) return false;
    return true;
}


// ==== Embedding Cache (supaya match cepat untuk 1000+ karyawan) ====
let EMB_CACHE = []; // [{ nrp, emb: Float32Array }]
let EMB_READY = false;

async function loadAllEmbeddings() {
    const rows = await q('SELECT nrp, embedding FROM table_face_embeddings');
    EMB_CACHE = rows.map(r => ({
        nrp: r.nrp,
        emb: Float32Array.from(Array.isArray(r.embedding) ? r.embedding : JSON.parse(r.embedding))
    }));
    EMB_READY = true;
}
function invalidateEmbeddingsFor(nrp) {
    EMB_CACHE = EMB_CACHE.filter(e => e.nrp !== nrp);
}
function addEmbeddingsFor(nrp, list) {
    for (const embArr of list) {
        EMB_CACHE.push({ nrp, emb: Float32Array.from(embArr) });
    }
}
async function ensureEmbeddings() {
    if (!EMB_READY) await loadAllEmbeddings();
}
function euclideanDistance(a, b) {
    let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s);
}

function isValidKategori(k) { return KATEGORI.includes(k); }

// Penanda asal data di table_absensi.source. Hanya nilai di sini yang diterima dari
// client; selain itu dipakai default. Dipakai untuk membedakan data uji coba Absensi v2.
const ONLINE_SOURCES = new Set(['web', 'web-v2']);
const OFFLINE_SOURCES = new Set(['offline-sync', 'offline-sync-v2']);
function pickSource(value, allowed, fallback) {
    return allowed.has(value) ? value : fallback;
}

function isActiveKaryawanStatus(status, statusIo) {
    const s = String(status ?? '').trim().toUpperCase();
    const io = statusIo == null ? null : String(statusIo).trim();

    if (io === '0') return false;
    if (['RESIGN', 'KELUAR', 'NONAKTIF', 'NON-AKTIF', 'HABIS KONTRAK'].includes(s)) return false;
    if (ACTIVE_STATUSES.has(s)) return true;

    // table_karyawan lokal lama memakai status 1/0.
    if (s === '1' || s === 'AKTIF') return true;
    if (s === '0') return false;

    return io === '1';
}


// --- Utilities ---
function getNow() {
    const now = dayjs();
    return { tanggal: now.format('YYYY-MM-DD'), jam: now.format('HH:mm:ss'), now };
}
async function getProfilUI(nrp) {
    const c = await ensureInCache(nrp);
    if (!c) return null;
    return mapCacheToUI(c); // {nrp,nama,dep,divisi,jabatan,status}
}
function deriveShiftCode(kategori) {
    if (!kategori) return null;
    const k = kategori.toLowerCase();

    if (k.includes('shift pagi')) return 'PAGI';
    if (k.includes('shift siang')) return 'SIANG';
    if (k.includes('shift malam')) return 'MALAM';
    if (k.includes('ds')) return 'DS';
    if (k.includes('driver')) return 'DRIVER';
    if (k.includes('security')) return 'SECURITY';
    if (k.includes('terlambat')) return 'TERLAMBAT';
    if (k.includes('ijin keluar')) return 'IJIN';

    return null;
}

function pasanganMasuk(katKeluar) {
    if (!katKeluar) return null;
    if (katKeluar.includes('Shift Pagi')) return 'Masuk Shift Pagi';
    if (katKeluar.includes('Shift Siang')) return 'Masuk Shift Siang';
    if (katKeluar.includes('Shift Malam')) return 'Masuk Shift Malam';
    if (katKeluar.includes('DS')) return 'Masuk DS';
    if (katKeluar.includes('Driver')) return 'Masuk Driver';
    if (katKeluar.includes('Security')) return 'Masuk Security';
    return null;
}

function isKeluarOvernightKategori(kategori) {
    const k = String(kategori || '').toLowerCase();
    return k.startsWith('keluar') && k.includes('shift malam');
}

async function resolveTanggalAbsensi(nrp, kategori, tanggalDefault) {
    if (!isKeluarOvernightKategori(kategori)) return tanggalDefault;

    const katMasuk = pasanganMasuk(kategori);
    if (!katMasuk) return tanggalDefault;

    // Jika ada masuk malam/security di tanggal yang sama, keluar wajib H+1.
    const sameDayMasuk = await q(
        `SELECT id
         FROM table_absensi
         WHERE nrp = ? AND tanggal = ? AND kategori = ?
         LIMIT 1`,
        [nrp, tanggalDefault, katMasuk]
    );
    if (sameDayMasuk.length) {
        return dayjs(tanggalDefault).add(1, 'day').format('YYYY-MM-DD');
    }

    return tanggalDefault;
}

async function insertDeteksiLog(sql, params, fallbackStatusIndex = -1) {
    try {
        await q(sql, params);
    } catch (e) {
        const isEnumStatusError = fallbackStatusIndex >= 0
            && params[fallbackStatusIndex] === 'ambiguous'
            && (e.code === 'WARN_DATA_TRUNCATED' || e.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD');

        if (!isEnumStatusError) throw e;

        const fallbackParams = [...params];
        fallbackParams[fallbackStatusIndex] = 'unknown';
        await q(sql, fallbackParams);
        console.warn('[deteksi-log] status ambiguous belum ada di ENUM, fallback ke unknown. Jalankan migrasi sql/2026-07-09-fix-critical-bugs.sql');
    }
}

function computeLateFlag(kategori, now) {
    // Telat hanya untuk Masuk Shift Pagi/Siang/Malam, grace 5 menit
    const map = {
        'Masuk Shift Pagi': '06:05',
        'Masuk Shift Siang': '14:05',
        'Masuk Shift Malam': '22:05'
    };
    if (!map[kategori]) return 0;
    const lateAt = dayjs(`${now.format('YYYY-MM-DD')} ${map[kategori]}`);
    return now.isAfter(lateAt) ? 1 : 0;
}
function computeLateMinutes(kategori, now) {
    // Hanya untuk Masuk Shift Pagi/Siang/Malam
    const startMap = {
        'Masuk Shift Pagi': '06:00',
        'Masuk Shift Siang': '14:00',
        'Masuk Shift Malam': '22:00'
    };
    const startStr = startMap[kategori];
    if (!startStr) return 0;
    // Anchor start time ke tanggal yang tepat
    // Khusus "Masuk Shift Malam": jika sekarang dini hari (00:00–05:59), anggap start-nya malam sebelumnya 22:00
    let start = dayjs(`${now.format('YYYY-MM-DD')} ${startStr}`);
    if (kategori === 'Masuk Shift Malam' && now.hour() < 6) {
        const prev = now.subtract(1, 'day');
        start = dayjs(`${prev.format('YYYY-MM-DD')} ${startStr}`);
    }

    const diffMin = now.diff(start, 'minute');   // bisa negatif bila datang lebih awal
    if (diffMin < 3) return 0;                   // grace 3 menit untuk perhitungan menit_terlambat
    return diffMin > 0 ? diffMin : 0;
}

// --- Autocomplete Karyawan ---
router.get('/karyawan/search', async (req, res) => {
    const qstr = (req.query.q || '').trim();
    if (!qstr || qstr.length < 1) return res.json([]);
    // Cari di cache dulu
    try {
        // 1) Cek cache
        let rows = await q(`
     SELECT nrp, nama, departement, divisi, jabatan
            FROM table_karyawan_cache
            WHERE (nrp LIKE ? OR nama LIKE ?)
              AND UPPER(COALESCE(status, '')) NOT IN ('RESIGN','KELUAR','NONAKTIF','NON-AKTIF','HABIS KONTRAK')
     LIMIT 20
   `, [`%${qstr}%`, `%${qstr}%`]);
        if (rows.length) return res.json(rows);

        // 2) Fallback HR + upsert ke cache
        const hrRows = await hrq(`
     SELECT nrp, nama, departement, divisi, jabatan, status
     FROM data_karyawan
     WHERE (nrp LIKE ? OR nama LIKE ?)
       AND (
         status_io = '1'
         OR UPPER(COALESCE(status, '')) IN ('KONTRAK','TETAP','MAGANG')
       )
       AND UPPER(COALESCE(status, '')) NOT IN ('RESIGN','KELUAR','NONAKTIF','NON-AKTIF','HABIS KONTRAK')
     LIMIT 20
   `, [`%${qstr}%`, `%${qstr}%`]);
        for (const r of hrRows) {
            await q(`
       INSERT INTO table_karyawan_cache (nrp, nama, departement, divisi, jabatan, status, updated_at)
       VALUES (?,?,?,?,?, COALESCE(?, 'KONTRAK'), NOW())
       ON DUPLICATE KEY UPDATE
         nama=VALUES(nama), departement=VALUES(departement), divisi=VALUES(divisi), jabatan=VALUES(jabatan), status=VALUES(status), updated_at=NOW()
     `, [r.nrp, r.nama, r.departement, r.divisi, r.jabatan, r.status]);
        }
        return res.json(hrRows.map(r => ({
            nrp: r.nrp, nama: r.nama, dep: r.departement, divisi: r.divisi, jabatan: r.jabatan
        })));
    } catch (e) {
        console.error('[search] fail:', e.message);
        return res.json([]); // jangan pecahkan client; kirim array kosong
    }
});
// --- Autocomplete list Nama / Divisi / Jabatan untuk filter laporan ---
router.get('/karyawan/nama-suggest', async (req, res) => {
    try {
        const term = (req.query.q || '').trim();
        const params = [];
        let where = 'WHERE nama IS NOT NULL AND nama <> ""';

        if (term) {
            where += ' AND nama LIKE ?';
            params.push(`%${term}%`);
        }

        const rows = await q(
            `
            SELECT DISTINCT nama
            FROM table_karyawan
            ${where}
            ORDER BY nama ASC
            LIMIT 20
            `,
            params
        );

        res.json({
            items: rows.map(r => r.nama).filter(Boolean)
        });
    } catch (e) {
        console.error('[karyawan/nama-suggest] fail:', e);
        res.json({ items: [] });
    }
});

router.get('/karyawan/divisi-suggest', async (req, res) => {
    try {
        const term = (req.query.q || '').trim();
        const params = [];
        let where = 'WHERE divisi IS NOT NULL AND divisi <> ""';

        if (term) {
            where += ' AND divisi LIKE ?';
            params.push(`%${term}%`);
        }

        const rows = await q(
            `
            SELECT DISTINCT divisi
            FROM table_karyawan
            ${where}
            ORDER BY divisi ASC
            LIMIT 20
            `,
            params
        );

        res.json({
            items: rows.map(r => r.divisi).filter(Boolean)
        });
    } catch (e) {
        console.error('[karyawan/divisi-suggest] fail:', e);
        res.json({ items: [] });
    }
});

router.get('/karyawan/jabatan-suggest', async (req, res) => {
    try {
        const term = (req.query.q || '').trim();
        const params = [];
        let where = 'WHERE jabatan IS NOT NULL AND jabatan <> ""';

        if (term) {
            where += ' AND jabatan LIKE ?';
            params.push(`%${term}%`);
        }

        const rows = await q(
            `
            SELECT DISTINCT jabatan
            FROM table_karyawan
            ${where}
            ORDER BY jabatan ASC
            LIMIT 20
            `,
            params
        );

        res.json({
            items: rows.map(r => r.jabatan).filter(Boolean)
        });
    } catch (e) {
        console.error('[karyawan/jabatan-suggest] fail:', e);
        res.json({ items: [] });
    }
});



// --- Test match: given descriptor list from client, find best NRP ---
router.post('/match', async (req, res) => {
    try {
        const { descriptors } = req.body; // [[128 floats], ...]
        if (!Array.isArray(descriptors) || descriptors.length === 0) {
            return res.status(400).json({ error: 'No descriptors' });
        }

        await ensureEmbeddings();

        // 1) Ambil jarak terbaik per NRP
        const bestByNRP = new Map(); // nrp -> dist
        for (const e of EMB_CACHE) {
            for (const d of descriptors) {
                const dist = euclideanDistance(e.emb, d);
                const prev = bestByNRP.get(e.nrp);
                if (prev === undefined || dist < prev) {
                    bestByNRP.set(e.nrp, dist);
                }
            }
        }

        // 2) Tentukan best dan second-best dari semua NRP
        let best = { nrp: null, dist: 9e9 };
        let second = { nrp: null, dist: 9e9 };
        for (const [nrp, dist] of bestByNRP.entries()) {
            if (dist < best.dist) {
                second = best;
                best = { nrp, dist };
            } else if (dist < second.dist) {
                second = { nrp, dist };
            }
        }

        // 3) Kalau tidak ada kandidat atau di atas threshold → tidak match
        if (!best.nrp || best.dist > FACE_THRESHOLD) {
            return res.json({ match: null, bestDist: best.dist });
        }

        // 4) Kalau selisih dengan kandidat kedua terlalu kecil → ambiguous → anggap tidak match
        if (second.nrp && (second.dist - best.dist) < FACE_MARGIN_MIN) {
            // Bisa juga dikembalikan reason khusus kalau mau dihandle di frontend:
            // return res.json({ match: null, reason: 'ambiguous', bestDist: best.dist, secondDist: second.dist });
            return res.json({ match: null, bestDist: best.dist, secondDist: second.dist });
        }

        // 5) Lolos threshold dan margin → ini match yang kita percaya
        const info = await getProfilUI(best.nrp);
        if (!info) {
            return res.json({ match: null, bestDist: best.dist });
        }
        return res.json({ match: { ...best, ...info } });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'match failed' });
    }
});




function euclideanDistance(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }


// --- Save face embeddings (15 samples) ---
router.post('/faces', async (req, res) => {
    try {
        //const { nrp, samples } = req.body;
        const { nrp, samples, forceReplace } = req.body; // samples: [{embedding:[...128], snapshotBase64, mime}]
        if (!nrp || !Array.isArray(samples) || samples.length === 0) return res.status(400).json({ error: 'Invalid payload' });
        // Validate karyawan
        //const cek = await q('SELECT nrp FROM table_karyawan WHERE nrp=? LIMIT 1', [nrp]);
        //if (!cek.length) return res.status(404).json({ error: 'NRP tidak ditemukan' });
        // sebelum insert rows:
        const prof = await ensureInCache(nrp);
        if (!prof) return res.status(404).json({ error: 'NRP tidak ditemukan di HR' });
        if (!ACTIVE_STATUSES.has((prof.status || '').toUpperCase())) {
            return res.status(400).json({ error: 'NRP tidak aktif (RESIGN)' });
        }
        const [{ c: existing = 0 }] = await q('SELECT COUNT(*) AS c FROM table_face_embeddings WHERE nrp=?', [nrp]);
        if (existing > 0 && !req.body?.forceReplace) {
            return res.json({ ok: false, reason: 'exists', count: Number(existing) });
        }

        const list = samples.slice(0, 15); // enforce 15 maksimal

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Cek existing
            const [countRows] = await conn.query('SELECT COUNT(*) AS c FROM table_face_embeddings WHERE nrp=?', [nrp]);
            const existing = Number(countRows?.[0]?.c || 0);
            if (existing > 0 && !forceReplace) {
                await conn.rollback();
                conn.release();
                return res.json({ ok: false, reason: 'exists', count: existing });
            }

            // Hapus lama jika forceReplace (atau existing > 0)
            if (existing > 0) {
                await conn.query('DELETE FROM table_face_embeddings WHERE nrp=?', [nrp]);
            }

            // Insert 15 rows (loop; aman & cukup cepat untuk 15 baris)
            for (const s of list) {
                const embJSON = JSON.stringify(s.embedding);
                const buf = s.snapshotBase64 ? Buffer.from((s.snapshotBase64.split(',')[1] || ''), 'base64') : null;
                await conn.query(
                    'INSERT INTO table_face_embeddings (nrp, embedding, snapshot, snapshot_mime) VALUES (?,?,?,?)',
                    [nrp, embJSON, buf, s.mime || 'image/jpeg']
                );
            }

            await conn.commit();
            conn.release();
            try {
                invalidateEmbeddingsFor(nrp);
                addEmbeddingsFor(nrp, list.map(s => s.embedding));
            } catch (e) { console.warn('[cache] update failed', e); }

            return res.json({ ok: true, saved: list.length });
        } catch (e) {
            try { await conn.rollback(); } catch { }
            conn.release();
            throw e;
        }

    } catch (e) {
        console.error(e); res.status(500).json({ error: 'faces save failed' });
    }
});
// --- Expose face config for frontend debug (threshold & margin) ---
router.get('/config/face', (req, res) => {
    res.json({
        threshold: FACE_THRESHOLD,
        marginMin: FACE_MARGIN_MIN
    });
});

// --- Absensi submit (anti-dobel per hari & kategori) ---
router.post('/absen', async (req, res) => {
    try {
        const { kategori, descriptors, frameBase64 } = req.body;
        const source = pickSource(req.body.source, ONLINE_SOURCES, 'web');
        if (!isValidKategori(kategori)) {
            return res.status(400).json({ error: 'Kategori tidak valid' });
        }
        if (!Array.isArray(descriptors) || descriptors.length === 0) {
            return res.status(400).json({ error: 'No descriptors' });
        }

        const nowObj = getNow();

        // Cari match terbaik
        await ensureEmbeddings();

        // 1) Ambil jarak terbaik per NRP
        const bestByNRP = new Map(); // nrp -> dist
        for (const e of EMB_CACHE) {
            for (const d of descriptors) {
                const dist = euclideanDistance(e.emb, d);
                const prev = bestByNRP.get(e.nrp);
                if (prev === undefined || dist < prev) {
                    bestByNRP.set(e.nrp, dist);
                }
            }
        }

        // 2) Tentukan best dan second-best dari semua NRP
        let best = { nrp: null, dist: 9e9 };
        let second = { nrp: null, dist: 9e9 };
        for (const [nrp, dist] of bestByNRP.entries()) {
            if (dist < best.dist) {
                second = best;
                best = { nrp, dist };
            } else if (dist < second.dist) {
                second = { nrp, dist };
            }
        }

        // 3) Jika tidak ada kandidat atau di atas threshold → unknown
        if (!best.nrp || best.dist > FACE_THRESHOLD) {
            await insertDeteksiLog(
                'INSERT INTO table_deteksi_log (context, kategori, status, distance, frame_snapshot) VALUES (?,?,?,?,?)',
                [
                    'absensi',
                    kategori,
                    'unknown',
                    best.dist || null,
                    frameBase64 ? Buffer.from(frameBase64.split(',')[1] || '', 'base64') : null
                ],
                2
            );
            return res.json({ ok: false, reason: 'unknown' });
        }

        // 4) Jika selisih best vs second terlalu kecil → ambiguous (jangan catat absensi)
        if (second.nrp && (second.dist - best.dist) < FACE_MARGIN_MIN) {
            await insertDeteksiLog(
                'INSERT INTO table_deteksi_log (context, kategori, status, distance, frame_snapshot) VALUES (?,?,?,?,?)',
                [
                    'absensi',
                    kategori,
                    'ambiguous',
                    best.dist,
                    frameBase64 ? Buffer.from(frameBase64.split(',')[1] || '', 'base64') : null
                ],
                2
            );
            return res.json({
                ok: false,
                reason: 'ambiguous'
            });
        }

        // Ambil profil dari cache (HR)
        const info = await getProfilUI(best.nrp);
        if (!info) {
            return res.json({ ok: false, reason: 'no-profile' });
        }
        if (!ACTIVE_STATUSES.has((info.status || '').toUpperCase())) {
            return res.json({ ok: false, reason: 'inactive', match: { ...best, ...info } });
        }

        const tanggalAbsensi = await resolveTanggalAbsensi(best.nrp, kategori, nowObj.tanggal);
        const late = computeLateFlag(kategori, nowObj.now);
        const lateMin = computeLateMinutes(kategori, nowObj.now);
        const shiftCode = deriveShiftCode(kategori);

        // Anti-dobel (nrp, tanggal, kategori)
        // Anti-dobel (nrp, tanggal, kategori)
        try {
            await q(
                `
        INSERT INTO table_absensi
          (nrp, tanggal, jam, kategori, shift_code,
           nama_snapshot, dep_snapshot, divisi_snapshot, jabatan_snapshot,
           is_late, menit_terlambat, snapshot_base64, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `,
                [
                    best.nrp,
                    tanggalAbsensi,
                    nowObj.jam,
                    kategori,
                    shiftCode,
                    info.nama,
                    info.dep,
                    info.divisi,
                    info.jabatan,
                    late,
                    lateMin,
                    frameBase64 || null,
                    source
                ]
            );
        } catch (e) {
            // Duplicate entry
            return res.json({
                ok: false,
                reason: 'duplicate',
                kategori,
                match: { ...best, ...info }
            });
        }


        // Log deteksi sukses
        await insertDeteksiLog(
            'INSERT INTO table_deteksi_log (context, kategori, nrp_detected, distance, status, frame_snapshot) VALUES (?,?,?,?,?,?)',
            [
                'absensi',
                kategori,
                best.nrp,
                best.dist,
                'recognized',
                frameBase64 ? Buffer.from(frameBase64.split(',')[1] || '', 'base64') : null
            ],
            4
        );

        // Sukses
        return res.json({
            ok: true,
            match: { ...best, ...info },
            is_late: late,
            menit_terlambat: lateMin
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'absen failed' });
    }
});

// --- Count embeddings by NRP ---
router.get('/faces/count', async (req, res) => {
    const nrp = (req.query.nrp || '').trim();
    if (!nrp) return res.status(400).json({ error: 'nrp required' });
    const [row] = await q('SELECT COUNT(*) AS c FROM table_face_embeddings WHERE nrp=?', [nrp]);
    res.json({ count: Number(row?.c || 0) });
});
// --- Reset embeddings (delete all for NRP) ---
router.post('/faces/reset', async (req, res) => {
    const { nrp } = req.body || {};
    if (!nrp) return res.status(400).json({ error: 'nrp required' });
    try {
        await q('DELETE FROM table_face_embeddings WHERE nrp=?', [nrp]);
        // Tanpa ini wajah lama tetap dikenali dari RAM sampai server restart.
        invalidateEmbeddingsFor(nrp);
        res.json({ ok: true });
    } catch (e) {
        console.error('[faces/reset] fail:', e);
        res.status(500).json({ ok: false, error: 'reset-failed' });
    }
});

// GET /api/hr/karyawan?q=...&page=1&limit=20&face=&dep=
router.get('/hr/karyawan', async (req, res) => {
    const qstr = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const faceFilter = (req.query.face || '').trim().toLowerCase(); // '', 'with', 'without'
    const depFilter = (req.query.dep || '').trim();
    const like = `%${qstr}%`;

    // Build WHERE untuk table_karyawan lokal
    const whereClauses = [];
    const params = [];

    if (qstr) {
        whereClauses.push(
            `(nrp LIKE ? OR nama LIKE ? OR dep LIKE ? OR divisi LIKE ? OR jabatan LIKE ?)`
        );
        params.push(like, like, like, like, like);
    }
    if (depFilter) {
        whereClauses.push(`dep = ?`);
        params.push(depFilter);
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    try {
        // 1) Ambil semua data dari table_karyawan (lokal)
        const allRows = await q(
            `SELECT nrp, nama, dep, divisi, jabatan, status
             FROM table_karyawan
             ${whereSql}
             ORDER BY nama ASC`,
            params
        );

        if (!allRows.length) {
            return res.json({
                page,
                limit,
                total: 0,
                rows: [],
                summary: {
                    total: 0,
                    spinning: 0,
                    weaving: 0
                }
            });
        }

        // Kumpulkan semua NRP
        const nrps = allRows.map(r => r.nrp).filter(Boolean);
        const placeholders = nrps.map(() => '?').join(',');

        // 2) Ambil status teks dari HR (rjsmanage.data_karyawan)
        let hrStatusMap = new Map();
        let hrStatusIoMap = new Map();
        if (nrps.length) {
            const hrRows = await hrq(
                `SELECT nrp, status, status_io
                 FROM data_karyawan 
                 WHERE nrp IN (${placeholders})`,
                nrps
            );
            hrStatusMap = new Map(hrRows.map(r => [r.nrp, r.status]));
            hrStatusIoMap = new Map(hrRows.map(r => [r.nrp, r.status_io]));
        }

        // 3) Ambil info wajah dari table_face_embeddings
        let faceSet = new Set();
        if (nrps.length) {
            const faceRows = await q(
                `SELECT DISTINCT nrp FROM table_face_embeddings WHERE nrp IN (${placeholders})`,
                nrps
            );
            faceSet = new Set(faceRows.map(fr => fr.nrp));
        }

        // 4) Gabungkan: data lokal + status HR + flag hasFace
        let mapped = allRows
            .map(r => ({
                ...r,
                status: hrStatusMap.get(r.nrp) || r.status, // override status angka dengan status HR (teks)
                status_io: hrStatusIoMap.get(r.nrp),
                hasFace: faceSet.has(r.nrp)
            }))
            .filter(r => isActiveKaryawanStatus(r.status, r.status_io));

        // 5) Filter wajah jika diminta
        if (faceFilter === 'with') {
            mapped = mapped.filter(r => r.hasFace);
        } else if (faceFilter === 'without') {
            mapped = mapped.filter(r => !r.hasFace);
        }

        const totalAll = mapped.length;
        const rows = mapped.slice(offset, offset + limit);

        // 6) Summary mengikuti daftar aktif yang sudah difilter dari HR.
        const sumRow = mapped.reduce((acc, r) => {
            acc.total++;
            if (String(r.dep || '').trim().toUpperCase() === 'SPINNING') acc.spinning++;
            if (String(r.dep || '').trim().toUpperCase() === 'WEAVING') acc.weaving++;
            return acc;
        }, { total: 0, spinning: 0, weaving: 0 });

        res.json({
            page,
            limit,
            total: totalAll,
            rows,
            summary: {
                total: Number(sumRow?.total || 0),
                spinning: Number(sumRow?.spinning || 0),
                weaving: Number(sumRow?.weaving || 0)
            }
        });

    } catch (e) {
        console.error('[hr/karyawan] local+hr fail:', e);
        res.status(500).json({ error: 'local-karyawan-failed' });
    }
});


// GET /api/hr/karyawan/:nrp
// router.get('/hr/karyawan/:nrp', async (req, res) => {
//     const nrp = (req.params.nrp || '').trim();
//     if (!nrp) return res.status(400).json({ error: 'nrp required' });
//     const rows = await hrq(
//         `SELECT idkar, nrp, nama, departement AS dep, divisi, jabatan, status,
//             tmt, tmp_lahir, tgl_lahir, goldar, jnskel, no_ktp, no_kk, npwp,
//             nohp, alamat, kel, kec, kabkota, prov, kodepos, pendidikan,
//             notelp, email, status_pernikahan, kode_pernikahan, norek_bca,
//             status_io, kjk, jam_kerja, istirahat_kerja
//      FROM data_karyawan WHERE nrp=? LIMIT 1`, [nrp]);
//     if (!rows.length) return res.status(404).json({ error: 'not found' });
//     res.json(rows[0]);
// });
router.get('/hr/karyawan/:nrp', async (req, res) => {
    const nrp = (req.params.nrp || '').trim();
    if (!nrp) return res.status(400).json({ error: 'nrp required' });

    // Data utama dari table_karyawan (lokal)
    const rowsLocal = await q(
        `SELECT nrp, nama, dep, divisi, jabatan, status
         FROM table_karyawan
         WHERE nrp = ?
         LIMIT 1`,
        [nrp]
    );
    if (!rowsLocal.length) {
        return res.status(404).json({ error: 'not found' });
    }
    const base = rowsLocal[0];

    // Status teks dari HR
    const hrRows = await hrq(
        `SELECT status 
         FROM data_karyawan
         WHERE nrp = ?
         LIMIT 1`,
        [nrp]
    );
    const statusText = hrRows.length ? hrRows[0].status : base.status;

    res.json({
        ...base,
        status: statusText
    });
});



// Webhook: invalidasi cache per-NRP (dipanggil dari CI/HR saat data berubah)
router.post('/cache/invalidate', async (req, res) => {
    try {
        const { nrp, fetch } = req.body || {};
        if (!nrp) return res.status(400).json({ error: 'nrp required' });
        await invalidateNRP(nrp);
        if (fetch) {
            // repopulate langsung (read-through)
            const c = await require('../services/karyawanCache').ensureInCache(nrp);
            return res.json({ ok: true, repopulated: !!c });
        }
        res.json({ ok: true });
    } catch (e) {
        console.error(e); res.status(500).json({ error: 'invalidate failed' });
    }
});

// Manual trigger full sync (opsional, untuk admin)
router.post('/cache/sync-now', async (req, res) => {
    try {
        const r = await fullSyncFromHR();
        res.json({ ok: true, ...r });
    } catch (e) {
        console.error(e); res.status(500).json({ error: 'sync failed' });
    }
});


// --- Monitoring deteksi log ---
// GET /api/deteksi-log?context=absensi&status=&tgl_from=&tgl_to=&limit=100
router.get('/deteksi-log', async (req, res) => {
    try {
        const {
            context = 'absensi',
            status,
            tgl_from,
            tgl_to,
            nrp,
            limit = '100'
        } = req.query || {};

        const where = [];
        const params = [];

        if (context) {
            where.push('context = ?');
            params.push(context);
        }
        if (status) {
            where.push('status = ?');
            params.push(status);
        }
        if (tgl_from) {
            where.push('DATE(created_at) >= ?');
            params.push(tgl_from);
        }
        if (tgl_to) {
            where.push('DATE(created_at) <= ?');
            params.push(tgl_to);
        }
        if (nrp) {
            where.push('nrp_detected LIKE ?');
            params.push(`%${nrp}%`);
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const lim = Math.min(500, Math.max(10, parseInt(limit, 10) || 100));

        const rows = await q(
            `
            SELECT 
              id,
              context,
              kategori,
              nrp_detected,
              distance,
              status,
              created_at
            FROM table_deteksi_log
            ${whereSql}
            ORDER BY created_at DESC
            LIMIT ${lim}
            `,
            params
        );

        res.json({ ok: true, rows });
    } catch (e) {
        console.error('[deteksi-log] fail:', e);
        res.status(500).json({ ok: false, error: 'deteksi-log-failed' });
    }
});

// GET /api/deteksi-log/:id/frame → kembalikan snapshot sebagai gambar JPEG (kalau ada)
router.get('/deteksi-log/:id/frame', async (req, res) => {
    try {
        const id = parseInt(req.params.id || '0', 10);
        if (!id) return res.status(400).send('invalid id');

        const [row] = await q(
            `SELECT frame_snapshot FROM table_deteksi_log WHERE id = ? LIMIT 1`,
            [id]
        );
        if (!row || !row.frame_snapshot) {
            return res.status(404).send('no image');
        }

        res.setHeader('Content-Type', 'image/jpeg');
        return res.end(row.frame_snapshot);
    } catch (e) {
        console.error('[deteksi-log/frame] fail:', e);
        res.status(500).send('error');
    }
});
// GET /api/deteksi-log/summary?context=absensi&status=&tgl_from=&tgl_to=&nrp=
router.get('/deteksi-log/summary', async (req, res) => {
    try {
        const {
            context = 'absensi',
            status,
            tgl_from,
            tgl_to,
            nrp
        } = req.query || {};

        const where = [];
        const params = [];

        if (context) {
            where.push('context = ?');
            params.push(context);
        }
        if (status) {
            where.push('status = ?');
            params.push(status);
        }
        if (tgl_from) {
            where.push('DATE(created_at) >= ?');
            params.push(tgl_from);
        }
        if (tgl_to) {
            where.push('DATE(created_at) <= ?');
            params.push(tgl_to);
        }
        if (nrp) {
            where.push('nrp_detected LIKE ?');
            params.push(`%${nrp}%`);
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const rows = await q(
            `
            SELECT 
              DATE(created_at) AS tgl,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'recognized' THEN 1 ELSE 0 END) AS recognized,
              SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown,
              SUM(CASE WHEN status = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous
            FROM table_deteksi_log
            ${whereSql}
            GROUP BY DATE(created_at)
            ORDER BY DATE(created_at) DESC
            LIMIT 14
            `,
            params
        );

        res.json({ ok: true, rows });
    } catch (e) {
        console.error('[deteksi-log/summary] fail:', e);
        res.status(500).json({ ok: false, error: 'summary-failed' });
    }
});


// ==== OFFLINE SYNC ENDPOINTS ====

// GET /api/health — health check untuk deteksi online/offline
router.get('/health', (req, res) => {
    res.json({ ok: true, time: Date.now() });
});

// GET /api/sync/manifest — cek versi data (untuk delta sync)
router.get('/sync/manifest', async (req, res) => {
    try {
        const [embRow] = await q('SELECT COUNT(*) AS c, MAX(created_at) AS max_at FROM table_face_embeddings');
        const [profRow] = await q('SELECT MAX(updated_at) AS max_at FROM table_karyawan_cache');
        res.json({
            ok: true,
            embCount: Number(embRow?.c || 0),
            embMaxAt: embRow?.max_at || null,
            profileMaxAt: profRow?.max_at || null,
            config: {
                threshold: FACE_THRESHOLD,
                marginMin: FACE_MARGIN_MIN,
                kategori: KATEGORI,
                shiftRules: SHIFT_RULES
            }
        });
    } catch (e) {
        console.error('[sync/manifest] fail:', e);
        res.status(500).json({ ok: false, error: 'manifest-failed' });
    }
});

// GET /api/sync/data — download semua embeddings + profiles + config untuk offline
router.get('/sync/data', async (req, res) => {
    try {
        // 1) Embeddings (hanya nrp + array, tanpa snapshot blob)
        const embRows = await q('SELECT nrp, embedding FROM table_face_embeddings');
        let embeddings = embRows.map(r => ({
            nrp: r.nrp,
            emb: Array.isArray(r.embedding) ? r.embedding : JSON.parse(r.embedding)
        }));

        // 2) Profiles dari table_karyawan_cache. Pastikan setiap NRP yang punya embedding
        // punya profil cache, supaya offline matching tidak berhenti di "no-profile".
        const nrps = [...new Set(embRows.map(r => r.nrp).filter(Boolean))];
        for (const nrp of nrps) {
            await ensureInCache(nrp);
        }

        let profRows = [];
        if (nrps.length) {
            const placeholders = nrps.map(() => '?').join(',');
            const cachedProfiles = await q(
                `SELECT nrp, nama, departement AS dep, divisi, jabatan, status
                 FROM table_karyawan_cache
                 WHERE nrp IN (${placeholders})`,
                nrps
            );
            profRows = cachedProfiles.filter(r => isActiveKaryawanStatus(r.status, null));
            const activeNrps = new Set(profRows.map(r => r.nrp));
            embeddings = embeddings.filter(e => activeNrps.has(e.nrp));
        }

        // 3) Config untuk matching & late computation di client
        const config = {
            threshold: FACE_THRESHOLD,
            marginMin: FACE_MARGIN_MIN,
            kategori: KATEGORI,
            shiftRules: SHIFT_RULES
        };

        res.json({
            ok: true,
            embeddings,
            profiles: profRows,
            config,
            syncToken: issueSyncToken(req.session.user),
            syncedAt: new Date().toISOString()
        });
    } catch (e) {
        console.error('[sync/data] fail:', e);
        res.status(500).json({ ok: false, error: 'sync-data-failed' });
    }
});

// POST /api/absen/sync — batch upload pending absensi offline (server menang)
router.post('/absen/sync', async (req, res) => {
    try {
        if (!(await isSyncAuthorized(req))) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }

        const { items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'No items' });
        }

        const results = [];
        for (const item of items) {
            const { nrp, kategori, tanggal, jam, frameBase64, clientId } = item;
            const source = pickSource(item.source, OFFLINE_SOURCES, 'offline-sync');
            try {
                // Validasi kategori
                if (!isValidKategori(kategori)) {
                    results.push({ clientId, ok: false, reason: 'invalid-kategori' });
                    continue;
                }
                if (!nrp || typeof nrp !== 'string') {
                    results.push({ clientId, ok: false, reason: 'no-profile' });
                    continue;
                }
                if (!isValidOfflineTimestamp(tanggal, jam)) {
                    results.push({ clientId, ok: false, reason: 'invalid-time' });
                    continue;
                }

                // Ambil profil dari cache (re-validate NRP)
                const info = await getProfilUI(nrp);
                if (!info) {
                    results.push({ clientId, ok: false, reason: 'no-profile' });
                    continue;
                }
                if (!ACTIVE_STATUSES.has((info.status || '').toUpperCase())) {
                    results.push({ clientId, ok: false, reason: 'inactive' });
                    continue;
                }

                // Compute late flags berdasarkan timestamp client
                const tanggalAbsensi = await resolveTanggalAbsensi(nrp, kategori, tanggal);
                const clientTime = dayjs(`${tanggalAbsensi} ${jam}`);
                const late = computeLateFlag(kategori, clientTime);
                const lateMin = computeLateMinutes(kategori, clientTime);
                const shiftCode = deriveShiftCode(kategori);

                // Anti-dobel + insert (server menang: first-write-wins)
                try {
                    await q(
                        `INSERT INTO table_absensi
                          (nrp, tanggal, jam, kategori, shift_code,
                           nama_snapshot, dep_snapshot, divisi_snapshot, jabatan_snapshot,
                           is_late, menit_terlambat, snapshot_base64, source)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                        [
                            nrp, tanggalAbsensi, jam, kategori, shiftCode,
                            info.nama, info.dep, info.divisi, info.jabatan,
                            late, lateMin, frameBase64 || null, source
                        ]
                    );
                } catch (e) {
                    if (e.code === 'ER_DUP_ENTRY') {
                        // Duplicate → server menang, skip
                        results.push({ clientId, ok: false, reason: 'duplicate' });
                        continue;
                    }
                    throw e;
                }

                // Log deteksi sukses
                await insertDeteksiLog(
                    'INSERT INTO table_deteksi_log (context, kategori, nrp_detected, status, frame_snapshot) VALUES (?,?,?,?,?)',
                    [
                        'absensi', kategori, nrp, 'recognized',
                        frameBase64 ? Buffer.from(frameBase64.split(',')[1] || '', 'base64') : null
                    ],
                    3
                );

                results.push({ clientId, ok: true });
            } catch (e) {
                console.error('[absen/sync] item fail:', e);
                results.push({ clientId, ok: false, reason: 'error' });
            }
        }

        res.json({ ok: true, results });
    } catch (e) {
        console.error('[absen/sync] fail:', e);
        res.status(500).json({ ok: false, error: 'sync-failed' });
    }
});

router.use(absensiRouter);
module.exports = router;
