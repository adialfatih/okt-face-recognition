# PRD & System Reference — Aplikasi Absensi Wajah (okt-face-presensi)

> **Tujuan dokumen ini:** Menjadi satu-satunya sumber acuan (single source of truth) bagi AI coding agent maupun developer, agar bisa memahami keseluruhan project **tanpa perlu men-scan semua file**. Setiap kali ada permintaan fitur baru / perbaikan, baca dokumen ini dulu untuk tahu di file mana harus bekerja, aturan bisnis apa yang berlaku, dan jebakan apa yang harus dihindari.
>
> **Terakhir dianalisa:** 2026-07-08 · **Branch:** `main` · Simpan dokumen ini selalu sinkron ketika struktur berubah.
>
> **Status verifikasi:** Dokumen ini telah diverifikasi ulang terhadap codebase saat ini. Struktur folder, dependensi, konfigurasi `.env`, route/service map, serta daftar bug & technical debt (§10) masih konsisten dengan kode aktual.

---

## 1. Ringkasan Produk

Aplikasi web internal **PT Rindang Jati** untuk **presensi (absensi) karyawan berbasis pengenalan wajah (face recognition)**. Karyawan berdiri di depan kamera, sistem mengenali wajahnya, lalu mencatat absensi sesuai kategori (shift/peran) yang dipilih. Deteksi & ekstraksi fitur wajah dilakukan **di browser** (face-api.js); server hanya menerima *descriptor* (vektor 128 float), mencocokkannya ke database, dan mencatat absensi.

**Pengguna:** operator/admin HR yang menjalankan stasiun absensi, merekam wajah karyawan baru, dan melihat laporan.

**Nilai inti:**
- Absensi cepat tanpa kontak (wajah), anti-dobel per hari/kategori.
- Data master karyawan diambil dari sistem HR eksternal (`rjsmanage`) dan di-cache lokal.
- Laporan absensi dengan pasangan Masuk/Keluar + durasi kerja + status terlambat.

---

## 2. Tech Stack

| Layer | Teknologi |
|---|---|
| Runtime | Node.js (CommonJS), Express 4 |
| View | EJS + `ejs-mate` (layout), Tailwind (CDN) + daisyUI 4 |
| DB | MySQL (via `mysql2/promise`), 2 pool: app + HR |
| Face | `face-api.js` 0.22.2 + `@tensorflow/tfjs` 1.7.4 (**di browser**, dari CDN) |
| Auth | `express-session` (cookie 7 hari), session in-memory |
| Realtime | `socket.io` (terpasang, praktis belum dipakai) |
| Scheduler | `node-cron` (sinkronisasi karyawan HR) |
| Transport | **HTTPS** (wajib — getUserMedia butuh secure context), sertifikat lokal di `certs/` |
| Lain | `dayjs` (waktu), `bcryptjs` (terpasang tapi **belum dipakai**), `jsonwebtoken` (terpasang tapi **belum dipakai**), `dotenv` |
| Frontend libs (CDN) | SweetAlert2, DataTables + jQuery, flatpickr, @tarekraafat/autocomplete.js, Font Awesome 6 |

**Menjalankan:** `npm start` (prod) atau `npm run dev` (nodemon). Server listen di `0.0.0.0:<PORT>` via HTTPS.

> ⚠️ **Catatan port:** `.env` men-set `PORT=3007`, sedangkan `app.js` fallback ke `3001`. Yang berlaku adalah `.env` → **3007**.

---

## 3. Arsitektur & Design Sistem

### 3.1 Diagram alur tingkat tinggi

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              BROWSER (Client)                              │
│                                                                            │
│  Kamera → face-api.js (deteksi + landmark + descriptor 128-float)          │
│      │         (models di-load dari /public/models, fallback CDN)          │
│      │                                                                     │
│      ├─ Rekam:   kumpulkan 15 sample  ─────────────► POST /api/faces       │
│      ├─ Absensi: kumpulkan 2–3 descriptor ────────► POST /api/absen        │
│      ├─ Test/Debug: 1 descriptor ─────────────────► POST /api/match        │
│      └─ UI (EJS + Tailwind/daisyUI), fetch JSON API                        │
└───────────────────────────────┬────────────────────────────────────────────┘
                                 │ HTTPS (self-signed cert)
