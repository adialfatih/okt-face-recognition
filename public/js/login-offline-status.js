/**
 * login-offline-status.js — indikator online/offline dan kesiapan data offline.
 */
(function () {
    const root = document.getElementById('loginOfflineStatus');
    if (!root) return;

    function formatSyncTime(value) {
        if (!value) return '-';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return '-';
        return d.toLocaleString('id-ID', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    async function canReachServer() {
        if (!navigator.onLine) return false;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        try {
            const resp = await fetch(`/login?online_check=${Date.now()}`, {
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

    async function getOfflineMeta() {
        try {
            if (typeof OfflineDB === 'undefined') return null;
            await OfflineDB.open();
            const [lastSyncAt, embCount, profileCount] = await Promise.all([
                OfflineDB.getMeta('lastSyncAt'),
                OfflineDB.getMeta('embCount'),
                OfflineDB.getMeta('profileCount')
            ]);
            return {
                lastSyncAt,
                embCount: Number(embCount || 0),
                profileCount: Number(profileCount || 0)
            };
        } catch (e) {
            return null;
        }
    }

    function render({ online, meta, checking }) {
        const ready = meta && meta.embCount > 0 && meta.profileCount > 0;
        const tone = online ? 'alert-success' : (ready ? 'alert-warning' : 'alert-error');
        const icon = online ? 'fa-wifi' : (ready ? 'fa-wifi-slash' : 'fa-triangle-exclamation');
        const title = checking
            ? 'Memeriksa koneksi...'
            : online
                ? 'Online'
                : ready
                    ? 'Offline - aplikasi bisa digunakan dalam mode offline'
                    : 'Offline - data offline belum siap';

        const detail = ready
            ? `${meta.profileCount} karyawan / ${meta.embCount} wajah • Sync ${formatSyncTime(meta.lastSyncAt)}`
            : 'Buka halaman absensi saat online untuk download data master ke device ini.';

        root.innerHTML = `
      <div class="alert ${tone} py-2 text-xs items-start">
        <i class="fa-solid ${icon} mt-0.5"></i>
        <div>
          <div class="font-semibold">${title}</div>
          <div class="opacity-80">${detail}</div>
        </div>
      </div>`;
    }

    async function refresh() {
        render({ online: false, meta: null, checking: true });
        const [online, meta] = await Promise.all([
            canReachServer(),
            getOfflineMeta()
        ]);
        render({ online, meta, checking: false });
    }

    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refresh();
    });

    refresh();
    setInterval(refresh, 10000);
})();
