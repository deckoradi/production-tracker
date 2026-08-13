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

console.log('📧 EMAIL_USER:', process.env.EMAIL_USER ? '✅ Postavljen' : '❌ NIJE postavljen');
console.log('📧 EMAIL_PASS:', process.env.EMAIL_PASS ? '✅ Postavljen' : '❌ NIJE postavljen');
console.log('📧 ADMIN_EMAIL:', process.env.ADMIN_EMAIL ? '✅ Postavljen' : '❌ NIJE postavljen');

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
app.use(express.json());

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
if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([]));
}
if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify([]));
}
if (!fs.existsSync(PROGRESS_FILE)) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify([]));
}

// ============ HELPER FUNKCIJE ============
const readData = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        return [];
    }
};

const writeData = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    invalidateCache();
};

// ============ CACHE ============
let ordersCache = null;
let progressCache = null;
let lastCacheUpdate = 0;
const CACHE_TTL = 5000;

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

// ============ DIREKTNO KREIRANJE ADMIN KORISNIKA ============
const ensureAdmin = () => {
    try {
        console.log('🔧 Proveravam admin korisnika...');
        
        const adminData = [{
            id: 1,
            username: 'admin',
            password: bcrypt.hashSync('admin123', 10),
            role: 'admin',
            company: 'Administrator'
        }];
        
        if (fs.existsSync(USERS_FILE)) {
            try {
                const content = fs.readFileSync(USERS_FILE, 'utf8');
                const users = JSON.parse(content);
                const adminExists = users.find(u => u.username === 'admin');
                if (adminExists) {
                    console.log('✅ Admin korisnik već postoji');
                    return;
                }
            } catch (e) {
                console.log('⚠️ users.json nije validan, kreiram novi');
            }
        }
        
        console.log('👤 Kreiram admin korisnika...');
        fs.writeFileSync(USERS_FILE, JSON.stringify(adminData, null, 2));
        console.log('✅ Admin korisnik kreiran!');
        console.log('   👤 Username: admin');
        console.log('   🔑 Lozinka: admin123');
        
    } catch (error) {
        console.log('❌ Greška pri kreiranju admina:', error.message);
    }
};

// ============ KREIRAJ ADMINA ============
console.log('🔧 Inicijalizacija...');
ensureAdmin();

// ============ MULTER SETUP ============
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        if (ext !== '.xlsx' && ext !== '.xls') {
            return cb(new Error('Only Excel files are allowed'));
        }
        cb(null, true);
    }
});

// ============ AUTHENTICATION MIDDLEWARE ============
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret_key');
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// ============ EMAIL TRANSPORTER - SA TIMEOUT-OM ============
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
        console.log('📧 Email transporter: ✅ Kreiran');
    } else {
        console.log('📧 Email transporter: ❌ Nije kreiran');
        console.log('   💡 EMAIL_USER:', process.env.EMAIL_USER || 'nije postavljen');
        console.log('   💡 EMAIL_PASS:', process.env.EMAIL_PASS ? 'postavljen' : 'nije postavljen');
    }
} catch (error) {
    console.log('📧 Email transporter: ❌ Greška:', error.message);
}

// ============ ROUTES ============

// LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const users = readData(USERS_FILE);
        
        console.log('🔐 Pokušaj logina:', username);
        console.log('📄 Korisnici u bazi:', users.map(u => u.username));
        
        const user = users.find(u => u.username === username);

        if (!user) {
            console.log('❌ Korisnik nije pronađen:', username);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            console.log('❌ Pogrešna lozinka za:', username);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        console.log('✅ Login uspešan:', username);

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, company: user.company },
            process.env.JWT_SECRET || 'default_secret_key',
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                company: user.company
            }
        });
    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET USERS
app.get('/api/users', authenticate, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    const users = readData(USERS_FILE);
    res.json(users.map(u => ({ ...u, password: undefined })));
});

// CREATE USER
app.post('/api/users', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
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
        res.status(201).json({
            message: 'User created successfully',
            user: { ...newUser, password: undefined }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// UPLOAD EXCEL
app.post('/api/upload', authenticate, upload.single('file'), (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const filePath = req.file.path;
        const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: false, cellText: false });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

        console.log('📊 Pronađene kolone:', Object.keys(data[0] || {}));
        console.log('📊 Ukupno redova:', data.length);

        const findValue = (row, keys) => {
            for (let key of keys) {
                if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
                    return row[key];
                }
            }
            return '';
        };

        const allOrders = [];
        const allProgress = [];

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
                allProgress.push({
                    orderId: order.id,
                    phases: order.phases.map(p => ({ ...p }))
                });
            }
        }

        console.log('📦 Učitano naloga:', allOrders.length);

        const existingOrders = readData(ORDERS_FILE);
        const existingProgress = readData(PROGRESS_FILE);
        const combinedOrders = [...existingOrders, ...allOrders];
        const combinedProgress = [...existingProgress, ...allProgress];
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(combinedOrders, null, 2));
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(combinedProgress, null, 2));
        invalidateCache();

        res.json({
            message: `✅ Uspešno učitano ${allOrders.length} naloga`,
            count: allOrders.length,
            totalRows: data.length
        });
    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET ORDERS
