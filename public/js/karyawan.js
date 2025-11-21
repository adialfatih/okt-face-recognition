(function () {
  const q = document.getElementById('q');
  const btn = document.getElementById('btnSearch');
  const rows = document.getElementById('rows');
  const list = document.getElementById('list');
  const meta = document.getElementById('meta');
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');
  const sumTotal = document.getElementById('sumTotal');
  const sumSpinning = document.getElementById('sumSpinning');
  const sumWeaving = document.getElementById('sumWeaving');

  let page = 1, limit = 20, total = 0, busy = false, lastQ = '';

  function buildStatusBadge(statusRaw) {
    const s = (statusRaw || '').toString().trim().toUpperCase();
    let cls = 'badge-status';

    if (s === 'TETAP') cls += ' tetap';
    else if (s === 'KONTRAK') cls += ' kontrak';
    else if (s === 'RESIGN') cls += ' resign';
    else if (s === 'MAGANG') cls += ' magang';

    return `<span class="${cls}">${s || '-'}</span>`;
  }
  function buildFaceStatusPill(r) {
    // hasFace: true/false dari backend
    if (r.hasFace) {
      return `
        <span class="face-pill face-ok" title="Wajah sudah terekam">
          <i class="fa-solid fa-user-check"></i>
          <span>Face OK</span>
        </span>
      `;
    }
    return `
      <span class="face-pill face-missing" title="Belum rekam wajah">
        <i class="fa-regular fa-user"></i>
        <span>Belum Rekam</span>
      </span>
    `;
  }

  function buildFaceIcon(r) {
    if (!r.hasFace) return '';
    return `
      <i class="fa-solid fa-user-check text-emerald-500 text-xs sm:text-sm ml-1"
         title="Wajah sudah terekam"></i>`;
  }

  function rowHTML(r) {
    return `
        <tr>
          <td class="font-mono text-xs sm:text-sm px-3 py-2 whitespace-nowrap">
            <span>${r.nrp}</span>
            ${buildFaceIcon(r)}
          </td>
          <td class="font-medium text-slate-900 px-3 py-2">${r.nama}</td>
          <td class="text-slate-700 px-3 py-2">${r.dep || '-'}</td>
          <td class="text-slate-700 px-3 py-2">${r.divisi || '-'}</td>
          <td class="text-slate-700 px-3 py-2">${r.jabatan || '-'}</td>
          <td class="px-3 py-2 text-right">
            ${buildStatusBadge(r.status)}
          </td>
        </tr>`;
  }


  function cardHTML(r) {
    const depDiv = `${r.dep || '-'} / ${r.divisi || '-'}`;
    const jab = r.jabatan || '-';
    return `
      <div class="card-karyawan">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
          <div>
            <h3>${r.nama}</h3>
            <p class="meta">
              NRP: ${r.nrp}
              ${buildFaceIcon(r)}
            </p>
            <p class="meta" style="margin-top:4px;">${depDiv}</p>
            <p class="meta">${jab}</p>
          </div>
          <div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:4px;color:#000;">
            ${buildStatusBadge(r.status)}
            ${buildFaceStatusPill(r)}
          </div>
        </div>
      </div>`;
  }



  async function load() {
    if (busy) return;
    busy = true;

    // simpan posisi scroll saat ini
    const scrollY = window.scrollY;

    rows.innerHTML = `<tr><td colspan="6" class="text-center text-slate-600 py-4">Memuat…</td></tr>`;
    list.innerHTML = `<div class="text-center text-sm text-slate-600">Memuat…</div>`;

    const qstr = q.value.trim();
    const url = `/api/hr/karyawan?q=${encodeURIComponent(qstr)}&page=${page}&limit=${limit}`;

    try {
      const data = await fetch(url).then(r => r.json());
      total = Number(data.total || 0);
      const arr = Array.isArray(data.rows) ? data.rows : [];
      // Update ringkasan (jika elemen ada)
      if (data.summary) {
        if (sumTotal) sumTotal.textContent = data.summary.total ?? total;
        if (sumSpinning) sumSpinning.textContent = data.summary.spinning ?? '-';
        if (sumWeaving) sumWeaving.textContent = data.summary.weaving ?? '-';
      } else {
        if (sumTotal) sumTotal.textContent = total;
        if (sumSpinning) sumSpinning.textContent = '-';
        if (sumWeaving) sumWeaving.textContent = '-';
      }


      rows.innerHTML =
        arr.map(rowHTML).join('') ||
        `<tr><td colspan="6" class="text-center text-slate-500 py-4">Tidak ada data</td></tr>`;

      list.innerHTML =
        arr.map(cardHTML).join('') ||
        `<div class="text-center text-sm text-slate-500">Tidak ada data</div>`;

      const from = total ? ((page - 1) * limit + 1) : 0;
      const to = Math.min(page * limit, total);
      meta.textContent = `${from}-${to} dari ${total}`;
      prev.disabled = page <= 1;
      next.disabled = page * limit >= total;
    }
    catch (e) {
      rows.innerHTML = `<tr><td colspan="6" class="text-center text-error py-4">Gagal memuat</td></tr>`;
      list.innerHTML = `<div class="text-center text-error">Gagal memuat</div>`;
      console.error(e);
    }
    finally {
      busy = false;

      // kembalikan posisi scroll
      setTimeout(() => {
        window.scrollTo({ top: scrollY, behavior: "instant" });
      }, 1);
    }
  }


  // events
  btn.addEventListener('click', () => { page = 1; load(); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 1; load(); } });
  let t;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { page = 1; load(); }, 250);
  });
  prev.addEventListener('click', () => { if (page > 1) { page--; load(); } });
  next.addEventListener('click', () => { if (page * limit < total) { page++; load(); } });

  load();
})();