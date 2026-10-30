# PRD & System Reference — Aplikasi Absensi Wajah (okt-face-presensi)

> **Tujuan dokumen ini:** Menjadi satu-satunya sumber acuan (single source of truth) bagi AI coding agent maupun developer, agar bisa memahami keseluruhan project **tanpa perlu men-scan semua file**. Setiap kali ada permintaan fitur baru / perbaikan, baca dokumen ini dulu untuk tahu di file mana harus bekerja, aturan bisnis apa yang berlaku, dan jebakan apa yang harus dihindari.
>
> **Terakhir dianalisa:** 2026-10-30 · **Branch:** `main` · **Commit terakhir:** `79cad5e perbaiki bug` (2026-09-08)
>
> **Status verifikasi:** Seluruh file server (`app.js`, `db.js`, `routes/*`, `services/*`, `sql/*`), seluruh JS frontend (`public/js/*`, `public/sw.js`, `public/manifest`) dan view EJS sudah dibaca ulang terhadap kode aktual. Skema DB di §5 berasal dari `SHOW CREATE TABLE` analisa sebelumnya (2026-07-08) + migrasi yang ada di repo; DB live **tidak** dicek ulang pada analisa ini.
>
> **Aturan pemeliharaan:** Setiap perubahan struktur (route, tabel, file baru, aturan bisnis) **wajib** memperbarui bagian terkait di dokumen ini + menambah baris di §13 Changelog.

---

## 1. Ringkasan Produk

Aplikasi web internal **PT Rindang Jati** untuk **presensi (absensi) karyawan berbasis pengenalan wajah (face recognition)**. Karyawan berdiri di depan kamera (tablet/HP stasiun absensi), sistem mengenali wajahnya, lalu mencatat absensi sesuai kategori (shift/peran) yang dipilih operator. Deteksi & ekstraksi fitur wajah dilakukan **di browser** (face-api.js); server hanya menerima *descriptor* (vektor 128 float), mencocokkannya ke database, dan mencatat absensi.

Sejak 2026-07 aplikasi juga berupa **PWA offline-first**: stasiun absensi tetap bisa mencatat absensi saat jaringan/server mati (matching wajah dilakukan di device memakai data yang sudah diunduh), lalu antrian dikirim ke server saat online kembali.

**Pengguna:** operator/admin HR yang menjalankan stasiun absensi, merekam wajah karyawan baru, dan melihat laporan.

**Nilai inti:**
- Absensi cepat tanpa kontak (wajah), anti-dobel per (NRP, tanggal, kategori).
- Tetap jalan saat offline (PWA + IndexedDB + sinkronisasi antrian).
- Data master karyawan diambil dari sistem HR eksternal (`rjsmanage`) dan di-cache lokal.
- Laporan absensi dengan pasangan Masuk/Keluar + durasi kerja + status terlambat, termasuk shift malam (lintas hari) dan Security (shift fleksibel).

### 1.1 Status fitur

| Fitur | Status | Halaman |
|---|---|---|
| Login (session, bcrypt) | ✅ jalan | `/login` |
| Absensi wajah online | ✅ jalan | `/absensi` → `/absensi/capture?k=` |
| Absensi wajah offline (PWA) | ✅ jalan | sama |
| **Absensi v2 — multi-wajah (maks 5/frame)** | 🧪 uji coba, menu terpisah; v1 tetap jalur produksi | `/absensi-v2` → `/absensi-v2/capture?k=` |
| Rekam wajah (15 sampel) | ✅ jalan (menu disembunyikan dari drawer, masih dari dashboard & bottom-nav) | `/rekam` → `/rekam/capture?nrp=` |
| Test wajah | ✅ jalan | `/test`, `/test/capture` |
| Data karyawan (filter wajah/dep, paginasi) | ✅ jalan | `/karyawan` |
| Laporan absensi (DataTables, detail foto, edit/hapus paket) | ✅ jalan | `/laporan` |
| Debug jarak wajah | ✅ tool dev | `/debug/match` |
| Monitoring deteksi log | ✅ tool dev | `/deteksi-log` |
| Cuti, Ijin | ⏳ placeholder ("akan dibuat nanti") | `/cuti`, `/ijin` |
| Blacklist NRP | ❌ tabel ada, belum dipakai | — |
| Role-based access (admin/user) | ❌ belum ada | — |

---

## 2. Tech Stack

| Layer | Teknologi |
|---|---|
| Runtime | Node.js (CommonJS), Express 4. Dev lokal tercatat Node 24; `about.ejs` menyebut Node 20 |
| View | EJS + `ejs-mate` (layout), Tailwind (CDN) + daisyUI 4.12.13 |
| DB | MySQL (via `mysql2/promise`), 2 pool: app + HR |
| Session | `express-session` + **`express-mysql-session`** (tabel `table_sessions`, auto-create), cookie 7 hari, `rolling: true` |
| Auth | Password **bcrypt** (`bcryptjs`, cost 12) dengan auto-upgrade dari plaintext lama |
| Face | `face-api.js` 0.22.2 + `@tensorflow/tfjs` 1.7.4 (**di browser**, dari CDN). Model: `tinyFaceDetector` + `faceLandmark68Net` + `faceRecognitionNet` |
| PWA / Offline | Service Worker `public/sw.js`, manifest `public/manifest`, IndexedDB (`okt-face-offline`) |
| Realtime | `socket.io` (terpasang, **idle** — hanya log koneksi) |
| Scheduler | `node-cron` (sinkronisasi karyawan HR) |
| Transport | **HTTPS** wajib (getUserMedia & Service Worker butuh secure context); sertifikat lokal `certs/192.168.200.5+1*.pem` (mkcert untuk IP LAN 192.168.200.5) |
| Lain | `dayjs`, `dotenv`, `jsonwebtoken` (syncToken untuk `/api/absen/sync`) |
| Frontend libs (CDN) | SweetAlert2 11, DataTables 1.13.6 + jQuery 3.7.1, flatpickr, @tarekraafat/autocomplete.js 10.2.x, Font Awesome 6.5, Google Font Inter |

**Menjalankan:** `npm start` (prod) atau `npm run dev` (nodemon; script memakai sintaks `NODE_ENV=... nodemon` ala Unix — tidak jalan di cmd/PowerShell Windows tanpa `cross-env`). Server listen di `0.0.0.0:<PORT>` via HTTPS. Server produksi berjalan di Linux (lihat path `SNAPSHOT_STORAGE_ROOT`).

> ⚠️ **Port:** `.env` produksi men-set `PORT=3007`; fallback di `app.js` adalah `3001`.
> ⚠️ **`.env` tidak ada di repo** (gitignored). Lihat §9 untuk daftar variabel.

---

## 3. Arsitektur & Design Sistem

