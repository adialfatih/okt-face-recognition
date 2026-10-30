const express = require('express');
const dayjs = require('dayjs');
const router = express.Router();
const { q } = require('../db');

function requireAuthorizationPassword(req, res) {
    const configured = process.env.PASSWORD_OTORISASI;
    if (!configured) {
        res.status(500).json({ ok: false, error: 'PASSWORD_OTORISASI belum diset di .env' });
        return false;
    }

    const supplied = req.body?.authorizationPassword
        || req.get('x-authorization-password')
        || '';

    if (supplied !== configured) {
        res.status(403).json({ ok: false, error: 'Password otorisasi salah' });
        return false;
    }

    return true;
}

// Helper untuk shift_code (sama seperti di api.js sebelumnya)
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
// Helper pasangan kategori (dipakai detail & delete)
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

function isOvernightAbsensi(kategori, shiftCode) {
    const k = String(kategori || '').toLowerCase();
    const sc = String(shiftCode || '').toUpperCase();
    return sc === 'MALAM'
        || k.includes('shift malam');
}

function isSecurityAbsensi(kategori, shiftCode) {
    const k = String(kategori || '').toLowerCase();
    const sc = String(shiftCode || '').toUpperCase();
    return sc === 'SECURITY' || k.includes('security');
}

function nextDateYmd(tanggal) {
    return dayjs(tanggal).add(1, 'day').format('YYYY-MM-DD');
}

function prevDateYmd(tanggal) {
    return dayjs(tanggal).subtract(1, 'day').format('YYYY-MM-DD');
}

function pairKeluarTanggal(tanggalMasuk, kategoriMasuk, shiftCode) {
    return isOvernightAbsensi(kategoriMasuk, shiftCode) ? nextDateYmd(tanggalMasuk) : dayjs(tanggalMasuk).format('YYYY-MM-DD');
}

function pairMasukTanggal(tanggalKeluar, kategoriKeluar, shiftCode) {
    return isOvernightAbsensi(kategoriKeluar, shiftCode) ? prevDateYmd(tanggalKeluar) : dayjs(tanggalKeluar).format('YYYY-MM-DD');
}

function pairKeluarTanggalForInput(tanggalMasuk, jamMasuk, jamKeluar, kategoriMasuk, shiftCode) {
    if (!isSecurityAbsensi(kategoriMasuk, shiftCode)) {
        return pairKeluarTanggal(tanggalMasuk, kategoriMasuk, shiftCode);
    }

    if (!jamMasuk || !jamKeluar) return dayjs(tanggalMasuk).format('YYYY-MM-DD');
    return jamKeluar <= jamMasuk ? nextDateYmd(tanggalMasuk) : dayjs(tanggalMasuk).format('YYYY-MM-DD');
}

const SECURITY_PAIR_MIN_MINUTES = 390; // 6 jam 30 menit, toleransi untuk shift 7 jam.
const SECURITY_PAIR_MAX_HOURS = 18;

// Kolom DATE dari `SELECT *` dikembalikan mysql2 sebagai objek Date. Kalau Date itu
// langsung masuk CONCAT(?, ' ', jam), mysql2 menulisnya 'YYYY-MM-DD 00:00:00.000'
// sehingga STR_TO_DATE membaca jam 00:00 dan `jam` absensi terabaikan.
function toYmd(tanggal) {
    return dayjs(tanggal).format('YYYY-MM-DD');
}

async function findSecurityKeluar(rowMasuk) {
    const tanggal = toYmd(rowMasuk.tanggal);
    const rows = await q(
        `SELECT id, jam, kategori, snapshot_base64, snapshot_url, created_at
         FROM table_absensi
         WHERE nrp = ?
           AND kategori = 'Keluar Security'
           AND STR_TO_DATE(CONCAT(tanggal, ' ', jam), '%Y-%m-%d %H:%i:%s')
               > STR_TO_DATE(CONCAT(?, ' ', ?), '%Y-%m-%d %H:%i:%s')
           AND STR_TO_DATE(CONCAT(tanggal, ' ', jam), '%Y-%m-%d %H:%i:%s')
               >= DATE_ADD(STR_TO_DATE(CONCAT(?, ' ', ?), '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE)
           AND STR_TO_DATE(CONCAT(tanggal, ' ', jam), '%Y-%m-%d %H:%i:%s')
               <= DATE_ADD(STR_TO_DATE(CONCAT(?, ' ', ?), '%Y-%m-%d %H:%i:%s'), INTERVAL ? HOUR)
         ORDER BY STR_TO_DATE(CONCAT(tanggal, ' ', jam), '%Y-%m-%d %H:%i:%s') ASC
         LIMIT 1`,
        [
            rowMasuk.nrp,
            tanggal, rowMasuk.jam,
            tanggal, rowMasuk.jam, SECURITY_PAIR_MIN_MINUTES,
            tanggal, rowMasuk.jam, SECURITY_PAIR_MAX_HOURS
        ]
    );
    return rows[0] || null;
}

