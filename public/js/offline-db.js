/**
 * offline-db.js — Wrapper IndexedDB untuk absensi offline-first
 *
 * Stores:
 *  - embeddings   : { nrp, emb: Float32Array }  (sample wajah untuk matching)
 *  - profiles     : { nrp, nama, dep, divisi, jabatan, status }
 *  - config       : { key, value }  (threshold, margin, kategori, shiftRules)
 *  - pending      : { id, nrp, kategori, tanggal, jam, frameBase64, sync_status, created_at }
 *  - meta         : { key, value }  (lastSyncAt, embMaxAt, profileMaxAt, session)
 */
const OfflineDB = (function () {
    const DB_NAME = 'okt-face-offline';
    const DB_VERSION = 2;

    let _db = null;

    function open() {
        return new Promise((resolve, reject) => {
            if (_db) return resolve(_db);
            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db = e.target.result;

                if (!db.objectStoreNames.contains('embeddings')) {
                    const store = db.createObjectStore('embeddings', { keyPath: 'id', autoIncrement: true });
                    store.createIndex('nrp', 'nrp', { unique: false });
                } else {
                    const store = e.target.transaction.objectStore('embeddings');
                    if (!store.indexNames.contains('nrp')) {
                        store.createIndex('nrp', 'nrp', { unique: false });
                    }
                }
                if (!db.objectStoreNames.contains('profiles')) {
                    const store = db.createObjectStore('profiles', { keyPath: 'nrp' });
                    store.createIndex('nama', 'nama', { unique: false });
                }
                if (!db.objectStoreNames.contains('config')) {
                    db.createObjectStore('config', { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains('pending')) {
                    const store = db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
                    store.createIndex('sync_status', 'sync_status', { unique: false });
                    store.createIndex('nrp_tanggal_kategori', ['nrp', 'tanggal', 'kategori'], { unique: false });
                } else {
                    const store = e.target.transaction.objectStore('pending');
                    if (!store.indexNames.contains('sync_status')) {
                        store.createIndex('sync_status', 'sync_status', { unique: false });
                    }
                    if (!store.indexNames.contains('nrp_tanggal_kategori')) {
                        store.createIndex('nrp_tanggal_kategori', ['nrp', 'tanggal', 'kategori'], { unique: false });
                    }
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            };

            req.onsuccess = (e) => {
                _db = e.target.result;
                _db.onversionchange = () => {
                    _db.close();
                    _db = null;
                };
                resolve(_db);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    function tx(storeName, mode = 'readonly') {
        return open().then(db => db.transaction(storeName, mode).objectStore(storeName));
    }

    // --- Generic helpers ---
    function putAll(storeName, items) {
        return open().then(db => {
            return new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                store.clear();
                for (const item of (items || [])) {
                    store.put(item);
                }
                tx.oncomplete = () => resolve((items || []).length);
                tx.onerror = () => reject(tx.error);
            });
        });
    }

    function getAll(storeName) {
        return tx(storeName).then(store => {
            return new Promise((resolve, reject) => {
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        });
    }

    function put(storeName, item) {
        return open().then(db => {
            return new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                tx.objectStore(storeName).put(item);
                tx.oncomplete = () => resolve(item);
                tx.onerror = () => reject(tx.error);
            });
        });
    }

    function get(storeName, key) {
        return tx(storeName).then(store => {
            return new Promise((resolve, reject) => {
                const req = store.get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        });
    }

    function del(storeName, key) {
        return open().then(db => {
            return new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                tx.objectStore(storeName).delete(key);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        });
    }

    function clear(storeName) {
        return open().then(db => {
            return new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                tx.objectStore(storeName).clear();
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        });
    }

    function count(storeName) {
        return tx(storeName).then(store => {
            return new Promise((resolve, reject) => {
                const req = store.count();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        });
    }

    // --- Meta helpers ---
    async function getMeta(key) {
        const row = await get('meta', key);
        return row ? row.value : null;
    }
    async function setMeta(key, value) {
        return put('meta', { key, value });
    }

    // --- Config helpers ---
    async function getConfig(key) {
        const row = await get('config', key);
        return row ? row.value : null;
    }
    async function setConfig(key, value) {
        return put('config', { key, value });
    }

    // --- Embeddings bulk replace ---
    async function replaceEmbeddings(embeddings) {
        // embeddings: [{ nrp, emb: [128 floats] }]
        // Simpan sebagai { nrp, emb: Float32Array } untuk matching cepat
        const items = (embeddings || []).map(e => ({
            nrp: e.nrp,
            emb: e.emb // simpan sebagai array biasa (JSON-compatible), convert ke Float32Array saat matching
        }));
        return putAll('embeddings', items);
    }

    async function getAllEmbeddings() {
        return getAll('embeddings');
    }

    // --- Profiles bulk replace ---
    async function replaceProfiles(profiles) {
        return putAll('profiles', profiles);
    }
    async function getProfile(nrp) {
        return get('profiles', nrp);
    }

    // --- Pending absensi ---
    //
    // CATATAN MEMORI: setiap baris `pending` membawa `frameBase64` (foto absensi).
    // Semua akses di bawah ini WAJIB lewat index/cursor, jangan `getAll('pending')`,
    // karena getAll menarik seluruh foto ke memori sekaligus dan itulah penyebab
    // renderer Chrome crash ("Aw, Snap") begitu antrian menumpuk.

    async function addPending(item) {
        // item: { nrp, kategori, tanggal, jam, frameBase64 }
        const row = {
            ...item,
            sync_status: 'pending',
            attempts: 0,
            created_at: new Date().toISOString()
        };
        return put('pending', row);
    }

    /**
     * Ambil maksimal `limit` baris berstatus 'pending' (urut id = kronologis).
     * Dipakai untuk upload per-batch supaya body request tidak menembus limit server.
     */
    async function getPendingBatch(limit = 5) {
        const store = await tx('pending');
        return new Promise((resolve, reject) => {
            const out = [];
            const req = store.index('sync_status').openCursor(IDBKeyRange.only('pending'));
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor || out.length >= limit) return resolve(out);
                out.push(cursor.value);
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    /** Hitung antrian lewat index — tidak menyentuh body/foto sama sekali. */
    async function getPendingCount() {
        const store = await tx('pending');
        return new Promise((resolve, reject) => {
            const req = store.index('sync_status').count(IDBKeyRange.only('pending'));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function updatePendingRow(id, mutate) {
        return open().then(db => new Promise((resolve, reject) => {
            const t = db.transaction('pending', 'readwrite');
            const req = t.objectStore('pending').openCursor(IDBKeyRange.only(id));
            let result = null;
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                result = mutate({ ...cursor.value });
                if (result) cursor.update(result);
            };
            t.oncomplete = () => resolve(result);
            t.onerror = () => reject(t.error);
        }));
    }

    async function updatePendingStatus(id, status) {
        return updatePendingRow(id, (row) => ({ ...row, sync_status: status }));
    }

    /**
     * Tandai gagal permanen. Foto dibuang sekaligus: baris ini tidak akan pernah
     * dikirim ulang, jadi menahan base64-nya cuma memakan memori & storage.
     */
    async function markPendingFailed(id) {
        return updatePendingRow(id, (row) => ({
            ...row,
            sync_status: 'failed',
            frameBase64: null,
            failed_at: new Date().toISOString()
        }));
    }

    /** Naikkan counter percobaan; kembalikan jumlah percobaan terbaru. */
    async function bumpPendingAttempt(id) {
        const row = await updatePendingRow(id, (r) => ({
            ...r,
            attempts: Number(r.attempts || 0) + 1
        }));
        return row ? Number(row.attempts || 0) : 0;
    }

    async function deletePending(id) {
        return del('pending', id);
    }

    /**
     * Buang baris 'failed' yang sudah lewat `maxAgeDays`. Tanpa ini store `pending`
     * hanya bisa membesar seumur hidup instalasi PWA.
     */
    async function purgeFailedPending(maxAgeDays = 7) {
        const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        const db = await open();
        return new Promise((resolve, reject) => {
            const t = db.transaction('pending', 'readwrite');
            const req = t.objectStore('pending').index('sync_status').openCursor(IDBKeyRange.only('failed'));
            let removed = 0;
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                const stamp = Date.parse(cursor.value.failed_at || cursor.value.created_at || '');
                if (!Number.isFinite(stamp) || stamp < cutoff) {
                    cursor.delete();
                    removed++;
                }
                cursor.continue();
            };
            t.oncomplete = () => resolve(removed);
            t.onerror = () => reject(t.error);
        });
    }

    /**
     * Cek anti-dobel lokal lewat index gabungan [nrp, tanggal, kategori].
     * Foto sengaja tidak ikut dikembalikan — pemanggil hanya butuh cek keberadaan.
     */
    async function getPendingByNrpTanggalKategori(nrp, tanggal, kategori) {
        const store = await tx('pending');
        return new Promise((resolve, reject) => {
            const range = IDBKeyRange.only([nrp, tanggal, kategori]);
            const req = store.index('nrp_tanggal_kategori').openCursor(range);
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return resolve(undefined);
                const row = cursor.value;
                if (row.sync_status !== 'failed') {
                    const { frameBase64, ...rest } = row;
                    return resolve(rest);
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    return {
        open,
        // generic
        getAll, put, get, del, clear, count,
        // meta
        getMeta, setMeta,
        // config
        getConfig, setConfig,
        // embeddings
        replaceEmbeddings, getAllEmbeddings,
        // profiles
        replaceProfiles, getProfile,
        // pending
        addPending, getPendingBatch, getPendingCount,
        updatePendingStatus, markPendingFailed, bumpPendingAttempt,
        deletePending, purgeFailedPending, getPendingByNrpTanggalKategori
    };
})();
