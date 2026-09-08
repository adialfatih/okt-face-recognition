const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { q } = require('../db');

function isBcryptHash(value) {
    return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

async function verifyPassword(userRow, password) {
    const stored = userRow.password || '';

    if (isBcryptHash(stored)) {
        return await bcrypt.compare(password, stored);
    }

    // Kompatibilitas data lama: jika plaintext cocok, langsung upgrade ke bcrypt.
    if (stored === password) {
        const hashed = await bcrypt.hash(password, 12);
        await q('UPDATE table_users SET password=? WHERE id=?', [hashed, userRow.id]);
        return true;
    }

    return false;
}

// GET /login
router.get('/login', (req, res) => {
    if (req.session && req.session.user) {
        return res.redirect('/');
    }
    res.render('login', {
        title: 'Login',
        error: null,
        old: { username: '' }
    });
});

// POST /login
router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    const old = { username: username || '' };

    if (!username || !password) {
        return res.render('login', {
            title: 'Login',
            error: 'Username dan password wajib diisi.',
            old
        });
    }

    try {
        const rows = await q(
            'SELECT id, nama_lengkap, username, password, hak_akses FROM table_users WHERE username=? LIMIT 1',
            [username]
        );

        if (!rows.length || !(await verifyPassword(rows[0], password))) {
            return res.render('login', {
                title: 'Login',
                error: 'Username atau password salah.',
                old
            });
        }

        const u = rows[0];
        req.session.user = {
            id: u.id,
            nama_lengkap: u.nama_lengkap,
            username: u.username,
            hak_akses: u.hak_akses
        };

        return res.redirect('/');
    } catch (e) {
        console.error('[login] fail:', e);
        return res.render('login', {
            title: 'Login',
            error: 'Terjadi kesalahan server. Coba lagi nanti.',
            old
        });
    }
});

// POST /logout
router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

module.exports = router;
