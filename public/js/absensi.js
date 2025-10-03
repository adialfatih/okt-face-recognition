(async function () {
    const video = document.getElementById('video');
    const canvas = document.getElementById('overlay');
    const infoCard = document.getElementById('infoCard');
    const kategori = (window.__KATEGORI__ || '').trim();
    const sndOk = new Audio('/public/ok.mp3');
    const sndErr = new Audio('/public/err.mp3');
    const threshold = 0.5;
    const DET_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.5 });

    await FaceCommon.loadModels();
    await FaceCommon.startCamera(video);

    // sinkron ukuran overlay ke tampilan (mobile & desktop)
    const doSync = () => FaceCommon.syncCanvasToDisplay(video, canvas);
    video.addEventListener('loadedmetadata', doSync);
    window.addEventListener('resize', doSync);
    setTimeout(doSync, 200);

    let cooldown = false;        // jeda setelah presensi
    let pending = false;         // fetch /api/absen sedang jalan
    let lastDet = 0; const DET_MS = 120; // throttle deteksi biar ringan

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

            if (!cooldown && !pending) {
                if (detections.length === 1) {
                    // Tampilkan “memeriksa...” kecil agar terasa responsif
                    renderInfo(`
            <div class="bg-base-100/70 backdrop-blur-sm rounded-box p-2 text-xs shadow">
              Memeriksa wajah…
            </div>`);

                    pending = true;
                    const desc = Array.from(detections[0].descriptor);
                    const frame = FaceCommon.grabFrame(video);
                    let resp;
                    try {
                        resp = await fetch('/api/absen', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ kategori, descriptors: [desc], frameBase64: frame })
                        }).then(r => r.json());
                    } catch (e) {
                        resp = { ok: false, reason: 'net' };
                    }
                    pending = false;

                    if (resp?.ok) {
                        //UI.toastTop('Presensi berhasil', 'success');
                        const m = resp.match;
                        renderInfo(`
              <div class="bg-success/80 text-success-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow leading-snug">
                <div class="font-semibold mb-1">✅ Presensi Berhasil${resp.is_late ? ' (Terlambat)' : ''}</div>
                <div class="grid grid-cols-[92px_8px_1fr] sm:grid-cols-[110px_10px_1fr] gap-y-0.5">
                  <div class="text-success-content/80">Nama</div><div>:</div><div class="font-medium break-words">${m.nama}</div>
                  <div class="text-success-content/80">NRP</div><div>:</div><div class="font-medium">${m.nrp}</div>
                  <div class="text-success-content/80">Jabatan</div><div>:</div><div class="font-medium break-words">${m.jabatan || '-'}</div>
                </div>
              </div>`);
                        cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 2500);
                    } else if (resp?.reason === 'duplicate') {
                        //             UI.toastTop('Sudah tercatat hari ini', 'success');
                        //             renderInfo(`
                        //   <div class="bg-warning/80 text-warning-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow">
                        //     ⚠️ Presensi kategori ini sudah tercatat hari ini
                        //   </div>`);
                        //             cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 1800);
                        const nama = resp?.match?.nama || 'Karyawan';
                        const label = simplifyKategori(resp?.kategori).toLowerCase();
                        //UI.toastTop(`${nama} sudah tercatat`, 'success');
                        renderInfo(`
    <div class="bg-warning/80 text-warning-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow leading-snug">
      ⚠️ ${nama} sudah absen ${label}
    </div>`);
                        cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 2200);
                    } else {
                        //UI.toastTop('Wajah tidak terdeteksi', 'error');
                        renderInfo(`
              <div class="bg-error/80 text-error-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow">
                ⛔ Wajah tidak terdeteksi dalam database
              </div>`);
                        cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 1500);
                    }
                } else if (detections.length > 1) {
                    renderInfo(`
            <div class="bg-warning/80 text-warning-content backdrop-blur-sm rounded-box p-2 text-xs shadow">
              Hanya 1 wajah per absensi
            </div>`);
                } else {
                    renderInfo('');
                }
            }
        } catch (err) {
            console.error('[absensi] error', err);
        }
        requestAnimationFrame(loop);
    }
    loop();
})();