### 3.1 Diagram alur tingkat tinggi

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                               BROWSER / PWA (Client)                          │
│                                                                              │
│  Kamera → face-api.js (deteksi + landmark + descriptor 128-float)            │
│      │       (model dari /public/models, fallback CDN github.io)             │
│      │                                                                       │
│      ├─ Rekam:   15 sample  ──────────────────────────► POST /api/faces      │
│      ├─ Absensi ONLINE:  2–3 descriptor ──────────────► POST /api/absen      │
│      ├─ Absensi OFFLINE: OfflineMatch (IndexedDB) → antrian `pending`        │
│      │        └─ saat online: SyncManager ────────────► POST /api/absen/sync │
│      │        └─ unduh master ◄─────────────────────── GET  /api/sync/data   │
│      ├─ Test/Debug: 1 descriptor ─────────────────────► POST /api/match      │
│      └─ Service Worker (sw.js): precache aset+model+CDN, fallback halaman    │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ HTTPS (cert mkcert)
┌───────────────────────────────▼──────────────────────────────────────────────┐
│                           EXPRESS SERVER (app.js)                             │
│  /public static · /sw.js (no-cache) · /storage static (foto webp eksternal)  │
│  session (MySQLStore → table_sessions)                                        │
│  routes/auth.js  (login/logout, publik)                                       │
│  /api  → ensureApiAuth (401 JSON; kecuali /health & /absen/sync)              │
│          routes/api.js ──► routes/api-absensi.js                              │
│  /     → ensureAuth (redirect /login) → routes/pages.js                       │
│                                                                              │
│  In-memory EMB_CACHE ◄── loadAllEmbeddings() dari table_face_embeddings       │
│  (matching Euclidean di RAM, bukan di DB)                                     │
│  CRON: 02:30 fullSyncFromHR() ; tiap 6 jam syncKaryawan()                     │
└───────┬──────────────────────────────────────────┬────────────────────────────┘
        │ pool (app DB)                             │ hrPool (HR DB, READ-ONLY)
