(async function () {
    const video = document.getElementById('video');
    const canvas = document.getElementById('overlay');
    const infoCard = document.getElementById('infoCard');
    const kategori = (window.__KATEGORI__ || '').trim();
    const sndErr = new Audio('/public/error.mp3');
    const DET_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.5 });

    // ==== OFFLINE-FIRST INIT ====
    let _isOnline = true;
    let _threshold = 0.45;
    let _marginMin = 0.05;
    let _offlineReady = false;

    // Init IndexedDB + SyncManager
    try {
        if (typeof OfflineDB === 'undefined' || typeof OfflineMatch === 'undefined' || typeof SyncManager === 'undefined') {
            throw new Error('offline-scripts-not-loaded');
        }
        await OfflineDB.open();
        // Load config dari IndexedDB
        const t = await OfflineDB.getConfig('threshold');
        const m = await OfflineDB.getConfig('marginMin');
        if (t) _threshold = t;
        if (m) _marginMin = m;

        // Load embeddings ke memory untuk offline matching
        await OfflineMatch.loadEmbeddings();

        // Init SyncManager dengan status callback
        SyncManager.init((status) => {
            console.log('[sync] status:', status);
            if (status === 'offline') _isOnline = false;
            else if (status === 'online') _isOnline = true;
            updateOfflineIndicator();
        });

        // Cek online status awal
        _isOnline = await SyncManager.isOnline();
        updateOfflineIndicator();

        // Auto-sync saat online
        if (_isOnline) {
            SyncManager.fullSync().catch(e => console.warn('[sync] initial fail:', e));
        }
        _offlineReady = true;
    } catch (e) {
        console.warn('[offline] init fail, fallback to online-only:', e);
    }

    // Offline indicator
    function updateOfflineIndicator() {
        let ind = document.getElementById('offlineIndicator');
        if (!ind) {
            ind = document.createElement('div');
            ind.id = 'offlineIndicator';
            ind.className = 'fixed top-2 left-2 z-50';
            infoCard.parentElement.appendChild(ind);
        }
        if (_isOnline) {
            ind.innerHTML = '';
        } else {
            ind.innerHTML = `
        <div class="badge badge-warning gap-1 text-xs">
          <i class="fa-solid fa-wifi-slash"></i> Offline
        </div>`;
        }
        // Update pending count
        updatePendingCount();
        updateOfflineDataStatus();
    }

    async function updatePendingCount() {
        try {
            const count = await OfflineDB.getPendingCount();
            let badge = document.getElementById('pendingBadge');
            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('div');
                    badge.id = 'pendingBadge';
                    badge.className = 'fixed top-2 right-16 z-50';
                    infoCard.parentElement.appendChild(badge);
                }
                badge.innerHTML = `
          <div class="badge badge-info gap-1 text-xs">
            <i class="fa-solid fa-cloud-arrow-up"></i> ${count} pending
          </div>`;
            } else if (badge) {
                badge.innerHTML = '';
            }
        } catch (e) { }
    }

    function formatSyncTime(value) {
        if (!value) return '-';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return '-';
        return d.toLocaleString('id-ID', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    async function updateOfflineDataStatus() {
        try {
            if (typeof OfflineDB === 'undefined') return;

            const [lastSyncAt, embCount, profileCount] = await Promise.all([
                OfflineDB.getMeta('lastSyncAt'),
                OfflineDB.getMeta('embCount'),
                OfflineDB.getMeta('profileCount')
            ]);

            let box = document.getElementById('offlineDataStatus');
            if (!box) {
                box = document.createElement('div');
                box.id = 'offlineDataStatus';
                box.className = 'fixed left-2 top-9 z-50 pointer-events-none';
                infoCard.parentElement.appendChild(box);
            }

            const ready = Number(embCount || 0) > 0 && Number(profileCount || 0) > 0;
            const tone = ready ? 'badge-success' : 'badge-warning';
            const label = ready
                ? `${profileCount} karyawan / ${embCount} wajah`
                : 'Data offline belum siap';
            const syncText = ready ? `Sync ${formatSyncTime(lastSyncAt)}` : 'Buka online untuk download data';

            box.innerHTML = `
        <div class="badge ${tone} gap-1 text-[11px] shadow">
          <i class="fa-solid ${ready ? 'fa-database' : 'fa-triangle-exclamation'}"></i>
          <span>${label}</span>
          <span class="opacity-70">• ${syncText}</span>
        </div>`;
        } catch (e) {
            console.warn('[offline] status fail:', e);
        }
    }

    await FaceCommon.loadModels();
    await FaceCommon.startCamera(video);

    // sinkron ukuran overlay ke tampilan (mobile & desktop)
    const doSync = () => FaceCommon.syncCanvasToDisplay(video, canvas);
    video.addEventListener('loadedmetadata', doSync);
    window.addEventListener('resize', doSync);
    setTimeout(doSync, 200);

    let cooldown = false;        // jeda setelah presensi
    let pending = false;         // fetch /api/absen sedang jalan
    let lastDet = 0; const DET_MS = 220; // throttle deteksi biar ringan
    // Multi-frame matching: kumpulkan beberapa frame sebelum kirim ke server
    let sampleBuffer = [];
    let sampleStartAt = 0;
    const SAMPLE_WINDOW_MS = 1200;  // maksimal durasi window pengambilan sampel
    const MAX_SAMPLES = 3;          // ambil maksimal 3 descriptor
    const MIN_SAMPLES = 2;          // minimal 2 descriptor sebelum kirim


    // QUALITY FILTER — batas minimal kualitas wajah yang boleh dikirim ke server
    const MIN_DET_SCORE = 0.6;      // minimal confidence deteksi
    const MIN_FACE_REL_HEIGHT = 0.20; // minimal tinggi wajah relatif (20% tinggi frame)
    const MAX_FACE_REL_HEIGHT = 0.85; // maksimal tinggi wajah relatif (85% tinggi frame)

    function renderInfo(html) { infoCard.innerHTML = html || ''; }
    function simplifyKategori(k) {
        const m = (k || '').match(/Shift Pagi|Shift Siang|Shift Malam/i);
        if (m) return m[0];
        if (/DS/i.test(k)) return 'DS';
        if (/Driver/i.test(k)) return 'Driver';
        if (/Security/i.test(k)) return 'Security';
        if (/Terlambat/i.test(k)) return 'Terlambat';
        if (/Ijin Keluar/i.test(k)) return 'Ijin Keluar';
        return k || '';
    }
    function drawGuideCircle() {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        if (!w || !h) return;

        // Lokasi pusat lingkaran & radius
        const r = Math.min(w, h) * 0.35;
        const cx = w / 2;
        const cy = h * 0.42; // sedikit ke atas

        ctx.clearRect(0, 0, w, h);

        // ====== 1) Lapisan putih penuh ======
        ctx.save();
        ctx.fillStyle = 'rgba(255, 255, 255, 1)';  // putih solid
        ctx.fillRect(0, 0, w, h);

        // ====== 2) Lubangi area lingkaran ======
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // ====== 3) Border lingkaran panduan ======
        ctx.save();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.30)'; // garis tipis abu gelap
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    // ==== OFFLINE MATCHING ====
    /**
     * Coba match offline menggunakan OfflineMatch.
     * Return: { ok, match, reason, is_late, menit_terlambat } atau null jika tidak bisa offline
     */
    async function tryOfflineMatch(descriptors, frame) {
        if (!_offlineReady || typeof OfflineMatch === 'undefined' || typeof OfflineDB === 'undefined') {
            return { ok: false, reason: 'offline-not-ready' };
        }
        if (!OfflineMatch.isReady()) {
            return { ok: false, reason: 'no-embeddings' };
        }

        const result = await OfflineMatch.findBestMatch(descriptors, _threshold, _marginMin);

        if (!result.match) {
            return { ok: false, reason: result.reason || 'unknown', bestDist: result.bestDist };
        }

        // Ambil profil dari IndexedDB
        const profile = await OfflineDB.getProfile(result.match.nrp);
        if (!profile) {
            return { ok: false, reason: 'no-profile' };
        }

        // Cek status aktif
        const ACTIVE_STATUSES = new Set(['TETAP', 'KONTRAK', 'MAGANG']);
        if (!ACTIVE_STATUSES.has((profile.status || '').toUpperCase())) {
            return { ok: false, reason: 'inactive', match: { ...result.match, ...profile } };
        }

        // Cek anti-dobel lokal (pending queue)
        const now = new Date();
        const tanggal = formatLocalDate(now);
        const jam = formatLocalTime(now);
        const existing = await OfflineDB.getPendingByNrpTanggalKategori(result.match.nrp, tanggal, kategori);
        if (existing) {
            return { ok: false, reason: 'duplicate', match: { ...result.match, ...profile } };
        }

        // Simpan ke pending queue
        await OfflineDB.addPending({
            nrp: result.match.nrp,
            kategori,
            tanggal,
            jam,
            frameBase64: frame || null
        });

        // Compute late flag (sederhana, sama dengan server)
        const isLate = computeLateFlag(kategori, now);
        const lateMin = computeLateMinutes(kategori, now);

        return {
            ok: true,
            match: { ...result.match, ...profile },
            is_late: isLate,
            menit_terlambat: lateMin,
            offline: true
        };
    }

    function computeLateFlag(kategori, now) {
        const map = {
            'Masuk Shift Pagi': '06:05',
            'Masuk Shift Siang': '14:05',
            'Masuk Shift Malam': '22:05'
        };
        if (!map[kategori]) return 0;
        const [h, m] = map[kategori].split(':').map(Number);
        const lateAt = new Date(now);
        lateAt.setHours(h, m, 0, 0);
        return now > lateAt ? 1 : 0;
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function formatLocalDate(d) {
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }

    function formatLocalTime(d) {
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }

    function computeLateMinutes(kategori, now) {
        const startMap = {
            'Masuk Shift Pagi': '06:00',
            'Masuk Shift Siang': '14:00',
            'Masuk Shift Malam': '22:00'
        };
        const startStr = startMap[kategori];
        if (!startStr) return 0;
        const [h, m] = startStr.split(':').map(Number);
        let start = new Date(now);
        start.setHours(h, m, 0, 0);

        // Khusus shift malam: jika sekarang dini hari (00:00–05:59), anchor ke malam sebelumnya
        if (kategori === 'Masuk Shift Malam' && now.getHours() < 6) {
            start = new Date(now);
            start.setDate(start.getDate() - 1);
            start.setHours(h, m, 0, 0);
        }

        const diffMin = Math.floor((now - start) / 60000);
        if (diffMin < 3) return 0;
        return diffMin > 0 ? diffMin : 0;
    }

    async function loop() {
        try {
            const now = performance.now();
            let detections = [];
            if (now - lastDet >= DET_MS) {
                detections = await faceapi
                    .detectAllFaces(video, DET_OPTS)
                    .withFaceLandmarks()
                    .withFaceDescriptors();
                lastDet = now;
            }

            // gambar bbox/landmarks yang sudah di-resize
            FaceCommon.drawWithResize(video, canvas, detections);
            drawGuideCircle();
            if (!cooldown && !pending) {
                if (detections.length === 1) {
                    const det = detections[0];
                    const score = det.detection?.score || 0;

                    // Hitung ukuran wajah relatif terhadap frame
                    const box = det.detection.box;
                    const frameW = canvas.width || video.videoWidth || 0;
                    const frameH = canvas.height || video.videoHeight || 0;
                    const relH = frameH ? (box.height / frameH) : 0;

                    // QUALITY GATE
                    if (score < MIN_DET_SCORE || relH < MIN_FACE_REL_HEIGHT || relH > MAX_FACE_REL_HEIGHT) {
                        // kualitas belum oke → jangan kirim ke server, reset buffer
                        sampleBuffer = [];
                        sampleStartAt = 0;
                        renderInfo(`
            <div class="bg-error/80 backdrop-blur-sm rounded-box p-2 text-xs shadow leading-snug">
              Posisi wajah belum ideal. Pastikan wajah berada di dalam lingkaran dan cukup dekat ke kamera.
            </div>`);
                    } else {
                        const now = performance.now();
                        const desc = Array.from(det.descriptor);

                        // Mulai window sampling baru jika buffer kosong
                        if (sampleBuffer.length === 0) {
                            sampleStartAt = now;
                        }

                        // Kalau masih dalam window dan belum mencapai MAX_SAMPLES → tambahkan sampel
                        if ((now - sampleStartAt) <= SAMPLE_WINDOW_MS && sampleBuffer.length < MAX_SAMPLES) {
                            sampleBuffer.push(desc);
                        }

                        // Tampilkan status "memeriksa..." selama kumpulin sampel
                        renderInfo(`
            <div class="bg-base-100/70 backdrop-blur-sm rounded-box p-2 text-xs shadow">
              Memeriksa wajah…
            </div>`);

                        const windowExpired = (now - sampleStartAt) > SAMPLE_WINDOW_MS;
                        const readyToSend =
                            sampleBuffer.length >= MIN_SAMPLES &&
                            (sampleBuffer.length >= MAX_SAMPLES || windowExpired);

                        if (readyToSend) {
                            pending = true;
                            const frame = FaceCommon.grabFrame(video);
                            let resp;

                            // ==== OFFLINE-FIRST STRATEGY ====
                            // Jika offline → coba offline match
                            // Jika online → coba server, fallback ke offline jika network error
                            if (!_isOnline) {
                                // OFFLINE MODE
                                resp = await tryOfflineMatch(sampleBuffer, frame);
                                // Trigger upload attempt (will fail silently if still offline)
                                if (typeof SyncManager !== 'undefined') SyncManager.uploadPending().catch(() => { });
                            } else {
                                // ONLINE MODE — coba server
                                try {
                                    resp = await fetch('/api/absen', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            kategori,
                                            descriptors: sampleBuffer,
                                            frameBase64: frame
                                        })
                                    }).then(r => r.json());
                                } catch (e) {
                                    // Network error → fallback ke offline
                                    console.warn('[absensi] network error, fallback offline:', e);
                                    _isOnline = false;
                                    updateOfflineIndicator();
                                    resp = await tryOfflineMatch(sampleBuffer, frame);
                                }
                            }
                            pending = false;
                            // reset buffer setelah kirim
                            sampleBuffer = [];
                            sampleStartAt = 0;

                            if (resp?.ok) {
                                const m = resp.match;
                                const offlineTag = resp.offline ? ' 📴(offline)' : '';
                                renderInfo(`
              <div class="bg-success/80 text-success-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow leading-snug">
                <div class="font-semibold mb-1">✅ Presensi Berhasil${resp.is_late ? ' (Terlambat)' : ''}${offlineTag}</div>
                <div class="grid grid-cols-[92px_8px_1fr] sm:grid-cols-[110px_10px_1fr] gap-y-0.5">
                  <div class="text-success-content/80">Nama</div><div>:</div><div class="font-medium break-words">${m.nama}</div>
                  <div class="text-success-content/80">NRP</div><div>:</div><div class="font-medium">${m.nrp}</div>
                  <div class="text-success-content/80">Jabatan</div><div>:</div><div class="font-medium break-words">${m.jabatan || '-'}</div>
                </div>
              </div>`);
                                cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 4000);
                                UI.speak(`Presensi berhasil. ${m.nama}. ${m.jabatan || ''}`);
                                updatePendingCount();
                            } else if (resp?.reason === 'duplicate') {
                                const nama = resp?.match?.nama || 'Karyawan';
                                const label = simplifyKategori(resp?.kategori || kategori).toLowerCase();
                                renderInfo(`
    <div class="bg-warning/80 text-warning-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow leading-snug">
      ⚠️ ${nama} sudah absen ${label}
    </div>`);
                                cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 4000);
                                try {
                                    sndErr.currentTime = 0;
                                    sndErr.play();
                                } catch (e) { }
                            } else {
                                renderInfo(`
              <div class="bg-error/80 text-error-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow">
                ⛔ Wajah tidak terdeteksi dalam database
              </div>`);
                                cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 4000);
                            }
                        }
                        // kalau belum siap kirim (butuh 2–3 frame), cukup terus kumpulin sampel
                    }
                } else if (detections.length > 1) {
                    renderInfo(`
            <div class="bg-warning/80 text-warning-content backdrop-blur-sm rounded-box p-2 text-xs shadow">
              Hanya 1 wajah per absensi
            </div>`);
                    // reset buffer kalau banyak wajah
                    sampleBuffer = [];
                    sampleStartAt = 0;
                } else {
                    renderInfo('');
                    // tidak ada wajah → reset buffer
                    sampleBuffer = [];
                    sampleStartAt = 0;
                }
            }
        } catch (err) {
            console.error('[absensi] error', err);
        }
        requestAnimationFrame(loop);
    }
    loop();
})();
