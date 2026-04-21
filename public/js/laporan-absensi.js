(function () {
    const tbody = document.getElementById('absensiBody');
    const lblCount = document.getElementById('absensiCount');
    const btnApply = document.getElementById('btnApplyFilter');
    const btnReset = document.getElementById('btnResetFilter');

    const fltDateRange = document.getElementById('fltDateRange');
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
    const detJamMasuk = document.getElementById('detJamMasuk');
    const detJamKeluar = document.getElementById('detJamKeluar');
    const detShift = document.getElementById('detShift');
    const detDep = document.getElementById('detDep');
    const detDivisi = document.getElementById('detDivisi');
    const detJabatan = document.getElementById('detJabatan');
    const detLate = document.getElementById('detLate');
    const detCreated = document.getElementById('detCreatedAt');
    const detDurasi = document.getElementById('detDurasi');
    const detPhotoMasuk = document.getElementById('detPhotoMasuk');
    const detNoPhotoMasuk = document.getElementById('detNoPhotoMasuk');
    const detPhotoKeluar = document.getElementById('detPhotoKeluar');
    const detNoPhotoKeluar = document.getElementById('detNoPhotoKeluar');


    let dt = null;
    let fpRange = null;

    // === Helper untuk state kosong (awal & setelah reset) ===
    function destroyDataTableIfAny() {
        if (window.jQuery && $.fn.DataTable && $.fn.DataTable.isDataTable('#tblAbsensi')) {
            $('#tblAbsensi').DataTable().clear().destroy();
        }
    }

    function setEmptyState(message) {
        destroyDataTableIfAny();

        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" class="text-center text-xs text-slate-400 py-4">
                        ${message || 'Silakan gunakan filter di atas untuk menampilkan absensi lalu klik "Terapkan Filter".'}
                    </td>
                </tr>
            `;
        }

        if (lblCount) {
            lblCount.textContent = 'Belum ada data. Silakan gunakan filter.';
        }
    }

    function fmtTanggal(iso) {
        if (!iso) return '-';
        // Kalau ada "T", anggap ISO date-time, ambil tanggal di local time
        if (iso.includes('T')) {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return iso;
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const yyyy = d.getFullYear();
            return `${dd}-${mm}-${yyyy}`;
        }

        // Kalau cuma 'YYYY-MM-DD'
        const d = iso.slice(0, 10);
        const [y, m, dd] = d.split('-');
        return `${dd}-${m}-${y}`;
    }

    function fmtDateTime(iso) {
        if (!iso) return '-';

        let s = String(iso).trim();
        // Normalisasi beberapa kemungkinan format dari backend
        s = s.replace('T', ' ').replace('.000Z', '').replace('Z', '');
        const parts = s.split(' ');
        const datePart = parts[0] || '';
        const timePart = parts[1] || '';

        const [y, m, d] = datePart.split('-');
        if (!y || !m || !d) return iso;

        const mNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
        const idx = parseInt(m, 10) - 1;
        const mm = mNames[idx] || m;

        // Hasil: "25 Nov 2025 22:37:35"
        return `${d} ${mm} ${y}${timePart ? ' ' + timePart : ''}`;
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
    function hitungDurasiMenit(jamMasuk, jamKeluar) {
        if (!jamMasuk || !jamKeluar) return null;

        const parse = (s) => {
            const [hh, mm, ss] = String(s).split(':');
            return {
                h: parseInt(hh || '0', 10),
                m: parseInt(mm || '0', 10),
                s: parseInt(ss || '0', 10)
            };
        };

        const a = parse(jamMasuk);
        const b = parse(jamKeluar);

        const t1 = a.h * 3600 + a.m * 60 + a.s;
        const t2 = b.h * 3600 + b.m * 60 + b.s;
        const diff = t2 - t1;
        if (diff <= 0) return null;

        return Math.floor(diff / 60); // menit
    }


    function fmtTerlambat(isLate, menit) {
        if (!isLate) return '-';
        const n = Number(menit || 0);
        if (!n) return 'Terlambat';
        return `Terlambat ${n} menit`;
    }

    function serializeFilter() {
        const p = new URLSearchParams();

        // ===== HANDLE RENTANG TANGGAL =====
        if (fltDateRange && fltDateRange.value) {
            const raw = fltDateRange.value.trim();
            const parts = raw.split(' to ');

            // Kasus user pilih 1 tanggal saja
            if (parts.length === 1) {
                const d = parts[0];
                if (d) {
                    p.set('tgl_from', d);   // from = tanggal
                    p.set('tgl_to', d);     // to   = tanggal yang sama
                }
            } else {
                if (parts[0]) p.set('tgl_from', parts[0]);
                if (parts[1]) p.set('tgl_to', parts[1]);
            }
        }

        // ===== FILTER LAIN =====
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

        destroyDataTableIfAny();

        tbody.innerHTML = `
            <tr>
                <td colspan="12" class="text-center text-xs text-slate-400 py-4">
                    Memuat data...
                </td>
            </tr>
        `;

        const qs = serializeFilter();
        console.log('[LAP ABSENSI] qs:', qs);
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
            if (lblCount) lblCount.textContent = 'Gagal memuat data.';
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
                        Tidak ada data.
                    </td>
                </tr>
            `;
            if (window.jQuery && $.fn.DataTable && $.fn.DataTable.isDataTable('#tblAbsensi')) {
                $('#tblAbsensi').DataTable().clear().destroy();
            }
            Swal.fire({
                icon: 'info',
                title: 'Tidak Ada Data',
                text: 'Tidak ditemukan data absensi berdasarkan filter yang diterapkan.',
                confirmButtonColor: '#0ea5e9',
                confirmButtonText: 'OK'
            });

            return;
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
            dt = $('#tblAbsensi').DataTable({
                paging: true,
                pageLength: 10,
                lengthChange: true,
                searching: true,
                info: true,
                order: [[0, 'desc'], [7, 'asc']],
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

            // --- Info dasar ---
            detNama && (detNama.textContent = d.nama_snapshot || '-');
            detNrp && (detNrp.textContent = d.nrp || '-');
            detTanggal && (detTanggal.textContent = fmtTanggal(d.tanggal));

            // Kategori masuk/keluar digabung
            const katMasuk = d.kategori_masuk || d.kategori || '-';
            const katKeluar = d.kategori_keluar || '-';
            if (detKategori) {
                if (katKeluar && katKeluar !== '-') {
                    detKategori.textContent = `Masuk: ${katMasuk} | Keluar: ${katKeluar}`;
                } else {
                    detKategori.textContent = `Masuk: ${katMasuk}`;
                }
            }

            // Jam masuk/keluar (fallback ke d.jam jika perlu)
            const jamMasukSrc = d.jam_masuk || d.jam || null;
            const jamKeluarSrc = d.jam_keluar || null;

            detJamMasuk && (detJamMasuk.textContent = fmtJam(jamMasukSrc));
            detJamKeluar && (detJamKeluar.textContent = fmtJam(jamKeluarSrc));

            detShift && (detShift.textContent = d.shift_code || '-');
            detDep && (detDep.textContent = d.dep_snapshot || '-');
            detDivisi && (detDivisi.textContent = d.divisi_snapshot || '-');
            detJabatan && (detJabatan.textContent = d.jabatan_snapshot || '-');
            detLate && (detLate.textContent = fmtTerlambat(d.is_late, d.menit_terlambat));
            detCreated && (detCreated.textContent = fmtDateTime(d.created_at));

            // Durasi kerja (hitung di sisi front-end)
            if (detDurasi) {
                const menit = hitungDurasiMenit(jamMasukSrc, jamKeluarSrc);
                detDurasi.textContent = menit != null ? fmtDurasi(menit) : '-';
            }

            // --- Foto Masuk & Keluar ---
            if (detPhotoMasuk && detNoPhotoMasuk) {
                let srcMasuk = d.snapshot_masuk || d.snapshot_base64 || null;
                if (srcMasuk) {
                    if (!srcMasuk.startsWith('data:')) {
                        srcMasuk = 'data:image/jpeg;base64,' + srcMasuk;
                    }
                    detPhotoMasuk.src = srcMasuk;
                    detPhotoMasuk.classList.remove('hidden');
                    detNoPhotoMasuk.classList.add('hidden');
                } else {
                    detPhotoMasuk.src = '';
                    detPhotoMasuk.classList.add('hidden');
                    detNoPhotoMasuk.classList.remove('hidden');
                }
            }

            if (detPhotoKeluar && detNoPhotoKeluar) {
                let srcKeluar = d.snapshot_keluar || null;
                if (srcKeluar) {
                    if (!srcKeluar.startsWith('data:')) {
                        srcKeluar = 'data:image/jpeg;base64,' + srcKeluar;
                    }
                    detPhotoKeluar.src = srcKeluar;
                    detPhotoKeluar.classList.remove('hidden');
                    detNoPhotoKeluar.classList.add('hidden');
                } else {
                    detPhotoKeluar.src = '';
                    detPhotoKeluar.classList.add('hidden');
                    detNoPhotoKeluar.classList.remove('hidden');
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
    async function handleEditAbsensi(id) {
        if (!id) return;
        try {
            const resp = await fetch('/api/absensi/' + encodeURIComponent(id), {
                credentials: 'same-origin'
            });
            const data = await resp.json();
            if (!data.ok || !data.data) {
                Swal.fire({
                    icon: 'error',
                    title: 'Gagal',
                    text: 'Gagal mengambil data absensi untuk edit.'
                });
                return;
            }
            const d = data.data;
            let tanggalVal = '';
            if (d.tanggal) {
                tanggalVal = String(d.tanggal).slice(0, 10);
            }
            const jamMasukVal = d.jam_masuk ? d.jam_masuk.slice(0, 5) : '';
            const jamKeluarVal = d.jam_keluar ? d.jam_keluar.slice(0, 5) : '';

            const result = await Swal.fire({
                title: 'Edit Absensi',
                html: `
                    <div class="text-left text-sm text-slate-700">
                        <div class="mb-3">
                            <div class="text-xs text-slate-500">Nama / NRP</div>
                            <div class="font-semibold">${d.nama_snapshot || '-'} (${d.nrp || '-'})</div>
                            <div class="text-[11px] text-slate-400">
                                Kategori: ${d.kategori || '-'} &middot; Shift: ${d.shift_code || '-'}
                            </div>
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <label class="text-xs text-slate-500">Tanggal</label>
                                <input id="swTanggal" type="date" class="swal2-input" value="${tanggalVal}">
                            </div>
                            <div>
                                <label class="text-xs text-slate-500">Jam Masuk</label>
                                <input id="swJamMasuk" type="time" class="swal2-input" value="${jamMasukVal}">
                            </div>
                            <div>
                                <label class="text-xs text-slate-500">Jam Keluar</label>
                                <input id="swJamKeluar" type="time" class="swal2-input" value="${jamKeluarVal}">
                                <div class="text-[10px] text-slate-400 mt-1">
                                    Boleh dikosongkan jika karyawan belum absen keluar.
                                </div>
                            </div>
                        </div>
                    </div>
                `,
                focusConfirm: false,
                showCancelButton: true,
                confirmButtonColor: '#0ea5e9',
                cancelButtonColor: '#94a3b8',
                confirmButtonText: 'Simpan Perubahan',
                cancelButtonText: 'Batal',
                preConfirm: () => {
                    const tanggal = document.getElementById('swTanggal').value;
                    const jamMasuk = document.getElementById('swJamMasuk').value;
                    const jamKeluar = document.getElementById('swJamKeluar').value;

                    if (!tanggal || !jamMasuk) {
                        Swal.showValidationMessage('Tanggal dan jam masuk wajib diisi.');
                        return false;
                    }

                    return {
                        tanggal,
                        jam_masuk: jamMasuk.length === 5 ? jamMasuk + ':00' : jamMasuk,
                        jam_keluar: jamKeluar
                            ? (jamKeluar.length === 5 ? jamKeluar + ':00' : jamKeluar)
                            : null
                    };
                }
            });

            if (!result.isConfirmed || !result.value) return;
            const { value: passwordEdit } = await Swal.fire({
                title: 'Otorisasi Diperlukan',
                input: 'password',
                inputLabel: 'Masukkan password untuk mengedit data',
                inputPlaceholder: 'Password',
                showCancelButton: true,
                confirmButtonColor: '#0ea5e9',
                cancelButtonColor: '#94a3b8',
                confirmButtonText: 'Lanjut',
                cancelButtonText: 'Batal'
            });

            // Password hardcode. Silakan ubah sesuai keinginan Bos.
            if (passwordEdit !== 'jangkrik15') {
                if (passwordEdit) { // Munculkan error jika diisi salah (bukan karena klik batal)
                    Swal.fire({ icon: 'error', title: 'Ditolak', text: 'Password salah!' });
                }
                return;
            }

            const payload = result.value;

            const respSave = await fetch('/api/absensi/pair/' + encodeURIComponent(id), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'same-origin',
                body: JSON.stringify(payload)
            });

            const saveJson = await respSave.json();
            if (!respSave.ok || !saveJson.ok) {
                Swal.fire({
                    icon: 'error',
                    title: 'Gagal',
                    text: saveJson.error || 'Gagal menyimpan perubahan absensi.'
                });
                return;
            }

            Swal.fire({
                icon: 'success',
                title: 'Berhasil',
                text: 'Absensi berhasil diperbarui.',
                timer: 1500,
                showConfirmButton: false
            });

            // Refresh tabel
            loadData();

        } catch (e) {
            console.error('[handleEditAbsensi] fail', e);
            Swal.fire({
                icon: 'error',
                title: 'Gagal',
                text: 'Terjadi kesalahan saat mengedit absensi.'
            });
        }
    }

    async function handleDeleteAbsensi(id) {
        if (!id) return;
        try {
            // Ambil detil dulu biar konfirmasi lebih jelas
            const resp = await fetch('/api/absensi/' + encodeURIComponent(id), {
                credentials: 'same-origin'
            });
            const data = await resp.json();
            if (!data.ok || !data.data) {
                Swal.fire({
                    icon: 'error',
                    title: 'Gagal',
                    text: 'Gagal mengambil detil absensi.'
                });
                return;
            }
            const d = data.data;
            const tanggal = fmtTanggal(d.tanggal);
            const jamMasuk = fmtJam(d.jam_masuk || d.jam);
            const jamKeluar = fmtJam(d.jam_keluar);

            const result = await Swal.fire({
                icon: 'warning',
                title: 'Hapus Absensi?',
                html: `
                    <div class="text-left text-sm text-slate-700">
                        <p class="mb-2">
                            Anda akan menghapus <b>paket absensi</b> untuk:
                        </p>
                        <ul class="text-xs text-slate-600 space-y-1">
                            <li><b>Nama</b>: ${d.nama_snapshot || '-'} (${d.nrp || '-'})</li>
                            <li><b>Tanggal</b>: ${tanggal}</li>
                            <li><b>Shift</b>: ${d.shift_code || '-'} (${d.kategori || '-'})</li>
                            <li><b>Jam Masuk</b>: ${jamMasuk}</li>
                            <li><b>Jam Keluar</b>: ${jamKeluar}</li>
                        </ul>
                        <p class="mt-3 text-[11px] text-amber-600">
                            Tindakan ini akan menghapus data Masuk dan Keluar untuk shift tersebut (jika ada).
                        </p>
                    </div>
                `,
                showCancelButton: true,
                confirmButtonColor: '#ef4444',
                cancelButtonColor: '#94a3b8',
                confirmButtonText: 'Ya, hapus',
                cancelButtonText: 'Batal'
            });

            if (!result.isConfirmed) return;

            const { value: passwordDel } = await Swal.fire({
                title: 'Otorisasi Diperlukan',
                input: 'password',
                inputLabel: 'Masukkan password untuk menghapus data',
                inputPlaceholder: 'Password',
                showCancelButton: true,
                confirmButtonColor: '#ef4444', // Warna disamakan dengan tema hapus (merah)
                cancelButtonColor: '#94a3b8',
                confirmButtonText: 'Lanjut',
                cancelButtonText: 'Batal'
            });

            // Password hardcode.
            if (passwordDel !== 'jangkrik15') {
                if (passwordDel) {
                    Swal.fire({ icon: 'error', title: 'Ditolak', text: 'Password salah!' });
                }
                return;
            }

            const respDel = await fetch('/api/absensi/pair/' + encodeURIComponent(id), {
                method: 'DELETE',
                credentials: 'same-origin'
            });
            const delJson = await respDel.json();

            if (!respDel.ok || !delJson.ok) {
                Swal.fire({
                    icon: 'error',
                    title: 'Gagal',
                    text: delJson.error || 'Gagal menghapus absensi.'
                });
                return;
            }

            Swal.fire({
                icon: 'success',
                title: 'Terhapus',
                text: 'Absensi berhasil dihapus.',
                timer: 1500,
                showConfirmButton: false
            });

            loadData();

        } catch (e) {
            console.error('[handleDeleteAbsensi] fail', e);
            Swal.fire({
                icon: 'error',
                title: 'Gagal',
                text: 'Terjadi kesalahan saat menghapus absensi.'
            });
        }
    }
    function formatDateYmd(d) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    function setDateRangePreset(type) {
        const today = new Date(); // pakai waktu browser user
        let start = null;
        let end = null;

        if (type === 'today') {
            start = end = today;
        } else if (type === 'yesterday') {
            const y = new Date(today);
            y.setDate(y.getDate() - 1);
            start = end = y;
        } else if (type === 'thisWeek') {
            const d = new Date(today);
            const day = d.getDay(); // 0 = Minggu, 1 = Senin, ...
            const diffToMonday = (day + 6) % 7; // Senin = 0
            const s = new Date(d);
            s.setDate(d.getDate() - diffToMonday);
            start = s;
            end = d;
        } else if (type === 'thisMonth') {
            const d = new Date(today);
            const s = new Date(d.getFullYear(), d.getMonth(), 1);
            start = s;
            end = d;
        } else if (type === 'clear') {
            if (fpRange) {
                fpRange.clear();
            } else if (fltDateRange) {
                fltDateRange.value = '';
            }
            return;
        }

        if (!start || !end) return;

        const sStr = formatDateYmd(start);
        const eStr = formatDateYmd(end);

        if (fpRange) {
            fpRange.setDate([sStr, eStr], true); // flatpickr akan set value: "YYYY-MM-DD to YYYY-MM-DD"
        } else if (fltDateRange) {
            fltDateRange.value = sStr === eStr ? sStr : `${sStr} to ${eStr}`;
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        // DEFAULT: halaman awal tanpa data
        setEmptyState();
        // === Autocomplete pakai @tarekraafat/autocomplete.js ===
        function createRemoteAutocomplete(selector, endpoint) {
            if (!window.autoComplete) return null;

            return new autoComplete({
                selector,
                placeHolder: "",
                threshold: 2,       // minimal 2 karakter baru cari
                debounce: 300,
                searchEngine: "loose",
                data: {
                    src: async (query) => {
                        try {
                            const resp = await fetch(
                                endpoint + '?q=' + encodeURIComponent(query),
                                { credentials: 'same-origin' }
                            );
                            const json = await resp.json();
                            return json.items || [];
                        } catch (e) {
                            console.error('[autoComplete] error', endpoint, e);
                            return [];
                        }
                    }
                },
                resultsList: {
                    maxResults: 10,
                    tabSelect: true
                },
                resultItem: {
                    highlight: true
                },
                events: {
                    input: {
                        selection: (event) => {
                            const value = event.detail.selection.value;
                            // Set value ke input aslinya
                            event.target.value = value;
                        }
                    }
                }
            });
        }

        // Inisialisasi untuk Nama, Divisi, Jabatan
        const acNama = createRemoteAutocomplete("#fltNama", "/api/karyawan/nama-suggest");
        const acDivisi = createRemoteAutocomplete("#fltDivisi", "/api/karyawan/divisi-suggest");
        const acJabatan = createRemoteAutocomplete("#fltJabatan", "/api/karyawan/jabatan-suggest");
        // === Init Date Range Picker ===
        if (fltDateRange && window.flatpickr) {
            fpRange = flatpickr(fltDateRange, {
                mode: 'range',
                dateFormat: 'Y-m-d',
                allowInput: false
            });
        }
        // === Tombol preset tanggal ===
        const btnToday = document.getElementById('btnRangeToday');
        const btnYesterday = document.getElementById('btnRangeYesterday');
        const btnThisWeek = document.getElementById('btnRangeThisWeek');
        const btnThisMonth = document.getElementById('btnRangeThisMonth');
        const btnClear = document.getElementById('btnRangeClear');

        if (btnToday) {
            btnToday.addEventListener('click', (e) => {
                e.preventDefault();
                setDateRangePreset('today');
                loadData(); // langsung apply
            });
        }
        if (btnYesterday) {
            btnYesterday.addEventListener('click', (e) => {
                e.preventDefault();
                setDateRangePreset('yesterday');
                loadData();
            });
        }
        if (btnThisWeek) {
            btnThisWeek.addEventListener('click', (e) => {
                e.preventDefault();
                setDateRangePreset('thisWeek');
                loadData();
            });
        }
        if (btnThisMonth) {
            btnThisMonth.addEventListener('click', (e) => {
                e.preventDefault();
                setDateRangePreset('thisMonth');
                loadData();
            });
        }
        if (btnClear) {
            btnClear.addEventListener('click', (e) => {
                e.preventDefault();
                setDateRangePreset('clear');
                // Tidak auto loadData supaya user bisa isi filter lain dulu
                setEmptyState();
            });
        }


        if (btnApply) {
            btnApply.addEventListener('click', (e) => {
                e.preventDefault();
                loadData();
            });
        }

        if (btnReset) {
            btnReset.addEventListener('click', (e) => {
                e.preventDefault();

                if (fltDateRange) fltDateRange.value = '';
                if (fltNama) fltNama.value = '';
                if (fltNrp) fltNrp.value = '';
                if (fltDep) fltDep.value = '';
                if (fltDivisi) fltDivisi.value = '';
                if (fltJabatan) fltJabatan.value = '';
                if (fltKategori) fltKategori.value = '';

                // Setelah reset, kembali ke state awal tanpa data
                setEmptyState();
            });
        }

        // Event delegation untuk tombol detil / edit / delete
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
                    if (id) {
                        handleEditAbsensi(id);
                    }
                    return;
                }

                if (del) {
                    e.preventDefault();
                    const id = del.dataset.id;
                    if (id) {
                        handleDeleteAbsensi(id);
                    }
                    return;
                }
            });
        }
    });
})();