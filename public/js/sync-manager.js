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
                cache: 'no-store',
                credentials: 'same-origin'
            });
            // Login offline tidak punya sesi server — data master memang hanya bisa
            // di-refresh setelah login online. Bukan error yang perlu diteriakkan.
            if (resp.status === 401) {
                setStatus('idle');
                return { ok: false, reason: 'unauthorized' };
            }
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
            // Token untuk POST /api/absen/sync saat device tidak punya sesi server
            // (mis. dibuka dari cache saat offline lalu jaringan kembali).
            if (data.syncToken) await OfflineDB.setMeta('syncToken', data.syncToken);
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

    // Kirim per-batch kecil. Dulu SELURUH antrian dikirim dalam satu request; begitu
    // antrian melewati ~10MB (limit express.json di server) request selalu dibalas 413,
    // tidak ada satu pun baris terhapus, dan antrian macet permanen sambil terus tumbuh.
    const UPLOAD_BATCH_SIZE = 5;
    const MIN_BATCH_SIZE = 1;
    const MAX_UPLOAD_ATTEMPTS = 3;

    // Alasan yang tidak akan pernah berubah kalau dicoba ulang → langsung tandai gagal.
    const PERMANENT_FAIL_REASONS = new Set(['no-profile', 'inactive', 'invalid-kategori', 'invalid-time']);

    /**
     * Upload pending absensi ke server, per-batch.
     * Server menang: first-write-wins, duplicate diabaikan.
     */
    async function uploadPending() {
        if (_syncing) return { ok: false, reason: 'already-syncing' };
        _syncing = true;
        setStatus('uploading');

        let batchSize = UPLOAD_BATCH_SIZE;
        let syncedCount = 0;
        let totalCount = 0;

        try {
            await OfflineDB.purgeFailedPending(7).catch(() => { });

            const headers = { 'Content-Type': 'application/json' };
            const syncToken = await OfflineDB.getMeta('syncToken').catch(() => null);
            if (syncToken) headers['Authorization'] = 'Bearer ' + syncToken;

            // Guard: tiap iterasi wajib membuat progres (hapus baris, tandai failed,
            // atau naikkan attempts sampai batas). Batas iterasi hanya jaring pengaman.
            for (let guard = 0; guard < 500; guard++) {
                const batch = await OfflineDB.getPendingBatch(batchSize);
                if (batch.length === 0) break;

                const items = batch.map(p => ({
                    clientId: String(p.id),
                    nrp: p.nrp,
                    kategori: p.kategori,
                    tanggal: p.tanggal,
                    jam: p.jam,
                    frameBase64: p.frameBase64 || null
                }));

                const resp = await fetch('/api/absen/sync', {
                    method: 'POST',
                    headers,
                    credentials: 'same-origin',
                    body: JSON.stringify({ items })
                });

                // Tidak ada sesi & token kosong/kedaluwarsa: antrian dibiarkan utuh,
                // akan terkirim setelah operator login online lagi.
                if (resp.status === 401) {
                    setStatus('idle');
                    return { ok: false, reason: 'unauthorized', synced: syncedCount };
                }

                // 413 = payload terlalu besar. Kecilkan batch dan coba lagi; kalau
                // satu item saja masih kebesaran, item itu tidak akan pernah bisa
                // dikirim → tandai gagal supaya tidak mengunci antrian.
                if (resp.status === 413) {
                    if (batchSize > MIN_BATCH_SIZE) {
                        batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2));
                        continue;
                    }
                    console.warn('[sync] item terlalu besar, ditandai gagal:', batch[0].id);
                    await OfflineDB.markPendingFailed(batch[0].id);
                    continue;
                }

                if (!resp.ok) throw new Error('upload-http-' + resp.status);
                const data = await resp.json();
                if (!data.ok) throw new Error('upload-failed');

                totalCount += batch.length;
                const seen = new Set();

                for (const r of data.results || []) {
                    const id = parseInt(r.clientId, 10);
                    if (!id) continue;
                    seen.add(id);

                    if (r.ok || r.reason === 'duplicate') {
                        // Sukses, atau server sudah punya datanya → hapus dari antrian.
                        await OfflineDB.deletePending(id);
                        syncedCount++;
                    } else if (PERMANENT_FAIL_REASONS.has(r.reason)) {
                        await OfflineDB.markPendingFailed(id);
                    } else {
                        // Error sementara → coba lagi nanti, sampai batas percobaan.
                        const attempts = await OfflineDB.bumpPendingAttempt(id);
                        if (attempts >= MAX_UPLOAD_ATTEMPTS) await OfflineDB.markPendingFailed(id);
                    }
                }

                // Item yang tidak dibalas server sama sekali juga harus maju,
                // kalau tidak batch yang sama akan diambil ulang tanpa henti.
                for (const p of batch) {
                    if (seen.has(p.id)) continue;
                    const attempts = await OfflineDB.bumpPendingAttempt(p.id);
                    if (attempts >= MAX_UPLOAD_ATTEMPTS) await OfflineDB.markPendingFailed(p.id);
                }
            }

            setStatus(syncedCount > 0 ? 'uploaded' : 'idle');
            return { ok: true, synced: syncedCount, total: totalCount };
        } catch (e) {
            console.error('[sync] uploadPending fail:', e);
            setStatus('error');
            return { ok: false, error: e.message, synced: syncedCount };
        } finally {
            _syncing = false;
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
