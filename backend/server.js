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
const { Pool } = require('pg');

// ============ UČITAVANJE .env FAJLA ============
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

console.log('📧 EMAIL_USER:', process.env.EMAIL_USER ? '✅' : '❌');
console.log('📧 EMAIL_PASS:', process.env.EMAIL_PASS ? '✅' : '❌');
console.log('📧 ADMIN_EMAIL:', process.env.ADMIN_EMAIL ? '✅' : '❌');
console.log('🗄️ DATABASE_URL:', process.env.DATABASE_URL ? '✅' : '❌');

const app = express();
const PORT = process.env.PORT || 5001;

// ============ POSTGRESQL BAZA ============
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'user',
                company VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id BIGINT PRIMARY KEY,
                company VARCHAR(255),
                code VARCHAR(100),
                name VARCHAR(255),
                order_number VARCHAR(100),
                quantity INTEGER DEFAULT 0,
                delivery_date VARCHAR(100),
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS progress (
                id SERIAL PRIMARY KEY,
                order_id BIGINT NOT NULL,
                phase VARCHAR(10) NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                comment TEXT DEFAULT '',
                updated_at DATE DEFAULT CURRENT_DATE,
                UNIQUE(order_id, phase)
            )
        `);

        const adminCheck = await pool.query('SELECT * FROM users WHERE username = $1', ['admin']);
        if (adminCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await pool.query(
                'INSERT INTO users (username, password, role, company) VALUES ($1, $2, $3, $4)',
                ['admin', hashedPassword, 'admin', 'Administrator']
            );
            console.log('✅ Admin korisnik kreiran: admin / admin123');
        }

        console.log('🗄️ PostgreSQL baza: ✅ Povezana');
    } catch (e) {
        console.error('❌ DB init error:', e.message);
    }
};

initDb();

// ============ MIDDLEWARE ============
app.use(cors({
    origin: ['http://localhost:3000', 'https://production-tracker-wcy8.onrender.com', 'https://production-tracker.onrender.com'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ============ MULTER ============
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

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

// ============ EMAIL ============
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
    }
} catch (e) { console.log('📧 Email: ❌', e.message); }

// ============ ROUTES ============

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
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

app.get('/api/users', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    try {
        const result = await pool.query('SELECT id, username, role, company FROM users');
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/users', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    try {
        const { username, company } = req.body;
        const exists = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (exists.rows.length > 0) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        const hashedPassword = await bcrypt.hash('password123', 10);
        const result = await pool.query(
            'INSERT INTO users (username, password, role, company) VALUES ($1, $2, $3, $4) RETURNING id, username, role, company',
            [username, hashedPassword, 'user', company]
        );
        res.status(201).json({ message: 'User created', user: result.rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============ ZAJEDNIČKA FUNKCIJA ============
const findValue = (row, keys) => {
    for (let key of keys) {
        if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
            return row[key];
        }
    }
    return '';
};

// ============ 1. OBRISI SVE ============
app.post('/api/clear-all', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Samo admin može' });
    }
    try {
        const ordersBackup = await pool.query('SELECT * FROM orders');
        const progressBackup = await pool.query('SELECT * FROM progress');
        const backup = {
            timestamp: new Date().toISOString(),
            orders: ordersBackup.rows,
            progress: progressBackup.rows
        };
        const backupPath = path.join(__dirname, 'backup_before_clear.json');
        fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
        console.log('📦 Backup kreiran pre brisanja');

        await pool.query('DELETE FROM progress');
        await pool.query('DELETE FROM orders');
        
        console.log('🗑️ Svi podaci obrisani');
        res.json({ 
            message: '✅ Svi podaci obrisani! Backup sačuvan.',
            count: ordersBackup.rows.length 
        });
    } catch (e) {
        console.error('❌ Clear error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ 2. SINHRONIZUJ SA EXCEL-OM ============
app.post('/api/upload-sync', authenticate, upload.single('file'), async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const filePath = req.file.path;
        console.log('📂 Fajl:', req.file.originalname);

        const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: false, cellText: false });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

        console.log('📊 Redova:', data.length);

        // 1. Sakupi sve naloge iz Excel-a
        const excelOrders = [];
        for (const row of data) {
            const company = findValue(row, ['ime firme', 'IME FIRME', 'Firma', 'firma', 'Ime firme', 'Company', 'company', 'Naziv firme']);
            const orderNumber = findValue(row, ['broj nalog', 'BROJ NALOG', 'Nalog', 'nalog', 'Broj naloga', 'broj naloga', 'Order', 'order', 'Order Number']);
            if (company && orderNumber) {
                excelOrders.push({ company, order_number: orderNumber });
            }
        }

        console.log(`📋 Excel ima ${excelOrders.length} naloga`);

        // 2. Pronađi i obriši naloge koji NISU u Excel-u
        const allDbOrders = await pool.query('SELECT id, company, order_number FROM orders');
        let deleted = 0;
        let updated = 0;
        let inserted = 0;

        for (const dbOrder of allDbOrders.rows) {
            const exists = excelOrders.some(e => e.company === dbOrder.company && e.order_number === dbOrder.order_number);
            if (!exists) {
                await pool.query('DELETE FROM progress WHERE order_id = $1', [dbOrder.id]);
                await pool.query('DELETE FROM orders WHERE id = $1', [dbOrder.id]);
                deleted++;
                console.log(`🗑️ Obrisan nalog: ${dbOrder.order_number} (${dbOrder.company})`);
            }
        }

        console.log(`🗑️ Obrisano ${deleted} naloga koji nisu u Excel-u`);

        // 3. Procesiraj Excel (dodaj nove, ažuriraj postojeće)
        for (let i = 0; i < data.length; i++) {
            const row = data[i];

            const company = findValue(row, ['ime firme', 'IME FIRME', 'Firma', 'firma', 'Ime firme', 'Company', 'company', 'Naziv firme']);
            const code = findValue(row, ['cod artikal', 'COD ARTIKAL', 'Sifra', 'sifra', 'Šifra artikla', 'Sifra artikla', 'Code', 'code', 'Šifra', 'Sifra artikla']);
            const name = findValue(row, ['naziv artikla', 'NAZIV ARTIKLA', 'Naziv', 'naziv', 'Naziv artikla', 'Name', 'name', 'Artikal', 'Proizvod']);
            const orderNumber = findValue(row, ['broj nalog', 'BROJ NALOG', 'Nalog', 'nalog', 'Broj naloga', 'broj naloga', 'Order', 'order', 'Order Number']);
            const quantity = parseInt(findValue(row, ['pari', 'PARI', 'Kolicina', 'kolicina', 'QUANTITA', 'Quantity', 'quantity', 'Količina'])) || 0;
            const deliveryDate = findValue(row, ['datum isporuke', 'DATUM ISPORUKE', 'Datum', 'datum', 'Datum isporuke', 'Delivery Date', 'delivery']);

            if (!company && !code && !orderNumber) continue;

            const existing = await pool.query('SELECT id FROM orders WHERE order_number = $1 AND company = $2', [orderNumber, company]);
            
            if (existing.rows.length > 0) {
                await pool.query(
                    `UPDATE orders SET 
                        code = $1, name = $2, quantity = $3, delivery_date = $4
                     WHERE order_number = $5 AND company = $6`,
                    [code, name, quantity, deliveryDate, orderNumber, company]
                );
                updated++;
            } else {
                const newId = Date.now() + i;
                await pool.query(
                    `INSERT INTO orders (id, company, code, name, order_number, quantity, delivery_date)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [newId, company, code, name, orderNumber, quantity, deliveryDate]
                );
                
                for (const phase of ['100', '200', '300', '400', '500']) {
                    await pool.query(
                        `INSERT INTO progress (order_id, phase, status, comment, updated_at)
                         VALUES ($1, $2, 'pending', '', CURRENT_DATE)
                         ON CONFLICT (order_id, phase) DO NOTHING`,
                        [newId, phase]
                    );
                }
                inserted++;
            }
        }

        console.log(`📦 Novih: ${inserted}, Ažuriranih: ${updated}, Obrisanih: ${deleted}`);
        res.json({ 
            message: `✅ Novih: ${inserted}, Ažuriranih: ${updated}, Obrisanih: ${deleted}`,
            inserted, 
            updated, 
            deleted,
            totalRows: data.length 
        });

    } catch (e) {
        console.error('❌ Upload error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ OSTALE RUTE ============

app.get('/api/orders', authenticate, async (req, res) => {
    try {
        const { search, page = 1, limit = 100 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let whereClause = '';
        let params = [];
        let paramIndex = 1;

        if (req.user.role !== 'admin') {
            if (search) {
                const s = search.toLowerCase();
                whereClause = `WHERE LOWER(order_number) LIKE $${paramIndex} OR LOWER(name) LIKE $${paramIndex} OR LOWER(code) LIKE $${paramIndex}`;
                params.push(`%${s}%`);
                paramIndex++;
            } else {
                whereClause = `WHERE company = $${paramIndex}`;
                params.push(req.user.company);
                paramIndex++;
            }
        }

        if (req.user.role === 'admin' && search) {
            const s = search.toLowerCase();
            if (whereClause) {
                whereClause += ` AND (LOWER(order_number) LIKE $${paramIndex} OR LOWER(name) LIKE $${paramIndex} OR LOWER(company) LIKE $${paramIndex} OR LOWER(code) LIKE $${paramIndex})`;
            } else {
                whereClause = `WHERE LOWER(order_number) LIKE $${paramIndex} OR LOWER(name) LIKE $${paramIndex} OR LOWER(company) LIKE $${paramIndex} OR LOWER(code) LIKE $${paramIndex}`;
            }
            params.push(`%${s}%`);
            paramIndex++;
        }

        const countQuery = `SELECT COUNT(*) FROM orders ${whereClause}`;
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        const dataQuery = `
            SELECT o.*, 
                   COALESCE(json_agg(json_build_object('phase', p.phase, 'status', p.status, 'comment', p.comment, 'updated_at', p.updated_at) ORDER BY p.phase) 
                   FILTER (WHERE p.phase IS NOT NULL), '[]') as progress
            FROM orders o
            LEFT JOIN progress p ON o.id = p.order_id
            ${whereClause}
            GROUP BY o.id
            ORDER BY o.id DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;
        params.push(parseInt(limit), offset);

        const result = await pool.query(dataQuery, params);

        res.json({
            data: result.rows,
            total: total,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(total / parseInt(limit))
        });
    } catch (e) {
        console.error('❌ Orders error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/update-phase', authenticate, async (req, res) => {
    try {
        const { orderId, phase, status, comment } = req.body;
        await pool.query(
            `INSERT INTO progress (order_id, phase, status, comment, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_DATE)
             ON CONFLICT (order_id, phase) DO UPDATE SET
             status = EXCLUDED.status, 
             comment = EXCLUDED.comment, 
             updated_at = CURRENT_DATE`,
            [orderId, phase, status, comment || '']
        );
        res.json({ message: 'Phase updated' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/send-report', authenticate, async (req, res) => {
    try {
        if (!transporter) {
            return res.status(400).json({ error: 'Email not configured' });
        }

        const { email, date } = req.body;
        const today = date || new Date().toLocaleDateString('sr-RS');

        const ordersResult = await pool.query(
            `SELECT o.*, 
                    COALESCE(json_agg(json_build_object('phase', p.phase, 'status', p.status, 'comment', p.comment, 'updated_at', p.updated_at) ORDER BY p.phase) 
                    FILTER (WHERE p.phase IS NOT NULL), '[]') as progress
             FROM orders o
             LEFT JOIN progress p ON o.id = p.order_id
             WHERE o.company = $1
             GROUP BY o.id
             ORDER BY o.id DESC`,
            [req.user.company]
        );

        const userOrders = ordersResult.rows;

        if (userOrders.length === 0) {
            return res.status(400).json({ error: 'Nema naloga' });
        }

        const activeOrders = [];
        let totalCompleted = 0, totalProblem = 0, totalPending = 0;

        userOrders.forEach(order => {
            const phases = order.progress || [];
            const hasCompleted = phases.some(p => p.status === 'completed');
            const hasProblem = phases.some(p => p.status === 'problem');
            const hasComment = phases.some(p => p.comment && p.comment.trim() !== '');
            if (hasCompleted || hasProblem || hasComment) {
                activeOrders.push(order);
                phases.forEach(p => {
                    if (p.status === 'completed') totalCompleted++;
                    else if (p.status === 'problem') totalProblem++;
                    else totalPending++;
                });
            }
        });

        if (activeOrders.length === 0) {
            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: email || process.env.ADMIN_EMAIL,
                subject: `📊 Dnevni izveštaj - ${req.user.company} - ${today}`,
                text: `Poštovani,\n\nDana ${today} nema novih aktivnosti.\n\nS poštovanjem,\nProduction Tracker`
            });
            return res.json({ message: '✅ Nema aktivnosti, izveštaj poslat.' });
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

        activeOrders.forEach(order => {
            const phases = order.progress || [];
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
                order.order_number || '',
                order.name || '',
                order.code || '',
                order.quantity || 0,
                order.delivery_date || '',
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

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email || process.env.ADMIN_EMAIL,
            subject: `📊 Dnevni izveštaj - ${req.user.company} - ${today}`,
            text: `Poštovani,\n\nU prilogu je dnevni izveštaj (${activeOrders.length} aktivnih naloga).\n\nS poštovanjem,\nProduction Tracker`,
            attachments: [{
                filename: `Izvestaj_${req.user.company}_${today.replace(/\./g, '-')}.xlsx`,
                content: buffer
            }]
        });

        res.json({ message: '✅ Izveštaj poslat!', activeCount: activeOrders.length });
    } catch (e) {
        console.error('❌ Send report error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/companies', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const result = await pool.query('SELECT DISTINCT company FROM orders WHERE company IS NOT NULL AND company != \'\'');
        res.json(result.rows.map(r => r.company));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============ BACKUP I RESTORE ============

app.get('/api/backup-status', authenticate, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Samo admin može' });
    }
    try {
        const backupPath = path.join(__dirname, 'backup.json');
        if (fs.existsSync(backupPath)) {
            const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
            res.json({
                exists: true,
                timestamp: backup.timestamp,
                count: {
                    users: backup.users.length,
                    orders: backup.orders.length,
                    progress: backup.progress.length
                }
            });
        } else {
            res.json({ exists: false });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backup', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Samo admin može' });
    }
    try {
        const orders = await pool.query('SELECT * FROM orders ORDER BY id');
        const progress = await pool.query('SELECT * FROM progress');
        const users = await pool.query('SELECT id, username, role, company FROM users');

        const backup = {
            timestamp: new Date().toISOString(),
            users: users.rows,
            orders: orders.rows,
            progress: progress.rows
        };

        const backupPath = path.join(__dirname, 'backup.json');
        fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

        console.log('✅ Backup kreiran:', backup.timestamp);
        res.json({ 
            message: '✅ Backup uspešno kreiran!', 
            timestamp: backup.timestamp,
            count: {
                users: backup.users.length,
                orders: backup.orders.length,
                progress: backup.progress.length
            }
        });
    } catch (e) {
        console.error('❌ Backup error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/restore', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Samo admin može' });
    }
    try {
        const backupPath = path.join(__dirname, 'backup.json');
        
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: 'Nema backup fajla. Prvo napravite backup.' });
        }

        const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
        console.log('📂 Vraćam backup od:', backup.timestamp);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM progress');
            await client.query('DELETE FROM orders');
            await client.query('DELETE FROM users');

            for (const u of backup.users) {
                if (u.username !== 'admin') {
                    await client.query(
                        'INSERT INTO users (id, username, role, company) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
                        [u.id, u.username, u.role, u.company]
                    );
                }
            }

            for (const o of backup.orders) {
                await client.query(
                    `INSERT INTO orders (id, company, code, name, order_number, quantity, delivery_date)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (id) DO UPDATE SET
                     company = EXCLUDED.company, code = EXCLUDED.code, name = EXCLUDED.name,
                     order_number = EXCLUDED.order_number, quantity = EXCLUDED.quantity,
                     delivery_date = EXCLUDED.delivery_date`,
                    [o.id, o.company, o.code, o.name, o.order_number, o.quantity, o.delivery_date]
                );
            }

            for (const p of backup.progress) {
                await client.query(
                    `INSERT INTO progress (order_id, phase, status, comment, updated_at)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (order_id, phase) DO UPDATE SET
                     status = EXCLUDED.status, comment = EXCLUDED.comment, updated_at = EXCLUDED.updated_at`,
                    [p.order_id, p.phase, p.status, p.comment, p.updated_at]
                );
            }

            await client.query('COMMIT');
            console.log('✅ Restore uspešan!');

            res.json({ 
                message: '✅ Podaci uspešno vraćeni!',
                timestamp: backup.timestamp,
                count: {
                    users: backup.users.length,
                    orders: backup.orders.length,
                    progress: backup.progress.length
                }
            });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (e) {
        console.error('❌ Restore error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ POKRENI SERVER ============
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🗄️ PostgreSQL: ${process.env.DATABASE_URL ? '✅' : '❌'}`);
    console.log(`📧 Email: ${transporter ? '✅' : '❌'}`);
});