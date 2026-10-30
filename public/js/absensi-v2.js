/**
 * absensi-v2.js — Absensi multi-wajah (UJI COBA)
 *
 * Berbeda dengan absensi.js (v1, 1 wajah per absensi + tutup putih lingkaran):
 *  - Satu frame bisa berisi sampai MAX_FACES wajah sekaligus.
 *  - Tiap wajah dilacak antar-frame (IoU kotak) supaya punya identitas tetap,
 *    lalu dikumpulkan 2–3 descriptor per wajah sebelum diputuskan.
 *  - Kandidat dicocokkan dulu secara lokal (OfflineMatch, data dari IndexedDB);
 *    wajah tak dikenal tidak dikirim ke server sama sekali.
 *  - Yang cocok dikirim per orang ke POST /api/absen (server tetap memverifikasi
 *    ulang & menolak dobel). Offline → antrian IndexedDB seperti v1.
 *  - Kotak MERAH = belum terkonfirmasi, HIJAU + nama = sudah tercatat.
 *  - NRP yang sudah tercatat tidak dikirim ulang selama NRP_COOLDOWN_MS.
 *
 * Data dari halaman ini ditandai source 'web-v2' / 'offline-sync-v2'.
 */
(async function () {
    const video = document.getElementById('video');
    const canvas = document.getElementById('overlay');
    const statusBar = document.getElementById('v2Status');
    const notice = document.getElementById('v2Notice');
    const historyList = document.getElementById('v2History');
    const historyCount = document.getElementById('v2Count');
    const btnSwitch = document.getElementById('btnSwitchCam');
    const kategori = (window.__KATEGORI__ || '').trim();
    const sndOk = new Audio('/public/ping.mp3');
    const sndErr = new Audio('/public/error.mp3');

    // ==== KONFIGURASI ====
    const MAX_FACES = 5;
    const NRP_COOLDOWN_MS = 2 * 60 * 1000;   // jeda kirim ulang per NRP
    const DET_MS = 220;                      // throttle loop deteksi
    // inputSize lebih besar dari v1 (256) supaya wajah yang lebih kecil/jauh
    // (beberapa orang dalam satu frame) tetap terdeteksi.
    const DET_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });

    // Quality gate per wajah. Lebih longgar dari v1 (min 20% tinggi frame)
    // karena beberapa orang harus muat di frame yang sama.
    const MIN_DET_SCORE = 0.6;
    const MIN_FACE_REL_HEIGHT = 0.10;
    const MAX_FACE_REL_HEIGHT = 0.90;

    const MIN_SAMPLES = 2;
    const MAX_SAMPLES = 3;
    const SAMPLE_GAP_MS = 150;              // jarak minimal antar sampel satu wajah
    const TRACK_TTL_MS = 1200;              // wajah hilang selama ini → track dibuang
    const TRACK_IOU_MIN = 0.3;
    const SERVER_RETRY_MS = 3000;           // jeda coba lagi setelah ditolak server
    const FULL_SCAN_EVERY = 5;              // tiap N tick tetap hitung descriptor (verifikasi ulang)

    const SOURCE_ONLINE = 'web-v2';
    const SOURCE_OFFLINE = 'offline-sync-v2';
    const ACTIVE_STATUSES = new Set(['TETAP', 'KONTRAK', 'MAGANG']);

    const COLOR_OK = '#22c55e';
    const COLOR_WAIT = '#ef4444';

    if (!kategori) {
        showNotice('Kategori absensi tidak ada. Kembali ke menu Absensi v2.', 'error', 0);
        return;
    }

    // ==== OFFLINE-FIRST INIT (sama seperti v1) ====
    let _isOnline = true;
    let _sessionExpired = false;
    let _threshold = 0.45;
    let _marginMin = 0.05;
    let _offlineReady = false;

    try {
        if (typeof OfflineDB === 'undefined' || typeof OfflineMatch === 'undefined' || typeof SyncManager === 'undefined') {
            throw new Error('offline-scripts-not-loaded');
        }
        await OfflineDB.open();
        const t = await OfflineDB.getConfig('threshold');
        const m = await OfflineDB.getConfig('marginMin');
        if (t) _threshold = t;
        if (m) _marginMin = m;

        await OfflineMatch.loadEmbeddings();

        SyncManager.init((status) => {
            if (status === 'offline') _isOnline = false;
            else if (status === 'online') _isOnline = true;
            renderStatus();
        });

        _isOnline = await SyncManager.isOnline();
        renderStatus();

        if (_isOnline) {
            SyncManager.fullSync()
                .then(async (r) => {
                    if (r?.download?.reason === 'unauthorized') _sessionExpired = true;
                    // Config bisa berubah setelah download data master.
                    const t2 = await OfflineDB.getConfig('threshold');
                    const m2 = await OfflineDB.getConfig('marginMin');
                    if (t2) _threshold = t2;
                    if (m2) _marginMin = m2;
                    renderStatus();
                })
                .catch(e => console.warn('[v2] initial sync fail:', e));
        }
        _offlineReady = true;
    } catch (e) {
        console.warn('[v2] offline init fail, online-only:', e);
    }

    function localMatchReady() {
        return _offlineReady && typeof OfflineMatch !== 'undefined' && OfflineMatch.isReady();
    }

    // ==== STATUS BAR ====
    async function renderStatus() {
        if (!statusBar) return;
        const parts = [];
        if (!_isOnline) {
            parts.push('<span class="badge badge-warning gap-1 text-xs"><i class="fa-solid fa-wifi-slash"></i> Offline</span>');
        } else if (_sessionExpired) {
            parts.push('<span class="badge badge-warning gap-1 text-xs"><i class="fa-solid fa-user-clock"></i> Sesi habis — disimpan di device, login ulang untuk sinkron</span>');
        } else {
            parts.push('<span class="badge badge-success gap-1 text-xs"><i class="fa-solid fa-wifi"></i> Online</span>');
        }
        try {
            if (typeof OfflineDB !== 'undefined') {
                const [embCount, profileCount, pendingCount] = await Promise.all([
                    OfflineDB.getMeta('embCount'),
                    OfflineDB.getMeta('profileCount'),
                    OfflineDB.getPendingCount()
                ]);
                const ready = Number(embCount || 0) > 0 && Number(profileCount || 0) > 0;
                parts.push(ready
                    ? `<span class="badge badge-ghost gap-1 text-xs"><i class="fa-solid fa-database"></i> ${profileCount} karyawan / ${embCount} wajah</span>`
                    : '<span class="badge badge-error gap-1 text-xs"><i class="fa-solid fa-triangle-exclamation"></i> Data wajah lokal belum siap</span>');
                if (pendingCount > 0) {
                    parts.push(`<span class="badge badge-info gap-1 text-xs"><i class="fa-solid fa-cloud-arrow-up"></i> ${pendingCount} pending</span>`);
                }
            }
        } catch (e) { }
        statusBar.innerHTML = parts.join('');
    }

    let _noticeTimer = null;
    function showNotice(text, tone = 'info', ms = 2500) {
        if (!notice) return;
        const cls = tone === 'error' ? 'bg-error/80 text-error-content'
            : tone === 'warning' ? 'bg-warning/80 text-warning-content'
                : 'bg-base-100/80';
        notice.innerHTML = text
            ? `<span class="inline-block rounded-box px-2 py-1 shadow backdrop-blur-sm ${cls}">${text}</span>`
            : '';
        clearTimeout(_noticeTimer);
        if (text && ms > 0) _noticeTimer = setTimeout(() => { notice.innerHTML = ''; }, ms);
    }

    // ==== SUARA ====
    // Hanya efek suara (ping/error). Ucapan nama (TTS) sengaja tidak dipakai di v2:
    // beberapa orang bisa tercatat bersamaan dan ucapan jadi menumpuk.
    function play(snd) {
        try { snd.currentTime = 0; snd.play(); } catch (e) { }
    }

    // ==== RIWAYAT SESI ====
    let _historyN = 0;
    function addHistory(m, status, extra = {}) {
        if (!historyList) return;
        if (_historyN === 0) historyList.innerHTML = '';
        _historyN++;
        if (historyCount) historyCount.textContent = String(_historyN);
        const now = new Date();
        const jam = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
        const badge = status === 'ok'
            ? `<span class="badge badge-success badge-xs">${extra.offline ? 'offline' : 'tercatat'}</span>`
            : '<span class="badge badge-warning badge-xs">sudah absen</span>';
        const late = extra.is_late ? ` <span class="badge badge-error badge-xs">terlambat ${extra.menit_terlambat || ''}m</span>` : '';
        const li = document.createElement('li');
        li.className = 'py-1.5 flex items-center justify-between gap-2';
        li.innerHTML = `
          <div class="min-w-0">
            <div class="font-medium truncate">${escapeHtml(m.nama || m.nrp)}</div>
            <div class="text-slate-500">${escapeHtml(m.nrp || '')} · ${escapeHtml(m.jabatan || '-')}</div>
          </div>
          <div class="text-right shrink-0">${badge}${late}<div class="text-slate-400">${jam}</div></div>`;
        historyList.prepend(li);
        while (historyList.children.length > 50) historyList.lastChild.remove();
    }
    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ==== WAKTU & TERLAMBAT (sama dengan absensi.js / server; hanya untuk tampilan offline) ====
    function pad2(n) { return String(n).padStart(2, '0'); }
    function formatLocalDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
    function formatLocalTime(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }

    function computeLateFlag(kat, now) {
        const map = { 'Masuk Shift Pagi': '06:05', 'Masuk Shift Siang': '14:05', 'Masuk Shift Malam': '22:05' };
        if (!map[kat]) return 0;
        const [h, m] = map[kat].split(':').map(Number);
        const lateAt = new Date(now);
        lateAt.setHours(h, m, 0, 0);
        return now > lateAt ? 1 : 0;
    }
    function computeLateMinutes(kat, now) {
        const startMap = { 'Masuk Shift Pagi': '06:00', 'Masuk Shift Siang': '14:00', 'Masuk Shift Malam': '22:00' };
        const startStr = startMap[kat];
        if (!startStr) return 0;
        const [h, m] = startStr.split(':').map(Number);
        let start = new Date(now);
        start.setHours(h, m, 0, 0);
        if (kat === 'Masuk Shift Malam' && now.getHours() < 6) {
            start = new Date(now);
            start.setDate(start.getDate() - 1);
            start.setHours(h, m, 0, 0);
        }
        const diffMin = Math.floor((now - start) / 60000);
        if (diffMin < 3) return 0;
        return diffMin > 0 ? diffMin : 0;
    }

    // ==== KAMERA ====
    await FaceCommon.loadModels();
    await FaceCommon.startCamera(video);

    const doSync = () => FaceCommon.syncCanvasToDisplay(video, canvas);
    video.addEventListener('loadedmetadata', doSync);
    window.addEventListener('resize', doSync);
    setTimeout(doSync, 200);

    if (btnSwitch) {
        btnSwitch.addEventListener('click', async () => {
            const cams = await FaceCommon.listCameras();
            if (!cams.length) return;
            const curId = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
            let idx = Math.max(0, cams.findIndex(c => c.deviceId === curId));
            idx = (idx + 1) % cams.length;
            await FaceCommon.switchCamera(video, cams[idx].deviceId);
            tracks.clear();
            setTimeout(doSync, 200);
        });
    }

    /** Potong area wajah (+ margin) dari frame video sebagai snapshot absensi orang itu. */
    function grabFaceCrop(box) {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh || !box) return null;
        const padX = box.width * 0.6;
        const padY = box.height * 0.7;
        const x = Math.max(0, box.x - padX);
        const y = Math.max(0, box.y - padY);
        const w = Math.min(vw - x, box.width + padX * 2);
        const h = Math.min(vh - y, box.height + padY * 2);
        if (w <= 0 || h <= 0) return null;
        const scale = Math.min(1, 480 / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        c.getContext('2d').drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
        const out = c.toDataURL('image/jpeg', 0.8);
        c.width = 0; c.height = 0;
        return out;
    }

    // ==== TRACKING ====
    // state: checking | unknown | sending | rejected | done
    const tracks = new Map();
    let _nextTrackId = 1;
    // nrp → { at, nama, sub } — NRP yang baru tercatat/ditolak permanen (cooldown).
    const recentByNrp = new Map();

    function newTrack(now) {
        const t = {
            id: _nextTrackId++,
            box: null,
            lastSeen: now,
            samples: [],
            lastSampleAt: 0,
            state: 'checking',
            label: 'Memeriksa…',
            sub: '',
            nrp: null,
            localNrp: null,
            nama: null,
            busy: false,
            verifying: false,
            retryAt: 0
        };
        tracks.set(t.id, t);
        return t;
    }

    function resetTrack(t, label = 'Memeriksa…') {
        t.state = 'checking';
        t.label = label;
        t.sub = '';
        t.samples = [];
        t.nrp = null;
        t.localNrp = null;
        t.nama = null;
    }

    function iou(a, b) {
        const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
        const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const uni = a.width * a.height + b.width * b.height - inter;
        return uni > 0 ? inter / uni : 0;
    }

    /** Pasangkan deteksi frame ini ke track yang ada (greedy IoU terbesar). */
    function assignTracks(dets, now) {
        const pairs = [];
        dets.forEach((d, i) => {
            for (const t of tracks.values()) {
                if (!t.box) continue;
                const v = iou(d.box, t.box);
                if (v >= TRACK_IOU_MIN) pairs.push({ i, t, v });
            }
        });
        pairs.sort((a, b) => b.v - a.v);
        const out = new Array(dets.length);
        const usedTracks = new Set();
        for (const p of pairs) {
            if (out[p.i] || usedTracks.has(p.t.id)) continue;
            out[p.i] = p.t;
            usedTracks.add(p.t.id);
        }
        let hasNew = false;
        dets.forEach((d, i) => {
            if (!out[i]) { out[i] = newTrack(now); hasNew = true; }
            out[i].box = d.box;
            out[i].lastSeen = now;
        });
        for (const [id, t] of tracks) {
            if (now - t.lastSeen > TRACK_TTL_MS) tracks.delete(id);
        }
        return { assigned: out, hasNew };
    }

    // ==== DETEKSI ====
    // Descriptor (landmark + recognition) mahal dan naik per jumlah wajah. Jika
    // semua wajah di frame sudah terkonfirmasi, cukup deteksi kotak saja untuk
    // melacak posisi; descriptor dihitung lagi bila ada wajah baru/belum
    // terkonfirmasi, dan berkala untuk verifikasi ulang.
    async function detect(full) {
        if (full) {
            const res = await faceapi.detectAllFaces(video, DET_OPTS).withFaceLandmarks().withFaceDescriptors();
            return res.map(r => ({ box: r.detection.box, score: r.detection.score, descriptor: r.descriptor }));
        }
        const res = await faceapi.detectAllFaces(video, DET_OPTS);
        return res.map(r => ({ box: r.box, score: r.score, descriptor: null }));
    }

    let _tick = 0;
    let _needFull = true;

    async function processFrame() {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return;
        if (!canvas.width || !canvas.height) doSync();

        _tick++;
        const full = _needFull || (_tick % FULL_SCAN_EVERY === 0);
        let dets = await detect(full);

        if (dets.length > MAX_FACES) {
            // Prioritaskan wajah terbesar (paling dekat ke kamera).
            dets.sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height));
            dets = dets.slice(0, MAX_FACES);
            showNotice(`Maksimal ${MAX_FACES} wajah per frame`, 'warning', 1500);
        }

        const now = performance.now();
        const { assigned, hasNew } = assignTracks(dets, now);

        let needFullNext = hasNew;
        dets.forEach((d, i) => {
            const t = assigned[i];
            handleTrack(t, d, vh, now);
            if (t.state !== 'done') needFullNext = true;
        });
        _needFull = needFullNext;

        draw(assigned);
    }

    function handleTrack(t, det, vh, now) {
        if (t.state === 'done') {
            if (det.descriptor) reverifyTrack(t, det.descriptor);
            return;
        }
        if (t.busy) return;

        if (t.state === 'rejected') {
            if (now < t.retryAt) return;
            resetTrack(t);
        }

        const relH = det.box.height / vh;
        if (det.score < MIN_DET_SCORE || relH < MIN_FACE_REL_HEIGHT || relH > MAX_FACE_REL_HEIGHT) {
            t.samples = [];
            t.state = 'checking';
            t.label = relH < MIN_FACE_REL_HEIGHT ? 'Mendekat ke kamera'
                : relH > MAX_FACE_REL_HEIGHT ? 'Terlalu dekat'
                    : 'Wajah kurang jelas';
            return;
        }

        if (!det.descriptor) return; // tick ini hanya deteksi kotak; tick berikutnya full

        if (now - t.lastSampleAt >= SAMPLE_GAP_MS) {
            t.samples.push(Array.from(det.descriptor));
            if (t.samples.length > MAX_SAMPLES) t.samples.shift();
            t.lastSampleAt = now;
        }
        if (t.samples.length < MIN_SAMPLES) {
            if (t.state === 'checking') t.label = 'Memeriksa…';
            return;
        }

        evaluateTrack(t, det.box);
    }

    /** Wajah yang sudah hijau dicek ulang berkala: kalau track "pindah" ke orang lain, reset. */
    async function reverifyTrack(t, descriptor) {
        if (t.verifying || !t.localNrp || !localMatchReady()) return;
        t.verifying = true;
        try {
            const r = await OfflineMatch.findBestMatch([Array.from(descriptor)], _threshold, _marginMin);
            if (r.match && r.match.nrp !== t.localNrp) resetTrack(t);
        } catch (e) {
        } finally {
            t.verifying = false;
        }
    }

    async function evaluateTrack(t, box) {
        t.busy = true;
        try {
            let local = null;

            if (localMatchReady()) {
                local = await OfflineMatch.findBestMatch(t.samples, _threshold, _marginMin);
                if (!local.match) {
                    t.state = 'unknown';
                    t.label = local.reason === 'ambiguous' ? 'Belum yakin, tahan posisi' : 'Tidak dikenal';
                    return;
                }
                const prof = await OfflineDB.getProfile(local.match.nrp);
                t.localNrp = local.match.nrp;
                t.nrp = local.match.nrp;
                t.nama = prof?.nama || local.match.nrp;

                const recent = recentByNrp.get(t.nrp);
                if (recent && Date.now() - recent.at < NRP_COOLDOWN_MS) {
                    applyRecent(t, recent);
                    return;
                }
            } else if (!_isOnline || _sessionExpired) {
                t.state = 'unknown';
                t.label = 'Data wajah lokal belum siap';
                return;
            } else if (performance.now() < t.retryAt) {
                // Tanpa saringan lokal: batasi tembakan ke server per wajah.
                return;
            }

            t.state = 'sending';
            t.label = t.nama ? `${t.nama} · mencatat…` : 'Mencatat…';
            const resp = await submitAbsensi(t.samples.slice(), grabFaceCrop(box), local);
            handleResult(t, resp, local);
        } catch (e) {
            console.error('[v2] evaluate fail:', e);
            t.state = 'rejected';
            t.label = 'Gagal, coba lagi';
            t.retryAt = performance.now() + SERVER_RETRY_MS;
        } finally {
            t.busy = false;
        }
    }

    function applyRecent(t, recent) {
        if (recent.rejected) {
            t.state = 'rejected';
            t.label = `${recent.nama} · ${recent.sub}`;
            t.retryAt = performance.now() + SERVER_RETRY_MS;
            return;
        }
        t.state = 'done';
        t.nama = recent.nama;
        t.label = recent.nama;
        t.sub = recent.sub;
    }

    function remember(nrps, data) {
        const rec = { at: Date.now(), ...data };
        for (const n of nrps) if (n) recentByNrp.set(n, rec);
    }

    function shortKategori(k) {
        return k.replace('Shift ', '');
    }

    // ==== KIRIM ====
    async function submitAbsensi(descriptors, frame, local) {
        if (_isOnline && !_sessionExpired) {
            try {
                const r = await fetch('/api/absen', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kategori, descriptors, frameBase64: frame, source: SOURCE_ONLINE })
                });
                if (r.status === 401) {
                    console.warn('[v2] sesi server tidak ada, fallback offline');
                    _sessionExpired = true;
                    renderStatus();
                    return await saveOffline(local, frame);
                }
                return await r.json();
            } catch (e) {
                console.warn('[v2] network error, fallback offline:', e);
                _isOnline = false;
                renderStatus();
                return await saveOffline(local, frame);
            }
        }
        return await saveOffline(local, frame);
    }

    async function saveOffline(local, frame) {
        if (!local || !local.match) return { ok: false, reason: 'offline-not-ready' };
        const profile = await OfflineDB.getProfile(local.match.nrp);
        if (!profile) return { ok: false, reason: 'no-profile' };
        const match = { ...local.match, ...profile };
        if (!ACTIVE_STATUSES.has((profile.status || '').toUpperCase())) {
            return { ok: false, reason: 'inactive', match };
        }

        const now = new Date();
        const tanggal = formatLocalDate(now);
        const existing = await OfflineDB.getPendingByNrpTanggalKategori(local.match.nrp, tanggal, kategori);
        if (existing) return { ok: false, reason: 'duplicate', match };

        await OfflineDB.addPending({
            nrp: local.match.nrp,
            kategori,
            tanggal,
            jam: formatLocalTime(now),
            frameBase64: frame || null,
            source: SOURCE_OFFLINE
        });
        if (typeof SyncManager !== 'undefined') SyncManager.uploadPending().catch(() => { });

        return {
            ok: true,
            match,
            is_late: computeLateFlag(kategori, now),
            menit_terlambat: computeLateMinutes(kategori, now),
            offline: true
        };
    }

    function handleResult(t, resp, local) {
        const localNrp = local?.match?.nrp || null;

        if (resp?.ok) {
            const m = resp.match || {};
            const sub = resp.offline ? '✓ tersimpan offline' : `✓ ${shortKategori(kategori)}${resp.is_late ? ' · terlambat' : ''}`;
            t.state = 'done';
            t.nrp = m.nrp || t.nrp;
            t.nama = m.nama || t.nama;
            t.label = t.nama;
            t.sub = sub;
            remember([t.nrp, localNrp], { nama: t.nama, sub });
            addHistory(m, 'ok', resp);
            play(sndOk);
            renderStatus();
            return;
        }

        if (resp?.reason === 'duplicate') {
            const m = resp.match || { nrp: t.nrp, nama: t.nama };
            t.state = 'done';
            t.nrp = m.nrp || t.nrp;
            t.nama = m.nama || t.nama;
            t.label = t.nama;
            t.sub = 'sudah absen';
            remember([t.nrp, localNrp], { nama: t.nama, sub: 'sudah absen' });
            addHistory(m, 'dup');
            play(sndErr);
            return;
        }

        if (resp?.reason === 'inactive') {
            const nama = resp.match?.nama || t.nama || '';
            t.state = 'rejected';
            t.label = `${nama} · tidak aktif`;
            t.retryAt = performance.now() + NRP_COOLDOWN_MS;
            remember([resp.match?.nrp, localNrp], { nama, sub: 'tidak aktif', rejected: true });
            play(sndErr);
            return;
        }

        // unknown / ambiguous / no-profile / error server: server tidak yakin
        // walau lokal yakin → tetap merah, coba lagi sebentar lagi.
        const reasons = {
            unknown: 'Tidak dikenal (server)',
            ambiguous: 'Belum yakin (server)',
            'no-profile': 'Profil tidak ditemukan',
            'offline-not-ready': 'Data wajah lokal belum siap'
        };
        t.state = 'rejected';
        t.label = reasons[resp?.reason] || 'Gagal, coba lagi';
        t.samples = [];
        t.retryAt = performance.now() + SERVER_RETRY_MS;
    }

    // ==== GAMBAR ====
    function draw(assigned) {
        const ctx = canvas.getContext('2d');
        const cw = canvas.width, ch = canvas.height;
        if (!cw || !ch) return;
        ctx.clearRect(0, 0, cw, ch);

        const sx = cw / video.videoWidth;
        const sy = ch / video.videoHeight;
        const fontMain = 600 + ' ' + Math.max(12, Math.round(cw / 50)) + 'px Inter, system-ui, sans-serif';
        const fontSub = Math.max(10, Math.round(cw / 64)) + 'px Inter, system-ui, sans-serif';

        for (const t of assigned) {
            if (!t || !t.box) continue;
            const x = t.box.x * sx, y = t.box.y * sy;
            const w = t.box.width * sx, h = t.box.height * sy;
            const color = t.state === 'done' ? COLOR_OK : COLOR_WAIT;

            ctx.lineWidth = 3;
            ctx.strokeStyle = color;
            ctx.strokeRect(x, y, w, h);

            // Label menempel di kiri atas kotak (di dalam kotak bila mepet atas layar).
            const main = t.label || '';
            const sub = t.state === 'done' ? (t.sub || '') : '';
            ctx.font = fontMain;
            const mainW = ctx.measureText(main).width;
            ctx.font = fontSub;
            const subW = sub ? ctx.measureText(sub).width : 0;
            const mainH = parseInt(fontMain.split(' ')[1], 10) + 6;
            const subH = sub ? parseInt(fontSub, 10) + 4 : 0;
            const boxW = Math.max(mainW, subW) + 10;
            const boxH = mainH + subH + 2;
            const ly = y - boxH >= 0 ? y - boxH : y;
            const lx = Math.min(Math.max(0, x - 1.5), Math.max(0, cw - boxW));

            ctx.fillStyle = color;
            ctx.fillRect(lx, ly, boxW, boxH);
            ctx.fillStyle = '#ffffff';
            ctx.textBaseline = 'top';
            ctx.font = fontMain;
            ctx.fillText(main, lx + 5, ly + 3);
            if (sub) {
                ctx.font = fontSub;
                ctx.fillText(sub, lx + 5, ly + mainH);
            }
        }
    }

    // ==== LOOP ====
    let lastDet = 0;
    async function loop() {
        const now = performance.now();
        if (now - lastDet >= DET_MS) {
            lastDet = now;
            try {
                await processFrame();
            } catch (err) {
                console.error('[v2] frame error', err);
            }
        }
        requestAnimationFrame(loop);
    }
    renderStatus();
    loop();
})();
