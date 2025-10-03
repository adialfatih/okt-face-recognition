function toastTop(msg, type = 'success') {
    const el = document.getElementById('toastArea');
    el.innerHTML = `<div class="alert ${type === 'success' ? 'alert-success' : 'alert-error'} shadow">${msg}</div>`;
    setTimeout(() => el.innerHTML = '', 1800);
}
function toastBottomInfo(html) {
    const el = document.getElementById('toastInfo');
    if (!el) return;
    el.innerHTML = `<div class="alert alert-info shadow">${html}</div>`;
    setTimeout(() => el.innerHTML = '', 2200);
}
window.UI = { toastTop, toastBottomInfo };