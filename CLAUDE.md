# CLAUDE.md

Aplikasi absensi wajah PT Rindang Jati (Express + EJS + MySQL, face-api.js di browser, PWA offline-first).

## Baca dulu
**`PRD.md` adalah peta lengkap project** (arsitektur, peta file, skema DB, aturan bisnis, alur offline/PWA, referensi API, daftar bug, checklist). Untuk setiap permintaan, baca `PRD.md` lalu buka **hanya** file yang ditunjuk — jangan scan ulang seluruh codebase.

Setelah mengubah struktur (route, tabel, file baru, aturan bisnis, status bug), perbarui bagian terkait di `PRD.md` dan tambahkan baris di §13 Changelog.

## Aturan wajib
- Bahasa Indonesia untuk komentar & pesan UI. Indentasi 4 spasi. Tanpa bundler/build step.
- **Ubah file di `public/` → naikkan `CACHE_VERSION` di `public/sw.js`** (aset `/public/*` disajikan cache-first; tanpa ini device PWA tetap memakai versi lama).
- **Absensi v2** (`/absensi-v2`, `public/js/absensi-v2.js`) masih uji coba. Jalur produksi pabrik = v1 (`/absensi`, `public/js/absensi.js`) — jangan ubah v1 saat mengerjakan v2 kecuali diminta.
- Logika matching wajah ada di 3 tempat (`/api/match`, `/api/absen`, `public/js/offline-match.js`) — ubah bersamaan.
- Aturan shift/telat/kategori ada di server (`routes/api.js`, `routes/api-absensi.js`) dan client (`public/js/absensi.js`, `public/sw.js`, `views/absensi-start.ejs`, `views/laporan-absensi.ejs`).
- DB `rjsmanage` (HR) **read-only**. `sql/schema.sql` usang — perubahan skema lewat file `sql/YYYY-MM-DD-*.sql` baru. MySQL STRICT mode.
- Jangan ubah urutan mount `/api` sebelum `/` di `app.js`. Endpoint publik hanya via `API_PUBLIC_PATHS`.
- IndexedDB store `pending` berisi foto: akses lewat index/cursor, jangan `getAll`.
- Kolom DATE dari mysql2 berupa objek `Date` — format `YYYY-MM-DD` dulu sebelum dipakai di SQL/CONCAT.

## Verifikasi
Tidak ada test/linter. Minimal: `node --check <file>` untuk file yang diubah. Uji fungsional manual via HTTPS + kamera + DevTools (Service Worker, IndexedDB).

## Deploy (server Ubuntu, pm2)
`git pull` → `npm install` (bila `package.json` berubah) → jalankan migrasi SQL baru bila ada → `pm2 restart <nama-app>`.