┌───────▼─────────────────────┐          ┌──────────▼─────────────────────────┐
│ MySQL: absensi_db_rjs        │          │ MySQL: rjsmanage (HR eksternal)     │
│ - table_absensi              │          │ - data_karyawan (master)            │
│ - table_face_embeddings      │          └─────────────────────────────────────┘
│ - table_deteksi_log          │          ┌─────────────────────────────────────┐
│ - table_karyawan             │◄─────────│ Proses automasi EKSTERNAL (di luar  │
│ - table_karyawan_cache       │ migrasi  │ repo): snapshot_base64 → file .webp │
│ - table_users                │          │ + isi snapshot_url; disajikan via   │
│ - table_sessions (auto)      │          │ /storage/... (SNAPSHOT_STORAGE_ROOT)│
│ - black_list_nrp (unused)    │          └─────────────────────────────────────┘
└──────────────────────────────┘
```

### 3.2 Keputusan desain penting (pahami sebelum mengubah kode)

1. **Face recognition 100% di client.** Server tidak pernah memproses gambar untuk mencari wajah; hanya membandingkan jarak descriptor. Kualitas absensi bergantung pada *quality gate* di frontend (`absensi.js`/`rekam.js`) dan konsistensi model face-api antar device.

2. **Matching in-memory (`EMB_CACHE` di `routes/api.js`).** Semua embedding dimuat ke RAM sekali (`loadAllEmbeddings`, lazy saat request pertama) lalu dibandingkan dengan loop Euclidean. Cache **harus** dijaga sinkron setiap embedding berubah (`invalidateEmbeddingsFor` / `addEmbeddingsFor`) — `/api/faces` dan `/api/faces/reset` sudah melakukannya.

3. **Logika matching ada di 3 tempat dan harus identik:** `/api/match`, `/api/absen` (server, `routes/api.js`) dan `OfflineMatch.findBestMatch` (client, `public/js/offline-match.js`). Algoritma: jarak terbaik per NRP → best & second-best → tolak jika `best > threshold` (unknown) atau `second - best < marginMin` (ambiguous). Threshold & margin di client diambil dari config hasil `/api/sync/data`.

4. **Aturan keterlambatan juga diduplikasi di client** (`absensi.js`: `computeLateFlag`/`computeLateMinutes`) untuk tampilan offline. Nilai final tetap dihitung ulang server saat `/api/absen/sync`.

5. **Dua database.** `absensi_db_rjs` (milik app, boleh tulis) dan `rjsmanage` (HR, **hanya baca**). Data karyawan tidak diketik manual — di-sync dari HR. Ada 2 mekanisme sync yang tumpang tindih (§7).

6. **Snapshot foto absensi punya 2 generasi penyimpanan:**
   - **Lama (base64):** `table_absensi.snapshot_base64` (LONGTEXT, data URI). `/api/absen` dan `/api/absen/sync` **masih menulis ke sini** (frame sudah dikecilkan ke maks 640px, JPEG q0.72).
   - **Baru (file webp):** `snapshot_url` berisi path seperti `/storage/snapshots/2026/06/<id>.webp`, diisi oleh **proses automasi eksternal** (di luar repo) yang memigrasi base64 → file; dipetakan oleh `app.use('/storage', express.static(SNAPSHOT_STORAGE_ROOT))`.
   - Server & frontend selalu **utamakan `snapshot_url`, fallback base64** (`/api/absensi/:id` dan `resolveSnapshotSrc` di `laporan-absensi.js`).

7. **Data karyawan di baris absensi bersifat snapshot-in-time** (`nama_snapshot`, `dep_snapshot`, `divisi_snapshot`, `jabatan_snapshot`). Laporan memakai nilai ini, **bukan** join ke master, agar perubahan data karyawan tidak mengubah histori.

8. **Urutan mount route di `app.js` penting.** `/api` dipasang **sebelum** `app.use('/', ensureAuth, pages)`; kalau dibalik, semua `/api/*` tanpa sesi dibalas redirect HTML ke `/login` (dulu menyebabkan deteksi online palsu & antrian offline macet). API tanpa sesi dibalas `401 {ok:false,error:'unauthorized'}`.

9. **Endpoint di luar `ensureApiAuth`:** `GET /api/health` (probe liveness, benar-benar publik) dan `POST /api/absen/sync` (device yang login offline belum punya sesi) — yang terakhir memeriksa sendiri sesi **atau** `syncToken` JWT (§8.2).

10. **Sesi disimpan di MySQL**, bukan MemoryStore — agar restart server tidak menendang semua PWA terinstall ke `/login` (penyebab lama PWA gagal dibuka).

---

## 4. Struktur Folder & Peta File

```
okt-face-recognition/
├─ app.js                    # Entry: HTTPS server, session(MySQLStore), cron, static (/public, /sw.js, /storage),
│                            #        ensureAuth/ensureApiAuth, mount routes, socket.io (idle)
├─ db.js                     # 2 pool MySQL: pool(app)+q(), hrPool(HR)+hrq()
├─ .env                      # Konfigurasi (TIDAK di-commit) — §9
├─ package.json              # name: absensi-face-node
├─ certs/                    # Sertifikat HTTPS mkcert (192.168.200.5)
├─ log.txt                   # Catatan/scratch lama dari sesi AI sebelumnya — bukan log aplikasi, aman diabaikan
├─ PRD.md                    # Dokumen ini
│
├─ routes/
│  ├─ auth.js                # GET/POST /login (bcrypt + auto-upgrade plaintext), POST /logout
│  ├─ pages.js               # Semua route render EJS (di-guard ensureAuth di app.js)
│  ├─ api.js                 # API inti: karyawan/autocomplete, match, faces, absen, cache HR, deteksi-log,
│  │                         #   OFFLINE: health, sync/manifest, sync/data, absen/sync. Konstanta KATEGORI & SHIFT_RULES
│  └─ api-absensi.js         # API laporan: report (pairing), detail, edit pair, delete pair (+password otorisasi)
│
├─ services/
│  ├─ karyawanCache.js       # Read-through cache HR→table_karyawan_cache (ensureInCache, fullSyncFromHR, ACTIVE_STATUSES)
│  └─ karyawanSync.js        # Sync HR→table_karyawan (syncKaryawan, status_io='1')
│
├─ sql/
│  ├─ schema.sql             # ⚠ USANG — jangan dipakai sebagai acuan (Bug B-11)
│  └─ 2026-07-09-fix-critical-bugs.sql   # ALTER enum status deteksi_log + 'ambiguous'
│
├─ public/
│  ├─ sw.js                  # Service Worker (CACHE_VERSION, precache, strategi fetch, halaman fallback offline)
│  ├─ manifest               # Web App Manifest (tanpa ekstensi; start_url '/', standalone, portrait)
│  ├─ icons/icon-192.png, icon-512.png
│  ├─ css/styles.css         # Style kustom (dimuat sebagai styles.css?v=3)
│  ├─ js/
│  │  ├─ face-common.js      # FaceCommon: loadModels, startCamera/switch/list, grabFrame(maxEdge,quality),
│  │  │                      #   syncCanvasToDisplay, drawWithResize, drawDetections
│  │  ├─ absensi.js          # [v1, produksi] Loop absensi 1 wajah: quality gate, multi-sample, online→/api/absen, offline→OfflineMatch+pending
│  │  ├─ absensi-v2.js       # [v2, uji coba] Multi-wajah: tracking IoU, match lokal, kotak merah/hijau + label nama, kirim per orang
│  │  ├─ offline-db.js       # OfflineDB: wrapper IndexedDB (embeddings, profiles, config, pending, meta)
│  │  ├─ offline-match.js    # OfflineMatch: port logika matching server ke client
│  │  ├─ sync-manager.js     # SyncManager: checkServer, downloadDataMaster, uploadPending (batch), fullSync
│  │  ├─ offline-session.js  # Login/logout offline (dimuat di semua halaman via head.ejs)
│  │  ├─ login-offline-status.js  # Indikator online/offline + kesiapan data di halaman login
│  │  ├─ rekam.js            # Autocomplete NRP (rekam-start) + rekam 15 sample + verifikasi anti-salah-orang
│  │  ├─ test.js             # Test wajah live → /api/match
│  │  ├─ debug-match.js      # Debug jarak wajah (threshold/margin/statistik sesi)
│  │  ├─ karyawan.js         # Kartu data karyawan + filter (face/dep) + paginasi
│  │  ├─ laporan-absensi.js  # Laporan: DataTables, filter, detail foto, edit/hapus (minta password otorisasi)
│  │  ├─ deteksi-log.js      # Monitoring log deteksi + ringkasan harian
│  │  └─ ui.js               # global: speak (TTS id-ID), toastTop, toastBottomInfo (diakses sbg window.UI)
│  ├─ models/                # Bobot face-api.js (yang dipakai: tiny_face_detector, face_landmark_68, face_recognition)
│  └─ ping.mp3 / error.mp3
│
└─ views/  (EJS + ejs-mate)
   ├─ layout.ejs / layoutfull.ejs (laporan) / auth-layout.ejs (login)
   ├─ partials/ head.ejs (CDN, manifest, register SW, offline-db+offline-session), nav.ejs (user+logout),
   │            drawer.ejs (menu kiri), bottomnav.ejs (mobile), footer.ejs
   ├─ login.ejs, dashboard.ejs, about.ejs, placeholder.ejs
   ├─ absensi-start.ejs      # grid 14 kategori; prefetch /absensi/capture agar ter-cache SW
   ├─ absensi-capture.ejs    # set window.__KATEGORI__, simpan session user ke IndexedDB (untuk login offline)
   ├─ absensi-v2-start.ejs, absensi-v2-capture.ejs   # Absensi v2 (uji coba): grid kategori + kamera & riwayat sesi
   ├─ rekam-start.ejs, rekam-capture.ejs (window.__NRP__)
   ├─ test-start.ejs, test-capture.ejs
   ├─ karyawan.ejs, laporan-absensi.ejs (load jQuery/DataTables/flatpickr/autocomplete/SweetAlert)
   └─ debug-match.ejs, deteksi-log.ejs
```

### 4.1 Alur data per fitur (file yang disentuh)

**Absensi online:** `absensi-start.ejs` → `absensi-capture.ejs` → `absensi.js` (quality gate + 2–3 descriptor + `grabFrame` 640px) → `POST /api/absen` (`api.js`) → match `EMB_CACHE` → `ensureInCache` (profil) → cek status aktif → `resolveTanggalAbsensi` → `INSERT table_absensi` (UNIQUE → duplicate) → `insertDeteksiLog` → JSON → UI (TTS + kartu hasil).

**Absensi offline:** `absensi.js` deteksi `_isOnline=false` (atau network error saat fetch) → `tryOfflineMatch` → `OfflineMatch.findBestMatch` → `OfflineDB.getProfile` → cek aktif → anti-dobel lokal (index `[nrp,tanggal,kategori]`) → `OfflineDB.addPending` → UI tampil "📴(offline)". Saat online: `SyncManager.fullSync()` → `uploadPending()` (batch 5, `POST /api/absen/sync`) → `downloadDataMaster()` (`GET /api/sync/data`).

**Absensi v2 (uji coba, `absensi-v2.js`):** tiap tick (220ms) `detectAllFaces` (TinyFaceDetector inputSize 416) → maks 5 wajah terbesar → dipasangkan ke *track* lewat IoU ≥0.3 (track hilang >1.2s dibuang). Descriptor hanya dihitung bila ada wajah baru/belum terkonfirmasi (+ tiap 5 tick untuk verifikasi ulang). Per track: quality gate (skor ≥0.6, tinggi wajah 10–90% frame) → 2–3 descriptor → `OfflineMatch.findBestMatch` lokal (tak dikenal/ambiguous = tetap merah, **tidak** dikirim) → cek cooldown NRP 2 menit → `POST /api/absen` (`source:'web-v2'`, snapshot = crop wajah 480px) → hasil: ok/duplicate = kotak hijau + nama; unknown/ambiguous dari server = merah, coba lagi 3s; inactive = merah 2 menit. Offline/401 → antrian IndexedDB dengan `source:'offline-sync-v2'`. Hanya efek suara ping/error, tanpa ucapan nama (TTS). Riwayat sesi tampil di bawah kamera.

**Rekam wajah:** `rekam-start.ejs` (autocomplete `/api/karyawan/search`) → `rekam-capture.ejs?nrp=` → `rekam.js`: cek `/api/faces/count` → konfirmasi penggantian (data lama **tidak** dihapus di client) → kumpulkan 15 sampel (jeda ≥600ms, frame 960px q0.82) dengan verifikasi sampel pertama via `/api/match` (tolak bila wajah milik NRP lain) → tombol Simpan → `POST /api/faces` (`forceReplace:true`).

**Laporan:** `laporan-absensi.ejs` → `laporan-absensi.js` → `GET /api/absensi/report` → DataTables; detail `GET /api/absensi/:id`; edit `PUT /api/absensi/pair/:id`; hapus `DELETE /api/absensi/pair/:id` (keduanya kirim `authorizationPassword`).

---

## 5. Skema Database (AKTUAL)

> Database aktif: **`absensi_db_rjs`** (bukan `absensi_db` seperti di `sql/schema.sql`). Gunakan definisi di bawah, **abaikan `sql/schema.sql`**. Server MySQL berjalan dengan `sql_mode` STRICT_TRANS_TABLES → nilai ENUM / NOT NULL yang salah akan error, bukan dipotong.

### `table_absensi` — catatan absensi
| Kolom | Tipe | Catatan |
|---|---|---|
| id | BIGINT UNSIGNED PK AI | |
| nrp | VARCHAR(32) | FK → table_karyawan.nrp |
| tanggal | DATE | Untuk Keluar Shift Malam bisa H+1 dari tanggal masuk (§6.5) |
| jam | TIME | |
| kategori | VARCHAR(64) | salah satu `KATEGORI` (§6.1) |
| shift_code | VARCHAR(20) NULL | PAGI/SIANG/MALAM/DS/DRIVER/SECURITY/TERLAMBAT/IJIN |
| nama_snapshot, dep_snapshot, divisi_snapshot, jabatan_snapshot | VARCHAR | disalin saat absen |
| is_late | TINYINT(1) | flag terlambat |
| menit_terlambat | INT | |
| snapshot_base64 | LONGTEXT NULL | data URI (generasi lama, masih ditulis) |
| snapshot_url | VARCHAR(255) NULL | `/storage/...webp` (diisi proses eksternal) |
| source | VARCHAR(32) def 'web' | `web` (v1 online), `offline-sync` (v1 offline), `web-v2` / `offline-sync-v2` (Absensi v2 uji coba). Whitelist di `ONLINE_SOURCES`/`OFFLINE_SOURCES` (`api.js`) |
| created_at | TIMESTAMP | |
| **UNIQUE** `uniq_absen` (nrp, tanggal, kategori) | | basis anti-dobel |

### `table_face_embeddings` — 1 baris = 1 sample wajah
| Kolom | Tipe | Catatan |
|---|---|---|
| id | BIGINT PK AI | |
| nrp | VARCHAR(32) | FK → table_karyawan.nrp |
| embedding | LONGTEXT (JSON, CHECK json_valid) | array 128 float |
| snapshot | LONGBLOB NULL | JPEG biner |
| snapshot_mime | VARCHAR(32) | |
| created_at | TIMESTAMP | |

Target 15 sample per NRP (server memotong `samples.slice(0,15)`).

### `table_deteksi_log` — audit setiap percobaan deteksi
| Kolom | Tipe | Catatan |
|---|---|---|
| id | BIGINT PK AI | |
| context | ENUM('absensi','rekam','test') | praktis hanya 'absensi' yang ditulis |
| kategori | VARCHAR(64) NULL | |
| nrp_detected | VARCHAR(32) NULL | |
| distance | DECIMAL(6,4) NULL | NULL untuk data offline-sync |
| status | ENUM('recognized','unknown','multi-face','no-face'**,'ambiguous'**) | 'ambiguous' ditambah oleh migrasi `sql/2026-07-09-fix-critical-bugs.sql`. Kode punya fallback ke 'unknown' jika migrasi belum dijalankan (`insertDeteksiLog`) |
| frame_snapshot | LONGBLOB NULL | JPEG biner |
| frame_url | VARCHAR(255) NULL | migrasi (jarang dipakai) |
| created_at | TIMESTAMP | |

### `table_karyawan` — master lokal (di-sync dari HR via `syncKaryawan`)
`nrp` PK, `nama`, `dep`, `divisi`, `jabatan`, `status TINYINT(1)`, `created_at`. `status` di sini angka (selalu di-set 1 oleh sync); `/api/hr/karyawan` menimpanya dengan status teks dari HR lalu memfilter yang aktif (`isActiveKaryawanStatus`).

### `table_karyawan_cache` — read-through cache profil HR
`nrp` PK, `idkar`, `nama`, `departement`, `divisi`, `jabatan`, `status ENUM('KONTRAK','TETAP','MAGANG','RESIGN')`, `tmt`, `updated_at`. Dipakai `/api/absen`, `/api/match`, `/api/faces`, `/api/absen/sync`, `/api/sync/data`, autocomplete rekam.

### `table_users` — akun login
`id` PK, `nama_lengkap`, `username` UNIQUE, `password` (bcrypt; baris lama plaintext otomatis di-hash saat login berhasil pertama kali), `hak_akses ENUM('admin','user')`, timestamps. Tidak ada UI manajemen user — user dibuat manual di DB.

### `table_sessions` — sesi express (dibuat otomatis oleh `express-mysql-session`)
Kolom standar library (`session_id`, `expires`, `data`). Jangan dibuat manual.

### `black_list_nrp` — **tabel ada, TIDAK dipakai di kode manapun**
`nrp` PK, `nama`, `created_at`.

### DB eksternal HR: `rjsmanage.data_karyawan` (READ-ONLY dari app)
Kolom yang dipakai: `idkar, nrp, nama, departement, divisi, jabatan, status` (teks: KONTRAK/TETAP/MAGANG/RESIGN, kemungkinan juga KELUAR/NONAKTIF/HABIS KONTRAK), `tmt`, `status_io` ('1' = aktif). ~1.7rb baris.

### IndexedDB client: `okt-face-offline` (DB_VERSION 2)
| Store | Key | Isi |
|---|---|---|
| embeddings | id (auto) + index `nrp` | `{nrp, emb:[128]}` (full replace tiap download) |
| profiles | nrp + index `nama` | `{nrp,nama,dep,divisi,jabatan,status}` |
| config | key | threshold, marginMin, kategori, shiftRules |
| pending | id (auto) + index `sync_status`, `nrp_tanggal_kategori` | `{nrp,kategori,tanggal,jam,frameBase64,sync_status:'pending'|'failed',attempts,created_at,failed_at}` |
| meta | key | lastSyncAt, embCount, profileCount, session `{user,expiresAt}`, offlineLoggedOut |

> Store `pending` berisi foto base64 → **jangan pakai `getAll('pending')`**, selalu lewat index/cursor (dulu menyebabkan Chrome "Aw, Snap" / OOM).

---

## 6. Aturan Bisnis

### 6.1 Daftar KATEGORI absensi (`api.js` → `KATEGORI`)
```
Masuk/Keluar Shift Pagi | Masuk/Keluar Shift Siang | Masuk/Keluar Shift Malam
Masuk/Keluar DS | Masuk/Keluar Driver | Masuk/Keluar Security
Masuk Terlambat | Ijin Keluar
```
Daftar ini juga **di-hardcode** di: `views/absensi-start.ejs` & `views/absensi-v2-start.ejs` (tombol), `public/sw.js` (`ABSENSI_KATEGORI`, halaman absensi offline), `views/laporan-absensi.ejs` (filter), dan pemetaan pasangan di `api.js`/`api-absensi.js`. Menambah kategori = ubah semua tempat itu.

Validasi wajib `isValidKategori()`. `shift_code` diturunkan via `deriveShiftCode()` (diduplikasi di `api.js` & `api-absensi.js`).

### 6.2 Jam shift & keterlambatan
| Shift | Mulai | Batas `is_late` |
|---|---|---|
| Pagi | 06:00 | > 06:05 |
| Siang | 14:00 | > 14:05 |
| Malam | 22:00 | > 22:05 |

- `computeLateFlag`: `is_late=1` jika absen setelah batas di atas, **hanya** untuk 3 kategori "Masuk Shift ...".
- `computeLateMinutes`: menit sejak jam mulai, **0 jika < 3 menit** (grace 3, bukan 5 → inkonsistensi, Bug B-13). Masuk Shift Malam pada 00:00–05:59 dihitung dari 22:00 hari sebelumnya.
- DS (`SHIFT_RULES.ds8h`, minimal 8 jam) & Security **belum punya aturan telat**.
- Edit jam masuk di laporan **tidak** menghitung ulang `is_late`/`menit_terlambat`.

### 6.3 Threshold pengenalan wajah (`.env`)
- `FACE_DISTANCE_THRESHOLD` (default 0.45) — jarak Euclidean maksimum agar match.
- `FACE_MARGIN_MIN` (default 0.05) — selisih minimum kandidat terbaik vs kedua; lebih kecil → **ambiguous** (ditolak).
- Nilai dikirim ke client via `/api/config/face` (debug) dan `/api/sync/data` (offline).

### 6.4 Quality gate client (absensi & rekam & debug)
- TinyFaceDetector `inputSize 256, scoreThreshold 0.5`.
- Skor deteksi ≥ 0.6; tinggi wajah relatif 20%–85% tinggi frame; tepat 1 wajah.
- Absensi: kumpulkan 2–3 descriptor dalam window 1.2 detik, loop throttle 220ms, cooldown 4 detik setelah hasil.
- Rekam: 15 sampel, jeda ≥600ms (+450ms tunggu), verifikasi sampel pertama via `/api/match`. Sejak 2026-10-30 tanpa tutup putih/lingkaran — hanya kotak hijau.
- Absensi v2 (uji coba): inputSize 416, maks 5 wajah, tinggi wajah 10–90% frame, 2–3 sampel per wajah, cooldown 2 menit per NRP (§4.1).

### 6.5 Tanggal absensi & pairing Masuk/Keluar
- **Keluar Shift Malam** (`resolveTanggalAbsensi`): jika ada "Masuk Shift Malam" di tanggal hari ini, tanggal keluar disimpan **H+1**. Keluar normal jam 06:00 otomatis sudah tanggal H+1.
- **Laporan (`/api/absensi/report`)** hanya mengambil baris `Masuk%` lalu LEFT JOIN 1 baris `Keluar%` (shift_code sama):
  - Non-Security: keluar di tanggal yang sama, kecuali MALAM → tanggal+1.
  - **Security**: keluar pertama dengan waktu > masuk + **6j30m** dan ≤ masuk + **18 jam** (shift fleksibel lintas hari).
  - Durasi = `TIMESTAMPDIFF(MINUTE, masuk, keluar)`. `LIMIT 1000`, urut tanggal DESC.
- **Detail/Edit/Hapus** memakai helper yang sama (`pairKeluarTanggal`, `pairMasukTanggal`, `findSecurityKeluar/Masuk`). Edit Security: jika jam keluar ≤ jam masuk → keluar dianggap H+1.
- Konsekuensi: **"Ijin Keluar" tidak pernah tampil di laporan** (bukan `Masuk%`), "Masuk Terlambat" tampil tanpa pasangan.

### 6.6 Status karyawan aktif
`ACTIVE_STATUSES = {KONTRAK, TETAP, MAGANG}` (`services/karyawanCache.js`). Non-aktif ditolak saat rekam, absen, offline-sync, dan dibuang dari data offline. `isActiveKaryawanStatus()` di `api.js` juga mengenal `status_io='0'`, RESIGN/KELUAR/NONAKTIF/NON-AKTIF/HABIS KONTRAK, dan status lokal '1'/'0'.

### 6.7 Otorisasi edit/hapus laporan
`PUT/DELETE /api/absensi/pair/:id` wajib `authorizationPassword` (body) atau header `x-authorization-password` yang sama persis dengan `PASSWORD_OTORISASI` di `.env`. Jika env tidak diset → 500. Password diminta lewat SweetAlert di `laporan-absensi.js`.

---

## 7. Sinkronisasi Data Karyawan (HR → App)

Ada **dua jalur sync yang tumpang tindih** (kandidat konsolidasi):

1. **`services/karyawanCache.js`** → `table_karyawan_cache`
   - `fullSyncFromHR()`: status ∈ (KONTRAK,TETAP,MAGANG) → upsert satu per satu. **Cron 02:30 WIB** + manual `POST /api/cache/sync-now`.
   - `ensureInCache(nrp)`: read-through — cache dulu, kosong/kadaluarsa → HR. TTL via `KARYAWAN_CACHE_TTL_MIN` (0 = tanpa TTL). Catatan: karyawan yang menjadi RESIGN tidak ikut `fullSyncFromHR`, jadi status di cache **bisa tetap aktif** sampai di-invalidate (`POST /api/cache/invalidate`) atau TTL diaktifkan.
2. **`services/karyawanSync.js`** → `table_karyawan`
   - `syncKaryawan()`: HR `status_io='1'` → upsert. **Cron tiap 6 jam** (tidak dijalankan saat startup).

> Kesimpulan untuk agent: **profil untuk absensi/rekam/offline** berasal dari `table_karyawan_cache`; **listing Data Karyawan & autocomplete filter laporan** dari `table_karyawan`. HR (`rjsmanage`) **read-only**.

---

## 8. Mode Offline / PWA (detail)

### 8.1 Service Worker (`public/sw.js`, `CACHE_VERSION = 'v6'`)
- Didaftarkan di `partials/head.ejs` (scope `/`); disajikan via route `/sw.js` dengan `Cache-Control: no-cache`.
- **Install:** precache aset lokal wajib (`PRECACHE_URLS`: styles, ui/offline-*/sync/face-common/absensi.js, suara, 3 model face-api) — gagal satu = install gagal; CDN (`CDN_PRECACHE_URLS`) best-effort dengan mode CORS. `skipWaiting()` + `clients.claim()`.
- **Strategi fetch (hanya GET):**
  | Request | Strategi |
  |---|---|
  | Navigasi (`mode: navigate`) | network → jika redirect dikembalikan sbg 302 baru (tak di-cache); gagal → cache halaman → `/absensi` = halaman absensi offline buatan SW → capture generik (`CAPTURE_PATHS`: `/absensi/capture`, `/absensi-v2/capture`) → `/` → halaman "belum tersedia offline" |
  | `/login?online_check` / `?offline_session_check` | network-only |
  | `/api/sync/manifest` | network-first |
  | `/api/*` lain | network-only (503 JSON `{error:'offline'}` saat gagal) |
  | `/storage/*` | tidak di-intercept |
  | `/public/*` | **cache-first (tanpa revalidasi)** |
  | CDN dikenal (`CDN_ORIGINS`) | cache-first |
  | lainnya same-origin | network-first |
