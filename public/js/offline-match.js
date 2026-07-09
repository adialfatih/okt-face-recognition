/**
 * offline-match.js — Logika matching wajah di client (offline)
 *
 * Logika ini adalah port dari routes/api.js (POST /api/absen & /api/match):
 *  - Euclidean distance
 *  - Best & second-best per NRP
 *  - Threshold + margin check
 *
 * Embeddings diambil dari IndexedDB (OfflineDB), dikonversi ke Float32Array
 * untuk performa.
 */
const OfflineMatch = (function () {

    let _embCache = null; // [{ nrp, emb: Float32Array }]
    let _embReady = false;

    function euclideanDistance(a, b) {
        let s = 0;
        for (let i = 0; i < a.length; i++) {
            const d = a[i] - b[i];
            s += d * d;
        }
        return Math.sqrt(s);
    }

    /**
     * Muat embeddings dari IndexedDB ke cache in-memory (Float32Array).
     * Dipanggil sekali saat halaman absensi dibuka.
     */
    async function loadEmbeddings() {
        const rows = await OfflineDB.getAllEmbeddings();
        _embCache = rows.map(r => ({
            nrp: r.nrp,
            emb: r.emb instanceof Float32Array ? r.emb : Float32Array.from(r.emb)
        }));
        _embReady = true;
        return _embCache.length;
    }

    function isReady() {
        return _embReady && _embCache && _embCache.length > 0;
    }

    function invalidate() {
        _embCache = null;
        _embReady = false;
    }

    /**
     * Cari match terbaik dari daftar descriptors.
     * Logika sama persis dengan /api/match & /api/absen di server.
     *
     * @param {number[][]} descriptors - array of 128-float descriptors
     * @param {number} threshold - FACE_DISTANCE_THRESHOLD (default 0.45)
     * @param {number} marginMin - FACE_MARGIN_MIN (default 0.05)
     * @returns {Promise<{match: object|null, bestDist: number, secondDist?: number, reason?: string}>}
     */
    async function findBestMatch(descriptors, threshold = 0.45, marginMin = 0.05) {
        if (!_embReady) {
            await loadEmbeddings();
        }
        if (!_embCache || _embCache.length === 0) {
            return { match: null, bestDist: 9e9, reason: 'no-embeddings' };
        }
        if (!Array.isArray(descriptors) || descriptors.length === 0) {
            return { match: null, bestDist: 9e9, reason: 'no-descriptors' };
        }

        const descArr = descriptors.map(d => d instanceof Float32Array ? d : Float32Array.from(d));

        const bestByNRP = new Map();
        for (const e of _embCache) {
            for (const d of descArr) {
                const dist = euclideanDistance(e.emb, d);
                const prev = bestByNRP.get(e.nrp);
                if (prev === undefined || dist < prev) {
                    bestByNRP.set(e.nrp, dist);
                }
            }
        }

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

        if (!best.nrp || best.dist > threshold) {
            return { match: null, bestDist: best.dist, reason: 'unknown' };
        }

        if (second.nrp && (second.dist - best.dist) < marginMin) {
            return { match: null, bestDist: best.dist, secondDist: second.dist, reason: 'ambiguous' };
        }

        return { match: { nrp: best.nrp, dist: best.dist }, bestDist: best.dist, reason: 'ok' };
    }

    return {
        loadEmbeddings,
        isReady,
        invalidate,
        findBestMatch,
        euclideanDistance
    };
})();