┌───────────────────────────────▼────────────────────────────────────────────┐
│                          EXPRESS SERVER (app.js)                            │
│                                                                            │
│  session(ensureAuth) ──► routes/auth.js  (login/logout)                     │
│                          routes/pages.js (render EJS, semua di-guard)       │
│                          routes/api.js    ──► routes/api-absensi.js         │
│                                                                            │
│  In-memory EMB_CACHE  ◄── loadAllEmbeddings() dari table_face_embeddings    │
│  (matching Euclidean distance dilakukan di sini, bukan di DB)               │
│                                                                            │
│  CRON: 02:30 fullSyncFromHR() ; tiap 6 jam syncKaryawan()                   │
└───────┬───────────────────────────────────────────┬────────────────────────┘
        │ pool (app DB)                              │ hrPool (HR DB, read-only)
┌───────▼────────────────────┐            ┌──────────▼──────────────────────────┐
│  MySQL: absensi_db_rjs      │            │  MySQL: rjsmanage (HR eksternal)     │
│  - table_absensi            │            │  - data_karyawan (master, read)      │
│  - table_face_embeddings    │            └──────────────────────────────────────┘
│  - table_deteksi_log        │
│  - table_karyawan (+cache)  │            ┌──────────────────────────────────────┐
│  - table_users              │            │  Storage foto (di luar project):     │
│  - black_list_nrp (unused)  │◄───────────│  proses automasi eksternal ubah      │
└─────────────────────────────┘  migrasi   │  snapshot_base64 → file .webp        │
                                            │  disajikan via /storage/... static   │
                                            └──────────────────────────────────────┘
