/**
 * test.js — Test pengenalan wajah (tidak mencatat absensi)
 *
 * Tampilan sama dengan Absensi v2: banyak wajah sekaligus (maks MAX_FACES),
 * kotak MERAH = belum/tidak dikenali, HIJAU + nama = dikenali server.
 * Pencocokan selalu lewat server (POST /api/match) karena halaman ini dipakai
 * untuk menguji data wajah yang ada di server.
 *
 * Bunyi: ping/error hanya SEKALI saat wajah pertama kali diputuskan. Selama
 * orang yang sama masih terlihat tidak berbunyi lagi; baru berbunyi lagi jika
 * ia sudah hilang dari kamera lebih dari SOUND_RESET_MS.
 */
(async function () {
    const video = document.getElementById('video');
    const overlay = document.getElementById('overlay');
    const infoCard = document.getElementById('infoCard');
    const notice = document.getElementById('testNotice');
    const btnSwitch = document.getElementById('btnSwitchCam');
    const sndOk = new Audio('/public/ping.mp3');
    const sndErr = new Audio('/public/error.mp3');

    // ==== KONFIGURASI ====
    const MAX_FACES = 5;
    const DET_MS = 220;                 // throttle loop deteksi
    const DET_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });
    const MIN_DET_SCORE = 0.6;
    const MIN_FACE_REL_HEIGHT = 0.10;
    const MIN_SAMPLES = 2;
    const MAX_SAMPLES = 3;
    const SAMPLE_GAP_MS = 150;
    const TRACK_TTL_MS = 1200;
    const TRACK_IOU_MIN = 0.3;
    const UNKNOWN_RETRY_MS = 1500;      // wajah belum dikenali dicek ulang tiap ...
    const REVERIFY_MS = 4000;           // wajah dikenali dicek ulang (deteksi track tertukar)
    const SOUND_RESET_MS = 5000;        // orang yang sama baru berbunyi lagi setelah hilang selama ini

    const COLOR_OK = '#22c55e';
    const COLOR_WAIT = '#ef4444';

    await FaceCommon.loadModels();
    await FaceCommon.startCamera(video);

    const doSync = () => FaceCommon.syncCanvasToDisplay(video, overlay);
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

    let _noticeTimer = null;
    function showNotice(text, ms = 3000) {
        if (!notice) return;
        notice.innerHTML = text
            ? `<span class="inline-block rounded-box px-2 py-1 shadow backdrop-blur-sm bg-warning/80 text-warning-content">${text}</span>`
            : '';
        clearTimeout(_noticeTimer);
        if (text && ms > 0) _noticeTimer = setTimeout(() => { notice.innerHTML = ''; }, ms);
    }

    function play(snd) {
        try { snd.currentTime = 0; snd.play(); } catch (e) { }
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function renderInfo(m) {
        if (!m) { infoCard.innerHTML = ''; return; }
        infoCard.innerHTML = `<div class="bg-base-100/80 backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow-md leading-snug">
      <div class="font-semibold mb-1">✅ Wajah Terdeteksi</div>
      <div class="grid grid-cols-[92px_8px_1fr] sm:grid-cols-[110px_10px_1fr] gap-y-0.5 items-start">
        <div class="text-base-content/70">Nama</div><div>:</div>
        <div class="font-medium break-words">${escapeHtml(m.nama)}</div>
        <div class="text-base-content/70">NRP</div><div>:</div>
        <div class="font-medium">${escapeHtml(m.nrp)}</div>
        <div class="text-base-content/70">Departement</div><div>:</div>
        <div class="font-medium break-words">${escapeHtml(m.dep || '-')}</div>
        <div class="text-base-content/70">Divisi</div><div>:</div>
        <div class="font-medium break-words">${escapeHtml(m.divisi || '-')}</div>
        <div class="text-base-content/70">Jabatan</div><div>:</div>
        <div class="font-medium break-words">${escapeHtml(m.jabatan || '-')}</div>
        <div class="text-base-content/70">Jarak</div><div>:</div>
        <div class="font-medium">${Number(m.dist).toFixed(3)}</div>
      </div>
    </div>`;
    }

    // ==== TRACKING (sama dengan absensi-v2.js) ====
    // state: checking | unknown | ok
    const tracks = new Map();
    let _nextTrackId = 1;
    // Kunci bunyi → terakhir terlihat. Kunci = NRP, atau 'unknown#<trackId>'.
    const soundSeen = new Map();
    let _focusTrackId = null; // track yang detailnya tampil di kartu info

    function newTrack(now) {
        const t = {
            id: _nextTrackId++, box: null, lastSeen: now,
            samples: [], lastSampleAt: 0,
            state: 'checking', label: 'Memeriksa…', sub: '',
            match: null, busy: false, nextCheckAt: 0
        };
        tracks.set(t.id, t);
        return t;
    }

    function iou(a, b) {
        const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
        const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const uni = a.width * a.height + b.width * b.height - inter;
        return uni > 0 ? inter / uni : 0;
    }

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
        const used = new Set();
        for (const p of pairs) {
            if (out[p.i] || used.has(p.t.id)) continue;
            out[p.i] = p.t;
            used.add(p.t.id);
        }
        dets.forEach((d, i) => {
            if (!out[i]) out[i] = newTrack(now);
            out[i].box = d.box;
            out[i].lastSeen = now;
        });
        for (const [id, t] of tracks) {
            if (now - t.lastSeen > TRACK_TTL_MS) tracks.delete(id);
        }
        return out;
    }

    /** Bunyi sekali per orang; tidak berulang selama orang itu masih terlihat. */
    function playOnce(key, snd, now) {
        const last = soundSeen.get(key);
        soundSeen.set(key, now);
        if (last !== undefined && now - last < SOUND_RESET_MS) return;
        play(snd);
    }
    /** Perbarui "terakhir terlihat" untuk orang yang masih di kamera. */
    function touchSound(key, now) {
        if (soundSeen.has(key)) soundSeen.set(key, now);
    }

    // ==== MATCH KE SERVER ====
    let _unauthorizedShown = false;

    async function checkTrack(t) {
        t.busy = true;
        try {
            const resp = await fetch('/api/match', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ descriptors: t.samples.slice() })
            });
            if (resp.status === 401) {
                if (!_unauthorizedShown) showNotice('Sesi login habis — silakan login ulang.', 0);
                _unauthorizedShown = true;
                t.state = 'unknown';
                t.label = 'Sesi habis';
                t.nextCheckAt = performance.now() + UNKNOWN_RETRY_MS;
                return;
            }
            const r = await resp.json();
            const now = performance.now();

            if (r.match) {
                const changed = t.match && t.match.nrp !== r.match.nrp;
                t.match = r.match;
                t.state = 'ok';
                t.label = r.match.nama || r.match.nrp;
                t.sub = `${r.match.nrp} · jarak ${Number(r.match.dist).toFixed(2)}`;
                t.nextCheckAt = now + REVERIFY_MS;
                soundSeen.delete('unknown#' + t.id);
                if (changed || _focusTrackId === null || !tracks.has(_focusTrackId) || _focusTrackId === t.id) {
                    _focusTrackId = t.id;
                    renderInfo(r.match);
                }
                playOnce(r.match.nrp, sndOk, now);
            } else {
                const ambiguous = r.secondDist !== undefined;
                t.match = null;
                t.state = 'unknown';
                t.label = ambiguous ? 'Ambigu (mirip >1 orang)' : 'Tidak dikenal';
                t.sub = Number.isFinite(r.bestDist) && r.bestDist < 9 ? `jarak terdekat ${Number(r.bestDist).toFixed(2)}` : '';
                t.samples = [];
                t.nextCheckAt = now + UNKNOWN_RETRY_MS;
                if (_focusTrackId === t.id) { _focusTrackId = null; renderInfo(null); }
                playOnce('unknown#' + t.id, sndErr, now);
            }
        } catch (e) {
            console.warn('[test] match fail:', e);
            t.state = 'unknown';
            t.label = 'Gagal menghubungi server';
            t.nextCheckAt = performance.now() + UNKNOWN_RETRY_MS;
        } finally {
            t.busy = false;
        }
    }

    function handleTrack(t, det, vh, now) {
        if (t.state === 'ok') touchSound(t.match.nrp, now);
        else touchSound('unknown#' + t.id, now);

        if (t.busy || now < t.nextCheckAt) return;

        const relH = det.box.height / vh;
        if (det.score < MIN_DET_SCORE || relH < MIN_FACE_REL_HEIGHT) {
            if (t.state !== 'ok') {
                t.samples = [];
                t.state = 'checking';
                t.label = relH < MIN_FACE_REL_HEIGHT ? 'Mendekat ke kamera' : 'Wajah kurang jelas';
                t.sub = '';
            }
            return;
        }

        if (now - t.lastSampleAt >= SAMPLE_GAP_MS) {
            t.samples.push(Array.from(det.descriptor));
            if (t.samples.length > MAX_SAMPLES) t.samples.shift();
            t.lastSampleAt = now;
        }
        if (t.samples.length < MIN_SAMPLES) return;

        checkTrack(t);
    }

    // ==== GAMBAR ====
    function draw(assigned) {
        const ctx = overlay.getContext('2d');
        const cw = overlay.width, ch = overlay.height;
        if (!cw || !ch) return;
        ctx.clearRect(0, 0, cw, ch);

        const sx = cw / video.videoWidth;
        const sy = ch / video.videoHeight;
        const mainPx = Math.max(12, Math.round(cw / 50));
        const subPx = Math.max(10, Math.round(cw / 64));

        for (const t of assigned) {
            if (!t || !t.box) continue;
            const x = t.box.x * sx, y = t.box.y * sy;
            const w = t.box.width * sx, h = t.box.height * sy;
            const color = t.state === 'ok' ? COLOR_OK : COLOR_WAIT;

            ctx.lineWidth = 3;
            ctx.strokeStyle = color;
            ctx.strokeRect(x, y, w, h);

            const main = t.label || '';
            const sub = t.sub || '';
            ctx.font = `600 ${mainPx}px Inter, system-ui, sans-serif`;
            const mainW = ctx.measureText(main).width;
            ctx.font = `${subPx}px Inter, system-ui, sans-serif`;
            const subW = sub ? ctx.measureText(sub).width : 0;
            const mainH = mainPx + 6;
            const subH = sub ? subPx + 4 : 0;
            const boxW = Math.max(mainW, subW) + 10;
            const boxH = mainH + subH + 2;
            const ly = y - boxH >= 0 ? y - boxH : y;
            const lx = Math.min(Math.max(0, x - 1.5), Math.max(0, cw - boxW));

            ctx.fillStyle = color;
            ctx.fillRect(lx, ly, boxW, boxH);
            ctx.fillStyle = '#ffffff';
            ctx.textBaseline = 'top';
            ctx.font = `600 ${mainPx}px Inter, system-ui, sans-serif`;
            ctx.fillText(main, lx + 5, ly + 3);
            if (sub) {
                ctx.font = `${subPx}px Inter, system-ui, sans-serif`;
                ctx.fillText(sub, lx + 5, ly + mainH);
            }
        }
    }

    // ==== LOOP ====
    async function processFrame() {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return;
        if (!overlay.width || !overlay.height) doSync();

        let dets = (await faceapi
            .detectAllFaces(video, DET_OPTS)
            .withFaceLandmarks()
            .withFaceDescriptors())
            .map(r => ({ box: r.detection.box, score: r.detection.score, descriptor: r.descriptor }));

        if (dets.length > MAX_FACES) {
            dets.sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height));
            dets = dets.slice(0, MAX_FACES);
            showNotice(`Maksimal ${MAX_FACES} wajah per frame`, 1500);
        }

        const now = performance.now();
        const assigned = assignTracks(dets, now);
        dets.forEach((d, i) => handleTrack(assigned[i], d, vh, now));

        // Kartu info ikut hilang kalau orangnya sudah tidak di kamera.
        if (_focusTrackId !== null && !tracks.has(_focusTrackId)) {
            _focusTrackId = null;
            const next = [...tracks.values()].find(t => t.state === 'ok');
            if (next) { _focusTrackId = next.id; renderInfo(next.match); } else renderInfo(null);
        }

        // Bersihkan catatan bunyi yang sudah lama tidak terlihat.
        for (const [k, at] of soundSeen) {
            if (now - at > SOUND_RESET_MS * 2) soundSeen.delete(k);
        }

        draw(assigned);
    }

    let lastDet = 0;
    async function loop() {
        const now = performance.now();
        if (now - lastDet >= DET_MS) {
            lastDet = now;
            try {
                await processFrame();
            } catch (err) {
                // Dulu satu error menghentikan loop selamanya (tanpa try/catch).
                console.error('[test] frame error', err);
            }
        }
        requestAnimationFrame(loop);
    }
    loop();
})();
