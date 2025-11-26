// public/js/laporan-absensi.js

(function () {
    const tbody = document.getElementById('absensiBody');
    const lblCount = document.getElementById('absensiCount');
    const btnApply = document.getElementById('btnApplyFilter');
    const btnReset = document.getElementById('btnResetFilter');

    const fltTglFrom = document.getElementById('fltTglFrom');
    const fltTglTo = document.getElementById('fltTglTo');
    const fltNama = document.getElementById('fltNama');
    const fltNrp = document.getElementById('fltNrp');
    const fltDep = document.getElementById('fltDep');
    const fltDivisi = document.getElementById('fltDivisi');
    const fltJabatan = document.getElementById('fltJabatan');
    const fltKategori = document.getElementById('fltKategori');

    const modalDetail = document.getElementById('modalDetailAbsensi');
    const detNama = document.getElementById('detNama');
    const detNrp = document.getElementById('detNrp');
    const detTanggal = document.getElementById('detTanggal');
    const detKategori = document.getElementById('detKategori');
    //const detJam = document.getElementById('detJam');
    const detJamMasuk = document.getElementById('detJamMasuk');
    const detJamKeluar = document.getElementById('detJamKeluar');
    const detShift = document.getElementById('detShift');
    const detDep = document.getElementById('detDep');
    const detDivisi = document.getElementById('detDivisi');
    const detJabatan = document.getElementById('detJabatan');
    const detLate = document.getElementById('detLate');
    const detCreated = document.getElementById('detCreatedAt');
    const detPhoto = document.getElementById('detPhoto');
    const detNoPhoto = document.getElementById('detNoPhoto');

    let dt = null;

    function fmtTanggal(iso) {
        if (!iso) return '-';
        // kalau backend kirim '2025-11-25T00:00:00.000Z' → ambil 10 char pertama
        const d = iso.slice(0, 10);
        const [y, m, dd] = d.split('-');
        return `${dd}-${m}-${y}`;
    }
    function fmtDateTime(iso) {
        if (!iso) return '-';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        const dd = String(d.getDate()).padStart(2, '0');
        const mNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
        const mm = mNames[d.getMonth()];
        const yyyy = d.getFullYear();
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${dd} ${mm} ${yyyy} ${hh}:${mi}:${ss}`;
    }

    function fmtJam(j) {
        return j ? j.slice(0, 8) : '-';
    }

    function fmtDurasi(menit) {
        if (menit == null) return '-';
        const n = Number(menit);
        if (Number.isNaN(n)) return '-';
        const jam = Math.floor(n / 60);
        const m = n % 60;
        if (jam > 0) return `${jam}j ${m}m`;
        return `${m} menit`;
    }

    function fmtTerlambat(isLate, menit) {
        if (!isLate) return '-';
        const n = Number(menit || 0);
        if (!n) return 'Terlambat';
        return `Terlambat ${n} menit`;
    }

    function serializeFilter() {
        const p = new URLSearchParams();
        if (fltTglFrom && fltTglFrom.value) p.set('tgl_from', fltTglFrom.value);
        if (fltTglTo && fltTglTo.value) p.set('tgl_to', fltTglTo.value);
        if (fltNama && fltNama.value) p.set('nama', fltNama.value.trim());
        if (fltNrp && fltNrp.value) p.set('nrp', fltNrp.value.trim());
        if (fltDep && fltDep.value) p.set('dep', fltDep.value.trim());
        if (fltDivisi && fltDivisi.value) p.set('divisi', fltDivisi.value.trim());
        if (fltJabatan && fltJabatan.value) p.set('jabatan', fltJabatan.value.trim());
        if (fltKategori && fltKategori.value) p.set('kategori', fltKategori.value);
        return p.toString();
    }

    async function loadData() {
        if (!tbody) return;

        // Destroy DataTable sebelumnya jika ada
        if (window.jQuery && $.fn.DataTable && $.fn.DataTable.isDataTable('#tblAbsensi')) {
            $('#tblAbsensi').DataTable().clear().destroy();
        }

        tbody.innerHTML = `
            <tr>
                <td colspan="12" class="text-center text-xs text-slate-400 py-4">
                    Memuat data...
                </td>
            </tr>
        `;

        const qs = serializeFilter();
        let data;
        try {
            const resp = await fetch('/api/absensi/report?' + qs, { credentials: 'same-origin' });
            data = await resp.json();
        } catch (e) {
            console.error('[laporan-absensi] fetch fail', e);
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" class="text-center text-xs text-red-500 py-4">
                        Gagal memuat data
                    </td>
                </tr>
            `;
            return;
        }

        const rows = (data && data.rows) ? data.rows : [];
        if (lblCount) {
            lblCount.textContent = `Menampilkan ${rows.length} baris`;
        }

        if (!rows.length) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" class="text-center text-xs text-slate-400 py-4">
                        Tidak ada data untuk filter ini
                    </td>
                </tr>
            `;
        } else {
            tbody.innerHTML = rows.map(r => {
                const tanggal = fmtTanggal(r.tanggal);
                const jamMasuk = fmtJam(r.jam_masuk);
                const jamKeluar = fmtJam(r.jam_keluar);
                const durasi = fmtDurasi(r.durasi_menit);
                const terlambat = fmtTerlambat(r.is_late, r.menit_terlambat);

                const kat = r.kategori_masuk || r.kategori_keluar || '';

                return `
                <tr data-id-masuk="${r.id_masuk || ''}">
                    <td>${tanggal}</td>
                    <td>${r.nrp || ''}</td>
                    <td>${r.nama_snapshot || ''}</td>
                    <td>${r.dep_snapshot || ''}</td>
                    <td>${r.divisi_snapshot || ''}</td>
                    <td>${r.jabatan_snapshot || ''}</td>
                    <td>${kat}</td>
                    <td>${jamMasuk}</td>
                    <td>${jamKeluar}</td>
                    <td>${durasi}</td>
                    <td>${terlambat}</td>
                    <td class="text-center">
                        <div class="dropdown dropdown-end">
                            <label tabindex="0" class="btn btn-ghost btn-xs" title="Menu">
                                <i class="fa-solid fa-ellipsis-vertical"></i>
                            </label>
                            <ul tabindex="0" class="dropdown-content menu p-1 shadow bg-white rounded-box w-44 text-xs">
                                <li>
                                    <a href="#" class="act-edit" data-id="${r.id_masuk || ''}">
                                        <i class="fa-solid fa-pen-to-square mr-1"></i> Edit absensi
                                    </a>
                                </li>
                                <li>
                                    <a href="#" class="act-delete" data-id="${r.id_masuk || ''}">
                                        <i class="fa-solid fa-trash-can mr-1"></i> Hapus absensi
                                    </a>
                                </li>
                                <li>
                                    <a href="#" class="act-detail" data-id="${r.id_masuk || ''}">
                                        <i class="fa-solid fa-eye mr-1"></i> Lihat detil
                                    </a>
                                </li>
                            </ul>
                        </div>
                    </td>

                </tr>
                `;
            }).join('');
        }

        // Init DataTable (light)
        if (window.jQuery && $.fn.DataTable && $('#tblAbsensi').length) {
            $('#tblAbsensi').DataTable({
                paging: true,
                pageLength: 25,
                lengthChange: true,
                searching: false,
                info: true,
                order: [[0, 'desc'], [7, 'asc']], // tanggal desc, jam masuk asc
                columnDefs: [
                    { orderable: false, targets: -1 }
                ],
                language: {
                    url: "https://cdn.datatables.net/plug-ins/1.13.6/i18n/id.json"
                }
            });
        }
    }

    async function openDetailModal(id) {
        if (!id || !modalDetail) return;

        try {
            const resp = await fetch('/api/absensi/' + encodeURIComponent(id), {
                credentials: 'same-origin'
            });
            const data = await resp.json();
            if (!data.ok || !data.data) {
                UI && UI.toastTop && UI.toastTop('Gagal mengambil detil absensi', 'error');
                return;
            }
            const d = data.data;

            detNama && (detNama.textContent = d.nama_snapshot || '-');
            detNrp && (detNrp.textContent = d.nrp || '-');
            detTanggal && (detTanggal.textContent = fmtTanggal(d.tanggal));
            detKategori && (detKategori.textContent = d.kategori || '-');
            //detJam && (detJam.textContent = fmtJam(d.jam));
            detJamMasuk && (detJamMasuk.textContent = fmtJam(d.jam_masuk));
            detJamKeluar && (detJamKeluar.textContent = fmtJam(d.jam_keluar));
            detShift && (detShift.textContent = d.shift_code || '-');
            detDep && (detDep.textContent = d.dep_snapshot || '-');
            detDivisi && (detDivisi.textContent = d.divisi_snapshot || '-');
            detJabatan && (detJabatan.textContent = d.jabatan_snapshot || '-');
            detLate && (detLate.textContent = fmtTerlambat(d.is_late, d.menit_terlambat));
            detCreated && (detCreatedAt.textContent = fmtDateTime(d.created_at));

            if (detPhoto && detNoPhoto) {
                if (d.snapshot_base64) {
                    detPhoto.src = d.snapshot_base64;
                    detPhoto.classList.remove('hidden');
                    detNoPhoto.classList.add('hidden');
                } else {
                    detPhoto.src = '';
                    detPhoto.classList.add('hidden');
                    detNoPhoto.classList.remove('hidden');
                }
            }

            if (typeof modalDetail.showModal === 'function') {
                modalDetail.showModal();
            }
        } catch (e) {
            console.error('[openDetailModal] fail', e);
            UI && UI.toastTop && UI.toastTop('Gagal membuka detil absensi', 'error');
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        // Bisa set default range tanggal di sini kalau mau
        // misalnya: setDefaultRangeToday();

        loadData();

        if (btnApply) {
            btnApply.addEventListener('click', (e) => {
                e.preventDefault();
                loadData();
            });
        }

        if (btnReset) {
            btnReset.addEventListener('click', (e) => {
                e.preventDefault();
                if (fltTglFrom) fltTglFrom.value = '';
                if (fltTglTo) fltTglTo.value = '';
                if (fltNama) fltNama.value = '';
                if (fltNrp) fltNrp.value = '';
                if (fltDep) fltDep.value = '';
                if (fltDivisi) fltDivisi.value = '';
                if (fltJabatan) fltJabatan.value = '';
                if (fltKategori) fltKategori.value = '';
                loadData();
            });
        }

        // Event delegation untuk tombol detil
        if (tbody) {
            tbody.addEventListener('click', (e) => {
                const detail = e.target.closest('.act-detail');
                const edit = e.target.closest('.act-edit');
                const del = e.target.closest('.act-delete');

                if (detail) {
                    e.preventDefault();
                    const id = detail.dataset.id;
                    if (id) openDetailModal(id);
                    return;
                }

                if (edit) {
                    e.preventDefault();
                    const id = edit.dataset.id;
                    // TODO: buka modal edit absensi
                    if (window.UI && UI.toastTop) {
                        UI.toastTop('Fitur edit absensi belum dibuat.', 'warning');
                    }
                    return;
                }

                if (del) {
                    e.preventDefault();
                    const id = del.dataset.id;
                    // TODO: konfirmasi + hapus absensi
                    if (window.UI && UI.toastTop) {
                        UI.toastTop('Fitur hapus absensi belum dibuat.', 'warning');
                    }
                    return;
                }
            });
        }

    });
})();
