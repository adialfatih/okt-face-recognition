(function () {
    const search = document.getElementById('search');
    // function speak(text) {
    //     try {
    //         if (!('speechSynthesis' in window)) return;
    //         const utter = new SpeechSynthesisUtterance(text);
    //         utter.lang = 'id-ID';
    //         utter.rate = 1;   // kecepatan normal
    //         utter.pitch = 1;  // nada normal
    //         window.speechSynthesis.cancel(); // batalkan antrian sebelumnya biar nggak numpuk
    //         window.speechSynthesis.speak(utter);
    //     } catch (e) {
    //         console.warn('[tts] gagal memutar suara', e);
    //     }
    // }


    //const suggest = document.getElementById('suggest');
    const btn = document.getElementById('btnStart');
    const selectedInfo = document.getElementById('selectedInfo');
    const selectedText = document.getElementById('selectedText');
    const sndOk = new Audio('/public/ping.mp3');
    const sndErr = new Audio('/public/error.mp3');
    //const btnSwitch = document.getElementById('btnSwitchCam');
    let selected = null;


    if (search) {
        const ac = new autoComplete({
            selector: "#search",
            threshold: 0,              // mulai dari ketikan pertama
            debounce: 100,
            data: {
                src: async (query) => {
                    if (!query) return [];
                    try {
                        const url = '/api/karyawan/search?q=' + encodeURIComponent(query);
                        const resp = await fetch(url, { credentials: 'same-origin' });
                        if (!resp.ok) return [];
                        const data = await resp.json().catch(() => []);
                        return Array.isArray(data) ? data : [];
                    } catch (e) {
                        // jaringan atau server error → jangan lempar, cukup kosongkan
                        return [];
                    }
                },
                keys: ["nrp", "nama"]
            },
            resultsList: {
                class: "menu bg-base-100 mt-2 rounded-box shadow max-h-60 overflow-auto",
                maxResults: 10,
                noResults: (el, query) => {
                    const li = document.createElement('li');
                    li.className = 'p-2 text-base-content/60';
                    li.innerText = query ? 'Tidak ada hasil' : 'Ketik NRP/Nama...';
                    el.appendChild(li);
                }
            },
            resultItem: {
                class: "p-2 hover:bg-base-200 cursor-pointer",
                highlight: true,
                element: (item, data) => {
                    item.innerHTML = `<div><b>${data.value.nrp}</b> — ${data.value.nama}</div>`;
                }
            },
            events: {
                input: {
                    selection: (ev) => {
                        const v = ev.detail.selection.value;
                        selected = { nrp: v.nrp, label: `${v.nrp} — ${v.nama}` };
                        search.value = selected.label;
                        if (selectedInfo) selectedInfo.classList.remove('hidden');
                        if (selectedText) selectedText.textContent = selected.label;
                        btn.classList.remove('disabled');
                        btn.setAttribute('href', '/rekam/capture?nrp=' + encodeURIComponent(v.nrp));
                    }
                }
            }
        });

        // Kalau user hapus input -> reset pilihan
        search.addEventListener('input', () => {
            if (!search.value.trim()) {
                selected = null;
                btn.classList.add('disabled');
                btn.setAttribute('href', '#');
                if (selectedInfo) selectedInfo.classList.add('hidden');
                if (selectedText) selectedText.textContent = '';
            }
        });

    }
    if (btn) {
        btn.addEventListener('click', (ev) => {
            if (btn.classList.contains('disabled')) {
                ev.preventDefault();
                UI.toastTop('Pilih karyawan dulu dari daftar', 'error');
            }
        });
    }

    // Capture page logic
    const nrp = (window.__NRP__ || '').trim();
    const video = document.getElementById('video');
    const overlay = document.getElementById('overlay');
    const counter = document.getElementById('counter');
    const btnSwitch = document.getElementById('btnSwitchCam');
    const btnRecStart = document.getElementById('btnRecStart');
    const recStatus = document.getElementById('recStatus');
    const recActions = document.getElementById('recActions');
    const btnSave = document.getElementById('btnSave');
    const btnRedo = document.getElementById('btnRedo');

    if (nrp && video) {
        (async function () {
            await FaceCommon.loadModels();
            await FaceCommon.startCamera(video);
            // Cek embedding existing untuk NRp ini
            const cnt = await fetch('/api/faces/count?nrp=' + encodeURIComponent(nrp)).then(r => r.json());
            if (Number(cnt.count || 0) > 0) {
                const yes = window.confirm(`Wajah untuk NRP ${nrp} sudah terekam (${cnt.count} sampel). Rekam ulang akan MENGHAPUS data lama. Lanjut?`);
                if (!yes) {
                    UI.toastTop('Rekam dibatalkan', 'error');
                    return; // stop, jangan lanjut loop
                }
                // Hapus semua embedding lama dulu
                await fetch('/api/faces/reset', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nrp })
                }).then(r => r.json());
                UI.toastTop('Data lama dihapus. Mulai rekam ulang...', 'success');
            }
            //video.addEventListener('loadedmetadata', () => FaceCommon.resizeCanvasToVideo(video, overlay));
            //const TINY_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
            video.addEventListener('loadedmetadata', () => FaceCommon.resizeCanvasToVideo(video, overlay));

            const TINY_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.5 });
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
            // Pre-check & mulai rekam ketika tombol ditekan
            if (btnRecStart) {
                btnRecStart.addEventListener('click', async () => {
                    // Cek existing embeddings
                    if (recording || saving) return;
                    const cnt = await fetch('/api/faces/count?nrp=' + encodeURIComponent(nrp)).then(r => r.json());
                    if (Number(cnt.count || 0) > 0) {
                        const yes = window.confirm(`Wajah untuk NRP ${nrp} sudah terekam (${cnt.count} sampel). Rekam ulang akan MENGHAPUS data lama. Lanjut?`);
                        if (!yes) { UI.toastTop('Rekam dibatalkan', 'error'); return; }
                        await fetch('/api/faces/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nrp }) });
                    }
                    // Set UI
                    saved = 0; samples.length = 0;
                    counter.textContent = `${saved} / 15`;
                    btnSave.disabled = true;
                    btnSave.disabled = true; btnSave.classList.remove('loading');
                    btnRecStart.disabled = true;
                    if (recStatus) recStatus.classList.remove('hidden');
                    if (recActions) recActions.classList.remove('hidden');
                    recording = true;
                });
            }
            if (btnRedo) {

                btnRedo.addEventListener('click', () => {
                    if (saving) return;
                    saved = 0; samples.length = 0;
                    counter.textContent = `0 / 15`;
                    btnSave.disabled = true;
                    btnSave.classList.remove('loading');
                    btnRecStart.disabled = true;
                    recording = true;
                });
            }
            if (btnSave) {
                btnSave.addEventListener('click', async () => {
                    if (saved < 15) { UI.toastTop('Belum mencapai 15 sampel', 'error'); return; }
                    if (saved < 15 || saving) {
                        if (!saving) UI.toastTop('Belum mencapai 15 sampel', 'error');
                        return;
                    }
                    saving = true;
                    btnSave.disabled = true;
                    btnSave.classList.add('loading'); // daisyUI spinner
                    btnRedo.disabled = true;
                    const resp = await fetch('/api/faces', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ nrp, samples, forceReplace: true })
                    }).then(r => r.json());
                    // if (resp.ok) { UI.toastTop(`Rekam selesai (${resp.saved})`, 'success'); }
                    // else if (resp.reason === 'exists') { UI.toastTop('Dataset sudah ada. Ulangi proses reset & rekam.', 'error'); }
                    // else { UI.toastTop('Gagal menyimpan', 'error'); }
                    if (resp.ok) {
                        UI.toastTop(`Rekam selesai (${resp.saved})`, 'success');
                        btnRecStart.disabled = false;   // boleh rekam lagi
                    } else if (resp.reason === 'exists') {
                        UI.toastTop('Dataset sudah ada. Ulangi proses reset & rekam.', 'error');
                    } else {
                        UI.toastTop('Gagal menyimpan', 'error');
                    }
                    saving = false;
                    btnSave.classList.remove('loading');
                    btnRedo.disabled = false;
                });
            }

            let saved = 0; const samples = [];
            let recording = false;
            let saving = false;
            let lastDet = 0; const DET_MS = 120;
            // throttle pengambilan sampel (biar tidak terlalu rapat)
            let lastSampleAt = 0;
            const SAMPLE_MS = 600; // minimal 600ms antar sampel

            // batas kualitas untuk rekam wajah
            const MIN_DET_SCORE = 0.7; // confidence deteksi minimal
            const MIN_FACE_REL_HEIGHT = 0.25; // min 25% tinggi frame
            const MAX_FACE_REL_HEIGHT = 0.9;  // max 90% tinggi frame

            async function loop() {
                try {
                    const now = performance.now();
                    let dets = [];
                    if (now - lastDet >= DET_MS) {
                        dets = await faceapi
                            .detectAllFaces(video, TINY_OPTS)
                            .withFaceLandmarks()
                            .withFaceDescriptors();
                        lastDet = now;
                    }
                    FaceCommon.drawWithResize(video, overlay, dets);
                    //if (dets.length === 1 && saved < 15) {
                    // Ambil sampel hanya jika:
                    // - sedang mode recording
                    // - hanya 1 wajah di frame
                    // - belum mencapai 15 sampel
                    // - jeda minimal antar sampel terpenuhi
                    if (recording && dets.length === 1 && saved < 15 && (now - lastSampleAt >= SAMPLE_MS)) {
                        const det = dets[0];
                        const score = det.detection?.score || 0;

                        // 1) Tolak jika score deteksi terlalu rendah
                        if (score < MIN_DET_SCORE) {
                            // Optional: bisa kasih hint ringan, tapi jangan tiap frame biar nggak spam
                            // UI.toastTop('Mendekat sedikit ke kamera', 'warning');
                        } else {
                            // 2) Cek ukuran wajah relatif terhadap frame (supaya tidak terlalu kecil/jauh)
                            const box = det.detection.box;
                            const frameW = overlay.width || video.videoWidth || 0;
                            const frameH = overlay.height || video.videoHeight || 0;
                            const relH = frameH ? (box.height / frameH) : 0;

                            if (relH < MIN_FACE_REL_HEIGHT || relH > MAX_FACE_REL_HEIGHT) {
                                // Wajah terlalu kecil / terlalu dekat --> skip
                                // Optional: UI.toastTop('Posisikan wajah di tengah dan cukup dekat', 'warning');
                            } else {
                                // 3) (Opsional tapi sangat membantu) Cek apakah wajah ini milik
                                //    karyawan lain yang sudah terekam, untuk mencegah salah orang.
                                let bolehSimpan = true;
                                try {
                                    const descArr = Array.from(det.descriptor);
                                    const matchResp = await fetch('/api/match', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ descriptors: [descArr] })
                                    }).then(r => r.json());

                                    if (matchResp?.match && matchResp.match.nrp && matchResp.match.nrp !== nrp) {
                                        // Sistem mengenali wajah ini sebagai NRP lain → jangan simpan
                                        bolehSimpan = false;
                                        UI.toastTop(
                                            `Terlihat wajah milik ${matchResp.match.nama || matchResp.match.nrp}, bukan NRP ${nrp}`,
                                            'error'
                                        );
                                    }
                                } catch (e) {
                                    // Kalau /api/match error, tetap lanjut simpan supaya rekam tidak mogok
                                    console.warn('[rekam] match check failed, lanjut tanpa verifikasi', e);
                                }

                                if (bolehSimpan) {
                                    const frame = FaceCommon.grabFrame(video);
                                    samples.push({
                                        embedding: Array.from(det.descriptor),
                                        snapshotBase64: frame,
                                        mime: 'image/jpeg'
                                    });

                                    saved++;
                                    lastSampleAt = now;

                                    // Update counter & progress bar
                                    counter.textContent = `${saved} / 15`;
                                    const pb = document.getElementById('fakeProgressBar');
                                    if (pb) {
                                        pb.style.width = `${(saved / 15) * 100}%`;
                                    }
                                    //UI.speak(`Menyimpan sampel`);
                                    try {
                                        sndOk.currentTime = 0;   // mulai lagi dari awal
                                        sndOk.play();
                                    } catch (e) { }
                                    UI.toastTop(`Sample ${saved} tersimpan`, 'success');
                                }
                            }
                        }

                        // jeda kecil supaya user punya waktu sedikit mengubah pose
                        await new Promise(r => setTimeout(r, 450));
                    }
                    if (recording && saved >= 15) {
                        recording = false;
                        btnSave.disabled = false;
                    }
                } catch (err) {
                    console.error('[rekam] detect error', err);
                }
                if (saved < 15) requestAnimationFrame(loop);
                else {
                    //const resp = await fetch('/api/faces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nrp, samples }) }).then(r => r.json());
                    const resp = await fetch('/api/faces', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ nrp, samples, forceReplace: true })
                    }).then(r => r.json());
                    if (!resp.ok && resp.reason === 'exists') {
                        UI.toastTop('Wajah sudah terekam. Silakan ulangi proses (reset & rekam ulang).', 'error');
                        return;
                    }
                    if (resp.ok) { UI.toastTop(`Rekam selesai (${resp.saved})`, 'success'); UI.speak("Rekaman selesai. Silakan tekan tombol simpan."); }
                    else { UI.toastTop('Gagal menyimpan', 'error'); }

                }
            }
            loop();
        })();
    }
})();