(async function () {
    const video = document.getElementById('video');
    const canvas = document.getElementById('overlay');
    const infoCard = document.getElementById('infoCard');
    const kategori = (window.__KATEGORI__ || '').trim();
    //const sndOk = new Audio('/public/ping.mp3');
    const sndErr = new Audio('/public/error.mp3');
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
                                resp = { ok: false, reason: 'net' };
                            }
                            pending = false;
                            // reset buffer setelah kirim
                            sampleBuffer = [];
                            sampleStartAt = 0;

                            if (resp?.ok) {
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
                                cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 4000);
                                UI.speak(`Presensi berhasil. ${m.nama}. ${m.jabatan || ''}`);
                            } else if (resp?.reason === 'duplicate') {
                                const nama = resp?.match?.nama || 'Karyawan';
                                const label = simplifyKategori(resp?.kategori).toLowerCase();
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
            //         if (!cooldown && !pending) {
            //             if (detections.length === 1) {
            //                 // Tampilkan “memeriksa...” kecil agar terasa responsif
            //                 renderInfo(`
            //         <div class="bg-base-100/70 backdrop-blur-sm rounded-box p-2 text-xs shadow">
            //           Memeriksa wajah…
            //         </div>`);

            //                 pending = true;
            //                 const desc = Array.from(detections[0].descriptor);
            //                 const frame = FaceCommon.grabFrame(video);
            //                 let resp;
            //                 try {
            //                     resp = await fetch('/api/absen', {
            //                         method: 'POST',
            //                         headers: { 'Content-Type': 'application/json' },
            //                         body: JSON.stringify({ kategori, descriptors: [desc], frameBase64: frame })
            //                     }).then(r => r.json());
            //                 } catch (e) {
            //                     resp = { ok: false, reason: 'net' };
            //                 }
            //                 pending = false;

            //                 if (resp?.ok) {
            //                     //UI.toastTop('Presensi berhasil', 'success');
            //                     const m = resp.match;
            //                     renderInfo(`
            //           <div class="bg-success/80 text-success-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow leading-snug">
            //             <div class="font-semibold mb-1">✅ Presensi Berhasil${resp.is_late ? ' (Terlambat)' : ''}</div>
            //             <div class="grid grid-cols-[92px_8px_1fr] sm:grid-cols-[110px_10px_1fr] gap-y-0.5">
            //               <div class="text-success-content/80">Nama</div><div>:</div><div class="font-medium break-words">${m.nama}</div>
            //               <div class="text-success-content/80">NRP</div><div>:</div><div class="font-medium">${m.nrp}</div>
            //               <div class="text-success-content/80">Jabatan</div><div>:</div><div class="font-medium break-words">${m.jabatan || '-'}</div>
            //             </div>
            //           </div>`);
            //                     cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 4000);
            //                     UI.speak(`Presensi berhasil. ${m.nama}. ${m.jabatan || ''}`);
            //                 } else if (resp?.reason === 'duplicate') {
            //                     //             UI.toastTop('Sudah tercatat hari ini', 'success');
            //                     //             renderInfo(`
            //                     //   <div class="bg-warning/80 text-warning-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow">
            //                     //     ⚠️ Presensi kategori ini sudah tercatat hari ini
            //                     //   </div>`);
            //                     //             cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 1800);
            //                     const nama = resp?.match?.nama || 'Karyawan';
            //                     const label = simplifyKategori(resp?.kategori).toLowerCase();
            //                     //UI.toastTop(`${nama} sudah tercatat`, 'success');
            //                     renderInfo(`
            // <div class="bg-warning/80 text-warning-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow leading-snug">
            //   ⚠️ ${nama} sudah absen ${label}
            // </div>`);
            //                     cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 4000);
            //                     //UI.speak(`${nama} sudah melakukan presensi sebelumnya.`);
            //                     try {
            //                         sndErr.currentTime = 0;   // mulai lagi dari awal
            //                         sndErr.play();
            //                     } catch (e) { }
            //                 } else {
            //                     //UI.toastTop('Wajah tidak terdeteksi', 'error');
            //                     renderInfo(`
            //           <div class="bg-error/80 text-error-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow">
            //             ⛔ Wajah tidak terdeteksi dalam database
            //           </div>`);
            //                     cooldown = true; setTimeout(() => { cooldown = false; renderInfo(''); }, 4000);
            //                 }
            //             } else if (detections.length > 1) {
            //                 renderInfo(`
            //         <div class="bg-warning/80 text-warning-content backdrop-blur-sm rounded-box p-2 text-xs shadow">
            //           Hanya 1 wajah per absensi
            //         </div>`);
            //             } else {
            //                 renderInfo('');
            //             }
            //         }
        } catch (err) {
            console.error('[absensi] error', err);
        }
        requestAnimationFrame(loop);
    }
    loop();
})();
