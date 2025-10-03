(function () {
    const q = document.getElementById('q');
    const btn = document.getElementById('btnSearch');
    const rows = document.getElementById('rows');
    const list = document.getElementById('list');
    const meta = document.getElementById('meta');
    const prev = document.getElementById('prev');
    const next = document.getElementById('next');

    let page = 1, limit = 20, total = 0, busy = false, lastQ = '';

    function rowHTML(r) {
        return `<tr>
      <td class="font-mono">${r.nrp}</td>
      <td class="font-medium">${r.nama}</td>
      <td>${r.dep || '-'}</td>
      <td>${r.divisi || '-'}</td>
      <td>${r.jabatan || '-'}</td>
      <td><span class="badge">${r.status}</span></td>
    </tr>`;
    }
    function cardHTML(r) {
        return `<div class="card bg-base-100 shadow-sm">
      <div class="card-body p-3">
        <div class="font-medium">${r.nama}</div>
        <div class="text-xs opacity-70">${r.nrp}</div>
        <div class="mt-1 text-sm">${r.dep || '-'} / ${r.divisi || '-'}</div>
        <div class="text-sm">${r.jabatan || '-'}</div>
        <div class="mt-1"><span class="badge badge-ghost">${r.status}</span></div>
      </div>
    </div>`;
    }

    async function load() {
        if (busy) return; busy = true;
        rows.innerHTML = `<tr><td colspan="6" class="text-center">Memuat…</td></tr>`;
        list.innerHTML = `<div class="text-center text-sm opacity-70">Memuat…</div>`;
        const qstr = q.value.trim();
        const url = `/api/hr/karyawan?q=${encodeURIComponent(qstr)}&page=${page}&limit=${limit}`;
        try {
            const data = await fetch(url).then(r => r.json());
            total = Number(data.total || 0);
            const arr = Array.isArray(data.rows) ? data.rows : [];
            rows.innerHTML = arr.map(rowHTML).join('') || `<tr><td colspan="6" class="text-center">Tidak ada data</td></tr>`;
            list.innerHTML = arr.map(cardHTML).join('') || `<div class="text-center text-sm opacity-70">Tidak ada data</div>`;
            const from = total ? ((page - 1) * limit + 1) : 0;
            const to = Math.min(page * limit, total);
            meta.textContent = `${from}-${to} dari ${total}`;
            prev.disabled = page <= 1;
            next.disabled = page * limit >= total;
            lastQ = qstr;
        } catch (e) {
            rows.innerHTML = `<tr><td colspan="6" class="text-center text-error">Gagal memuat</td></tr>`;
            list.innerHTML = `<div class="text-center text-error">Gagal memuat</div>`;
            console.error(e);
        } finally { busy = false; }
    }

    // events
    btn.addEventListener('click', () => { page = 1; load(); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 1; load(); } });
    let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { page = 1; load(); }, 250); });
    prev.addEventListener('click', () => { if (page > 1) { page--; load(); } });
    next.addEventListener('click', () => { if (page * limit < total) { page++; load(); } });

    load();
})();
