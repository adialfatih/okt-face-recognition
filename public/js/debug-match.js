(async function () {
    const video = document.getElementById('video');
    const overlay = document.getElementById('overlay');
    const btnSwitch = document.getElementById('btnSwitchCam');
    const lastResultEl = document.getElementById('lastResult');
    const statsEl = document.getElementById('sessionStats');
    const cfgThresholdEl = document.getElementById('cfgThreshold');
    const cfgMarginEl = document.getElementById('cfgMargin');

    const DET_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.5 });

    // state sesi
    let FACE_THRESHOLD = 0.45;
    let FACE_MARGIN_MIN = 0.05;
    let totalDeteksi = 0;
    let totalRecognized = 0;
    let sumDistRecognized = 0;

    try {
        // ambil config dari backend
        const cfg = await fetch('/api/config/face').then(r => r.json()).catch(() => null);
        if (cfg && typeof cfg.threshold === 'number') {
            FACE_THRESHOLD = cfg.threshold;
            FACE_MARGIN_MIN = cfg.marginMin;
        }
    } catch (e) { }

    if (cfgThresholdEl) cfgThresholdEl.textContent = FACE_THRESHOLD.toFixed(3);
    if (cfgMarginEl) cfgMarginEl.textContent = FACE_MARGIN_MIN.toFixed(3);

    await FaceCommon.loadModels();
    await FaceCommon.startCamera(video);

    const doSync = () => FaceCommon.syncCanvasToDisplay(video, overlay);
    video.addEventListener('loadedmetadata', doSync);
    window.addEventListener('resize', doSync);
    setTimeout(doSync, 200);

    if (btnSwitch) {
        btnSwitch.addEventListener('click', async () => {
            const cams = await FaceCommon.listCameras();
            const curId = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
            let idx = Math.max(0, cams.findIndex(c => c.deviceId === curId));
            idx = (idx + 1) % cams.length;
            await FaceCommon.switchCamera(video, cams[idx].deviceId);
            setTimeout(doSync, 200);
        });
    }

    const MIN_DET_SCORE = 0.6;
    const MIN_FACE_REL_HEIGHT = 0.2;
    const MAX_FACE_REL_HEIGHT = 0.85;

    let lastDet = 0;
    const DET_MS = 250;
    let pending = false;

    function renderSessionStats() {
        const avg = totalRecognized ? (sumDistRecognized / totalRecognized) : null;
        statsEl.innerHTML = `
          Total deteksi: ${totalDeteksi}<br/>
          Recognized: ${totalRecognized}<br/>
          Rata-rata jarak (recognized): ${avg !== null ? avg.toFixed(4) : '-'}
        `;
    }

    async function loop() {
        try {
            const now = performance.now();
            let dets = [];
            if (now - lastDet >= DET_MS) {
                dets = await faceapi
                    .detectAllFaces(video, DET_OPTS)
                    .withFaceLandmarks()
                    .withFaceDescriptors();
                lastDet = now;
            }

            FaceCommon.drawWithResize(video, overlay, dets);

            if (!pending && dets.length === 1) {
                const det = dets[0];
                const score = det.detection?.score || 0;
                const box = det.detection.box;
                const frameW = overlay.width || video.videoWidth || 0;
                const frameH = overlay.height || video.videoHeight || 0;
                const relH = frameH ? (box.height / frameH) : 0;

                if (score >= MIN_DET_SCORE && relH >= MIN_FACE_REL_HEIGHT && relH <= MAX_FACE_REL_HEIGHT) {
                    pending = true;
                    const desc = Array.from(det.descriptor);
                    let resp;
                    try {
                        resp = await fetch('/api/match', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ descriptors: [desc] })
                        }).then(r => r.json());
                    } catch (e) {
                        resp = null;
                    }
                    pending = false;

                    totalDeteksi++;

                    let html = '';
                    if (resp && resp.match && resp.match.nrp) {
                        const dist = resp.match.dist;
                        const nama = resp.match.nama || '-';
                        const nrp = resp.match.nrp;
                        const bestDist = dist;
                        const secondDist = typeof resp.secondDist === 'number' ? resp.secondDist : null;

                        // klasifikasi sama dengan backend
                        let status = 'recognized';
                        if (!bestDist || bestDist > FACE_THRESHOLD) {
                            status = 'unknown';
                        } else if (secondDist !== null && (secondDist - bestDist) < FACE_MARGIN_MIN) {
                            status = 'ambiguous';
                        }

                        if (status === 'recognized') {
                            totalRecognized++;
                            sumDistRecognized += bestDist;
                        }

                        html = `
              <div class="text-xs sm:text-sm leading-snug">
                <div class="mb-1">
                  <span class="font-semibold">${nama}</span>
                  <span class="text-slate-500"> (${nrp})</span>
                </div>
                <div>Best distance: <span class="font-mono">${bestDist.toFixed(4)}</span></div>
                ${secondDist !== null ? `<div>Second distance: <span class="font-mono">${secondDist.toFixed(4)}</span></div>` : ''}
                <div class="mt-1">
                  Status: 
                  <span class="font-semibold ${status === 'recognized'
                                ? 'text-emerald-600'
                                : status === 'ambiguous'
                                    ? 'text-amber-600'
                                    : 'text-rose-600'
                            }">${status}</span>
                </div>
              </div>
            `;
                    } else {
                        html = `
              <div class="text-xs sm:text-sm text-rose-600">
                Tidak ada match yang lolos threshold.
              </div>
            `;
                    }

                    lastResultEl.innerHTML = html;
                    renderSessionStats();
                }
            } else if (dets.length !== 1) {
                // kalau tidak persis satu wajah, kita tidak kirim request
            }
        } catch (e) {
            console.error('[debug-match] loop error', e);
        }
        requestAnimationFrame(loop);
    }

    loop();
})();
