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
        if (!Array.isArray(descriptors) || descriptors.length === 0) return res.status(400).json({ error: 'No descriptors' });

        await ensureEmbeddings();
        let best = { nrp: null, dist: 9e9 };
        for (const e of EMB_CACHE) {
            for (const d of descriptors) {
                const dist = euclideanDistance(e.emb, d);
                if (dist < best.dist) best = { nrp: e.nrp, dist };
            }
        }
        if (best.dist <= FACE_THRESHOLD) {
            //const [info] = await q('SELECT nrp, nama, dep, divisi, jabatan FROM table_karyawan WHERE nrp=? LIMIT 1', [best.nrp]);
            // const [info] = await hrQ('SELECT nrp, nama, departement AS dep, divisi, jabatan FROM data_karyawan WHERE nrp=? LIMIT 1', [best.nrp]);
            // return res.json({ match: { ...best, ...info } });
            const info = await getProfilUI(best.nrp);
            return res.json({ match: { ...best, ...info } });
        }
        res.json({ match: null, bestDist: best.dist });
    } catch (e) {
        console.error(e); res.status(500).json({ error: 'match failed' });
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
        let best = { nrp: null, dist: 9e9 };
        for (const e of EMB_CACHE) {
            for (const d of descriptors) {
                const dist = euclideanDistance(e.emb, d);
                if (dist < best.dist) best = { nrp: e.nrp, dist };
            }
        }

        // Jika tidak ketemu / di atas threshold -> log unknown
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

        // Anti-dobel (nrp, tanggal, kategori)
        try {
            await q(
                `
        INSERT INTO table_absensi
          (nrp, tanggal, jam, kategori,
           nama_snapshot, dep_snapshot, divisi_snapshot, jabatan_snapshot,
           is_late, menit_terlambat)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `,
                [
                    best.nrp,
                    nowObj.tanggal,
                    nowObj.jam,
                    kategori,
                    info.nama,
                    info.dep,
                    info.divisi,
                    info.jabatan,
                    late,
                    lateMin
                ]
            );
        } catch (e) {
            // Duplicate entry
            return res.json({
                ok: false,
                reason: 'duplicate',
                kategori,
                match: { ...best, ...info } // pakai info dari cache
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
    const totalRow = await hrq(`SELECT COUNT(*) AS c FROM data_karyawan ${where}`, params);
    const rows = await hrq(
        `SELECT idkar, nrp, nama, departement AS dep, divisi, jabatan, status
    FROM data_karyawan ${where}
     ORDER BY nama ASC
     LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    res.json({ page, limit, total: Number(totalRow?.[0]?.c || 0), rows });
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



module.exports = router;