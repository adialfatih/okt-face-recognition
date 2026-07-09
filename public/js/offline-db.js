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
    async function addPending(item) {
        // item: { nrp, kategori, tanggal, jam, frameBase64 }
        const row = {
            ...item,
            sync_status: 'pending',
            created_at: new Date().toISOString()
        };
        return put('pending', row);
    }

    async function getPending() {
        const rows = await getAll('pending');
        return rows.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    }

    async function getPendingCount() {
        const rows = await getAll('pending');
        return rows.filter(p => p.sync_status === 'pending').length;
    }

    async function updatePendingStatus(id, status) {
        const item = await get('pending', id);
        if (!item) return;
        item.sync_status = status;
        return put('pending', item);
    }

    async function deletePending(id) {
        return del('pending', id);
    }

    async function getPendingByNrpTanggalKategori(nrp, tanggal, kategori) {
        // Cek anti-dobel lokal
        const all = await getAll('pending');
        return all.find(p =>
            p.nrp === nrp &&
            p.tanggal === tanggal &&
            p.kategori === kategori &&
            p.sync_status !== 'failed'
        );
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
        addPending, getPending, getPendingCount,
        updatePendingStatus, deletePending, getPendingByNrpTanggalKategori
    };
})();