```

### 3.2 Keputusan desain penting (yang harus dipahami sebelum mengubah kode)

1. **Face recognition 100% di client.** Server **tidak** pernah memproses gambar untuk mencari wajah. Server hanya menerima array descriptor dan membandingkan jarak. Konsekuensi: kualitas absensi sangat bergantung pada *quality gate* di frontend (`absensi.js`) dan konsistensi model face-api antar device.

2. **Matching in-memory (`EMB_CACHE`).** Semua embedding dimuat ke RAM sekali (`loadAllEmbeddings`) lalu dibandingkan dengan loop Euclidean. Ini agar cepat untuk ribuan karyawan. **Cache harus dijaga sinkron** setiap kali embedding berubah (`invalidateEmbeddingsFor` / `addEmbeddingsFor`). Lihat Bug #8.

3. **Dua database.** `absensi_db_rjs` (milik app, boleh tulis) dan `rjsmanage` (HR, hanya baca). Data karyawan **tidak diketik manual** — di-sync dari HR. Ada 2 mekanisme sync yang tumpang tindih (lihat §7).

4. **Snapshot punya 2 generasi penyimpanan:**
   - **Lama (base64):** kolom `table_absensi.snapshot_base64` (LONGTEXT, data URI penuh). Kode `/api/absen` **masih menulis ke sini**.
   - **Baru (file webp):** kolom `snapshot_url` berisi path seperti `/storage/snapshots/2026/06/<id>.webp`. Diisi oleh **proses automasi eksternal** (di luar repo ini) yang memigrasi base64 → file, lalu dipetakan oleh `app.use('/storage', express.static(SNAPSHOT_STORAGE_ROOT))`.
   - Frontend selalu **utamakan `snapshot_url`, fallback ke base64** (lihat `resolveSnapshotSrc` di `laporan-absensi.js`).

5. **Data snapshot di baris absensi bersifat "snapshot-in-time"** (kolom `*_snapshot`: nama/dep/divisi/jabatan disalin saat absen). Laporan memakai nilai snapshot ini, **bukan** join ke master, supaya perubahan data karyawan tidak mengubah histori.

---

## 4. Struktur Folder & Peta File

```
okt-face-presensi/
├─ app.js                    # Entry point: HTTPS server, session, cron, mount routes, /storage static
├─ db.js                     # 2 pool MySQL: pool(app)+q(), hrPool(HR)+hrq()
├─ .env                      # Konfigurasi (TIDAK di-commit)
├─ package.json
├─ certs/                    # Sertifikat HTTPS self-signed (key + cert)
│
├─ routes/
│  ├─ auth.js                # GET/POST /login, POST /logout  (password PLAINTEXT — lihat Bug #1)
│  ├─ pages.js               # Semua route render EJS (di-guard ensureAuth)
│  ├─ api.js                 # API inti: match, faces, absen, karyawan, cache, deteksi-log
│  └─ api-absensi.js         # API laporan absensi: report, detail, edit(pair), delete(pair)
│
├─ services/
│  ├─ karyawanCache.js       # Read-through cache HR→table_karyawan_cache (fullSyncFromHR, ensureInCache)
│  └─ karyawanSync.js        # Sync HR→table_karyawan (syncKaryawan, status_io='1')
│
├─ public/
│  ├─ css/styles.css         # Style kustom (badge status, face-pill, toast, card karyawan)
│  ├─ js/
│  │  ├─ face-common.js      # FaceCommon: loadModels, startCamera, grabFrame, draw overlay ⚠ lihat Bug #9
│  │  ├─ absensi.js          # Loop absensi: quality gate, multi-sample, POST /api/absen
│  │  ├─ rekam.js            # Rekam 15 sample wajah + verifikasi anti-salah-orang, POST /api/faces
│  │  ├─ test.js             # Test wajah live → /api/match (tampilkan profil)
│  │  ├─ debug-match.js      # Debug jarak wajah (threshold/margin/statistik sesi)
│  │  ├─ karyawan.js         # Tabel/kartu data karyawan + filter (face/dep) + paginasi
│  │  ├─ laporan-absensi.js  # Laporan: DataTables, filter tanggal/nama/dll, detail/edit/hapus (password hardcode!)
│  │  ├─ deteksi-log.js      # Monitoring log deteksi + ringkasan persentase
│  │  └─ ui.js               # window.UI: toastTop, toastBottomInfo, speak (TTS)
│  ├─ models/                # Bobot face-api.js (tiny_face_detector, landmark_68, recognition, dll)
│  ├─ ping.mp3 / error.mp3   # Efek suara
│
├─ views/  (EJS + ejs-mate)
│  ├─ layout.ejs / layoutfull.ejs / auth-layout.ejs   # Layout master
│  ├─ partials/ head.ejs, nav.ejs, drawer.ejs, bottomnav.ejs, footer.ejs
│  ├─ login.ejs, dashboard.ejs, about.ejs, placeholder.ejs
│  ├─ absensi-start.ejs, absensi-capture.ejs          # Pilih kategori → kamera absensi
│  ├─ rekam-start.ejs, rekam-capture.ejs              # Cari karyawan → rekam wajah
│  ├─ test-start.ejs, test-capture.ejs                # Test pengenalan
│  ├─ karyawan.ejs, laporan-absensi.ejs               # Data & laporan
│  └─ debug-match.ejs, deteksi-log.ejs                # Tools debug/monitoring
│
└─ sql/schema.sql            # ⚠ USANG — tidak mencerminkan DB nyata (lihat §5 & Bug #6)
```

### Cara data mengalir antar-file (untuk absensi):
`absensi-start.ejs` (pilih kategori) → `absensi-capture.ejs` (set `window.__KATEGORI__`) → `absensi.js` (deteksi + kirim) → `POST /api/absen` di `api.js` → cocokkan `EMB_CACHE` → tulis `table_absensi` + `table_deteksi_log` → profil dari `karyawanCache.ensureInCache`.

---

## 5. Skema Database (AKTUAL — hasil `SHOW CREATE TABLE`)

> Database aktif: **`absensi_db_rjs`** (bukan `absensi_db` seperti di `sql/schema.sql`). Gunakan definisi di bawah ini sebagai acuan, **abaikan `sql/schema.sql`** yang usang.

### `table_absensi` — catatan absensi (anti-dobel per nrp+tanggal+kategori)
| Kolom | Tipe | Catatan |
|---|---|---|
| id | BIGINT UNSIGNED PK AI | |
| nrp | VARCHAR(32) | FK → table_karyawan.nrp |
| tanggal | DATE | |
| jam | TIME | |
| kategori | VARCHAR(64) | salah satu dari `KATEGORI` (§6.1) |
| shift_code | VARCHAR(20) NULL | PAGI/SIANG/MALAM/DS/DRIVER/SECURITY/TERLAMBAT/IJIN |
| nama_snapshot, dep_snapshot, divisi_snapshot, jabatan_snapshot | VARCHAR | disalin saat absen |
| is_late | TINYINT(1) | flag terlambat |
| menit_terlambat | INT | |
| snapshot_base64 | LONGTEXT NULL | data URI penuh (generasi lama) |
| snapshot_url | VARCHAR(255) NULL | path `/storage/...webp` (generasi baru) |
| source | VARCHAR(32) def 'web' | |
| created_at | TIMESTAMP | |
| **UNIQUE** `uniq_absen` (nrp, tanggal, kategori) | | basis anti-dobel |

### `table_face_embeddings` — 1 baris = 1 sample wajah
| Kolom | Tipe | Catatan |
|---|---|---|
| id | BIGINT PK AI | |
| nrp | VARCHAR(32) | FK → table_karyawan.nrp |
| embedding | LONGTEXT (JSON, CHECK json_valid) | array 128 float |
| snapshot | LONGBLOB NULL | JPEG biner (opsional) |
| snapshot_mime | VARCHAR(32) | |
| created_at | TIMESTAMP | |

Target ~15 sample per NRP.

### `table_deteksi_log` — audit setiap percobaan deteksi
| Kolom | Tipe | Catatan |
|---|---|---|
| id | BIGINT PK AI | |
| context | ENUM('absensi','rekam','test') | |
| kategori | VARCHAR(64) NULL | |
| nrp_detected | VARCHAR(32) NULL | |
| distance | DECIMAL(6,4) NULL | |
| status | **ENUM('recognized','unknown','multi-face','no-face')** | ⚠ **tidak ada 'ambiguous'** — lihat Bug #2 |
| frame_snapshot | LONGBLOB NULL | JPEG biner |
| frame_url | VARCHAR(255) NULL | migrasi (jarang dipakai) |
| created_at | TIMESTAMP | |

### `table_karyawan` — master lokal (di-sync dari HR via `syncKaryawan`)
`nrp` PK, `nama`, `dep`, `divisi`, `jabatan`, `status TINYINT(1)`, `created_at`. **Catatan:** `status` di sini angka, tetapi UI/`hr/karyawan` menimpanya dengan status teks dari HR.

### `table_karyawan_cache` — read-through cache profil HR
`nrp` PK, `idkar`, `nama`, `departement`, `divisi`, `jabatan`, `status ENUM('KONTRAK','TETAP','MAGANG','RESIGN')`, `tmt`, `updated_at`. Dipakai `/api/absen` & `/api/match` untuk ambil profil.

### `table_users` — akun login
`id` PK, `nama_lengkap`, `username` UNIQUE, `password` (⚠ **plaintext**), `hak_akses ENUM('admin','user')`, timestamps.

### `black_list_nrp` — **tabel ada, TIDAK dipakai di kode manapun**
`nrp` PK, `nama`, `created_at`. Kandidat fitur "blokir NRP dari absensi" yang belum diimplementasi.

### DB eksternal HR: `rjsmanage.data_karyawan` (READ-ONLY dari app)
Kolom yang dipakai: `idkar, nrp, nama, departement, divisi, jabatan, status` (teks: KONTRAK/TETAP/MAGANG/RESIGN), `tmt`, `status_io` ('1' = aktif). ~1772 baris.

---

## 6. Aturan Bisnis

### 6.1 Daftar KATEGORI absensi (`api.js`)
```
Masuk/Keluar Shift Pagi | Masuk/Keluar Shift Siang | Masuk/Keluar Shift Malam
Masuk/Keluar DS | Masuk/Keluar Driver | Masuk/Keluar Security
Masuk Terlambat | Ijin Keluar
```
Validasi kategori wajib pakai `isValidKategori()`. `shift_code` diturunkan dari kategori via `deriveShiftCode()`.

### 6.2 Jam shift & keterlambatan
| Shift | Mulai | Batas telat (grace) |
|---|---|---|
| Pagi | 06:00 | 06:05 |
| Siang | 14:00 | 14:05 |
| Malam | 22:00 | 22:05 |

- `is_late` (`computeLateFlag`): 1 jika absen **setelah** batas grace 5 menit, **hanya** untuk 3 kategori "Masuk Shift ...".
- `menit_terlambat` (`computeLateMinutes`): selisih menit dari jam mulai, dengan **grace 3 menit** (bukan 5). Khusus Shift Malam, jika absen dini hari (00:00–05:59) jam mulai dianggap 22:00 hari sebelumnya.
- ⚠ **Inkonsistensi grace 5 vs 3 menit** antara dua fungsi — lihat Bug #5.
- DS = fleksibel minimal 8 jam (`SHIFT_RULES.ds8h`) — **aturan ini belum diterapkan** di kode absen/laporan (hanya konstanta).

### 6.3 Threshold pengenalan wajah (`.env`)
- `FACE_DISTANCE_THRESHOLD=0.45` — jarak Euclidean maksimum agar dianggap match.
- `FACE_MARGIN_MIN=0.05` — selisih minimum antara kandidat terbaik & kedua. Jika lebih kecil → **ambiguous** (ditolak).
- Logika sama diterapkan di `/api/match` dan `/api/absen` (duplikasi — lihat Bug #4).

### 6.4 Status karyawan aktif
`ACTIVE_STATUSES = {KONTRAK, TETAP, MAGANG}`. RESIGN ditolak saat rekam & absen.

### 6.5 Pairing Masuk/Keluar (laporan)
Baris "Masuk%" dipasangkan dengan "Keluar%" berdasarkan `nrp` + `tanggal` sama + `shift_code` sama (fallback: pasangan kategori). Durasi = `TIMESTAMPDIFF` menit. Lihat `api-absensi.js /absensi/report`.

---

## 7. Sinkronisasi Data Karyawan (HR → App)

Ada **dua jalur sync yang tumpang tindih** (perlu konsolidasi):

1. **`services/karyawanCache.js`** → mengisi `table_karyawan_cache`.
   - `fullSyncFromHR()`: ambil semua status ∈ (KONTRAK,TETAP,MAGANG) → upsert cache. **Cron 02:30 WIB.**
   - `ensureInCache(nrp)`: read-through — cek cache, kalau kosong ambil dari HR. Dipakai `/api/absen`, `/api/match`, `/api/faces`.
   - TTL opsional via `KARYAWAN_CACHE_TTL_MIN` (0 = tanpa TTL).

2. **`services/karyawanSync.js`** → mengisi `table_karyawan`.
   - `syncKaryawan()`: ambil HR `status_io='1'` → upsert `table_karyawan`. **Cron tiap 6 jam.**

Endpoint `GET /api/hr/karyawan` (untuk halaman Data Karyawan) membaca `table_karyawan` (lokal) + menimpa status dengan teks HR + flag `hasFace` dari `table_face_embeddings`. Endpoint autocomplete `/api/karyawan/search` membaca `table_karyawan_cache` dulu, fallback HR.

> Kesimpulan penting untuk agent: **profil untuk absensi** berasal dari `table_karyawan_cache`; **listing/laporan** dari `table_karyawan`. Keduanya harus di-sync agar konsisten.

---

## 8. Referensi API (semua di bawah `/api`, semua butuh session kecuali dinyatakan)

### Pengenalan wajah & rekam
| Method | Path | Body/Query | Fungsi |
|---|---|---|---|
| POST | `/api/match` | `{descriptors:[[128f]]}` | Cari NRP terbaik (test/debug). Return `{match}` atau `{match:null,bestDist}` |
| POST | `/api/absen` | `{kategori, descriptors, frameBase64}` | Catat absensi. Return `{ok, match, is_late, menit_terlambat}` / `{ok:false, reason}` (`unknown`\|`ambiguous`\|`duplicate`\|`inactive`\|`no-profile`) |
| POST | `/api/faces` | `{nrp, samples:[{embedding,snapshotBase64,mime}], forceReplace}` | Simpan ≤15 embedding (transaksi, hapus lama jika forceReplace) |
| GET | `/api/faces/count?nrp=` | | Jumlah embedding NRP |
| POST | `/api/faces/reset` | `{nrp}` | Hapus semua embedding NRP ⚠ tidak invalidasi EMB_CACHE (Bug #8) |
| GET | `/api/config/face` | | `{threshold, marginMin}` untuk frontend |

### Karyawan
| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/karyawan/search?q=` | Autocomplete (cache→HR) |
| GET | `/api/karyawan/nama-suggest?q=` / `divisi-suggest` / `jabatan-suggest` | Autocomplete filter laporan (dari `table_karyawan`) |
| GET | `/api/hr/karyawan?q=&page=&limit=&face=&dep=` | Listing data karyawan + summary + hasFace |
| GET | `/api/hr/karyawan/:nrp` | Detail 1 karyawan (lokal + status HR) |
| POST | `/api/cache/invalidate` | `{nrp, fetch?}` webhook invalidasi cache |
| POST | `/api/cache/sync-now` | Trigger `fullSyncFromHR` manual |

