/**
 * offline-session.js — login/logout lokal saat server tidak bisa dijangkau.
 *
 * Catatan: offline login hanya mengaktifkan kembali session user yang pernah
 * login online dan masih tersimpan di IndexedDB.
 */
(function () {
    function hasOfflineDB() {
        return typeof OfflineDB !== 'undefined';
    }

    async function canReachServer() {
        if (!navigator.onLine) return false;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        try {
            const resp = await fetch(`/login?offline_session_check=${Date.now()}`, {
                method: 'GET',
                cache: 'no-store',
                signal: controller.signal
            });
            return resp.ok;
        } catch (e) {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    async function getCachedSession() {
        if (!hasOfflineDB()) return null;
        await OfflineDB.open();
        const session = await OfflineDB.getMeta('session');
        if (!session || !session.user || !session.expiresAt) return null;
        if (Date.now() > Number(session.expiresAt)) return null;
        return session;
    }

    async function getOfflineReady() {
        if (!hasOfflineDB()) return false;
        const [embCount, profileCount] = await Promise.all([
            OfflineDB.getMeta('embCount'),
            OfflineDB.getMeta('profileCount')
        ]);
        return Number(embCount || 0) > 0 && Number(profileCount || 0) > 0;
    }

    function showLoginError(message) {
        const root = document.getElementById('loginOfflineMessage');
        if (!root) {
            alert(message);
            return;
        }
        root.innerHTML = `
      <div class="alert alert-error py-2 text-sm">
        <i class="fa-solid fa-circle-exclamation"></i>
        <span>${message}</span>
      </div>`;
    }

    async function handleLoginSubmit(event) {
        const online = await canReachServer();
        if (online) return;

        event.preventDefault();

        try {
            const form = event.currentTarget;
            const username = (form.elements.username?.value || '').trim();
            const session = await getCachedSession();
            const ready = await getOfflineReady();

            if (!session || !ready) {
                showLoginError('Offline login belum bisa digunakan. Login online dan buka halaman absensi sekali untuk download data offline.');
                return;
            }

            if (username && username !== session.user.username) {
                showLoginError(`Offline login hanya tersedia untuk user terakhir: ${session.user.username}.`);
                return;
            }

            await OfflineDB.setMeta('offlineLoggedOut', false);
            window.location.href = '/absensi';
        } catch (e) {
            console.warn('[offline-session] login failed:', e);
            showLoginError('Offline login gagal. Coba buka aplikasi saat online untuk refresh data.');
        }
    }

    async function handleLogoutSubmit(event) {
        const online = await canReachServer();
        if (online) return;

        event.preventDefault();

        try {
            if (hasOfflineDB()) {
                await OfflineDB.open();
                await OfflineDB.setMeta('offlineLoggedOut', true);
            }
        } catch (e) {
            console.warn('[offline-session] logout failed:', e);
        }

        window.location.href = '/login';
    }

    async function syncOfflineLogout() {
        try {
            if (!hasOfflineDB()) return;
            await OfflineDB.open();
            const offlineLoggedOut = await OfflineDB.getMeta('offlineLoggedOut');
            if (offlineLoggedOut !== true) return;

            const online = await canReachServer();
            if (!online) return;

            await fetch('/logout', {
                method: 'POST',
                credentials: 'same-origin'
            });
            await OfflineDB.setMeta('offlineLoggedOut', false);
        } catch (e) {
            console.warn('[offline-session] sync logout failed:', e);
        }
    }

    function init() {
        const loginForm = document.querySelector('form[data-offline-login="true"]');
        if (loginForm) {
            loginForm.addEventListener('submit', handleLoginSubmit);
        }

        document.querySelectorAll('form[data-offline-logout="true"]').forEach(form => {
            form.addEventListener('submit', handleLogoutSubmit);
        });

        syncOfflineLogout();
    }

    document.addEventListener('DOMContentLoaded', init);
    window.addEventListener('online', syncOfflineLogout);
})();
