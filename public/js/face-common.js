const FaceCommon = (function () {
    // async function loadModels() {
    //     // const base = '/public/models';
    //     // await faceapi.nets.tinyFaceDetector.loadFromUri(base);
    //     // await faceapi.nets.faceLandmark68Net.loadFromUri(base);
    //     // await faceapi.nets.faceRecognitionNet.loadFromUri(base);
    //     const base = 'https://justadudewhohacks.github.io/face-api.js/models';
    //     if (window.tf) {
    //         try {
    //             await tf.setBackend('webgl');
    //             await tf.ready();
    //         } catch (e) { console.warn('[tf] backend set failed, fallback default', e); }
    //     }
    //     await faceapi.nets.tinyFaceDetector.loadFromUri(base);
    //     await faceapi.nets.faceLandmark68Net.loadFromUri(base);
    //     await faceapi.nets.faceRecognitionNet.loadFromUri(base);
    // }
    async function loadModels() {
        const localBase = '/public/models';
        const onlineBase = 'https://justadudewhohacks.github.io/face-api.js/models';

        if (window.tf) {
            try {
                await tf.setBackend('webgl');
                await tf.ready();
            } catch (e) {
                console.warn('[tf] backend set failed, fallback default', e);
            }
        }

        try {
            // Coba load dari model lokal dulu
            await Promise.all([
                faceapi.nets.tinyFaceDetector.loadFromUri(localBase),
                faceapi.nets.faceLandmark68Net.loadFromUri(localBase),
                faceapi.nets.faceRecognitionNet.loadFromUri(localBase),
            ]);
            console.log('[face] models loaded from LOCAL', localBase);
        } catch (err) {
            console.error('[face] gagal load model lokal, fallback ke ONLINE', err);
            // Fallback terakhir ke model online (biar app tidak blank kalau ada file hilang)
            await Promise.all([
                faceapi.nets.tinyFaceDetector.loadFromUri(onlineBase),
                faceapi.nets.faceLandmark68Net.loadFromUri(onlineBase),
                faceapi.nets.faceRecognitionNet.loadFromUri(onlineBase),
            ]);
        }
    }

    function stopStream(video) {
        try {
            const s = video.srcObject;
            if (s && s.getTracks) s.getTracks().forEach(t => t.stop());
            video.srcObject = null;
        } catch (e) { console.warn('[camera] stopStream', e); }
    }
    async function startCamera(video, opts = {}) {
        let stream;
        try {
            const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
            const videoConst = opts.deviceId
                ? { deviceId: { exact: opts.deviceId }, ...base }
                : { facingMode: { ideal: 'user' }, ...base }; // ← utamakan kamera depan
            stream = await navigator.mediaDevices.getUserMedia({ video: videoConst, audio: false });
        } catch (e) {
            console.warn('[camera] fallback default constraints', e);
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        video.srcObject = stream; await video.play();
        return stream;
    }
    async function listCameras() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(d => d.kind === 'videoinput');
    }
    async function switchCamera(video, deviceId) {
        stopStream(video);
        return await startCamera(video, { deviceId });
    }
    /**
     * Ambil snapshot dari video sebagai data URI JPEG.
     *
     * Dulu ini meng-encode frame penuh 1280x720 pada kualitas 0.85 → ±300KB per
     * absensi. String sebesar itu ikut mengendap di antrian IndexedDB dan membuat
     * batch upload menembus limit body server. Sekarang frame diperkecil dulu.
     *
     * @param {HTMLVideoElement} video
     * @param {{maxEdge?: number, quality?: number}} opts
     */
    function grabFrame(video, opts = {}) {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return null;

        const maxEdge = Number(opts.maxEdge) || 640;
        const quality = Number(opts.quality) || 0.72;

        const scale = Math.min(1, maxEdge / Math.max(vw, vh));
        const w = Math.max(1, Math.round(vw * scale));
        const h = Math.max(1, Math.round(vh * scale));

        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(video, 0, 0, w, h);
        const out = c.toDataURL('image/jpeg', quality);

        // Lepaskan backing store canvas tanpa menunggu GC.
        c.width = 0; c.height = 0;
        return out;
    }

    function syncCanvasToDisplay(video, canvas) {
        const w = video.clientWidth || video.videoWidth;
        const h = video.clientHeight || video.videoHeight;
        if (!w || !h) return { width: canvas.width, height: canvas.height };
        canvas.width = w; canvas.height = h;
        return { width: w, height: h };
    }
    function drawDetections(canvas, resizedDetections) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        resizedDetections.forEach(d => {
            const { x, y, width, height } = d.detection.box;
            ctx.strokeStyle = '#22c55e';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, width, height);
            const pts = d.landmarks.positions;
            ctx.beginPath();
            for (const p of pts) { ctx.rect(p.x, p.y, 1.2, 1.2); }
            ctx.stroke();
        });
    }
    function drawWithResize(video, canvas, rawDetections) {
        // JANGAN panggil faceapi.matchDimensions() di sini. Fungsi itu menulis
        // canvas.width/height, dan menulis dimensi canvas mengalokasikan ulang
        // backing store-nya. Dipanggil dari loop render, itu berarti realokasi
        // puluhan kali per detik di atas WebGL context TFJS — sumber crash renderer.
        // Dimensi canvas sudah disinkronkan lewat syncCanvasToDisplay() pada event
        // 'loadedmetadata' dan 'resize' saja.
        const width = canvas.width, height = canvas.height;
        if (!width || !height) return;
        const resized = faceapi.resizeResults(rawDetections, { width, height });
        drawDetections(canvas, resized);
    }
    return { loadModels, startCamera, switchCamera, listCameras, stopStream, grabFrame, syncCanvasToDisplay, drawDetections, drawWithResize };

})();