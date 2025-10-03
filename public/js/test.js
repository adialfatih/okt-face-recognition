(async function () {
    const video = document.getElementById('video');
    const overlay = document.getElementById('overlay');
    //const info = document.getElementById('info');
    const infoCard = document.getElementById('infoCard');
    const btnSwitch = document.getElementById('btnSwitchCam');

    await FaceCommon.loadModels();
    await FaceCommon.startCamera(video);
    //setTimeout(() => FaceCommon.resizeCanvasToVideo(video, overlay), 200);
    const doSync = () => FaceCommon.syncCanvasToDisplay(video, overlay);
    video.addEventListener('loadedmetadata', doSync);
    window.addEventListener('resize', doSync);
    setTimeout(doSync, 200);
    const DET_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.5 });

    if (btnSwitch) {
        btnSwitch.addEventListener('click', async () => {
            const cams = await FaceCommon.listCameras();
            const curId = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
            let idx = Math.max(0, cams.findIndex(c => c.deviceId === curId));
            idx = (idx + 1) % cams.length;
            await FaceCommon.switchCamera(video, cams[idx].deviceId);
            setTimeout(() => FaceCommon.resizeCanvasToVideo(video, overlay), 200);
        });
    }

    async function loop() {
        //const dets = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
        //.withFaceLandmarks().withFaceDescriptors();
        // const dets = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        //     .withFaceLandmarks().withFaceDescriptors();
        // const dets = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        //     .withFaceLandmarks().withFaceDescriptors();
        //FaceCommon.drawDetections(overlay, dets);
        // FaceCommon.drawWithResize(video, overlay, dets);
        // if (dets.length === 1) {
        //     const desc = Array.from(dets[0].descriptor);
        //     const r = await fetch('/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ descriptors: [desc] }) }).then(r => r.json());
        //     if (r.match) {
        //         const m = r.match;
        //         info.innerHTML = `<div class="badge badge-success">${m.nrp} - ${m.nama} • ${m.dep}/${m.divisi} • ${m.jabatan}</div>`;
        //     } else {
        //         info.innerHTML = `<div class="badge badge-error">Wajah tidak terdeteksi dalam database</div>`;
        //     }
        // } else if (dets.length === 0) {
        //     info.innerHTML = `<div class="badge">Arahkan wajah ke kamera</div>`;
        // } else {
        //     info.innerHTML = `<div class="badge badge-warning">Hanya 1 wajah</div>`;
        // }
        const dets = await faceapi
            .detectAllFaces(video, DET_OPTS)
            .withFaceLandmarks()
            .withFaceDescriptors();

        // Gambar bbox + landmarks yang sudah di-resize agar pas dengan tampilan
        FaceCommon.drawWithResize(video, overlay, dets);

        // Render info overlay (pojok kiri bawah) — hanya saat 1 wajah terdeteksi
        if (dets.length === 1) {
            const desc = Array.from(dets[0].descriptor);
            const r = await fetch('/api/match', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ descriptors: [desc] })
            }).then(r => r.json());

            if (r.match) {
                const m = r.match;
                infoCard.innerHTML = `<div class="bg-base-100/80 backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow-md leading-snug">
      <div class="font-semibold mb-1">✅ Wajah Terdeteksi</div>
      <div class="grid grid-cols-[92px_8px_1fr] sm:grid-cols-[110px_10px_1fr] gap-y-0.5 items-start">
        <div class="text-base-content/70">Nama</div><div>:</div>
        <div class="font-medium break-words">${m.nama}</div>

        <div class="text-base-content/70">NRP</div><div>:</div>
        <div class="font-medium">${m.nrp}</div>

        <div class="text-base-content/70">Departement</div><div>:</div>
        <div class="font-medium break-words">${m.dep || '-'}</div>

        <div class="text-base-content/70">Divisi</div><div>:</div>
        <div class="font-medium break-words">${m.divisi || '-'}</div>

        <div class="text-base-content/70">Jabatan</div><div>:</div>
        <div class="font-medium break-words">${m.jabatan || '-'}</div>
      </div>
    </div>
        `;
            } else {
                infoCard.innerHTML = `
<div class="bg-error/80 text-error-content backdrop-blur-sm rounded-box p-2 sm:p-3 text-xs sm:text-sm shadow-md">
⛔ Wajah tidak terdeteksi dalam database
</div>
        `;
            }
        } else {
            // 0 wajah atau >1 wajah → sembunyikan kartu biar tidak mengganggu
            infoCard.innerHTML = '';
        }
        requestAnimationFrame(loop);
    }
    loop();
})();