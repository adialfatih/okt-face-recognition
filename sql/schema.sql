CREATE DATABASE IF NOT EXISTS absensi_db CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE absensi_db;


-- 1) Tabel karyawan (sudah ada kata Adi, definisikan minimal kolom)
CREATE TABLE IF NOT EXISTS table_karyawan (
nrp VARCHAR(32) PRIMARY KEY,
nama VARCHAR(100) NOT NULL,
dep VARCHAR(100) DEFAULT NULL,
divisi VARCHAR(100) DEFAULT NULL,
jabatan VARCHAR(100) DEFAULT NULL,
status TINYINT(1) DEFAULT 1,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;


-- 2) Embedding wajah: 1 baris = 1 embedding + 1 snapshot
CREATE TABLE IF NOT EXISTS table_face_embeddings (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
nrp VARCHAR(32) NOT NULL,
embedding JSON NOT NULL, -- array 128/512 floats (face-api.js: 128)
snapshot LONGBLOB NULL, -- simpan JPEG/PNG biner
snapshot_mime VARCHAR(32) DEFAULT 'image/jpeg',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
INDEX idx_nrp (nrp),
CONSTRAINT fk_face_nrp FOREIGN KEY (nrp) REFERENCES table_karyawan(nrp)
) ENGINE=InnoDB;



-- 3) Log deteksi (untuk audit absensi/rekam/test)
CREATE TABLE IF NOT EXISTS table_deteksi_log (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
context ENUM('absensi','rekam','test') NOT NULL,
kategori VARCHAR(64) DEFAULT NULL, -- hanya untuk absensi
nrp_detected VARCHAR(32) DEFAULT NULL, -- boleh null jika unknown
distance DECIMAL(6,4) DEFAULT NULL,
status ENUM('recognized','unknown','multi-face','no-face') NOT NULL,
frame_snapshot LONGBLOB NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
INDEX idx_created (created_at),
INDEX idx_context (context),
INDEX idx_nrp (nrp_detected)
) ENGINE=InnoDB;


-- 4) Absensi (anti dobel per (nrp, tanggal, kategori))
CREATE TABLE IF NOT EXISTS table_absensi (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
nrp VARCHAR(32) NOT NULL,
tanggal DATE NOT NULL,
jam TIME NOT NULL,
kategori VARCHAR(64) NOT NULL,
is_late TINYINT(1) DEFAULT 0,
source VARCHAR(32) DEFAULT 'web',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
UNIQUE KEY uniq_absen (nrp, tanggal, kategori),
INDEX idx_tanggal (tanggal),
CONSTRAINT fk_absen_nrp FOREIGN KEY (nrp) REFERENCES table_karyawan(nrp)
) ENGINE=InnoDB;