- Response `redirected`, opaque, no-store, non-2xx **tidak** pernah di-cache (`safeCachePut`).
- ⚠️ **Setiap mengubah file di `/public/` (JS/CSS/model) WAJIB menaikkan `CACHE_VERSION`** — kalau tidak, device yang sudah install tetap memakai versi lama selamanya (cache-first). Untuk `styles.css` juga naikkan query `?v=` di `head.ejs` dan `PRECACHE_URLS`.

### 8.2 Data offline
- `GET /api/sync/data` (butuh sesi): seluruh embedding NRP aktif + profil dari `table_karyawan_cache` + config. Dipanggil `SyncManager.fullSync()` **setiap kali halaman absensi-capture dibuka saat online** dan saat event `online`. Full replace (tidak ada delta; `/api/sync/manifest` tersedia tapi belum dipakai).
- Respons `/api/sync/data` membawa `syncToken` (JWT 30 hari) → disimpan di `meta.syncToken`.
- Upload antrian: `uploadPending()` batch 5 (diperkecil otomatis saat 413) dengan header `Authorization: Bearer <syncToken>` (cookie sesi juga ikut bila ada). 401 → berhenti, antrian **tetap utuh**. Hasil per item: `ok`/`duplicate` → hapus; `no-profile`/`inactive`/`invalid-kategori`/`invalid-time` → `failed` permanen (foto dibuang); error lain → `attempts++`, gagal setelah 3 kali. Baris `failed` dibersihkan setelah 7 hari.
- Server `/api/absen/sync` butuh sesi atau syncToken valid; memvalidasi format & rentang `tanggal/jam` (≤ `OFFLINE_SYNC_MAX_AGE_DAYS`=30 hari lalu, ≤ 1 hari ke depan), tetapi tetap **mempercayai `nrp` hasil matching di device** dan jam device; menghitung ulang telat & shift_code, `source='offline-sync'`, first-write-wins.
- Jika jaringan hidup tetapi server membalas 401 (tidak ada sesi), `absensi.js` menyalakan `_sessionExpired` dan semua absensi lewat jalur offline (antrian) sampai halaman dimuat ulang setelah login.

