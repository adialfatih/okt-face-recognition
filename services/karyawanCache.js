const dayjs = require('dayjs');
const { q, hrq } = require('../db');

const TTL_MIN = Number(process.env.KARYAWAN_CACHE_TTL_MIN || 0);
const ACTIVE_STATUSES = new Set(['KONTRAK', 'TETAP', 'MAGANG']);

function mapHRtoCache(r) {
    return {
        nrp: r.nrp,
        idkar: r.idkar ?? null,
        nama: r.nama,
        departement: r.departement,
        divisi: r.divisi,
        jabatan: r.jabatan,
        status: r.status,
        tmt: r.tmt ?? null
    };
}
function mapCacheToUI(r) {
    return {
        nrp: r.nrp,
        nama: r.nama,
        dep: r.departement,        // UI pakai 'dep'
        divisi: r.divisi,
        jabatan: r.jabatan,
        status: r.status
    };
}

async function getFromCache(nrp) {
    const rows = await q('SELECT * FROM table_karyawan_cache WHERE nrp=? LIMIT 1', [nrp]);
    if (!rows.length) return null;
    const r = rows[0];
    if (TTL_MIN > 0) {
        const age = dayjs().diff(dayjs(r.updated_at), 'minute');
        if (age > TTL_MIN) return { ...r, __expired: true };
    }
    return r;
}

async function upsertCache(obj) {
    await q(`
    INSERT INTO table_karyawan_cache
      (nrp, idkar, nama, departement, divisi, jabatan, status, tmt, updated_at)
    VALUES (?,?,?,?,?,?,?,?, NOW())
    ON DUPLICATE KEY UPDATE
      idkar=VALUES(idkar),
      nama=VALUES(nama),
      departement=VALUES(departement),
      divisi=VALUES(divisi),
      jabatan=VALUES(jabatan),
      status=VALUES(status),
      tmt=VALUES(tmt),
      updated_at=NOW()
  `, [obj.nrp, obj.idkar, obj.nama, obj.departement, obj.divisi, obj.jabatan, obj.status, obj.tmt]);
}

async function fetchFromHR(nrp) {
    const rows = await hrq(`
    SELECT idkar, nrp, nama, departement, divisi, jabatan, status, tmt
    FROM data_karyawan WHERE nrp=? LIMIT 1
  `, [nrp]);
    if (!rows.length) return null;
    const r = rows[0];
    return mapHRtoCache(r);
}

async function ensureInCache(nrp) {
    let c = await getFromCache(nrp);
    if (c && !c.__expired) return c;

    const hr = await fetchFromHR(nrp);
    if (!hr) return c || null;
    await upsertCache(hr);
    return await getFromCache(nrp);
}

async function fullSyncFromHR() {
    const rows = await hrq(`
    SELECT idkar, nrp, nama, departement, divisi, jabatan, status, tmt
    FROM data_karyawan
    WHERE status IN ('KONTRAK','TETAP','MAGANG')
  `);
    if (!rows.length) return { upserted: 0 };
    // Bulk upsert (loop cukup; data aktif biasanya ratusan–ribuan)
    let n = 0;
    for (const r of rows) {
        await upsertCache(mapHRtoCache(r));
        n++;
    }
    return { upserted: n };
}

async function invalidateNRP(nrp) {
    await q('DELETE FROM table_karyawan_cache WHERE nrp=?', [nrp]);
    return { ok: true };
}

module.exports = {
    mapCacheToUI, ensureInCache, fetchFromHR, upsertCache, fullSyncFromHR, invalidateNRP, ACTIVE_STATUSES
};
