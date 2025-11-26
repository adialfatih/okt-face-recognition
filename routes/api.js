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
const { q, pool, hrq } = require('../db');
const router = express.Router();
const { mapCacheToUI, ensureInCache, fullSyncFromHR, invalidateNRP, ACTIVE_STATUSES } = require('../services/karyawanCache');

const FACE_THRESHOLD = Number(process.env.FACE_DISTANCE_THRESHOLD || 0.5);
// Minimum selisih jarak antara kandidat terbaik dan kedua terbaik
const FACE_MARGIN_MIN = Number(process.env.FACE_MARGIN_MIN || 0.08);

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
     SELECT nrp, nama, departement AS dep, divisi, jabatan
     FROM table_karyawan_cache
     WHERE nrp LIKE ? OR nama LIKE ?
     LIMIT 20
   `, [`%${qstr}%`, `%${qstr}%`]);
        if (rows.length) return res.json(rows);

        // 2) Fallback HR + upsert ke cache
        const hrRows = await hrq(`
     SELECT nrp, nama, departement, divisi, jabatan, status
     FROM data_karyawan
     WHERE nrp LIKE ? OR nama LIKE ?
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

// --- Absensi submit (anti-dobel per hari & kategori) ---
router.post('/absen', async (req, res) => {
    try {
        const { kategori, descriptors, frameBase64 } = req.body;
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
            await q(
                'INSERT INTO table_deteksi_log (context, kategori, status, distance, frame_snapshot) VALUES (?,?,?,?,?)',
                [
                    'absensi',
                    kategori,
                    'unknown',
                    best.dist || null,
                    frameBase64 ? Buffer.from(frameBase64.split(',')[1] || '', 'base64') : null
                ]
            );
            return res.json({ ok: false, reason: 'unknown' });
        }

        // 4) Jika selisih best vs second terlalu kecil → ambiguous (jangan catat absensi)
        if (second.nrp && (second.dist - best.dist) < FACE_MARGIN_MIN) {
            await q(
                'INSERT INTO table_deteksi_log (context, kategori, status, distance, frame_snapshot) VALUES (?,?,?,?,?)',
                [
                    'absensi',
                    kategori,
                    'ambiguous',
                    best.dist,
                    frameBase64 ? Buffer.from(frameBase64.split(',')[1] || '', 'base64') : null
                ]
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
           is_late, menit_terlambat, snapshot_base64)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `,
                [
                    best.nrp,
                    nowObj.tanggal,
                    nowObj.jam,
                    kategori,
                    shiftCode,
                    info.nama,
                    info.dep,
                    info.divisi,
                    info.jabatan,
                    late,
                    lateMin,
                    frameBase64 || null
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
        await q(
            'INSERT INTO table_deteksi_log (context, kategori, nrp_detected, distance, status, frame_snapshot) VALUES (?,?,?,?,?,?)',
            [
                'absensi',
                kategori,
                best.nrp,
                best.dist,
                'recognized',
                frameBase64 ? Buffer.from(frameBase64.split(',')[1] || '', 'base64') : null
            ]
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
    await q('DELETE FROM table_face_embeddings WHERE nrp=?', [nrp]);
    res.json({ ok: true });
});

// GET /api/hr/karyawan?q=...&page=1&limit=20
// router.get('/hr/karyawan', async (req, res) => {
//     const qstr = (req.query.q || '').trim();
//     const page = Math.max(1, parseInt(req.query.page || '1', 10));
//     const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
//     const offset = (page - 1) * limit;
//     const like = `%${qstr}%`;
//     const where = qstr
//         ? `WHERE nrp LIKE ? OR nama LIKE ? OR departement LIKE ? OR divisi LIKE ? OR jabatan LIKE ?`
//         : '';
//     const params = qstr ? [like, like, like, like, like] : [];
//     const totalRow = await hrq(`SELECT COUNT(*) AS c FROM data_karyawan ${where}`, params);
//     const rows = await hrq(
//         `SELECT idkar, nrp, nama, departement AS dep, divisi, jabatan, status
//     FROM data_karyawan ${where}
//      ORDER BY nama ASC
//      LIMIT ? OFFSET ?`,
//         [...params, limit, offset]
//     );
//     res.json({ page, limit, total: Number(totalRow?.[0]?.c || 0), rows });
// });
// GET /api/hr/karyawan?q=...&page=1&limit=20
router.get('/hr/karyawan', async (req, res) => {
    const qstr = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;
    const like = `%${qstr}%`;
    const where = qstr
        ? `WHERE nrp LIKE ? OR nama LIKE ? OR departement LIKE ? OR divisi LIKE ? OR jabatan LIKE ?`
        : '';
    const params = qstr ? [like, like, like, like, like] : [];

    // 1) Total baris di HR (untuk pagination & meta)
    const totalRow = await hrq(`SELECT COUNT(*) AS c FROM data_karyawan ${where}`, params);
    const totalAll = Number(totalRow?.[0]?.c || 0);

    // 2) Ambil halaman data dari HR
    const rows = await hrq(
        `SELECT idkar, nrp, nama, departement AS dep, divisi, jabatan, status
         FROM data_karyawan ${where}
         ORDER BY nama ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    // 3) Cek siapa yang sudah punya face embedding di absensi_db_rjs
    let faceSet = new Set();
    if (rows.length > 0) {
        const nrps = rows.map(r => r.nrp);
        const placeholders = nrps.map(() => '?').join(',');
        const faceRows = await q(
            `SELECT DISTINCT nrp FROM table_face_embeddings WHERE nrp IN (${placeholders})`,
            nrps
        );
        faceSet = new Set(faceRows.map(fr => fr.nrp));
    }

    const mapped = rows.map(r => ({
        ...r,
        hasFace: faceSet.has(r.nrp)
    }));


    const [sumRow] = await q(`
        SELECT 
            COUNT(*) AS total,
            SUM(CASE WHEN UPPER(dep) = 'SPINNING' THEN 1 ELSE 0 END) AS spinning,
            SUM(CASE WHEN UPPER(dep) = 'WEAVING' THEN 1 ELSE 0 END) AS weaving
        FROM table_karyawan
    `);

    res.json({
        page,
        limit,
        total: totalAll,     // ini tetap total versi HR, untuk meta "1–20 dari X"
        rows: mapped,
        summary: {
            total: Number(sumRow?.total || 0),
            spinning: Number(sumRow?.spinning || 0),
            weaving: Number(sumRow?.weaving || 0)
        }
    });
});

// GET /api/hr/karyawan/:nrp
router.get('/hr/karyawan/:nrp', async (req, res) => {
    const nrp = (req.params.nrp || '').trim();
    if (!nrp) return res.status(400).json({ error: 'nrp required' });
    const rows = await hrq(
        `SELECT idkar, nrp, nama, departement AS dep, divisi, jabatan, status,
            tmt, tmp_lahir, tgl_lahir, goldar, jnskel, no_ktp, no_kk, npwp,
            nohp, alamat, kel, kec, kabkota, prov, kodepos, pendidikan,
            notelp, email, status_pernikahan, kode_pernikahan, norek_bca,
            status_io, kjk, jam_kerja, istirahat_kerja
     FROM data_karyawan WHERE nrp=? LIMIT 1`, [nrp]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
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

// GET /api/absensi?dep=&divisi=&jabatan=&nama=&nrp=&kategori=&tgl_from=&tgl_to=
// router.get('/absensi', async (req, res) => {
//     try {
//         const {
//             dep = '',
//             divisi = '',
//             jabatan = '',
//             nama = '',
//             nrp = '',
//             kategori = '',
//             tgl_from = '',
//             tgl_to = ''
//         } = req.query || {};

//         const where = [];
//         const params = [];

//         // Hanya ambil baris "Masuk ..."
//         where.push("a.kategori LIKE 'Masuk %'");

//         if (nrp.trim()) {
//             where.push('a.nrp LIKE ?');
//             params.push('%' + nrp.trim() + '%');
//         }
//         if (nama.trim()) {
//             where.push('a.nama_snapshot LIKE ?');
//             params.push('%' + nama.trim() + '%');
//         }
//         if (dep.trim()) {
//             where.push('a.dep_snapshot LIKE ?');
//             params.push('%' + dep.trim() + '%');
//         }
//         if (divisi.trim()) {
//             where.push('a.divisi_snapshot LIKE ?');
//             params.push('%' + divisi.trim() + '%');
//         }
//         if (jabatan.trim()) {
//             where.push('a.jabatan_snapshot LIKE ?');
//             params.push('%' + jabatan.trim() + '%');
//         }
//         if (kategori.trim()) {
//             where.push('a.kategori = ?');
//             params.push(kategori.trim());
//         }
//         if (tgl_from.trim()) {
//             where.push('a.tanggal >= ?');
//             params.push(tgl_from.trim());
//         }
//         if (tgl_to.trim()) {
//             where.push('a.tanggal <= ?');
//             params.push(tgl_to.trim());
//         }

//         const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

//         const rows = await q(`
//             SELECT
//                 a.id,
//                 a.nrp,
//                 a.tanggal,
//                 a.jam AS jam_masuk,
//                 b.jam AS jam_keluar,
//                 a.kategori AS kategori_masuk,
//                 b.kategori AS kategori_keluar,
//                 a.nama_snapshot AS nama,
//                 a.dep_snapshot AS dep,
//                 a.divisi_snapshot AS divisi,
//                 a.jabatan_snapshot AS jabatan,
//                 a.is_late,
//                 a.menit_terlambat,
//                 CASE 
//                     WHEN b.jam IS NOT NULL THEN
//                         TIMESTAMPDIFF(
//                             MINUTE,
//                             CONCAT(a.tanggal, ' ', a.jam),
//                             CONCAT(a.tanggal, ' ', b.jam)
//                         )
//                     ELSE NULL
//                 END AS durasi_menit
//             FROM table_absensi a
//             LEFT JOIN table_absensi b
//                 ON b.nrp = a.nrp
//                 AND b.tanggal = a.tanggal
//                 AND b.kategori = REPLACE(a.kategori, 'Masuk ', 'Keluar ')
//             ${whereSql}
//             ORDER BY a.tanggal DESC, a.jam ASC
//             LIMIT 500
//         `, params);

//         res.json({ rows });
//     } catch (e) {
//         console.error('[api/absensi] fail:', e);
//         res.status(500).json({ error: 'failed' });
//     }
// });
router.get('/absensi/report', async (req, res) => {
    try {
        const {
            tgl_from,
            tgl_to,
            nrp,
            nama,
            dep,
            divisi,
            jabatan,
            kategori
        } = req.query || {};

        const whereMasuk = [];
        const paramsMasuk = [];

        // Hanya ambil baris "Masuk ..."
        whereMasuk.push(`a.kategori LIKE 'Masuk%'`);

        // Filter tanggal
        if (tgl_from) {
            whereMasuk.push(`a.tanggal >= ?`);
            paramsMasuk.push(tgl_from);
        }
        if (tgl_to) {
            whereMasuk.push(`a.tanggal <= ?`);
            paramsMasuk.push(tgl_to);
        }

        // Filter NRP
        if (nrp) {
            whereMasuk.push(`a.nrp LIKE ?`);
            paramsMasuk.push(`%${nrp}%`);
        }

        // Filter nama (snapshot)
        if (nama) {
            whereMasuk.push(`a.nama_snapshot LIKE ?`);
            paramsMasuk.push(`%${nama}%`);
        }

        // Filter dep / divisi / jabatan (snapshot)
        if (dep) {
            whereMasuk.push(`a.dep_snapshot LIKE ?`);
            paramsMasuk.push(`%${dep}%`);
        }
        if (divisi) {
            whereMasuk.push(`a.divisi_snapshot LIKE ?`);
            paramsMasuk.push(`%${divisi}%`);
        }
        if (jabatan) {
            whereMasuk.push(`a.jabatan_snapshot LIKE ?`);
            paramsMasuk.push(`%${jabatan}%`);
        }

        // Filter kategori spesifik (mis. hanya Masuk Shift Pagi)
        if (kategori) {
            whereMasuk.push(`a.kategori = ?`);
            paramsMasuk.push(kategori);
        }

        const whereSql = whereMasuk.length ? `WHERE ${whereMasuk.join(' AND ')}` : '';

        // Pairing: a = Masuk, b = Keluar (shift_code sama & tanggal sama & nrp sama)
        const sql = `
            SELECT
                a.id              AS id_masuk,
                b.id              AS id_keluar,
                a.nrp,
                a.tanggal,
                a.jam             AS jam_masuk,
                b.jam             AS jam_keluar,
                a.kategori        AS kategori_masuk,
                b.kategori        AS kategori_keluar,
                a.shift_code,
                a.nama_snapshot,
                a.dep_snapshot,
                a.divisi_snapshot,
                a.jabatan_snapshot,
                a.is_late,
                a.menit_terlambat,
                -- durasi dalam menit (boleh NULL kalau jam_keluar belum ada)
                CASE 
                    WHEN b.id IS NOT NULL THEN TIMESTAMPDIFF(
                        MINUTE,
                        STR_TO_DATE(CONCAT(a.tanggal, ' ', a.jam), '%Y-%m-%d %H:%i:%s'),
                        STR_TO_DATE(CONCAT(b.tanggal, ' ', b.jam), '%Y-%m-%d %H:%i:%s')
                    )
                    ELSE NULL
                END AS durasi_menit
            FROM table_absensi a
            LEFT JOIN table_absensi b
                ON  b.nrp = a.nrp
                AND b.tanggal = a.tanggal
                AND (
                        (a.shift_code IS NOT NULL AND b.shift_code IS NOT NULL AND b.shift_code = a.shift_code)
                     OR (a.shift_code IS NULL AND b.shift_code IS NULL AND b.kategori LIKE 'Keluar%')
                )
                AND b.kategori LIKE 'Keluar%'
            ${whereSql}
            ORDER BY a.tanggal DESC, a.jam ASC
            LIMIT 1000
        `;

        const rows = await q(sql, paramsMasuk);
        res.json({ ok: true, rows });
    } catch (e) {
        console.error('[absensi/report] fail:', e);
        res.status(500).json({ ok: false, error: 'report-failed' });
    }
});
// GET /api/absensi/:id  → detil 1 baris absensi (untuk modal)
// GET /api/absensi/:id  → detil 1 baris absensi + pasangan masuk/keluar
router.get('/absensi/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id || '0', 10);
        if (!id) return res.status(400).json({ ok: false, error: 'invalid-id' });

        const rows = await q(
            `SELECT 
                id,
                nrp,
                tanggal,
                jam,
                kategori,
                shift_code,
                nama_snapshot,
                dep_snapshot,
                divisi_snapshot,
                jabatan_snapshot,
                is_late,
                menit_terlambat,
                snapshot_base64,
                created_at
            FROM table_absensi
            WHERE id = ?
            LIMIT 1`,
            [id]
        );

        if (!rows.length) {
            return res.status(404).json({ ok: false, error: 'not-found' });
        }

        const r = rows[0];
        const shiftCode = r.shift_code || deriveShiftCode(r.kategori || '');
        let jamMasuk = null;
        let jamKeluar = null;

        // Helper map kategori pasangan (fallback kalau shift_code belum ada)
        function pasanganKeluar(katMasuk) {
            if (!katMasuk) return null;
            if (katMasuk.includes('Shift Pagi')) return 'Keluar Shift Pagi';
            if (katMasuk.includes('Shift Siang')) return 'Keluar Shift Siang';
            if (katMasuk.includes('Shift Malam')) return 'Keluar Shift Malam';
            if (katMasuk.includes('DS')) return 'Keluar DS';
            if (katMasuk.includes('Driver')) return 'Keluar Driver';
            if (katMasuk.includes('Security')) return 'Keluar Security';
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

        if ((r.kategori || '').startsWith('Masuk')) {
            jamMasuk = r.jam;

            // Cari pasangan Keluar
            let pair;
            if (shiftCode) {
                const p = await q(
                    `SELECT id, jam, kategori FROM table_absensi
                     WHERE nrp=? AND tanggal=? AND shift_code=? AND kategori LIKE 'Keluar%'
                     ORDER BY jam ASC
                     LIMIT 1`,
                    [r.nrp, r.tanggal, shiftCode]
                );
                pair = p[0];
            } else {
                const katKeluar = pasanganKeluar(r.kategori);
                if (katKeluar) {
                    const p = await q(
                        `SELECT id, jam, kategori FROM table_absensi
                         WHERE nrp=? AND tanggal=? AND kategori=?
                         ORDER BY jam ASC
                         LIMIT 1`,
                        [r.nrp, r.tanggal, katKeluar]
                    );
                    pair = p[0];
                }
            }
            if (pair) jamKeluar = pair.jam;

        } else if ((r.kategori || '').startsWith('Keluar')) {
            jamKeluar = r.jam;

            // Cari pasangan Masuk
            let pair;
            if (shiftCode) {
                const p = await q(
                    `SELECT id, jam, kategori FROM table_absensi
                     WHERE nrp=? AND tanggal=? AND shift_code=? AND kategori LIKE 'Masuk%'
                     ORDER BY jam ASC
                     LIMIT 1`,
                    [r.nrp, r.tanggal, shiftCode]
                );
                pair = p[0];
            } else {
                const katMasuk = pasanganMasuk(r.kategori);
                if (katMasuk) {
                    const p = await q(
                        `SELECT id, jam, kategori FROM table_absensi
                         WHERE nrp=? AND tanggal=? AND kategori=?
                         ORDER BY jam ASC
                         LIMIT 1`,
                        [r.nrp, r.tanggal, katMasuk]
                    );
                    pair = p[0];
                }
            }
            if (pair) jamMasuk = pair.jam;
        } else {
            // kategori lain (Masuk Terlambat, Ijin Keluar, dll)
            jamMasuk = r.jam;
        }

        res.json({
            ok: true,
            data: {
                ...r,
                jam_masuk: jamMasuk,
                jam_keluar: jamKeluar
            }
        });
    } catch (e) {
        console.error('[absensi/:id] fail:', e);
        res.status(500).json({ ok: false, error: 'detail-failed' });
    }
});



module.exports = router;