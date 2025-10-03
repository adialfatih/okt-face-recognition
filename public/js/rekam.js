(function () {
    const search = document.getElementById('search');
    //const suggest = document.getElementById('suggest');
    const btn = document.getElementById('btnStart');
    const selectedInfo = document.getElementById('selectedInfo');
    const selectedText = document.getElementById('selectedText');
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
                    const url = '/api/karyawan/search?q=' + encodeURIComponent(query);
                    return await fetch(url).then(r => r.json());
                },
                keys: ["nrp", "nama"]
            },
            resultsList: {
                class: "menu bg-base-100 mt-2 rounded-box shadow max-h-60 overflow-auto",
                maxResults: 10,
                noResults: true
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
        // let t;
        // search.addEventListener('input', async () => {
        //     const q = search.value.trim();
        //     if (q.length < 2) { suggest.classList.add('hidden'); suggest.innerHTML = ''; return; }
        //     selected = null;
        //     btn.classList.add('disabled');
        //     btn.setAttribute('href', '#');
        //     if (selectedInfo) { selectedInfo.classList.add('hidden'); }
        //     if (selectedText) { selectedText.textContent = ''; }
        //     clearTimeout(t); t = setTimeout(async () => {
        //         const rows = await fetch('/api/karyawan/search?q=' + encodeURIComponent(q)).then(r => r.json());
        //         suggest.innerHTML = rows.map(r => `<li><a data-nrp="${r.nrp}">${r.nrp} — ${r.nama}</a></li>`).join('');
        //         suggest.classList.remove('hidden');
        //     }, 200);
        // });
        // search.addEventListener('keydown', (e) => {
        //     if (e.key === 'Enter') {
        //         const first = suggest.querySelector('a[data-nrp]');
        //         if (first) { e.preventDefault(); first.click(); }
        //     }
        // });

        // suggest.addEventListener('click', (e) => {
        //     const a = e.target.closest('a[data-nrp]'); if (!a) return;
        //     const nrp = a.dataset.nrp;
        //     const label = a.textContent.trim();
        //     selected = { nrp, label };
        //     if (selectedInfo) selectedInfo.classList.remove('hidden');
        //     if (selectedText) selectedText.textContent = label;
        //     btn.classList.remove('disabled');
        //     btn.setAttribute('href', '/rekam/capture?nrp=' + encodeURIComponent(nrp));
        //     suggest.classList.add('hidden');
        // });
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
            //const DET_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

            //setTimeout(() => FaceCommon.resizeCanvasToVideo(video, overlay), 200);
            // const doSync = () => FaceCommon.syncCanvasToDisplay(video, overlay);
            // video.addEventListener('loadedmetadata', doSync);
            // window.addEventListener('resize', doSync);
            // setTimeout(doSync, 200);
            const TINY_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.5 });
            const doSync = () => FaceCommon.syncCanvasToDisplay(video, overlay);
            video.addEventListener('loadedmetadata', doSync);
            window.addEventListener('resize', doSync);
            setTimeout(doSync, 200);

            // if (btnSwitch) {
            //     btnSwitch.addEventListener('click', async () => {
            //         const cams = await FaceCommon.listCameras();
            //         const curId = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
            //         let idx = Math.max(0, cams.findIndex(c => c.deviceId === curId));
            //         idx = (idx + 1) % cams.length;
            //         await FaceCommon.switchCamera(video, cams[idx].deviceId);
            //         setTimeout(() => FaceCommon.resizeCanvasToVideo(video, overlay), 200);
            //     });
            // }
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
            async function loop() {
                try {
                    // const dets = await faceapi
                    //     .detectAllFaces(video, DET_OPTS)
                    //     .withFaceLandmarks()
                    //     .withFaceDescriptors();
                    // const dets = await faceapi
                    //     .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
                    //     .withFaceLandmarks()
                    //     .withFaceDescriptors();
                    //FaceCommon.drawDetections(overlay, dets);
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
                    if (recording && dets.length === 1 && saved < 15) {
                        const desc = dets[0].descriptor;
                        const frame = FaceCommon.grabFrame(video);
                        samples.push({ embedding: Array.from(desc), snapshotBase64: frame, mime: 'image/jpeg' });
                        saved++; counter.textContent = `${saved} / 15`;
                        UI.toastTop(`Sample ${saved} tersimpan`, 'success');
                        //if (saved % 3 === 0 || saved === 15) UI.toastTop(`Sample ${saved} tersimpan`, 'success');
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
                    if (resp.ok) { UI.toastTop(`Rekam selesai (${resp.saved})`, 'success'); }
                    else { UI.toastTop('Gagal menyimpan', 'error'); }

                }
            }
            loop();
        })();
    }
})();