### Laporan absensi (`api-absensi.js`)
| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/absensi/report?tgl_from&tgl_to&nrp&nama&dep&divisi&jabatan&kategori` | Laporan pasangan Masuk/Keluar + durasi (LIMIT 1000) |
| GET | `/api/absensi/:id` | Detail 1 absensi + pasangannya + snapshot |
| PUT | `/api/absensi/pair/:id` | Edit paket (tanggal/jam masuk & keluar; insert keluar jika perlu) |
| DELETE | `/api/absensi/pair/:id` | Hapus paket Masuk+Keluar |

### Monitoring deteksi
| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/deteksi-log?context&status&tgl_from&tgl_to&nrp&limit` | Daftar log deteksi |
| GET | `/api/deteksi-log/:id/frame` | Kembalikan `frame_snapshot` sebagai image/jpeg |
| GET | `/api/deteksi-log/summary?...` | Ringkasan per hari (recognized/unknown/ambiguous) |

### Halaman (routes/pages.js, di-guard) & Auth (routes/auth.js)
`GET /` (dashboard), `/absensi`, `/absensi/capture?k=`, `/rekam`, `/rekam/capture?nrp=`, `/test`, `/test/capture`, `/karyawan`, `/laporan`, `/cuti`(placeholder), `/ijin`(placeholder), `/about`, `/debug/match`, `/deteksi-log`. Auth: `GET/POST /login`, `POST /logout`.