app.get('/api/orders', authenticate, (req, res) => {
    try {
        const { orders, progress } = getCachedData();
        const { search, page = 1, limit = 100 } = req.query;

        let filteredOrders = orders;
        if (req.user.role !== 'admin') {
            filteredOrders = orders.filter(o => o.company === req.user.company);
        }

        if (search) {
            const searchLower = search.toLowerCase();
            filteredOrders = filteredOrders.filter(o =>
                (o.company || '').toLowerCase().includes(searchLower) ||
                (o.code || '').toLowerCase().includes(searchLower) ||
                (o.name || '').toLowerCase().includes(searchLower) ||
                (o.orderNumber || '').toLowerCase().includes(searchLower)
            );
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const startIndex = (pageNum - 1) * limitNum;
        const endIndex = startIndex + limitNum;
        const paginatedOrders = filteredOrders.slice(startIndex, endIndex);

        const result = paginatedOrders.map(order => {
            const orderProgress = progress.find(p => p.orderId === order.id);
            return {
                ...order,
                progress: orderProgress ? orderProgress.phases : order.phases || [
                    { phase: '100', status: 'pending', comment: '' },
                    { phase: '200', status: 'pending', comment: '' },
                    { phase: '300', status: 'pending', comment: '' },
                    { phase: '400', status: 'pending', comment: '' },
                    { phase: '500', status: 'pending', comment: '' }
                ]
            };
        });

        res.json({
            data: result,
            total: filteredOrders.length,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(filteredOrders.length / limitNum)
        });
    } catch (error) {
        console.error('❌ Orders error:', error);
        res.status(500).json({ error: error.message });
    }
});

// UPDATE PHASE
app.post('/api/update-phase', authenticate, (req, res) => {
    try {
        const { orderId, phase, status, comment } = req.body;
        const progress = readData(PROGRESS_FILE);
        let orderProgress = progress.find(p => p.orderId === orderId);
        if (!orderProgress) {
            orderProgress = {
                orderId,
                phases: [
                    { phase: '100', status: 'pending', comment: '' },
                    { phase: '200', status: 'pending', comment: '' },
                    { phase: '300', status: 'pending', comment: '' },
                    { phase: '400', status: 'pending', comment: '' },
                    { phase: '500', status: 'pending', comment: '' }
                ]
            };
            progress.push(orderProgress);
        }
        const phaseData = orderProgress.phases.find(p => p.phase === phase);
        if (phaseData) {
            phaseData.status = status;
            if (comment !== undefined) {
                phaseData.comment = comment;
            }
        }
        writeData(PROGRESS_FILE, progress);
        res.json({ message: 'Phase updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ SEND REPORT - SA TIMEOUT-OM (NE BLOKIRA) ============
app.post('/api/send-report', authenticate, async (req, res) => {
    try {
        console.log('📧 ZAPOCINJEM SLANJE IZVESTAJA...');
        
        if (!transporter) {
            console.log('❌ Email transporter nije kreiran!');
            return res.status(400).json({ error: 'Email not configured. Add EMAIL_USER and EMAIL_PASS to .env file' });
        }

        const { email, date } = req.body;
        const today = date || new Date().toLocaleDateString('sr-RS');
        const orders = readData(ORDERS_FILE);
        const progress = readData(PROGRESS_FILE);

        const userOrders = orders.filter(o => o.company === req.user.company);
        console.log(`📦 Korisnik ima ${userOrders.length} naloga`);
        
        if (userOrders.length === 0) {
            return res.status(400).json({ error: 'Nema naloga za vašu firmu.' });
        }

        // Filtriraj aktivne naloge
        const activeOrders = [];
        let totalCompleted = 0, totalProblem = 0, totalPending = 0;

        userOrders.forEach(order => {
            const orderProgress = progress.find(p => p.orderId === order.id);
            const phases = orderProgress ? orderProgress.phases : order.phases;
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

        console.log(`📊 Aktivnih naloga: ${activeOrders.length}`);

        // Ako nema aktivnosti - pošalji email sa timeout-om
        if (activeOrders.length === 0) {
            console.log('📧 Nema aktivnosti, saljem email...');
            try {
                const result = await Promise.race([
                    transporter.sendMail({
                        from: process.env.EMAIL_USER,
                        to: email || process.env.ADMIN_EMAIL,
                        subject: `📊 Dnevni izveštaj - ${req.user.company} - ${today}`,
                        text: `Poštovani,\n\nDana ${today} nema novih aktivnosti za firmu ${req.user.company}.\n\nSve faze su na čekanju.\n\nS poštovanjem,\nProduction Tracker`
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 15000))
                ]);
                console.log('✅ Email poslat (nema aktivnosti)');
                return res.json({ message: '✅ Nema aktivnosti, izveštaj poslat.' });
            } catch (err) {
                console.log('⚠️ Email nije poslat (timeout), ali aplikacija nastavlja');
                return res.json({ message: '⚠️ Izveštaj generisan, ali email nije poslat (timeout).' });
            }
        }

        // Kreiraj Excel
        console.log('📊 Kreiram Excel fajl...');
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Dnevni izveštaj');

        worksheet.getColumn(1).width = 15;
        worksheet.getColumn(2).width = 25;
        worksheet.getColumn(3).width = 12;
        worksheet.getColumn(4).width = 12;
        worksheet.getColumn(5).width = 15;
        worksheet.getColumn(6).width = 12;
        worksheet.getColumn(7).width = 12;
        worksheet.getColumn(8).width = 12;
        worksheet.getColumn(9).width = 12;
        worksheet.getColumn(10).width = 12;
        worksheet.getColumn(11).width = 30;

        worksheet.mergeCells('A1:K1');
        const titleCell = worksheet.getCell('A1');
        titleCell.value = `DNEVNI IZVEŠTAJ - ${req.user.company}`;
        titleCell.font = { size: 16, bold: true };
        titleCell.alignment = { horizontal: 'center' };

        worksheet.mergeCells('A2:K2');
        const dateCell = worksheet.getCell('A2');
        dateCell.value = `Datum: ${today}`;
        dateCell.font = { size: 12, bold: true };
        dateCell.alignment = { horizontal: 'center' };

        const headers = ['Nalog', 'Artikal', 'Šifra', 'Količina', 'Datum isporuke',
            'Faza 100', 'Faza 200', 'Faza 300', 'Faza 400', 'Faza 500', 'Komentar'];
        const headerRow = worksheet.addRow(headers);
        headerRow.font = { bold: true };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

        activeOrders.forEach(({ order, phases }) => {
            const phaseMap = {};
            let comments = [];
            phases.forEach(p => {
                phaseMap[p.phase] = p.status;
                if (p.comment && p.comment.trim() !== '') {
                    comments.push(`Faza ${p.phase}: ${p.comment}`);
                }
            });
            const getStatusText = (phaseNum) => {
                const status = phaseMap[phaseNum] || 'pending';
                if (status === 'completed') return 'ZAVRŠENO';
                if (status === 'problem') return 'PROBLEM';
                return 'NA ČEKANJU';
            };
            const row = worksheet.addRow([
                order.orderNumber || '',
                order.name || '',
                order.code || '',
                order.quantity || 0,
                order.deliveryDate || '',
                getStatusText('100'),
                getStatusText('200'),
                getStatusText('300'),
                getStatusText('400'),
                getStatusText('500'),
                comments.join('; ')
            ]);
            [6, 7, 8, 9, 10].forEach(colIndex => {
                const cell = row.getCell(colIndex);
                const value = cell.value;
                if (value === 'ZAVRŠENO') {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } };
                } else if (value === 'PROBLEM') {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
                    cell.font = { color: { argb: 'FFFFFFFF' } };
                } else {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
                }
            });
        });

        worksheet.addRow([]);
        const statsRow = worksheet.addRow([
            '📊 STATISTIKA:', '', '', '', '',
            `✅ Završene: ${totalCompleted}`,
            `⚠️ Problem: ${totalProblem}`,
            `⬜ Na čekanju: ${totalPending}`,
            `📦 Aktivnih naloga: ${activeOrders.length}`,
            ''
        ]);
        statsRow.font = { bold: true };

        const buffer = await workbook.xlsx.writeBuffer();
        console.log('✅ Excel kreiran, velicina:', buffer.length, 'bajtova');

        // POŠALJI EMAIL SA TIMEOUT-OM - NE BLOKIRA!
        console.log('📧 Saljem email sa timeout-om (15s)...');
        
        try {
            const result = await Promise.race([
                transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: email || process.env.ADMIN_EMAIL,
                    subject: `📊 Dnevni izveštaj - ${req.user.company} - ${today}`,
                    text: `Poštovani,\n\nU prilogu je dnevni izveštaj za firmu ${req.user.company} (${activeOrders.length} aktivnih naloga).\n\nS poštovanjem,\nProduction Tracker`,
                    attachments: [{
                        filename: `Izvestaj_${req.user.company}_${today.replace(/\./g, '-')}.xlsx`,
                        content: buffer
                    }]
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT - email nije poslat za 15 sekundi')), 15000))
            ]);
            
            console.log('✅ Email POSLAT!');
            res.json({ 
                message: '✅ Izveštaj poslat!', 
                activeCount: activeOrders.length 
            });
        } catch (emailError) {
            console.error('❌ Greska pri slanju email-a (timeout):', emailError.message);
            // VAŽNO: Vraćamo uspeh iako email nije poslat - aplikacija ne sme da se blokira!
            res.json({ 
                message: '⚠️ Izveštaj generisan, ali email nije poslat (timeout). Proverite email podešavanja.', 
                activeCount: activeOrders.length 
            });
        }
    } catch (error) {
        console.error('❌ Send report error:', error);
        res.status(500).json({ error: error.message });
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
    console.log(`📊 Cache TTL: ${CACHE_TTL/1000}s`);
    console.log(`📄 Data folder: ${dataDir}`);
    console.log(`🌐 Frontend folder: ${path.join(__dirname, '../frontend')}`);
    console.log(`📧 Email status: ${transporter ? '✅ Spreman' : '❌ Nije konfigurisan'}`);
});