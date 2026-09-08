-- Bug #2: table_deteksi_log.status harus mendukung status ambiguous.
-- Jalankan pada database aplikasi absensi.
ALTER TABLE table_deteksi_log
  MODIFY status ENUM('recognized','unknown','multi-face','no-face','ambiguous') NOT NULL;