---

## 9. Konfigurasi (.env)

```ini
PORT=3007
NODE_ENV=development
DB_HOST=127.0.0.1  DB_USER=root  DB_PASS=***  DB_NAME=absensi_db_rjs  DB_CONN_LIMIT=10
TZ=Asia/Jakarta
SNAPSHOT_STORAGE_ROOT=/home/rindang/Downloads/automasi/.../fotoabsen   # dipetakan ke /storage
FACE_DISTANCE_THRESHOLD=0.45   FACE_MARGIN_MIN=0.05
HR_DB_HOST=127.0.0.1  HR_DB_USER=root  HR_DB_PASS=***  HR_DB_NAME=rjsmanage  HR_DB_CONN_LIMIT=10
KARYAWAN_CACHE_TTL_MIN=0
SESSION_SECRET=(tidak diset → pakai fallback dev — perbaiki di produksi)
```

---

## 10. 🐞 Bug & Technical Debt (prioritas untuk diperbaiki)

### 🔴 Kritis (memengaruhi keamanan / data hilang / fitur gagal senyap)

**Bug #1 — Password login disimpan & dibandingkan plaintext.**
`routes/auth.js:36` → `rows[0].password !== password`. `table_users.password` plaintext. `bcryptjs` sudah terpasang tapi tidak dipakai. **Dampak:** kredensial bocor jika DB terekspos. **Perbaikan:** hash bcrypt saat buat user + `bcrypt.compare` saat login.

