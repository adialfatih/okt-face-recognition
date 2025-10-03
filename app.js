require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const dayjs = require('dayjs');
const { Server } = require('socket.io');
const ejsMate = require('ejs-mate');
const cron = require('node-cron');
const { fullSyncFromHR } = require('./services/karyawanCache');

const app = express();
const server = http.createServer(app);
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

app.engine('ejs', ejsMate);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));


// Global locals
app.locals.APP_NAME = 'Rindang Jati';
app.locals.formatDate = (d) => dayjs(d).format('DD MMM YYYY');


// Socket.IO (for toasts or live events if needed)
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);
});
app.set('io', io);


// Routes
const pages = require('./routes/pages');
const api = require('./routes/api');
app.use('/', pages);
app.use('/api', api);


const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));