### 8.3 Sesi offline
- Saat `absensi-capture` dibuka online, `{user, expiresAt: +7 hari}` disimpan ke IndexedDB `meta.session`.
- `offline-session.js` mencegat submit login/logout (`preventDefault` sinkron), cek server via `/login?offline_session_check`; jika terjangkau form dikirim normal, jika tidak: login offline (hanya **username terakhir**, tanpa password) → redirect `/absensi`; logout offline → set `meta.offlineLoggedOut=true`, di-sync ke `POST /logout` saat online.
- Praktiknya, PWA yang dibuka saat offline langsung mendapat halaman dari cache SW (tanpa login).

---

## 9. Referensi API (semua di bawah `/api`; butuh sesi kecuali ditandai 🌐 publik)

Tanpa sesi → `401 {ok:false, error:'unauthorized'}`.

### Pengenalan wajah & rekam
| Method | Path | Body/Query | Fungsi |
|---|---|---|---|
| POST | `/api/match` | `{descriptors:[[128f]]}` | Cari NRP terbaik. Return `{match:{nrp,dist,nama,dep,divisi,jabatan,status}}` atau `{match:null,bestDist[,secondDist]}` |
| POST | `/api/absen` | `{kategori, descriptors, frameBase64, source?}` (`source` ∈ web, web-v2) | Catat absensi. `{ok:true, match, is_late, menit_terlambat}` / `{ok:false, reason}` (`unknown`\|`ambiguous`\|`duplicate`\|`inactive`\|`no-profile`) / 400 / 500 |
| POST | `/api/faces` | `{nrp, samples:[{embedding,snapshotBase64,mime}], forceReplace}` | Simpan ≤15 embedding (transaksi; replace jika forceReplace); update EMB_CACHE. `{ok:false,reason:'exists'}` bila ada & tidak force |
| GET | `/api/faces/count?nrp=` | | `{count}` |
| POST | `/api/faces/reset` | `{nrp}` | Hapus semua embedding NRP + invalidasi EMB_CACHE (tidak dipakai UI lagi) |
| GET | `/api/config/face` | | `{threshold, marginMin}` |

