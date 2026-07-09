/**
 * sync-manager.js — Sinkronisasi data offline-first
 *
 * Tugas:
 *  1. Download embeddings + profiles + config dari server → IndexedDB
 *  2. Upload pending absensi (offline) → server (server menang)
 *  3. Cek online/offline status
 *  4. Auto-sync saat online (event listener)
 */
const SyncManager = (function () {

    let _isOnline = navigator.onLine;
    let _syncing = false;
    let _onStatusChange = null; // callback(status)

    function setStatus(status) {
        if (_onStatusChange) _onStatusChange(status);
    }

    /**
     * Cek apakah server reachable (health check).
     * navigator.onLine tidak selalu akurat di semua browser.
     */
    async function checkServer() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
            const resp = await fetch('/api/health', {
                method: 'GET',
                cache: 'no-store',
                signal: controller.signal
            });
            if (!resp.ok) return false;
            const data = await resp.json();
            return data.ok === true;
        } catch (e) {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Cek online/offline dengan fallback ke health check.
     */
    async function isOnline() {
        if (!navigator.onLine) return false;
        return await checkServer();
    }

    /**
     * Download data master (embeddings + profiles + config) dari server.
     * Full sync — ganti semua data lokal.
     */
    async function downloadDataMaster() {
        setStatus('downloading');
        try {
            const resp = await fetch('/api/sync/data', {
                method: 'GET',
                cache: 'no-store'
            });
            if (!resp.ok) throw new Error('sync-data-failed');
            const data = await resp.json();
            if (!data.ok) throw new Error('sync-data-error');

            // 1) Simpan embeddings
            await OfflineDB.replaceEmbeddings(data.embeddings || []);

            // 2) Simpan profiles
            await OfflineDB.replaceProfiles(data.profiles || []);

            // 3) Simpan config
            if (data.config) {
                await OfflineDB.setConfig('threshold', data.config.threshold);
                await OfflineDB.setConfig('marginMin', data.config.marginMin);
                await OfflineDB.setConfig('kategori', data.config.kategori);
                await OfflineDB.setConfig('shiftRules', data.config.shiftRules);
            }

            // 4) Update meta
            await OfflineDB.setMeta('lastSyncAt', data.syncedAt);
            await OfflineDB.setMeta('embCount', (data.embeddings || []).length);
            await OfflineDB.setMeta('profileCount', (data.profiles || []).length);

            // 5) Invalidate cache matching supaya reload dari IndexedDB
            OfflineMatch.invalidate();
            await OfflineMatch.loadEmbeddings();

            setStatus('downloaded');
            return { ok: true, embCount: (data.embeddings || []).length, profileCount: (data.profiles || []).length };
        } catch (e) {
            console.error('[sync] downloadDataMaster fail:', e);
            setStatus('error');
            return { ok: false, error: e.message };
        }
    }

    /**
     * Upload pending absensi ke server (batch).
     * Server menang: first-write-wins, duplicate diabaikan.
     */
    async function uploadPending() {
        if (_syncing) return { ok: false, reason: 'already-syncing' };
        _syncing = true;
        setStatus('uploading');
        try {
            const pending = await OfflineDB.getPending();
            const toSync = pending.filter(p => p.sync_status === 'pending');
            if (toSync.length === 0) {
                setStatus('idle');
                _syncing = false;
                return { ok: true, synced: 0 };
            }

            const items = toSync.map(p => ({
                clientId: String(p.id),
                nrp: p.nrp,
                kategori: p.kategori,
                tanggal: p.tanggal,
                jam: p.jam,
                frameBase64: p.frameBase64 || null
            }));

            const resp = await fetch('/api/absen/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items })
            });
            if (!resp.ok) throw new Error('upload-http-failed');
            const data = await resp.json();

            if (!data.ok) throw new Error('upload-failed');

            // Proses hasil per item
            let syncedCount = 0;
            for (const r of data.results || []) {
                const id = parseInt(r.clientId, 10);
                if (!id) continue;
                if (r.ok) {
                    // Sukses → hapus dari pending
                    await OfflineDB.deletePending(id);
                    syncedCount++;
                } else if (r.reason === 'duplicate') {
                    // Server menang → hapus dari pending (sudah ada di server)
                    await OfflineDB.deletePending(id);
                    syncedCount++;
                } else {
                    // Gagal (no-profile, inactive, error) → tandai failed
                    await OfflineDB.updatePendingStatus(id, 'failed');
                }
            }

            setStatus('uploaded');
            _syncing = false;
            return { ok: true, synced: syncedCount, total: toSync.length };
        } catch (e) {
            console.error('[sync] uploadPending fail:', e);
            setStatus('error');
            _syncing = false;
            return { ok: false, error: e.message };
        }
    }

    /**
     * Full sync: download data master + upload pending.
     */
    async function fullSync() {
        const online = await isOnline();
        if (!online) {
            setStatus('offline');
            return { ok: false, reason: 'offline' };
        }

        // 1) Upload pending dulu (prioritas: data absen jangan hilang)
        await uploadPending();
        setStatus('online');

        // 2) Download data master
        const dl = await downloadDataMaster();

        return { ok: true, download: dl };
    }

    /**
     * Init: setup event listeners + auto-sync saat online.
     */
    function init(onStatusChange) {
        _onStatusChange = onStatusChange;

        window.addEventListener('online', async () => {
            _isOnline = true;
            setStatus('online');
            // Auto-sync saat kembali online
            await fullSync();
        });

        window.addEventListener('offline', () => {
            _isOnline = false;
            setStatus('offline');
        });

        // Initial status
        setStatus(_isOnline ? 'online' : 'offline');
    }

    return {
        isOnline,
        checkServer,
        downloadDataMaster,
        uploadPending,
        fullSync,
        init
    };
})();
