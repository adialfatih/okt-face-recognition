const express = require('express');
const router = express.Router();


router.get('/', (req, res) => res.render('dashboard'));


// Absensi
router.get('/absensi', (req, res) => res.render('absensi-start'));
router.get('/absensi/capture', (req, res) => res.render('absensi-capture', { kategori: req.query.k || '' }));


// Rekam wajah
router.get('/rekam', (req, res) => res.render('rekam-start'));
router.get('/rekam/capture', (req, res) => res.render('rekam-capture', { nrp: req.query.nrp || '' }));


// Test wajah
router.get('/test', (req, res) => res.render('test-start'));
router.get('/test/capture', (req, res) => res.render('test-capture'));


// Placeholder pages
router.get('/karyawan', (req, res) => res.render('placeholder', { title: 'Data Karyawan' }));
router.get('/cuti', (req, res) => res.render('placeholder', { title: 'Cuti' }));
router.get('/ijin', (req, res) => res.render('placeholder', { title: 'Ijin' }));
router.get('/laporan', (req, res) => res.render('placeholder', { title: 'Laporan' }));
router.get('/about', (req, res) => res.render('about'));


module.exports = router;