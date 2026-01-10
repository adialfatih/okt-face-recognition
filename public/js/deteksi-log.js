(function () {
    const fltFrom = document.getElementById('fltFrom');
    const fltTo = document.getElementById('fltTo');
    const fltStatus = document.getElementById('fltStatus');
    const fltNrp = document.getElementById('fltNrp');
    const btnApply = document.getElementById('btnApply');
    const btnReset = document.getElementById('btnReset');
    const tbody = document.getElementById('logBody');
    const lblCount = document.getElementById('lblCount');
    const lblCountInline = document.getElementById('lblCountInline');

    const lblPctRecognized = document.getElementById('lblPctRecognized');
    const lblPctUnknown = document.getElementById('lblPctUnknown');
    const lblSummaryRange = document.getElementById('lblSummaryRange');

    function formatDateTime(iso) {
        if (!iso) return '-';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function formatDateShort(isoDate) {
        if (!isoDate) return '-';
        const [y, m, d] = isoDate.split('-');
        if (!y || !m || !d) return isoDate;
        return `${d}-${m}-${y}`;
    }

    function buildQuery() {
        const p = new URLSearchParams();
        p.set('context', 'absensi');
        const f = fltFrom.value;
        const t = fltTo.value;
        const s = fltStatus.value;
        const nrp = fltNrp.value.trim();

        if (f) p.set('tgl_from', f);
        if (t) p.set('tgl_to', t);
        if (s) p.set('status', s);
        if (nrp) p.set('nrp', nrp);
        p.set('limit', '200');
        return p.toString();
    }

    async function loadLogs() {
        const qs = buildQuery();
        tbody.innerHTML = `
      <tr><td colspan="7" class="text-center text-xs py-4 text-slate-400">Memuat data...</td></tr>
    `;
        try {
            const resp = await fetch('/api/deteksi-log?' + qs);
            const data = await resp.json();
            if (!data.ok) throw new Error('not ok');
            const rows = data.rows || [];
            lblCount.textContent = rows.length;
            lblCountInline.textContent = rows.length;

            if (!rows.length) {
                tbody.innerHTML = `
          <tr><td colspan="7" class="text-center text-xs py-4 text-slate-400">Belum ada data</td></tr>
        `;
                return;
            }

            tbody.innerHTML = '';
            let i = 1;
            for (const r of rows) {
                const tr = document.createElement('tr');

                const badgeClass =
                    r.status === 'recognized'
                        ? 'badge-success'
                        : r.status === 'ambiguous'
                            ? 'badge-warning'
                            : 'badge-error';

                const dist = typeof r.distance === 'number'
                    ? r.distance.toFixed(4)
                    : (r.distance ? Number(r.distance).toFixed(4) : '-');

                const imgUrl = `/api/deteksi-log/${r.id}/frame`;

                tr.innerHTML = `
          <td class="text-center align-top">${i++}</td>
          <td class="whitespace-nowrap align-top">${formatDateTime(r.created_at)}</td>
          <td class="align-top">
            <span class="font-mono text-[11px]">${r.nrp_detected || '-'}</span>
          </td>
          <td class="align-top">
            <div class="max-w-[160px] truncate" title="${r.kategori || '-'}">
              ${r.kategori || '-'}
            </div>
          </td>
          <td class="text-right align-top font-mono">${dist}</td>
          <td class="text-center align-top">
            <span class="badge badge-xs ${badgeClass}">${r.status}</span>
          </td>
          <td class="text-center align-top">
            <a href="${imgUrl}" target="_blank" class="link link-primary link-hover text-[11px]">Lihat</a>
          </td>
        `;

                tbody.appendChild(tr);
            }
        } catch (e) {
            console.error('[deteksi-log] load fail', e);
            tbody.innerHTML = `
      <tr><td colspan="7" class="text-center text-xs py-4 text-rose-500">Gagal memuat data</td></tr>
    `;
        }
    }

    async function loadSummary() {
        const qs = buildQuery(); // pakai filter yang sama (tgl, status, nrp)
        try {
            const resp = await fetch('/api/deteksi-log/summary?' + qs);
            const data = await resp.json();
            if (!data.ok) throw new Error('not ok');
            const rows = data.rows || [];
            if (!rows.length) {
                lblPctRecognized.textContent = '-';
                lblPctUnknown.textContent = '-';
                lblSummaryRange.textContent = '-';
                return;
            }

            // hitung rata-rata persentase recognized vs unknown per hari
            let sumPctRec = 0;
            let sumPctUnk = 0;
            let days = 0;
            let minDate = rows[0].tgl;
            let maxDate = rows[0].tgl;

            for (const r of rows) {
                const total = Number(r.total || 0);
                const rec = Number(r.recognized || 0);
                const unk = Number(r.unknown || 0);

                if (total > 0) {
                    const pctRec = (rec / total) * 100;
                    const pctUnk = (unk / total) * 100;
                    sumPctRec += pctRec;
                    sumPctUnk += pctUnk;
                    days++;
                }

                if (r.tgl < minDate) minDate = r.tgl;
                if (r.tgl > maxDate) maxDate = r.tgl;
            }

            if (days > 0) {
                const avgRec = sumPctRec / days;
                const avgUnk = sumPctUnk / days;
                lblPctRecognized.textContent = avgRec.toFixed(1);
                lblPctUnknown.textContent = avgUnk.toFixed(1);
            } else {
                lblPctRecognized.textContent = '-';
                lblPctUnknown.textContent = '-';
            }

            if (minDate === maxDate) {
                lblSummaryRange.textContent = formatDateShort(minDate);
            } else {
                lblSummaryRange.textContent = `${formatDateShort(minDate)} s/d ${formatDateShort(maxDate)}`;
            }
        } catch (e) {
            console.error('[deteksi-log] summary fail', e);
            lblPctRecognized.textContent = '-';
            lblPctUnknown.textContent = '-';
            lblSummaryRange.textContent = '-';
        }
    }

    async function reloadAll() {
        await loadLogs();
        await loadSummary();
    }

    if (btnApply) btnApply.addEventListener('click', () => reloadAll());
    if (btnReset) btnReset.addEventListener('click', () => {
        fltFrom.value = '';
        fltTo.value = '';
        fltStatus.value = '';
        fltNrp.value = '';
        reloadAll();
    });

    // auto set tgl hari ini untuk awal
    try {
        const today = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
        fltFrom.value = iso;
        fltTo.value = iso;
    } catch (e) { }

    reloadAll();
})();