async function findSecurityMasuk(rowKeluar) {
    const tanggal = toYmd(rowKeluar.tanggal);
    const rows = await q(
        `SELECT id, jam, kategori, snapshot_base64, snapshot_url, created_at
         FROM table_absensi
         WHERE nrp = ?
           AND kategori = 'Masuk Security'
           AND STR_TO_DATE(CONCAT(tanggal, ' ', jam), '%Y-%m-%d %H:%i:%s')
               < STR_TO_DATE(CONCAT(?, ' ', ?), '%Y-%m-%d %H:%i:%s')
           AND STR_TO_DATE(CONCAT(tanggal, ' ', jam), '%Y-%m-%d %H:%i:%s')
               <= DATE_SUB(STR_TO_DATE(CONCAT(?, ' ', ?), '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE)
           AND STR_TO_DATE(CONCAT(tanggal, ' ', jam), '%Y-%m-%d %H:%i:%s')
               >= DATE_SUB(STR_TO_DATE(CONCAT(?, ' ', ?), '%Y-%m-%d %H:%i:%s'), INTERVAL ? HOUR)
         ORDER BY STR_TO_DATE(CONCAT(tanggal, ' ', jam), '%Y-%m-%d %H:%i:%s') DESC
         LIMIT 1`,
        [
            rowKeluar.nrp,
            tanggal, rowKeluar.jam,
            tanggal, rowKeluar.jam, SECURITY_PAIR_MIN_MINUTES,
            tanggal, rowKeluar.jam, SECURITY_PAIR_MAX_HOURS
        ]
    );
    return rows[0] || null;
}
// GET /api/absensi/report
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

        // Pairing: a = Masuk, b = Keluar.
        // Shift malam keluar H+1. Security pakai urutan waktu aktual dalam window 18 jam.
        const sql = `
            SELECT
                a.id              AS id_masuk,
                b.id              AS id_keluar,
                a.nrp,
                DATE_FORMAT(a.tanggal, '%Y-%m-%d') AS tanggal,
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
                ON b.id = (
                    SELECT bx.id
                    FROM table_absensi bx
                    WHERE bx.nrp = a.nrp
                      AND bx.kategori LIKE 'Keluar%'
                      AND (
                            (a.shift_code IS NOT NULL AND bx.shift_code IS NOT NULL AND bx.shift_code = a.shift_code)
                         OR (a.shift_code IS NULL AND bx.shift_code IS NULL)
                      )
                      AND (
                            (
                                (a.shift_code = 'SECURITY' OR a.kategori LIKE '%Security%')
                                AND STR_TO_DATE(CONCAT(bx.tanggal, ' ', bx.jam), '%Y-%m-%d %H:%i:%s')
                                    > STR_TO_DATE(CONCAT(a.tanggal, ' ', a.jam), '%Y-%m-%d %H:%i:%s')
                                AND STR_TO_DATE(CONCAT(bx.tanggal, ' ', bx.jam), '%Y-%m-%d %H:%i:%s')
                                    >= DATE_ADD(STR_TO_DATE(CONCAT(a.tanggal, ' ', a.jam), '%Y-%m-%d %H:%i:%s'), INTERVAL ${SECURITY_PAIR_MIN_MINUTES} MINUTE)
                                AND STR_TO_DATE(CONCAT(bx.tanggal, ' ', bx.jam), '%Y-%m-%d %H:%i:%s')
                                    <= DATE_ADD(STR_TO_DATE(CONCAT(a.tanggal, ' ', a.jam), '%Y-%m-%d %H:%i:%s'), INTERVAL ${SECURITY_PAIR_MAX_HOURS} HOUR)
                            )
                         OR (
                                NOT (a.shift_code = 'SECURITY' OR a.kategori LIKE '%Security%')
                                AND bx.tanggal = CASE
                                    WHEN (a.shift_code = 'MALAM' OR a.kategori LIKE '%Shift Malam%')
                                    THEN DATE_ADD(a.tanggal, INTERVAL 1 DAY)
                                    ELSE a.tanggal
                                END
                            )
                      )
                    ORDER BY STR_TO_DATE(CONCAT(bx.tanggal, ' ', bx.jam), '%Y-%m-%d %H:%i:%s') ASC
                    LIMIT 1
                )
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

// GET /api/absensi/:id  → detil 1 baris absensi + pasangan masuk/keluar
router.get('/absensi/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id || '0', 10);
        if (!id) return res.status(400).json({ ok: false, error: 'invalid-id' });

        const rows = await q(
            `SELECT 
                id,
                nrp,
                DATE_FORMAT(tanggal, '%Y-%m-%d') AS tanggal,
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
                snapshot_url,
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
        let rowMasuk = null;
        let rowKeluar = null;

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

            let pair;
            if (isSecurityAbsensi(r.kategori, shiftCode)) {
                pair = await findSecurityKeluar(r);
            } else if (shiftCode) {
                // Cari pasangan Keluar. Shift malam keluar H+1 dari tanggal masuk.
                const tanggalKeluar = pairKeluarTanggal(r.tanggal, r.kategori, shiftCode);
                const p = await q(
                    `SELECT id, jam, kategori, snapshot_base64, snapshot_url, created_at FROM table_absensi
                     WHERE nrp=? AND tanggal=? AND shift_code=? AND kategori LIKE 'Keluar%'
                     ORDER BY jam ASC
                     LIMIT 1`,
                    [r.nrp, tanggalKeluar, shiftCode]
                );
                pair = p[0];
            } else {
                const katKeluar = pasanganKeluar(r.kategori);
                if (katKeluar) {
                    const tanggalKeluar = pairKeluarTanggal(r.tanggal, r.kategori, shiftCode);
                    const p = await q(
                        `SELECT id, jam, kategori, snapshot_base64, snapshot_url, created_at FROM table_absensi
                         WHERE nrp=? AND tanggal=? AND kategori=?
                         ORDER BY jam ASC
                         LIMIT 1`,
                        [r.nrp, tanggalKeluar, katKeluar]
                    );
                    pair = p[0];
                }
            }
            if (pair) {
                jamKeluar = pair.jam;
                rowMasuk = r;
                rowKeluar = pair;
            } else {
                rowMasuk = r;
            }
        } else if ((r.kategori || '').startsWith('Keluar')) {
            jamKeluar = r.jam;

            let pair;
            if (isSecurityAbsensi(r.kategori, shiftCode)) {
                pair = await findSecurityMasuk(r);
            } else if (shiftCode) {
                // Cari pasangan Masuk. Untuk keluar shift malam, masuk ada H-1.
                const tanggalMasuk = pairMasukTanggal(r.tanggal, r.kategori, shiftCode);
                const p = await q(
                    `SELECT id, jam, kategori, snapshot_base64, snapshot_url, created_at FROM table_absensi
                     WHERE nrp=? AND tanggal=? AND shift_code=? AND kategori LIKE 'Masuk%'
                     ORDER BY jam ASC
                     LIMIT 1`,
                    [r.nrp, tanggalMasuk, shiftCode]
                );
                pair = p[0];
            } else {
                const katMasuk = pasanganMasuk(r.kategori);
                if (katMasuk) {
                    const tanggalMasuk = pairMasukTanggal(r.tanggal, r.kategori, shiftCode);
                    const p = await q(
                        `SELECT id, jam, kategori, snapshot_base64, snapshot_url, created_at FROM table_absensi
                         WHERE nrp=? AND tanggal=? AND kategori=?
                         ORDER BY jam ASC
                         LIMIT 1`,
                        [r.nrp, tanggalMasuk, katMasuk]
                    );
                    pair = p[0];
                }
            }
            if (pair) {
                jamMasuk = pair.jam;
                rowMasuk = pair;
                rowKeluar = r;
            } else {
                rowKeluar = r;
            }
        } else {
            // kategori lain (Masuk Terlambat, Ijin Keluar, dll)
            jamMasuk = r.jam;
            rowMasuk = r;
        }

        res.json({
            ok: true,
            data: {
                ...r,
                jam_masuk: jamMasuk,
                jam_keluar: jamKeluar,
                kategori_masuk: rowMasuk ? rowMasuk.kategori : null,
                kategori_keluar: rowKeluar ? rowKeluar.kategori : null,
                // Utamakan file webp (snapshot_url); fallback ke base64 lama bila belum dimigrasi
                snapshot_masuk: rowMasuk ? (rowMasuk.snapshot_url || rowMasuk.snapshot_base64) : null,
                snapshot_keluar: rowKeluar ? (rowKeluar.snapshot_url || rowKeluar.snapshot_base64) : null
            }
        });

    } catch (e) {
        console.error('[absensi/:id] fail:', e);
        res.status(500).json({ ok: false, error: 'detail-failed' });
    }
});

