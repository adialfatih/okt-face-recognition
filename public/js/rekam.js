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

    // ==== Capture page logic ====
    //
    // Rekam wajah tetap 1 wajah (pendaftaran 1 NRP). Tampilan disamakan dengan
    // Absensi v2 / Test: kotak HIJAU = siap/diambil, MERAH + alasan = belum bisa.
    // Sampel diambil per langkah pose (POSE_STEPS) supaya data wajah bervariasi
    // — v2 mengenali wajah yang lebih kecil & agak miring, jadi data yang isinya
    // hanya wajah lurus & dekat kurang cocok.
    const nrp = (window.__NRP__ || '').trim();
    const video = document.getElementById('video');
    const overlay = document.getElementById('overlay');
    const counter = document.getElementById('counter');
    const btnSwitch = document.getElementById('btnSwitchCam');
    const btnRecStart = document.getElementById('btnRecStart');
    const recStatus = document.getElementById('recStatus');
    const btnSave = document.getElementById('btnSave');
    const btnRedo = document.getElementById('btnRedo');
    const poseHint = document.getElementById('poseHint');
    const progressBar = document.getElementById('fakeProgressBar');

    if (nrp && video) {
        (async function () {
            const TARGET = 15;
            // 5 langkah × 3 sampel. minRel/maxRel = tinggi wajah relatif terhadap
            // tinggi frame VIDEO (bukan tinggi tampilan di layar).
            const POSE_STEPS = [
                { text: 'Lihat lurus ke kamera', minRel: 0.18, maxRel: 0.80 },
                { text: 'Tengok sedikit ke kiri', minRel: 0.18, maxRel: 0.80 },
                { text: 'Tengok sedikit ke kanan', minRel: 0.18, maxRel: 0.80 },
                { text: 'Angkat dagu sedikit, lalu sedikit menunduk', minRel: 0.18, maxRel: 0.80 },
                { text: 'Mundur ±1 langkah, lihat lurus ke kamera', minRel: 0.10, maxRel: 0.35 }
            ];
            const PER_STEP = TARGET / POSE_STEPS.length;
            const STEP_PAUSE_MS = 1500;          // jeda baca instruksi pose berikutnya
            const SAMPLE_GAP_MS = 500;           // jarak minimal antar sampel
            const DET_MS = 150;
            const DET_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
            const MIN_DET_SCORE = 0.6;
            // Sampel baru ditolak bila terlalu jauh dari rata-rata sampel sebelumnya:
            // mencegah wajah orang lain ikut tersimpan ke NRP ini di tengah rekaman.
            // Orang yang sama (beda pose) umumnya < 0.45; orang berbeda > 0.6.
            const CONSISTENCY_MAX = 0.55;

            const COLOR_OK = '#22c55e';
            const COLOR_WAIT = '#ef4444';

            await FaceCommon.loadModels();
            await FaceCommon.startCamera(video);

            // Data lama TIDAK dihapus di sini: POST /api/faces dengan forceReplace
            // mengganti data lama dalam satu transaksi saat tombol Simpan ditekan.
            let replaceConfirmed = false;
            const cnt = await fetch('/api/faces/count?nrp=' + encodeURIComponent(nrp)).then(r => r.json());
            if (Number(cnt.count || 0) > 0) {
                const yes = window.confirm(`Wajah untuk NRP ${nrp} sudah terekam (${cnt.count} sampel). Data lama akan DIGANTI setelah rekaman baru disimpan. Lanjut?`);
                if (!yes) {
                    UI.toastTop('Rekam dibatalkan', 'error');
                    return;
                }
                replaceConfirmed = true;
            }

            const doSync = () => FaceCommon.syncCanvasToDisplay(video, overlay);
            video.addEventListener('loadedmetadata', doSync);
            window.addEventListener('resize', doSync);
            setTimeout(doSync, 200);

            // ==== STATE ====
            const samples = [];          // [{embedding, snapshotBase64, mime}]
            let recording = false;
            let saving = false;
            let savedToDb = false;
            let verifiedSelf = false;
            let checkingSelf = false;
            let lastSampleAt = 0;
            let stepReadyAt = 0;         // performance.now() saat pose berikutnya mulai diambil
            let lastDet = 0;
            let rejectNote = '';         // alasan penolakan terakhir (ditampilkan di label)
            let rejectNoteUntil = 0;

            function currentStep() {
                return POSE_STEPS[Math.min(POSE_STEPS.length - 1, Math.floor(samples.length / PER_STEP))];
            }

            function setPoseHint(html) {
                if (poseHint) poseHint.innerHTML = html;
            }

            function updateProgress() {
                const n = samples.length;
                counter.textContent = `${n} / ${TARGET}`;
                if (progressBar) progressBar.style.width = `${(n / TARGET) * 100}%`;
                if (!recording && n < TARGET) {
                    setPoseHint('Tekan <b>Mulai Rekam</b> bila wajah sudah berada di kotak hijau.');
                } else if (n >= TARGET) {
                    setPoseHint('✅ <b>15 sampel lengkap.</b> Tekan <b>Simpan ke Database</b>.');
                } else {
                    const stepIdx = Math.floor(n / PER_STEP) + 1;
                    setPoseHint(`Langkah ${stepIdx}/${POSE_STEPS.length}: <b>${currentStep().text}</b>`);
                }
            }

            function setRedoVisible(on) {
                if (!btnRedo) return;
                btnRedo.classList.toggle('hidden', !on);
                btnRedo.style.display = on ? '' : 'none';
            }

            function playOk() {
                try { sndOk.currentTime = 0; sndOk.play(); } catch (e) { }
            }

            function startRecording() {
                samples.length = 0;
                verifiedSelf = false;
                checkingSelf = false;
                savedToDb = false;
                lastSampleAt = 0;
                stepReadyAt = performance.now() + 800;
                recording = true;
                btnSave.disabled = true;
                btnSave.classList.remove('loading');
                btnRecStart.disabled = true;
                setRedoVisible(true);
                updateProgress();
            }

            function euclidean(a, b) {
                let s = 0;
                for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
                return Math.sqrt(s);
            }

            function distanceToMean(desc) {
                if (!samples.length) return 0;
                const mean = new Array(desc.length).fill(0);
                for (const s of samples) for (let i = 0; i < desc.length; i++) mean[i] += s.embedding[i];
                for (let i = 0; i < mean.length; i++) mean[i] /= samples.length;
                return euclidean(desc, mean);
            }

            function reject(note) {
                rejectNote = note;
                rejectNoteUntil = performance.now() + 1500;
            }

            // Sampel pertama dicek ke server: wajah ini bukan milik NRP lain?
            async function verifySelf(desc) {
                checkingSelf = true;
                try {
                    const r = await fetch('/api/match', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ descriptors: [desc] })
                    }).then(res => res.json());
                    if (r?.match && r.match.nrp && r.match.nrp !== nrp) {
                        reject(`Bukan NRP ini: ${r.match.nama || r.match.nrp}`);
                        UI.toastTop(`Terlihat wajah milik ${r.match.nama || r.match.nrp}, bukan NRP ${nrp}`, 'error');
                        return false;
                    }
                    verifiedSelf = true;
                    return true;
                } catch (e) {
                    console.warn('[rekam] match check failed, lanjut tanpa verifikasi', e);
                    verifiedSelf = true;
                    return true;
                } finally {
                    checkingSelf = false;
                }
            }

            async function takeSample(det, now) {
                const desc = Array.from(det.descriptor);

                if (!verifiedSelf) {
                    if (checkingSelf) return;
                    const ok = await verifySelf(desc);
                    if (!ok) return;
                }

                const dist = distanceToMean(desc);
                if (dist > CONSISTENCY_MAX) {
                    reject('Wajah berbeda dari sampel sebelumnya');
                    return;
                }

                const stepBefore = Math.floor(samples.length / PER_STEP);
                samples.push({
                    embedding: desc,
                    snapshotBase64: FaceCommon.grabFrame(video, { maxEdge: 960, quality: 0.82 }),
                    mime: 'image/jpeg'
                });
                lastSampleAt = now;
                playOk();

                if (samples.length >= TARGET) {
                    recording = false;
                    btnSave.disabled = false;
                    UI.toastTop('15 sampel lengkap, silakan Simpan', 'success');
                } else if (Math.floor(samples.length / PER_STEP) !== stepBefore) {
                    // Ganti pose: beri jeda supaya operator sempat membaca instruksi.
                    stepReadyAt = now + STEP_PAUSE_MS;
                }
                updateProgress();
            }

            /** Tentukan status satu wajah: { ok, label } untuk warna & teks kotak. */
            function assess(det, faceCount, now) {
                if (faceCount > 1) return { ok: false, label: 'Hanya 1 wajah di depan kamera' };
                const step = recording ? currentStep() : POSE_STEPS[0];
                const relH = det.detection.box.height / video.videoHeight;
                if (det.detection.score < MIN_DET_SCORE) return { ok: false, label: 'Wajah kurang jelas' };
                if (relH < step.minRel) return { ok: false, label: 'Mendekat ke kamera' };
                if (relH > step.maxRel) return { ok: false, label: recording && step.maxRel < 0.5 ? 'Mundur sedikit lagi' : 'Terlalu dekat' };
                if (now < rejectNoteUntil) return { ok: false, label: rejectNote };
                if (!recording) {
                    return samples.length >= TARGET
                        ? { ok: true, label: 'Selesai — silakan Simpan' }
                        : { ok: true, label: 'Siap — tekan Mulai Rekam' };
                }
                if (now < stepReadyAt) return { ok: true, label: currentStep().text };
                return { ok: true, label: `Sampel ${samples.length + 1}/${TARGET}` };
            }

            function draw(dets, states) {
                const ctx = overlay.getContext('2d');
                const cw = overlay.width, ch = overlay.height;
                if (!cw || !ch) return;
                ctx.clearRect(0, 0, cw, ch);
                const sx = cw / video.videoWidth, sy = ch / video.videoHeight;
                const px = Math.max(12, Math.round(cw / 45));

                dets.forEach((d, i) => {
                    const b = d.detection.box;
                    const x = b.x * sx, y = b.y * sy, w = b.width * sx, h = b.height * sy;
                    const color = states[i].ok ? COLOR_OK : COLOR_WAIT;
                    ctx.lineWidth = 3;
                    ctx.strokeStyle = color;
                    ctx.strokeRect(x, y, w, h);

                    const label = states[i].label || '';
                    ctx.font = `600 ${px}px Inter, system-ui, sans-serif`;
                    const lw = ctx.measureText(label).width + 10;
                    const lh = px + 8;
                    const ly = y - lh >= 0 ? y - lh : y;
                    const lx = Math.min(Math.max(0, x - 1.5), Math.max(0, cw - lw));
                    ctx.fillStyle = color;
                    ctx.fillRect(lx, ly, lw, lh);
                    ctx.fillStyle = '#ffffff';
                    ctx.textBaseline = 'top';
                    ctx.fillText(label, lx + 5, ly + 4);
                });
            }

            async function processFrame() {
                if (!video.videoWidth || !video.videoHeight) return;
                if (!overlay.width || !overlay.height) doSync();

                const dets = await faceapi
                    .detectAllFaces(video, DET_OPTS)
                    .withFaceLandmarks()
                    .withFaceDescriptors();
                const now = performance.now();
                const states = dets.map(d => assess(d, dets.length, now));
                draw(dets, states);

                if (!recording || saving || dets.length !== 1 || !states[0].ok) return;
                if (now < stepReadyAt || now - lastSampleAt < SAMPLE_GAP_MS) return;
                await takeSample(dets[0], now);
            }

            async function loop() {
                const now = performance.now();
                if (now - lastDet >= DET_MS) {
                    lastDet = now;
                    try {
                        await processFrame();
                    } catch (err) {
                        console.error('[rekam] detect error', err);
                    }
                }
                requestAnimationFrame(loop);
            }

            // ==== TOMBOL ====
            if (btnSwitch) {
                btnSwitch.addEventListener('click', async () => {
                    const cams = await FaceCommon.listCameras();
                    if (!cams.length) return;
                    const curId = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
                    let idx = Math.max(0, cams.findIndex(c => c.deviceId === curId));
                    idx = (idx + 1) % cams.length;
                    await FaceCommon.switchCamera(video, cams[idx].deviceId);
                    setTimeout(doSync, 200);
                });
            }

            if (btnRecStart) {
                btnRecStart.addEventListener('click', async () => {
                    if (recording || saving) return;
                    if (!replaceConfirmed) {
                        const c = await fetch('/api/faces/count?nrp=' + encodeURIComponent(nrp)).then(r => r.json());
                        if (Number(c.count || 0) > 0) {
                            const yes = window.confirm(`Wajah untuk NRP ${nrp} sudah terekam (${c.count} sampel). Data lama akan DIGANTI setelah rekaman baru disimpan. Lanjut?`);
                            if (!yes) { UI.toastTop('Rekam dibatalkan', 'error'); return; }
                            replaceConfirmed = true;
                        }
                    }
                    startRecording();
                });
            }

            if (btnRedo) {
                btnRedo.addEventListener('click', () => {
                    if (saving) return;
                    startRecording();
                });
            }

            if (btnSave) {
                btnSave.addEventListener('click', async () => {
                    if (saving) return;
                    if (samples.length < TARGET) {
                        UI.toastTop(`Belum mencapai ${TARGET} sampel`, 'error');
                        return;
                    }

                    saving = true;
                    btnSave.disabled = true;
                    btnSave.classList.add('loading');
                    if (btnRedo) btnRedo.disabled = true;
                    if (recStatus) recStatus.classList.remove('hidden');

                    try {
                        const resp = await fetch('/api/faces', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ nrp, samples, forceReplace: true })
                        }).then(r => r.json());

                        if (resp.ok) {
                            savedToDb = true;
                            replaceConfirmed = false; // rekam berikutnya mengganti data yang baru disimpan → konfirmasi lagi
                            UI.toastTop(`Rekam selesai (${resp.saved} sampel tersimpan)`, 'success');
                            setPoseHint('✅ <b>Tersimpan.</b> Perangkat Absensi v2 perlu dibuka ulang saat online agar wajah ini dikenali.');
                            btnRecStart.disabled = false;
                        } else {
                            UI.toastTop(resp.error || 'Gagal menyimpan', 'error');
                            btnSave.disabled = false;
                        }
                    } catch (e) {
                        console.error('[rekam] save fail', e);
                        UI.toastTop('Gagal menyimpan (jaringan)', 'error');
                        btnSave.disabled = false;
                    } finally {
                        saving = false;
                        btnSave.classList.remove('loading');
                        if (btnRedo) btnRedo.disabled = false;
                        if (recStatus) recStatus.classList.add('hidden');
                    }
                });
            }

            // Peringatan bila meninggalkan halaman dengan rekaman yang belum disimpan.
            window.addEventListener('beforeunload', (e) => {
                if (samples.length > 0 && !savedToDb) {
                    e.preventDefault();
                    e.returnValue = '';
                }
            });

            setRedoVisible(false);
            updateProgress();
            loop();
        })();
    }
})();