### Karyawan & cache HR
| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/karyawan/search?q=` | Autocomplete rekam (cache → fallback HR + upsert cache), maks 20 |
| GET | `/api/karyawan/nama-suggest` \| `divisi-suggest` \| `jabatan-suggest` `?q=` | `{items:[...]}` dari `table_karyawan` |
| GET | `/api/hr/karyawan?q=&page=&limit=&face=with\|without&dep=` | Listing aktif + `hasFace` + summary (total/spinning/weaving); paginasi in-memory |
| GET | `/api/hr/karyawan/:nrp` | Detail lokal + status teks HR |
| POST | `/api/cache/invalidate` | `{nrp, fetch?}` hapus cache NRP (opsional repopulate) |
| POST | `/api/cache/sync-now` | Trigger `fullSyncFromHR` |

### Laporan absensi (`api-absensi.js`)
| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/absensi/report?tgl_from&tgl_to&nrp&nama&dep&divisi&jabatan&kategori` | Pasangan Masuk/Keluar + durasi (LIMIT 1000). Filter `kategori` hanya bermakna untuk kategori `Masuk...` |
| GET | `/api/absensi/:id` | Detail + pasangan + `snapshot_masuk`/`snapshot_keluar` (url atau base64) |
| PUT | `/api/absensi/pair/:id` | `{tanggal, jam_masuk, jam_keluar?, authorizationPassword}` edit paket; jam_keluar kosong → hapus baris keluar; belum ada → insert |
| DELETE | `/api/absensi/pair/:id` | `{authorizationPassword}` hapus paket Masuk+Keluar |

