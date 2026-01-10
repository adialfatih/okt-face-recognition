function speak(text) {
    try {
        if (!('speechSynthesis' in window)) return;

        // pilih voice bahasa Indonesia kalau ada
        const voices = speechSynthesis.getVoices();
        const indo = voices.find(v => v.lang === 'id-ID') || voices[0];

        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'id-ID';
        utter.voice = indo;
        utter.rate = 1;
        utter.pitch = 1;

        // stop antrian sebelumnya biar tidak double
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utter);

    } catch (e) {
        console.warn('[tts] gagal', e);
    }
}

function toastTop(msg, type = 'success') {
    const area = document.getElementById('toastArea');
    if (!area) return;

    const el = document.createElement('div');
    el.className = "toast-message";

    if (type === "success") {
        el.style.background = "rgba(16, 185, 129, 0.90)"; // green
    } else if (type === "error") {
        el.style.background = "rgba(239, 68, 68, 0.90)"; // red
    } else if (type === "warning") {
        el.style.background = "rgba(234, 179, 8, 0.90)"; // yellow
    }

    el.textContent = msg;

    area.appendChild(el);

    setTimeout(() => {
        el.style.transition = "opacity 0.4s ease";
        el.style.opacity = 0;
        setTimeout(() => el.remove(), 400);
    }, 1800);
}
function toastBottomInfo(html) {
    const el = document.getElementById('toastInfo');
    if (!el) return;
    el.innerHTML = `<div class="alert alert-info shadow">${html}</div>`;
    setTimeout(() => el.innerHTML = '', 2200);
}
window.UI = { toastTop, toastBottomInfo, speak };