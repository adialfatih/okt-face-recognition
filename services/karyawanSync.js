const { hrq, q } = require("../db");

async function syncKaryawan() {
    try {
        // Ambil karyawan dari HR (status_io = 1)
        const rows = await hrq(`
            SELECT nrp, nama, departement AS dep, divisi, jabatan
            FROM data_karyawan
            WHERE status_io = '1'
        `);

        for (const r of rows) {
            await q(`
                INSERT INTO table_karyawan (nrp, nama, dep, divisi, jabatan, status)
                VALUES (?,?,?,?,?,1)
                ON DUPLICATE KEY UPDATE
                  nama = VALUES(nama),
                  dep = VALUES(dep),
                  divisi = VALUES(divisi),
                  jabatan = VALUES(jabatan),
                  status = VALUES(status)
            `, [r.nrp, r.nama, r.dep, r.divisi, r.jabatan]);
        }

        return { ok: true, synced: rows.length };
    } catch (e) {
        console.error("[syncKaryawan] ERROR:", e);
        return { ok: false, error: e.message };
    }
}

module.exports = { syncKaryawan };