### Monitoring deteksi
| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/deteksi-log?context&status&tgl_from&tgl_to&nrp&limit` | Daftar log (limit 10–500) |
| GET | `/api/deteksi-log/:id/frame` | `frame_snapshot` sebagai image/jpeg |
| GET | `/api/deteksi-log/summary?...` | Ringkasan per hari (recognized/unknown/ambiguous), 14 hari |

### Offline / sync
| Method | Path | Fungsi |
|---|---|---|
| GET 🌐 | `/api/health` | `{ok:true,time}` — probe liveness (jangan di-cache) |
| GET | `/api/sync/manifest` | `{embCount, embMaxAt, profileMaxAt, config}` (belum dipakai client) |
| GET | `/api/sync/data` | `{embeddings, profiles, config, syncToken, syncedAt}` — data master offline |
| POST 🌐* | `/api/absen/sync` | *Butuh sesi **atau** header `Authorization: Bearer <syncToken>` (401 jika tidak). `{items:[{clientId,nrp,kategori,tanggal,jam,frameBase64,source?}]}` (`source` ∈ offline-sync, offline-sync-v2) → `{ok:true, results:[{clientId, ok, reason?}]}` (reason: `invalid-kategori`\|`invalid-time`\|`no-profile`\|`inactive`\|`duplicate`\|`error`) |

### Halaman (`routes/pages.js`, di-guard) & Auth (`routes/auth.js`)
`GET /` (dashboard), `/absensi`, `/absensi/capture?k=`, `/absensi-v2`, `/absensi-v2/capture?k=` (uji coba), `/rekam`, `/rekam/capture?nrp=`, `/test`, `/test/capture`, `/karyawan`, `/laporan`, `/cuti` & `/ijin` (placeholder), `/about`, `/debug/match`, `/deteksi-log`. Auth: `GET/POST /login`, `POST /logout`. Statis: `/public/*`, `/sw.js`, `/storage/*`.

---

## 10. Konfigurasi (.env)

```ini
PORT=3007
NODE_ENV=development
TZ=Asia/Jakarta
DB_HOST=127.0.0.1  DB_USER=root  DB_PASS=***  DB_NAME=absensi_db_rjs  DB_CONN_LIMIT=10
HR_DB_HOST=127.0.0.1  HR_DB_USER=root  HR_DB_PASS=***  HR_DB_NAME=rjsmanage  HR_DB_CONN_LIMIT=10
SNAPSHOT_STORAGE_ROOT=/home/rindang/Downloads/automasi/.../fotoabsen   # dipetakan ke /storage
FACE_DISTANCE_THRESHOLD=0.45
FACE_MARGIN_MIN=0.05
KARYAWAN_CACHE_TTL_MIN=0
SESSION_SECRET=***            # WAJIB di produksi (fallback hardcode 'rjs-face-dev-secret'); juga dipakai menandatangani syncToken
SYNC_TOKEN_SECRET=***         # opsional — rahasia khusus syncToken (default = SESSION_SECRET)
PASSWORD_OTORISASI=***        # WAJIB — password edit/hapus laporan (tanpa ini edit/hapus 500)
```
Mengganti `SESSION_SECRET` akan me-logout semua sesi dan membatalkan semua syncToken (device perlu login online sekali lagi).
HR_* fallback ke DB_* bila tidak diset. Path sertifikat HTTPS di-hardcode di `app.js`.

---

## 11. 🐞 Bug & Technical Debt

### 11.1 Sudah diperbaiki (riwayat, jangan diulang)
| ID lama | Perbaikan | Commit |
|---|---|---|
| #1 Password plaintext | bcrypt + auto-upgrade di `routes/auth.js` | 79cad5e |
| #2 Insert 'ambiguous' gagal | Migrasi `sql/2026-07-09-fix-critical-bugs.sql` + fallback `insertDeteksiLog` | 79cad5e |
| #3 Password edit/hapus di JS | Dipindah ke server (`PASSWORD_OTORISASI`) | 79cad5e |
| — Session MemoryStore | MySQLStore + `rolling` + `secure:'auto'` | 79cad5e |
| — `/api` di belakang redirect HTML | `ensureApiAuth` 401 JSON, mount sebelum pages | 79cad5e |
| — OOM/antrian offline macet | batch upload, cursor IndexedDB, frame 640px, purge failed | 79cad5e |
| — PWA gagal dibuka (redirect ter-cache) | `navigationHandler` + `safeCachePut` | 79cad5e |
| — Sampel absensi tak pernah cukup | throttle dipindah ke level loop | 79cad5e |
| B-01 Login/logout offline tidak jalan (`preventDefault` setelah `await`) | `offline-session.js`: `preventDefault()` sinkron di awal, jika server terjangkau form dikirim via `HTMLFormElement.prototype.submit`; flag `offlineBusy` + reset saat `pageshow` | 2026-10-30 |
| B-02 `/api/absen/sync` publik tanpa proteksi | Wajib sesi **atau** `Authorization: Bearer <syncToken>` (JWT 30 hari, diterbitkan `/api/sync/data`, dicek user masih ada); validasi format & rentang `tanggal/jam` (≤30 hari lalu, ≤1 hari ke depan → `invalid-time`) | 2026-10-30 |
| B-03 401 tampil "wajah tidak terdeteksi" | `absensi.js`: 401 dari `/api/absen` (atau `unauthorized` saat sync awal) → `_sessionExpired`, absensi dialihkan ke jalur offline + badge "Sesi habis"; pesan khusus bila data offline belum siap | 2026-10-30 |
| B-04 Pairing Security PUT/DELETE pakai jam 00:00 | `api-absensi.js`: `toYmd()` di `findSecurityKeluar/Masuk` | 2026-10-30 |
| B-05 Rekam ulang setelah 15 sampel tidak merekam | `rekam.js`: `ensureLoop()` dipanggil tombol Mulai/Ulangi | 2026-10-30 |
| B-06 Rekam menghapus data lama sebelum simpan | `rekam.js`: tidak lagi memanggil `/api/faces/reset`; penggantian data lewat `POST /api/faces` `forceReplace` (transaksional); konfirmasi sekali (`replaceConfirmed`) | 2026-10-30 |
| B-07 `EMB_CACHE` basi setelah reset | `/api/faces/reset` memanggil `invalidateEmbeddingsFor` + try/catch | 2026-10-30 |

### 11.2 🔴 Kritis
_(tidak ada yang terbuka saat ini)_

Catatan sisa dari B-01/B-02:
- Login offline tetap hanya mencocokkan **username terakhir tanpa password** (desain awal; password tidak disimpan di device).
- Keamanan token sync bergantung pada `SESSION_SECRET`/`SYNC_TOKEN_SECRET` di `.env`. Jika keduanya tidak diset, dipakai fallback hardcode yang bisa ditebak.
- Device yang belum pernah mengunduh data dengan kode baru belum punya token; antriannya tertahan (401, tidak dibuang) sampai operator login online sekali.

### 11.3 🟠 Penting
**B-08 — Tidak ada otorisasi berbasis peran.** `hak_akses` (admin/user) tidak pernah dicek. Semua user login bisa rekam/reset wajah, sync cache, debug, lihat laporan. Edit/hapus laporan hanya dilindungi satu password bersama di `.env`. **Perbaikan:** middleware `ensureAdmin`.

**B-09 — Sinkron offline berat.** Setiap buka halaman absensi online → `fullSync` mengunduh **semua** embedding (≈15 × jumlah karyawan × 128 float JSON, puluhan MB) dan server memanggil `ensureInCache` per NRP secara serial. `/api/sync/manifest` sudah ada tapi tidak dipakai. **Perbaikan:** bandingkan manifest (`embCount/embMaxAt/profileMaxAt`) dengan meta lokal sebelum download.

**B-10 — Duplikasi logika.** Matching (best/second/threshold/margin) ada di `/api/match`, `/api/absen`, `offline-match.js`; `euclideanDistance` didefinisikan **dua kali** di `api.js`; `deriveShiftCode`/`pasanganMasuk`/`pasanganKeluar` diduplikasi (bahkan didefinisikan ulang di dalam handler `/absensi/:id`); aturan telat diduplikasi di `absensi.js`; daftar kategori di 4+ tempat (§6.1). **Perbaikan:** ekstrak ke `services/faceMatch.js` & `services/shift.js`; untuk client, ambil dari config sync.

**B-11 — `sql/schema.sql` usang.** DB `absensi_db`, tak memuat `table_users`, `table_karyawan_cache`, `black_list_nrp`, `table_sessions`, kolom `shift_code`, `snapshot_url`, `*_snapshot`, `source`, ENUM ambiguous. **Perbaikan:** regenerate dari `SHOW CREATE TABLE`.

**B-12 — Laporan tidak menampilkan "Ijin Keluar" & filter kategori Keluar selalu kosong.** Query hanya mengambil `kategori LIKE 'Masuk%'`, sementara dropdown filter menawarkan semua 14 kategori. `LIMIT 1000` tanpa paginasi bisa memotong rentang besar.

### 11.4 🟡 Minor / kebersihan
- **B-13** Grace telat tidak konsisten: `is_late` grace 5 menit, `menit_terlambat` grace 3 menit (06:04 → `is_late=0`, `menit_terlambat=4`). Server & client sama-sama begitu.
- **B-14** Masuk Shift Malam setelah tengah malam (mis. 00:30) disimpan dengan tanggal hari berikutnya; Keluar paginya lalu digeser ke H+1 lagi → pasangan/durasi laporan salah (~29 jam).
- **B-15** `FaceCommon.resizeCanvasToVideo` tidak ada tetapi masih dipanggil di `test.js` (setelah ganti kamera) → TypeError tak berbahaya. Ganti dengan `syncCanvasToDisplay`. (Pemanggilan di `rekam.js` sudah dihapus 2026-10-30.)
- **B-16** `absensi.js` hanya membedakan `ok` & `duplicate`; `ambiguous`, `inactive`, `no-profile`, 401, 500 semua tampil "Wajah tidak terdeteksi dalam database".
- **B-17** Anti-dobel offline hanya terhadap antrian lokal; setelah antrian terkirim/terhapus, absen ulang offline di hari yang sama tampil "berhasil" lalu ditolak server diam-diam sebagai `duplicate`.
- **B-18** Endpoint `/faces/count`, `/hr/karyawan/:nrp` tanpa try/catch → error DB membuat request menggantung (Express 4).
- **B-19** Tidak ada proteksi CSRF pada POST/PUT/DELETE (cookie `sameSite: lax` sedikit membantu).
- **B-20** `black_list_nrp` tak terpakai; `socket.io` idle; model `age_gender`, `face_expression`, `mtcnn`, `ssd_mobilenetv1`, `face_landmark_68_tiny` tidak dipakai.
- **B-21** Banyak blok kode ter-comment di `rekam.js` (~120 baris) & `absensi.js`; `log.txt` berisi scratch percakapan lama.
- **B-22** Foto base64 masih ditulis ke `table_absensi.snapshot_base64` dan blob ke `table_deteksi_log.frame_snapshot` tiap deteksi (termasuk unknown) → tabel membengkak; bergantung pada proses migrasi eksternal.
- **B-23** `npm run dev` tidak portable ke Windows; `about.ejs` menyebut Node 20.19.4.
- **B-24** Edit tanggal/jam masuk tidak menghitung ulang `is_late`/`menit_terlambat`; insert keluar baru saat edit tidak mengisi `source`.
- **B-25** Cache karyawan bisa memegang status aktif untuk karyawan yang sudah RESIGN (lihat §7).

---

## 12. Konvensi & Panduan untuk AI Coding Agent

**Bahasa & gaya:** komentar dan pesan UI dalam **Bahasa Indonesia**. Indentasi 4 spasi, `const/let`, async/await, CommonJS di server, IIFE/module-pattern global (`FaceCommon`, `OfflineDB`, `OfflineMatch`, `SyncManager`, `UI`) di client — **tanpa bundler/build step**. Setiap route dibungkus `try/catch` dan membalas JSON `{ok:false, error|reason}` atau `res.status(5xx)`. Komentar menjelaskan *kenapa* (lihat gaya komentar di `app.js`/`sw.js`).

**Checklist sebelum menambah/ubah fitur:**
1. **DB berubah?** Buat file migrasi baru `sql/YYYY-MM-DD-<deskripsi>.sql` + perbarui §5. Ingat STRICT mode → ENUM/NOT NULL harus tepat. Jangan andalkan `sql/schema.sql`.
2. **Menyentuh matching wajah?** Ubah **ketiga** implementasi (`/api/match`, `/api/absen`, `offline-match.js`) atau konsolidasikan dulu (B-10). Jaga `EMB_CACHE` sinkron.
3. **Menyentuh aturan shift/telat/kategori?** Ubah server (`api.js`, `api-absensi.js`) **dan** client (`absensi.js`, `sw.js` ABSENSI_KATEGORI, `absensi-start.ejs`, filter `laporan-absensi.ejs`).
4. **Mengubah file di `/public/`?** **Naikkan `CACHE_VERSION` di `public/sw.js`** (dan `?v=` CSS bila CSS berubah). Jika file baru dibutuhkan offline, tambahkan ke `PRECACHE_URLS`.
5. **Menambah endpoint API?** Taruh di `routes/api.js` atau `api-absensi.js`; otomatis butuh sesi (401 JSON). Endpoint publik hanya lewat `API_PUBLIC_PATHS` di `app.js` — pikirkan keamanan.
6. **Menambah halaman?** Route di `routes/pages.js` (otomatis ter-guard) + view `<% layout('layout') -%>` + link di `partials/drawer.ejs` (dan `bottomnav.ejs`/`dashboard.ejs` bila perlu). Halaman yang harus jalan offline perlu penanganan di `navigationFallback` SW.
7. **Menyentuh profil karyawan?** Absensi/rekam/offline → `table_karyawan_cache` (`ensureInCache`); listing/autocomplete laporan → `table_karyawan`. HR read-only.
8. **Menyentuh foto?** Utamakan `snapshot_url`, fallback base64. Gunakan `FaceCommon.grabFrame(video, {maxEdge, quality})` — jangan encode frame penuh.
9. **IndexedDB `pending`:** akses lewat index/cursor, jangan `getAll`. Jika menambah store/index, naikkan `DB_VERSION` di `offline-db.js` dan tangani di `onupgradeneeded`.
10. **Waktu/tanggal:** server pakai `dayjs` (zona `TZ=Asia/Jakarta`); format DB `tanggal` `YYYY-MM-DD`, `jam` `HH:mm:ss`. Hati-hati kolom DATE dari mysql2 berupa objek `Date` (lihat B-04) — format dulu sebelum dipakai di SQL.
11. **Frontend face:** wajib HTTPS. Quality gate (§6.4) harus konsisten antara absensi, rekam, dan debug.

**Perintah verifikasi cepat:**
```bash
# Struktur tabel nyata
mysql -h127.0.0.1 -uroot -p absensi_db_rjs -e "SHOW CREATE TABLE table_absensi\G"
# Jalankan dev (Linux/macOS)
npm run dev        # HTTPS di port .env (3007)
# Cek syntax file JS server tanpa menjalankan
node --check app.js && node --check routes/api.js && node --check routes/api-absensi.js
```
Tidak ada test otomatis maupun linter di project ini — verifikasi manual via browser (HTTPS, kamera) dan DevTools → Application (Service Worker, IndexedDB).

**Jangan:**
- Menulis ke DB `rjsmanage` (HR).
- Menaruh rahasia/otorisasi di JS frontend.
- Memakai `sql/schema.sql` sebagai kebenaran skema.
- Menambah nilai ENUM tanpa `ALTER TABLE` lebih dulu.
- Mengubah urutan mount `/api` vs `/` di `app.js`.
- Meng-cache `/api/health` atau response redirect di Service Worker.
- Lupa menaikkan `CACHE_VERSION` setelah mengubah aset `/public/`.

---

## 13. Changelog Dokumen

| Tanggal | Perubahan |
|---|---|
| 2026-07-08 | Versi awal (analisa sebelum PWA offline). |
| 2026-10-30 | Analisa ulang penuh s/d commit `79cad5e`: tambah mode offline/PWA (§8), IndexedDB, endpoint sync, session MySQL, bcrypt, `PASSWORD_OTORISASI`, pairing shift malam & Security, status fitur; tandai bug lama yang sudah diperbaiki; tambah bug baru B-01…B-25 dengan ID baru; panduan agent diperbarui. Tambah `CLAUDE.md`. |
| 2026-10-30 | Perbaikan B-01…B-07: login/logout offline, proteksi `/api/absen/sync` (syncToken JWT + validasi waktu), fallback 401 di absensi, pairing Security PUT/DELETE, loop rekam ulang, rekam tidak lagi menghapus data sebelum simpan, invalidasi EMB_CACHE saat reset. `CACHE_VERSION` → v5. |
| 2026-10-30 | Tambah **Absensi v2 (uji coba)**: multi-wajah maks 5, kotak merah/hijau + nama, cooldown 2 menit, menu terpisah `/absensi-v2`; `source` web-v2/offline-sync-v2; tutup putih di halaman rekam dihapus; `CACHE_VERSION` → v6. |
