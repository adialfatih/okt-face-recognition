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
    function grabFrame(video) {
        const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
        const ctx = c.getContext('2d'); ctx.drawImage(video, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.85);
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
        const displaySize = { width: video.clientWidth || video.videoWidth, height: video.clientHeight || video.videoHeight };
        faceapi.matchDimensions(canvas, displaySize);
        const resized = faceapi.resizeResults(rawDetections, displaySize);
        drawDetections(canvas, resized);
    }
    return { loadModels, startCamera, switchCamera, listCameras, stopStream, grabFrame, syncCanvasToDisplay, drawDetections, drawWithResize };

})();