**Bug #2 — Insert status `'ambiguous'` GAGAL diam-diam (data hilang + user dapat pesan salah).**
`table_deteksi_log.status` adalah `ENUM('recognized','unknown','multi-face','no-face')` — **tidak ada `'ambiguous'`**. Kode `api.js` (blok ambiguous di `/absen`) meng-`INSERT ... status='ambiguous'`. Dengan `sql_mode=STRICT_TRANS_TABLES`, insert ini melempar error → tertangkap catch luar → **respons `500 {error:'absen failed'}`**, sehingga frontend menampilkan *"Wajah tidak terdeteksi dalam database"* alih-alih pesan ambiguous. Terbukti: `GROUP BY status` menghasilkan **0 baris ambiguous** padahal kode berusaha menulisnya. Query `/deteksi-log/summary` juga menghitung `ambiguous` yang selalu 0. **Perbaikan:** `ALTER TABLE table_deteksi_log MODIFY status ENUM('recognized','unknown','multi-face','no-face','ambiguous')` **atau** ganti nilai insert menjadi `'unknown'`. Pilih satu dan selaraskan frontend `deteksi-log.js` (yang sudah punya badge 'ambiguous').

**Bug #3 — Password otorisasi edit/hapus di-hardcode di frontend.**
`public/js/laporan-absensi.js` membandingkan `passwordEdit !== 'jangkrik15'` (dan sama untuk delete) **di sisi klien**. Siapa pun bisa membaca sumber JS → bypass. Endpoint `PUT/DELETE /api/absensi/pair/:id` **tidak** memverifikasi apa pun di server. **Dampak:** proteksi ilusi; edit/hapus bisa dipanggil langsung tanpa password. **Perbaikan:** pindahkan otorisasi ke server (cek `hak_akses='admin'` / password ter-hash).

