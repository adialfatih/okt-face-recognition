const express = require('express');
const router = express.Router();
const { q } = require('../db');

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

        // Pairing: a = Masuk, b = Keluar (shift_code sama & tanggal sama & nrp sama)
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

// PUT /api/absensi/pair/:id  → edit satu paket absensi (Masuk + optional Keluar)
router.put('/absensi/pair/:id', async (req, res) => {
    try {
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
        if (shiftCode) {
            const listKeluar = await q(
                `SELECT *
                 FROM table_absensi
                 WHERE nrp = ?
                   AND tanggal = ?
                   AND shift_code = ?
                   AND kategori LIKE 'Keluar%'
                 ORDER BY jam ASC
                 LIMIT 1`,
                [masuk.nrp, masuk.tanggal, shiftCode]
            );
            keluar = listKeluar[0] || null;
        } else {
            const katKeluar = pasanganKeluar(masuk.kategori || '');
            if (katKeluar) {
                const listKeluar = await q(
                    `SELECT *
                     FROM table_absensi
                     WHERE nrp = ?
                       AND tanggal = ?
                       AND kategori = ?
                     ORDER BY jam ASC
                     LIMIT 1`,
                    [masuk.nrp, masuk.tanggal, katKeluar]
                );
                keluar = listKeluar[0] || null;
            }
        }

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
                    [tanggal, jamKeluar, keluar.id]
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
                        tanggal,
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

        let whereSql = '';
        let params = [];

        if (shiftCode) {
            // Paket berdasarkan shift_code
            whereSql = `nrp = ? AND tanggal = ? AND shift_code = ?`;
            params = [base.nrp, base.tanggal, shiftCode];
        } else {
            // Paket berdasarkan pasangan kategori
            const kat = base.kategori || '';
            if (kat.startsWith('Masuk')) {
                const katKeluar = pasanganKeluar(kat);
                if (katKeluar) {
                    whereSql = `nrp = ? AND tanggal = ? AND kategori IN (?,?)`;
                    params = [base.nrp, base.tanggal, kat, katKeluar];
                } else {
                    whereSql = `id = ?`;
                    params = [base.id];
                }
            } else if (kat.startsWith('Keluar')) {
                const katMasuk = pasanganMasuk(kat);
                if (katMasuk) {
                    whereSql = `nrp = ? AND tanggal = ? AND kategori IN (?,?)`;
                    params = [base.nrp, base.tanggal, katMasuk, kat];
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