// PUT /api/absensi/pair/:id  → edit satu paket absensi (Masuk + optional Keluar)
router.put('/absensi/pair/:id', async (req, res) => {
    try {
        if (!requireAuthorizationPassword(req, res)) return;

        const id = parseInt(req.params.id || '0', 10);
        if (!id) return res.status(400).json({ ok: false, error: 'invalid-id' });

        const body = req.body || {};
        const tanggal = (body.tanggal || '').trim();
        const jamMasuk = (body.jam_masuk || '').trim();
        const jamKeluar = (body.jam_keluar || '').trim();

        if (!tanggal || !jamMasuk) {
            return res.status(400).json({ ok: false, error: 'tanggal-dan-jam-masuk-wajib' });
        }

        // Ambil baris MASUK
        const rowsMasuk = await q(
            `SELECT *
             FROM table_absensi
             WHERE id = ?
             LIMIT 1`,
            [id]
        );
        if (!rowsMasuk.length) {
            return res.status(404).json({ ok: false, error: 'not-found' });
        }

        const masuk = rowsMasuk[0];
        const shiftCode = masuk.shift_code || deriveShiftCode(masuk.kategori || '');
        let keluar = null;

        // Cari pasangan KELUAR (kalau ada)
        if (isSecurityAbsensi(masuk.kategori, shiftCode)) {
            keluar = await findSecurityKeluar(masuk);
        } else if (shiftCode) {
            const tanggalKeluarExisting = pairKeluarTanggal(masuk.tanggal, masuk.kategori, shiftCode);
            const listKeluar = await q(
                `SELECT *
                 FROM table_absensi
                 WHERE nrp = ?
                   AND tanggal = ?
                   AND shift_code = ?
                   AND kategori LIKE 'Keluar%'
                 ORDER BY jam ASC
                 LIMIT 1`,
                [masuk.nrp, tanggalKeluarExisting, shiftCode]
            );
            keluar = listKeluar[0] || null;
        } else {
            const katKeluar = pasanganKeluar(masuk.kategori || '');
            if (katKeluar) {
                const tanggalKeluarExisting = pairKeluarTanggal(masuk.tanggal, masuk.kategori, shiftCode);
                const listKeluar = await q(
                    `SELECT *
                     FROM table_absensi
                     WHERE nrp = ?
                       AND tanggal = ?
                       AND kategori = ?
                     ORDER BY jam ASC
                     LIMIT 1`,
                    [masuk.nrp, tanggalKeluarExisting, katKeluar]
                );
                keluar = listKeluar[0] || null;
            }
        }

        const tanggalKeluarBaru = pairKeluarTanggalForInput(tanggal, jamMasuk, jamKeluar, masuk.kategori, shiftCode);

        // 1) UPDATE baris MASUK (tanggal + jam)
        await q(
            `UPDATE table_absensi
             SET tanggal = ?, jam = ?
             WHERE id = ?`,
            [tanggal, jamMasuk, masuk.id]
        );

        // 2) HANDLE KELUAR:
        if (jamKeluar) {
            // Ada jam keluar baru / diisi
            if (keluar) {
                // UPDATE baris keluar
                await q(
                    `UPDATE table_absensi
                     SET tanggal = ?, jam = ?
                     WHERE id = ?`,
                    [tanggalKeluarBaru, jamKeluar, keluar.id]
                );
            } else {
                // INSERT baris keluar baru
                const kategoriKeluar = pasanganKeluar(masuk.kategori || '') || 'Keluar Shift Pagi';
                const sc = shiftCode || deriveShiftCode(kategoriKeluar) || null;

                await q(
                    `INSERT INTO table_absensi
                     (nrp, tanggal, jam, kategori, shift_code,
                      nama_snapshot, dep_snapshot, divisi_snapshot, jabatan_snapshot,
                      is_late, menit_terlambat, snapshot_base64)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [
                        masuk.nrp,
                        tanggalKeluarBaru,
                        jamKeluar,
                        kategoriKeluar,
                        sc,
                        masuk.nama_snapshot,
                        masuk.dep_snapshot,
                        masuk.divisi_snapshot,
                        masuk.jabatan_snapshot,
                        0,
                        0,
                        null
                    ]
                );
            }
        } else if (keluar) {
            // jamKeluar dikosongkan → hapus baris keluar kalau ada
            await q(
                `DELETE FROM table_absensi
                 WHERE id = ?`,
                [keluar.id]
            );
        }

        res.json({ ok: true });
    } catch (e) {
        console.error('[absensi/pair PUT] fail:', e);
        res.status(500).json({ ok: false, error: 'edit-failed' });
    }
});
// DELETE /api/absensi/pair/:id  → hapus satu paket absensi (Masuk + Keluar)
router.delete('/absensi/pair/:id', async (req, res) => {
    try {
        if (!requireAuthorizationPassword(req, res)) return;

        const id = parseInt(req.params.id || '0', 10);
        if (!id) return res.status(400).json({ ok: false, error: 'invalid-id' });

        const rowsBase = await q(
            `SELECT id, nrp, tanggal, shift_code, kategori
             FROM table_absensi
             WHERE id = ?
             LIMIT 1`,
            [id]
        );
        if (!rowsBase.length) {
            return res.status(404).json({ ok: false, error: 'not-found' });
        }

        const base = rowsBase[0];
        const shiftCode = base.shift_code || deriveShiftCode(base.kategori || '');
        if (isSecurityAbsensi(base.kategori, shiftCode)) {
            const pair = String(base.kategori || '').startsWith('Masuk')
                ? await findSecurityKeluar(base)
                : await findSecurityMasuk(base);
            const ids = [base.id, pair?.id].filter(Boolean);
            const placeholders = ids.map(() => '?').join(',');
            const list = await q(
                `SELECT id, kategori, jam
                 FROM table_absensi
                 WHERE id IN (${placeholders})`,
                ids
            );
            await q(
                `DELETE FROM table_absensi
                 WHERE id IN (${placeholders})`,
                ids
            );
            return res.json({
                ok: true,
                deleted: list.length,
                base
            });
        }

        const isMasuk = String(base.kategori || '').startsWith('Masuk');
        const tanggalMasuk = isMasuk
            ? dayjs(base.tanggal).format('YYYY-MM-DD')
            : pairMasukTanggal(base.tanggal, base.kategori, shiftCode);
        const tanggalKeluar = isMasuk
            ? pairKeluarTanggal(base.tanggal, base.kategori, shiftCode)
            : dayjs(base.tanggal).format('YYYY-MM-DD');

        let whereSql = '';
        let params = [];

        if (shiftCode) {
            // Paket berdasarkan shift_code
            whereSql = `nrp = ? AND shift_code = ? AND (
                (kategori LIKE 'Masuk%' AND tanggal = ?)
                OR (kategori LIKE 'Keluar%' AND tanggal = ?)
            )`;
            params = [base.nrp, shiftCode, tanggalMasuk, tanggalKeluar];
        } else {
            // Paket berdasarkan pasangan kategori
            const kat = base.kategori || '';
            if (kat.startsWith('Masuk')) {
                const katKeluar = pasanganKeluar(kat);
                if (katKeluar) {
                    whereSql = `nrp = ? AND (
                        (tanggal = ? AND kategori = ?)
                        OR (tanggal = ? AND kategori = ?)
                    )`;
                    params = [base.nrp, tanggalMasuk, kat, tanggalKeluar, katKeluar];
                } else {
                    whereSql = `id = ?`;
                    params = [base.id];
                }
            } else if (kat.startsWith('Keluar')) {
                const katMasuk = pasanganMasuk(kat);
                if (katMasuk) {
                    whereSql = `nrp = ? AND (
                        (tanggal = ? AND kategori = ?)
                        OR (tanggal = ? AND kategori = ?)
                    )`;
                    params = [base.nrp, tanggalMasuk, katMasuk, tanggalKeluar, kat];
                } else {
                    whereSql = `id = ?`;
                    params = [base.id];
                }
            } else {
                // kategori lain → anggap single row saja
                whereSql = `id = ?`;
                params = [base.id];
            }
        }

        // Ambil list dulu untuk info
        const list = await q(
            `SELECT id, kategori, jam
             FROM table_absensi
             WHERE ${whereSql}`,
            params
        );

        // Hapus
        await q(
            `DELETE FROM table_absensi
             WHERE ${whereSql}`,
            params
        );

        res.json({
            ok: true,
            deleted: list.length,
            base
        });
    } catch (e) {
        console.error('[absensi/pair DELETE] fail:', e);
        res.status(500).json({ ok: false, error: 'delete-failed' });
    }
});

module.exports = router;