### 🟠 Penting (bug fungsional / risiko konsistensi)

**Bug #4 — Duplikasi logika matching.** Blok pencarian best/second + threshold/margin di `/api/match` dan `/api/absen` identik (copy-paste). Fungsi `euclideanDistance` bahkan **didefinisikan dua kali** di `api.js` (baris ~56 dan ~317). `deriveShiftCode` diduplikasi di `api.js` & `api-absensi.js`. **Perbaikan:** ekstrak ke satu modul (mis. `services/faceMatch.js`, `services/shift.js`).

**Bug #5 — Grace period terlambat tidak konsisten.** `computeLateFlag` pakai grace **5 menit** (06:05), `computeLateMinutes` pakai grace **3 menit**. Akibatnya karyawan datang 06:04 bisa `is_late=0` tetapi `menit_terlambat=4`. **Perbaikan:** satukan sumber aturan grace.

**Bug #6 — `sql/schema.sql` usang & menyesatkan.** Menyebut DB `absensi_db`, tak memuat `table_users`, `table_karyawan_cache`, `black_list_nrp`, kolom `shift_code`, `snapshot_url`, `*_snapshot`, dll. Bisa merusak jika dipakai bootstrap DB baru. **Perbaikan:** regenerate dari `SHOW CREATE TABLE` (lihat §5) atau tandai deprecated.

**Bug #7 — `EMB_CACHE` bisa basi setelah reset.** `POST /api/faces/reset` hanya `DELETE` dari DB, **tidak** memanggil `invalidateEmbeddingsFor(nrp)`. Jika user reset tanpa langsung merekam ulang, embedding lama masih ada di RAM → bisa salah kenal sampai server restart. (Alur normal rekam.js reset→save menutupi ini karena `/api/faces` melakukan invalidate+add.) **Perbaikan:** panggil `invalidateEmbeddingsFor` di endpoint reset.

**Bug #8 — Tidak ada otorisasi berbasis peran.** `ensureAuth` hanya cek "sudah login". `hak_akses` (admin/user) tak pernah diperiksa di route mana pun. Semua user bisa akses laporan, edit, hapus, debug, sync. **Perbaikan:** middleware `ensureAdmin` untuk operasi sensitif.

### 🟡 Minor / kebersihan kode

