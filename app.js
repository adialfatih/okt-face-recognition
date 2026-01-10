require('dotenv').config();
const express = require('express');
//const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { Server } = require('socket.io');
const ejsMate = require('ejs-mate');
const cron = require('node-cron');
const session = require('express-session');
const { fullSyncFromHR } = require('./services/karyawanCache');
const { syncKaryawan } = require('./services/karyawanSync');

const app = express();
const httpsOptions = {
    key: fs.readFileSync(path.join(__dirname, 'certs/192.168.200.5+1-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'certs/192.168.200.5+1.pem')),
};
//const server = http.createServer(app);
const server = https.createServer(httpsOptions, app);
const io = new Server(server);

// CRON: full sync setiap 02:30 WIB
cron.schedule('30 2 * * *', async () => {
    try {
        const r = await fullSyncFromHR();
        console.log('[cron] karyawan full sync OK:', r);
    } catch (e) {
        console.error('[cron] karyawan full sync FAIL:', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

cron.schedule('0 */6 * * *', async () => {
    const r = await syncKaryawan();
    console.log("[cron-sync] Karyawan:", r);
}, { timezone: 'Asia/Jakarta' });

app.engine('ejs', ejsMate);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'rjs-face-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 hari
    }
}));
app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    next();
});

// Global locals
app.locals.APP_NAME = 'Rindang Jati';
app.locals.formatDate = (d) => dayjs(d).format('DD MMM YYYY');


// Socket.IO (for toasts or live events if needed)
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);
});
app.set('io', io);
function ensureAuth(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    return res.redirect('/login');
}

// Routes
const authRoutes = require('./routes/auth');
const pages = require('./routes/pages');
const api = require('./routes/api');
app.use('/', authRoutes);
app.use('/', ensureAuth, pages);
app.use('/api', api);



const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on https://0.0.0.0:${PORT}`);
});
