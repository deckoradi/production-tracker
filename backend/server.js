const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');

// ============ UČITAVANJE .env FAJLA ============
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

console.log('📧 EMAIL_USER:', process.env.EMAIL_USER ? '✅' : '❌');
console.log('📧 EMAIL_PASS:', process.env.EMAIL_PASS ? '✅' : '❌');
console.log('📧 ADMIN_EMAIL:', process.env.ADMIN_EMAIL ? '✅' : '❌');

const app = express();
const PORT = process.env.PORT || 5001;

// ============ SERVE FRONTEND ============
app.use(express.static(path.join(__dirname, '../frontend')));

// ============ MIDDLEWARE ============
app.use(cors({
    origin: ['http://localhost:3000', 'https://production-tracker-wcy8.onrender.com', 'https://production-tracker.onrender.com'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ============ ROOT ROUTE ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ============ DIREKTORIJUMI I FAJLOVI ============
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const USERS_FILE = path.join(dataDir, 'users.json');
const ORDERS_FILE = path.join(dataDir, 'orders.json');
const PROGRESS_FILE = path.join(dataDir, 'progress.json');

// ============ INICIJALIZACIJA FAJLOVA ============
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify([]));
if (!fs.existsSync(PROGRESS_FILE)) fs.writeFileSync(PROGRESS_FILE, JSON.stringify([]));

// ============ HELPER FUNKCIJE ============
const readData = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } 
    catch (e) { return []; }
};

const writeData = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// ============ BRZI CACHE ============
let ordersCache = null;
let progressCache = null;
let lastCacheUpdate = 0;
const CACHE_TTL = 3000;

const getCachedData = () => {
    const now = Date.now();
    if (ordersCache && progressCache && (now - lastCacheUpdate) < CACHE_TTL) {
        return { orders: ordersCache, progress: progressCache };
    }
    ordersCache = readData(ORDERS_FILE);
    progressCache = readData(PROGRESS_FILE);
    lastCacheUpdate = now;
    return { orders: ordersCache, progress: progressCache };
};

const invalidateCache = () => {
    ordersCache = null;
    progressCache = null;
    lastCacheUpdate = 0;
};

// ============ KREIRANJE ADMIN KORISNIKA ============
const ensureAdmin = () => {
    try {
        const users = readData(USERS_FILE);
        if (!users.find(u => u.username === 'admin')) {
            console.log('👤 Kreiram admin korisnika...');
            users.push({
                id: users.length + 1,
                username: 'admin',
                password: bcrypt.hashSync('admin123', 10),
                role: 'admin',
                company: 'Administrator'
            });
            writeData(USERS_FILE, users);
            console.log('✅ Admin kreiran: admin / admin123');
        }
    } catch (e) { console.log('❌ Greška pri kreiranju admina:', e.message); }
};
ensureAdmin();

// ============ MULTER ============
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        if (ext !== '.xlsx' && ext !== '.xls') {
            return cb(new Error('Only Excel files'));
        }
        cb(null, true);
    }
});

// ============ AUTH ============
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// ============ EMAIL TRANSPORTER ============
let transporter = null;
try {
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 15000
        });
        console.log('📧 Email transporter: ✅');
    } else {
        console.log('📧 Email transporter: ❌');
    }
} catch (e) { console.log('📧 Email: ❌', e.message); }

// ============ ROUTES ============

// LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const users = readData(USERS_FILE);
        const user = users.find(u => u.username === username);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        if (!await bcrypt.compare(password, user.password)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, company: user.company },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '24h' }
        );
        res.json({ token, user: { id: user.id, username: user.username, role: user.role, company: user.company } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET USERS
app.get('/api/users', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    const users = readData(USERS_FILE);
    res.json(users.map(u => ({ ...u, password: undefined })));
});

// CREATE USER
app.post('/api/users', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    try {
        const { username, company } = req.body;
        const users = readData(USERS_FILE);
        if (users.find(u => u.username === username)) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        const newUser = {
            id: users.length + 1,
            username,
            password: await bcrypt.hash('password123', 10),
            role: 'user',
            company
        };
        users.push(newUser);
        writeData(USERS_FILE, users);
        res.status(201).json({ message: 'User created', user: { ...newUser, password: undefined } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============ UPLOAD - OPTIMIZOVANO ============
app.post('/api/upload', authenticate, upload.single('file'), (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const filePath = req.file.path;
        console.log('📂 Fajl:', req.file.originalname, req.file.size, 'bajtova');
        
        const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: false, cellText: false });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
        
        console.log('📊 Redova:', data.length);

        const BATCH_SIZE = 200;
        let processed = 0;
        let allOrders = [];
        let allProgress = [];

        const findValue = (row, keys) => {
            for (let key of keys) {
                if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
                    return row[key];
                }
            }
            return '';
        };

        const saveBatch = (orders, progress) => {
            const existingOrders = readData(ORDERS_FILE);
            const existingProgress = readData(PROGRESS_FILE);
            const combinedOrders = [...existingOrders, ...orders];
            const combinedProgress = [...existingProgress, ...progress];
            writeData(ORDERS_FILE, combinedOrders);
            writeData(PROGRESS_FILE, combinedProgress);
            invalidateCache();
        };

        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            const order = {
                id: Date.now() + i,
                company: findValue(row, ['ime firme', 'IME FIRME', 'Firma', 'firma', 'Ime firme', 'Company', 'company', 'Naziv firme']),
                code: findValue(row, ['cod artikal', 'COD ARTIKAL', 'Sifra', 'sifra', 'Šifra artikla', 'Sifra artikla', 'Code', 'code', 'Šifra', 'Sifra artikla']),
                name: findValue(row, ['naziv artikla', 'NAZIV ARTIKLA', 'Naziv', 'naziv', 'Naziv artikla', 'Name', 'name', 'Artikal', 'Proizvod']),
                orderNumber: findValue(row, ['broj nalog', 'BROJ NALOG', 'Nalog', 'nalog', 'Broj naloga', 'broj naloga', 'Order', 'order', 'Order Number']),
                quantity: parseInt(findValue(row, ['pari', 'PARI', 'Kolicina', 'kolicina', 'QUANTITA', 'Quantity', 'quantity', 'Količina'])) || 0,
                deliveryDate: findValue(row, ['datum isporuke', 'DATUM ISPORUKE', 'Datum', 'datum', 'Datum isporuke', 'Delivery Date', 'delivery']),
                phases: [
                    { phase: '100', status: 'pending', comment: '' },
                    { phase: '200', status: 'pending', comment: '' },
                    { phase: '300', status: 'pending', comment: '' },
                    { phase: '400', status: 'pending', comment: '' },
                    { phase: '500', status: 'pending', comment: '' }
                ]
            };
            if (order.company || order.code || order.orderNumber) {
                allOrders.push(order);
                allProgress.push({ orderId: order.id, phases: order.phases.map(p => ({ ...p })) });
                processed++;
            }
            if (allOrders.length >= BATCH_SIZE) {
                saveBatch(allOrders, allProgress);
                allOrders = [];
                allProgress = [];
                console.log(`📦 Batch: ${processed}`);
            }
        }
        if (allOrders.length > 0) {
            saveBatch(allOrders, allProgress);
            console.log(`📦 Završni batch: ${processed}`);
        }
        
        console.log(`📦 UKUPNO: ${processed} naloga`);
        res.json({ message: `✅ Učitano ${processed} naloga`, count: processed, totalRows: data.length });
    } catch (e) {
        console.error('❌ Upload error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ GET ORDERS - SA PRAVILOM ZA PRETRAGU ============
app.get('/api/orders', authenticate, (req, res) => {
    try {
        const { orders, progress } = getCachedData();
        const { search, page = 1, limit = 100 } = req.query;

        let filteredOrders = orders;

        // ADMIN: vidi sve
        if (req.user.role === 'admin') {
            // nema filtera
        } else {
            // OBIČAN KORISNIK
            if (search) {
                // Ako ima pretragu → vidi sve naloge koji odgovaraju (sve firme)
                const s = search.toLowerCase();
                filteredOrders = filteredOrders.filter(o =>
                    (o.orderNumber || '').toLowerCase().includes(s) ||
                    (o.name || '').toLowerCase().includes(s) ||
                    (o.code || '').toLowerCase().includes(s)
                );
            } else {
                // Ako NEMA pretragu → vidi samo svoje naloge
                filteredOrders = filteredOrders.filter(o => o.company === req.user.company);
            }
        }

        // Ako ima pretragu (i admin i korisnik) - dodatno filtriraj
        if (search) {
            const s = search.toLowerCase();
            filteredOrders = filteredOrders.filter(o =>
                (o.company || '').toLowerCase().includes(s) ||
                (o.code || '').toLowerCase().includes(s) ||
                (o.name || '').toLowerCase().includes(s) ||
                (o.orderNumber || '').toLowerCase().includes(s)
            );
        }

        // Paginacija
        const p = parseInt(page), l = parseInt(limit);
        const start = (p - 1) * l;
        const paginated = filteredOrders.slice(start, start + l);
        const result = paginated.map(o => {
            const pr = progress.find(p => p.orderId === o.id);
            return { ...o, progress: pr ? pr.phases : o.phases };
        });

        res.json({
            data: result,
            total: filteredOrders.length,
            page: p,
            limit: l,
            totalPages: Math.ceil(filteredOrders.length / l)
        });
    } catch (e) {
        console.error('❌ Orders error:', e);
        res.status(500).json({ error: e.message });
    }
});

// UPDATE PHASE
app.post('/api/update-phase', authenticate, (req, res) => {
    try {
        const { orderId, phase, status, comment } = req.body;
        const progress = readData(PROGRESS_FILE);
        let op = progress.find(p => p.orderId === orderId);
        if (!op) {
            op = { orderId, phases: [
                { phase: '100', status: 'pending', comment: '' },
                { phase: '200', status: 'pending', comment: '' },
                { phase: '300', status: 'pending', comment: '' },
                { phase: '400', status: 'pending', comment: '' },
                { phase: '500', status: 'pending', comment: '' }
            ]};
            progress.push(op);
        }
        const pd = op.phases.find(p => p.phase === phase);
        if (pd) {
            pd.status = status;
            if (comment !== undefined) pd.comment = comment;
        }
        writeData(PROGRESS_FILE, progress);
        invalidateCache();
        res.json({ message: 'Phase updated' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============ TEST EMAIL RUTA ============
app.get('/api/test-email', authenticate, async (req, res) => {
    try {
        console.log('📧 TEST EMAIL - ZAPOCINJEM...');
        
        if (!transporter) {
            console.log('❌ Transporter nije kreiran');
            return res.status(400).json({ 
                error: 'Email not configured',
                details: 'EMAIL_USER ili EMAIL_PASS nedostaju'
            });
        }

        console.log('📧 Saljem test email na:', process.env.ADMIN_EMAIL || 'grupkovic@gmail.com');
        console.log('📧 Sa:', process.env.EMAIL_USER);

        const result = await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.ADMIN_EMAIL || 'grupkovic@gmail.com',
            subject: '🧪 Test email sa Render-a',
            text: `Ovo je test email.\n\nAko ste dobili ovo, email radi!\n\nVreme: ${new Date().toLocaleString()}`
        });

        console.log('✅ TEST EMAIL POSLAT!');
        console.log('   📧 Message ID:', result.messageId);
        console.log('   📧 Response:', result.response);

        res.json({ 
            success: true, 
            messageId: result.messageId,
            response: result.response
        });
    } catch (error) {
        console.error('❌ TEST EMAIL FAILED:');
        console.error('   📧 Poruka:', error.message);
        console.error('   📧 Stack:', error.stack);
        res.status(500).json({ 
            error: error.message,
            stack: error.stack
        });
    }
});

// ============ SEND REPORT ============
app.post('/api/send-report', authenticate, async (req, res) => {
    try {
        console.log('📧 Slanje izveštaja...');
        
        if (!transporter) {
            console.log('❌ Email nije konfigurisan');
            return res.status(400).json({ error: 'Email not configured' });
        }

        const { email, date } = req.body;
        const today = date || new Date().toLocaleDateString('sr-RS');
        const orders = readData(ORDERS_FILE);
        const progress = readData(PROGRESS_FILE);

        const userOrders = orders.filter(o => o.company === req.user.company);
        console.log(`📦 ${userOrders.length} naloga`);

        if (userOrders.length === 0) {
            return res.status(400).json({ error: 'Nema naloga' });
        }

        const activeOrders = [];
        let totalCompleted = 0, totalProblem = 0, totalPending = 0;

        userOrders.forEach(order => {
            const op = progress.find(p => p.orderId === order.id);
            const phases = op ? op.phases : order.phases;
            const hasCompleted = phases.some(p => p.status === 'completed');
            const hasProblem = phases.some(p => p.status === 'problem');
            const hasComment = phases.some(p => p.comment && p.comment.trim() !== '');
            if (hasCompleted || hasProblem || hasComment) {
                activeOrders.push({ order, phases });
                phases.forEach(p => {
                    if (p.status === 'completed') totalCompleted++;
                    else if (p.status === 'problem') totalProblem++;
                    else totalPending++;
                });
            }
        });

        console.log(`📊 Aktivnih: ${activeOrders.length}`);

        if (activeOrders.length === 0) {
            try {
                await Promise.race([
                    transporter.sendMail({
                        from: process.env.EMAIL_USER,
                        to: email || process.env.ADMIN_EMAIL,
                        subject: `📊 Dnevni izveštaj - ${req.user.company} - ${today}`,
                        text: `Poštovani,\n\nDana ${today} nema novih aktivnosti.\n\nS poštovanjem,\nProduction Tracker`
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
                ]);
                console.log('✅ Email poslat (nema aktivnosti)');
                return res.json({ message: '✅ Izveštaj poslat (nema aktivnosti)' });
            } catch (err) {
                console.log('⚠️ Email timeout');
                return res.json({ message: '⚠️ Izveštaj generisan, email nije poslat (timeout)' });
            }
        }

        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Dnevni izveštaj');

        ws.getColumn(1).width = 15;
        ws.getColumn(2).width = 25;
        ws.getColumn(3).width = 12;
        ws.getColumn(4).width = 12;
        ws.getColumn(5).width = 15;
        ws.getColumn(6).width = 12;
        ws.getColumn(7).width = 12;
        ws.getColumn(8).width = 12;
        ws.getColumn(9).width = 12;
        ws.getColumn(10).width = 12;
        ws.getColumn(11).width = 30;

        ws.mergeCells('A1:K1');
        const title = ws.getCell('A1');
        title.value = `DNEVNI IZVEŠTAJ - ${req.user.company}`;
        title.font = { size: 16, bold: true };
        title.alignment = { horizontal: 'center' };

        ws.mergeCells('A2:K2');
        const d = ws.getCell('A2');
        d.value = `Datum: ${today}`;
        d.font = { size: 12, bold: true };
        d.alignment = { horizontal: 'center' };

        const headers = ['Nalog', 'Artikal', 'Šifra', 'Količina', 'Datum isporuke',
            'Faza 100', 'Faza 200', 'Faza 300', 'Faza 400', 'Faza 500', 'Komentar'];
        const hr = ws.addRow(headers);
        hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
        hr.alignment = { horizontal: 'center', vertical: 'middle' };

        activeOrders.forEach(({ order, phases }) => {
            const map = {};
            const comments = [];
            phases.forEach(p => {
                map[p.phase] = p.status;
                if (p.comment && p.comment.trim() !== '') {
                    comments.push(`Faza ${p.phase}: ${p.comment}`);
                }
            });
            const getStatus = (p) => {
                const s = map[p] || 'pending';
                if (s === 'completed') return 'ZAVRŠENO';
                if (s === 'problem') return 'PROBLEM';
                return 'NA ČEKANJU';
            };
            const row = ws.addRow([
                order.orderNumber || '',
                order.name || '',
                order.code || '',
                order.quantity || 0,
                order.deliveryDate || '',
                getStatus('100'), getStatus('200'), getStatus('300'),
                getStatus('400'), getStatus('500'),
                comments.join('; ')
            ]);
            [6, 7, 8, 9, 10].forEach(col => {
                const cell = row.getCell(col);
                const val = cell.value;
                if (val === 'ZAVRŠENO') {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } };
                } else if (val === 'PROBLEM') {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
                    cell.font = { color: { argb: 'FFFFFFFF' } };
                } else {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
                }
            });
        });

        ws.addRow([]);
        const stats = ws.addRow([
            '📊 STATISTIKA:', '', '', '', '',
            `✅ Završene: ${totalCompleted}`,
            `⚠️ Problem: ${totalProblem}`,
            `⬜ Na čekanju: ${totalPending}`,
            `📦 Aktivnih: ${activeOrders.length}`,
            ''
        ]);
        stats.font = { bold: true };

        const buffer = await workbook.xlsx.writeBuffer();
        console.log('📊 Excel kreiran, veličina:', buffer.length);

        console.log('📧 Slanje email-a...');
        try {
            await Promise.race([
                transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: email || process.env.ADMIN_EMAIL,
                    subject: `📊 Dnevni izveštaj - ${req.user.company} - ${today}`,
                    text: `Poštovani,\n\nU prilogu je dnevni izveštaj (${activeOrders.length} aktivnih naloga).\n\nS poštovanjem,\nProduction Tracker`,
                    attachments: [{
                        filename: `Izvestaj_${req.user.company}_${today.replace(/\./g, '-')}.xlsx`,
                        content: buffer
                    }]
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
            ]);
            console.log('✅ Email POSLAT!');
            res.json({ message: '✅ Izveštaj poslat!', activeCount: activeOrders.length });
        } catch (err) {
            console.log('⚠️ Email timeout');
            res.json({ message: '⚠️ Izveštaj generisan, email nije poslat (timeout)', activeCount: activeOrders.length });
        }
    } catch (e) {
        console.error('❌ Send report error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET COMPANIES
app.get('/api/companies', authenticate, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    const orders = readData(ORDERS_FILE);
    const companies = [...new Set(orders.map(o => o.company).filter(c => c))];
    res.json(companies);
});

// ============ POKRENI SERVER ============
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Cache: ${CACHE_TTL/1000}s`);
    console.log(`📧 Email: ${transporter ? '✅' : '❌'}`);
    console.log(`📄 Data folder: ${dataDir}`);
    console.log(`🌐 Frontend folder: ${path.join(__dirname, '../frontend')}`);
});