- **Bug #9 — Referensi fungsi tidak ada:** `rekam.js` memanggil `FaceCommon.resizeCanvasToVideo(...)` (baris ~136,140) & `test.js`, tetapi `FaceCommon` **tidak mengekspor** `resizeCanvasToVideo` (yang ada `syncCanvasToDisplay`). Memicu `TypeError` pada listener `loadedmetadata` (tertelan karena async), fungsi sinkronisasi tetap jalan lewat `doSync`. Bersihkan pemanggilan yang salah.
- **Port ganda:** `.env` 3007 vs fallback 3001 di `app.js` — dokumentasikan/samakan.
- **Cookie session tidak `secure`** walau HTTPS; `SESSION_SECRET` fallback hardcode. Set di `.env` produksi.
- **Tidak ada proteksi CSRF** pada POST/PUT/DELETE.
- **`black_list_nrp` tak terpakai** — implementasikan atau hapus.
- **Banyak blok kode ter-comment** besar di `absensi.js` & `rekam.js` (versi lama) — sebaiknya dibersihkan.
- **`socket.io` terpasang tapi idle**; `jsonwebtoken` tidak dipakai (auth pakai session). Hapus dependency jika tak direncanakan.
- **Snapshot base64 penuh** ditulis ke `table_absensi.snapshot_base64` & blob ke `table_deteksi_log.frame_snapshot` tiap deteksi → tabel membengkak (log 30k+ baris). Andalkan pipeline `snapshot_url`/`frame_url` dan pangkas base64.
- **`var threshold=0.5` mati** di `absensi.js` (server yang menentukan). Hapus.
- **`/absensi/report` LIMIT 1000 tanpa paginasi** — bisa memotong data pada rentang besar.

---

## 11. Konvensi & Panduan untuk AI Coding Agent

**Bahasa & gaya:** komentar dan pesan UI dalam **Bahasa Indonesia**. Ikuti gaya kode sekitar (indentasi 4 spasi, `const/let`, async/await, `try/catch` di setiap route mengembalikan JSON `{ok:false,...}` atau `res.status(5xx)`).

**Saat menambah/ubah fitur, cek dulu:**
1. **Butuh DB baru?** Perbarui §5 di dokumen ini + buat migrasi SQL (jangan andalkan `sql/schema.sql`). Ingat `sql_mode` STRICT → nilai ENUM/kolom NOT NULL harus tepat.
2. **Menyentuh matching wajah?** Pahami `EMB_CACHE` harus dijaga sinkron (`invalidateEmbeddingsFor`/`addEmbeddingsFor`) dan threshold/margin di `.env`. Idealnya konsolidasikan logika duplikat (Bug #4) sebelum menambah.
3. **Menyentuh profil karyawan?** Bedakan sumber: absensi → `table_karyawan_cache` (via `ensureInCache`); listing/laporan → `table_karyawan`. HR (`rjsmanage`) **read-only**.
4. **Menambah route halaman?** Tambah di `routes/pages.js` (otomatis ter-guard `ensureAuth`) + view EJS pakai `<% layout('layout') -%>` + link di `partials/drawer.ejs`. Untuk operasi sensitif tambahkan cek peran (belum ada — lihat Bug #8).
5. **Menyentuh snapshot/foto?** Selalu utamakan `snapshot_url` (file webp via `/storage`), fallback `snapshot_base64`. Jangan asumsikan base64 selalu ada (mayoritas sudah dimigrasi ke file).
6. **Waktu/tanggal:** pakai `dayjs`, zona `Asia/Jakarta`. Format DB: `tanggal` `YYYY-MM-DD`, `jam` `HH:mm:ss`.
7. **Frontend face:** model di-load dari `/public/models` (fallback CDN). Wajib HTTPS (kamera). Quality gate (score, tinggi wajah relatif) ada di `absensi.js`/`rekam.js` — jaga konsistensi jika mengubah.

**Perintah verifikasi cepat:**
```bash
# Struktur tabel nyata
mysql -h127.0.0.1 -uroot -p<pass> absensi_db_rjs -e "SHOW CREATE TABLE table_absensi\G"
# Jalankan dev
npm run dev    # nodemon, HTTPS di port .env (3007)
```

**Jangan:**
- Jangan menulis ke DB `rjsmanage` (HR) — hanya baca.
- Jangan menaruh rahasia/otorisasi di JS frontend (lihat Bug #3).
- Jangan pakai `sql/schema.sql` sebagai kebenaran skema.
- Jangan menambah nilai status/enum tanpa `ALTER TABLE` lebih dulu (STRICT mode akan menolak).
