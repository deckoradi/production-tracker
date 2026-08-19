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

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

console.log('📧 EMAIL_USER:', process.env.EMAIL_USER ? '✅' : '❌');
console.log('📧 EMAIL_PASS:', process.env.EMAIL_PASS ? '✅' : '❌');
console.log('📧 ADMIN_EMAIL:', process.env.ADMIN_EMAIL ? '✅' : '❌');
console.log('🗄️ DATABASE_URL:', process.env.DATABASE_URL ? '✅' : '❌');

const app = express();
const PORT = process.env.PORT || 5001;

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
                phase VARCHAR(50) NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                comment TEXT DEFAULT '',
                updated_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(order_id, phase)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_history (
                id SERIAL PRIMARY KEY,
                order_number VARCHAR(100) NOT NULL,
                company VARCHAR(255) NOT NULL,
                phase VARCHAR(50) NOT NULL,
                old_status VARCHAR(20),
                new_status VARCHAR(20) NOT NULL,
                comment TEXT,
                changed_by VARCHAR(100),
                changed_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Proširi kolonu ako je još uvek VARCHAR(10)
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='progress' AND column_name='phase' 
                    AND data_type='character varying' AND character_maximum_length=10
                ) THEN
                    ALTER TABLE progress ALTER COLUMN phase TYPE VARCHAR(50);
                END IF;
            END $$;
        `);

        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='order_history' AND column_name='phase' 
                    AND data_type='character varying' AND character_maximum_length=10
                ) THEN
                    ALTER TABLE order_history ALTER COLUMN phase TYPE VARCHAR(50);
                END IF;
            END $$;
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

// ============ UPLOAD ============
app.post('/api/upload', authenticate, upload.single('file'), async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const filePath = req.file.path;
        console.log('📂 Fajl primljen:', req.file.originalname);

        const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: false, cellText: false });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

        console.log('📊 Redova:', data.length);
        console.log('📋 Kolone:', Object.keys(data[0] || {}));

        const findValue = (row, keys) => {
            for (let key of keys) {
                if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
                    return row[key];
                }
            }
            return '';
        };

        const PHASES = ['Krojenje', 'Serigrafija', 'Vez', 'Šivenje', 'Poslato'];

        let inserted = 0;
        let updated = 0;
        let restored = 0;

        for (let i = 0; i < data.length; i++) {
            const row = data[i];

            const company = findValue(row, [
                'ime firme', 'IME FIRME', 'Firma', 'firma', 'Ime firme',
                'FIRMA', 'Name', 'name', 'Company', 'company', 'Naziv firme'
            ]);
            const code = findValue(row, [
                'cod artikal', 'COD ARTIKAL', 'Sifra', 'sifra',
                'Šifra artikla', 'Sifra artikla', 'ŠIFRA ARTIKLA',
                'ŠIFRA', 'Code', 'code', 'Šifra', 'Sifra artikla'
            ]);
            const name = findValue(row, [
                'naziv artikla', 'NAZIV ARTIKLA', 'Naziv', 'naziv',
                'Naziv artikla', 'NAZIV', 'Name', 'name', 'Artikal', 'Proizvod'
            ]);
            const orderNumber = findValue(row, [
                'broj nalog', 'BROJ NALOG', 'Nalog', 'nalog',
                'Broj naloga', 'broj naloga', 'BROJ NALOGA', 'NALOG',
                'NALOG', 'Order', 'order', 'Order Number'
            ]);
            const quantity = parseInt(findValue(row, [
                'pari', 'PARI', 'Kolicina', 'kolicina',
                'QUANTITA', 'Quantity', 'quantity', 'Količina', 'KOLIČINA'
            ])) || 0;
            const deliveryDate = findValue(row, [
                'datum isporuke', 'DATUM ISPORUKE', 'Datum', 'datum',
                'Datum isporuke', 'Delivery Date', 'delivery', 'DATUM ISPORUKE', 'DATUM'
            ]);

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

                let anyRestoredForThisOrder = false;
                for (const phase of PHASES) {
                    const histResult = await pool.query(
                        `SELECT new_status, comment, changed_at FROM order_history
                         WHERE order_number = $1 AND company = $2 AND phase = $3
                         ORDER BY changed_at DESC LIMIT 1`,
                        [orderNumber, company, phase]
                    );

                    const restoredStatus = histResult.rows[0]?.new_status || 'pending';
                    const restoredComment = histResult.rows[0]?.comment || '';
                    const restoredDate = histResult.rows[0]?.changed_at || new Date();

                    if (histResult.rows.length > 0) anyRestoredForThisOrder = true;

                    await pool.query(
                        `INSERT INTO progress (order_id, phase, status, comment, updated_at)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (order_id, phase) DO NOTHING`,
                        [newId, phase, restoredStatus, restoredComment, restoredDate]
                    );
                }
                if (anyRestoredForThisOrder) restored++;
                inserted++;
            }
        }

        console.log(`📦 Novih: ${inserted}, Ažuriranih: ${updated}, Vraćeno iz istorije: ${restored}`);
        res.json({ 
            message: `✅ Novih: ${inserted}, Ažuriranih: ${updated}, Vraćeno iz istorije: ${restored}`, 
            inserted, 
            updated,
            restored,
            totalRows: data.length 
        });

    } catch (e) {
        console.error('❌ Upload error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ ORDERS ============
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
                   COALESCE(json_agg(json_build_object('phase', p.phase, 'status', p.status, 'comment', p.comment, 'updatedAt', p.updated_at) ORDER BY p.phase) 
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

        const data = result.rows.map(row => ({
            id: row.id,
            company: row.company,
            code: row.code,
            name: row.name,
            orderNumber: row.order_number,
            quantity: row.quantity,
            deliveryDate: row.delivery_date,
            progress: row.progress || []
        }));

        res.json({
            data: data,
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

// ============ UPDATE PHASE ============
app.post('/api/update-phase', authenticate, async (req, res) => {
    try {
        const { orderId, phase, comment } = req.body;
        let { status } = req.body;
        console.log(`🔄 Menjam fazu ${phase} za nalog ${orderId}`, status ? `na ${status}` : '(samo komentar)');

        const current = await pool.query(
            'SELECT status, comment FROM progress WHERE order_id = $1 AND phase = $2',
            [orderId, phase]
        );
        const oldStatus = current.rows[0]?.status || 'pending';
        const oldComment = current.rows[0]?.comment || '';

        if (!status) status = oldStatus;
        const finalComment = comment !== undefined ? comment : oldComment;

        await pool.query(
            `INSERT INTO progress (order_id, phase, status, comment, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (order_id, phase) DO UPDATE SET
             status = EXCLUDED.status, 
             comment = EXCLUDED.comment, 
             updated_at = NOW()`,
            [orderId, phase, status, finalComment]
        );

        if (status !== oldStatus || finalComment !== oldComment) {
            const orderInfo = await pool.query(
                'SELECT order_number, company FROM orders WHERE id = $1',
                [orderId]
            );
            if (orderInfo.rows.length > 0) {
                const { order_number, company } = orderInfo.rows[0];
                await pool.query(
                    `INSERT INTO order_history 
                        (order_number, company, phase, old_status, new_status, comment, changed_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [order_number, company, phase, oldStatus, status, finalComment, req.user.username]
                );
                console.log('📜 Istorija sačuvana');
            }
        }

        const updated = await pool.query(
            'SELECT updated_at FROM progress WHERE order_id = $1 AND phase = $2',
            [orderId, phase]
        );
        const updatedAt = updated.rows[0]?.updated_at || new Date();

        console.log('✅ Faza ažurirana u bazi');
        res.json({ 
            message: 'Phase updated',
            status,
            comment: finalComment,
            updatedAt: updatedAt
        });
    } catch (e) {
        console.error('❌ Update phase error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ OBRISI AKTIVNE NALOGE ============
app.post('/api/clear-orders', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Samo admin može' });
    }
    try {
        const deletedOrders = await pool.query('DELETE FROM orders RETURNING id');
        const deletedProgress = await pool.query('DELETE FROM progress RETURNING id');
        res.json({ 
            message: '✅ Aktivni nalozi obrisani! Istorija je sačuvana.',
            deletedOrders: deletedOrders.rowCount,
            deletedProgress: deletedProgress.rowCount
        });
    } catch (e) {
        console.error('❌ Clear error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ OBRISI SVE ============
app.post('/api/clear-all', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Samo admin može' });
    }
    try {
        const deletedOrders = await pool.query('DELETE FROM orders RETURNING id');
        const deletedProgress = await pool.query('DELETE FROM progress RETURNING id');
        const deletedHistory = await pool.query('DELETE FROM order_history RETURNING id');
        res.json({
            message: '✅ Aktivni nalozi i istorija su potpuno obrisani!',
            deletedOrders: deletedOrders.rowCount,
            deletedProgress: deletedProgress.rowCount,
            deletedHistory: deletedHistory.rowCount
        });
    } catch (e) {
        console.error('❌ Clear all error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ EXPORT ISTORIJE ============
app.get('/api/history/export', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Samo admin može' });
    }
    try {
        const { company, dateFrom, dateTo } = req.query;
        let where = [];
        let params = [];
        let idx = 1;

        if (company) {
            where.push(`company = $${idx}`);
            params.push(company);
            idx++;
        }
        if (dateFrom) {
            where.push(`changed_at >= $${idx}`);
            params.push(dateFrom + ' 00:00:00');
            idx++;
        }
        if (dateTo) {
            where.push(`changed_at <= $${idx}`);
            params.push(dateTo + ' 23:59:59');
            idx++;
        }
        const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const lastActivityResult = await pool.query(
            `SELECT DISTINCT ON (order_number, company) order_number, company, comment, changed_by, changed_at
             FROM order_history
             ${whereClause}
             ORDER BY order_number, company, changed_at DESC`,
            params
        );

        if (lastActivityResult.rows.length === 0) {
            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet('Istorija');
            sheet.mergeCells('A1:C1');
            const emptyCell = sheet.getCell('A1');
            emptyCell.value = 'Nema podataka za izabrani filter.';
            emptyCell.font = { name: 'Arial', italic: true, color: { argb: 'FFA0AEC0' } };
            const fileName = `istorija_${company || 'sve-firme'}_${dateFrom || 'x'}_${dateTo || 'x'}.xlsx`;
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            await workbook.xlsx.write(res);
            return res.end();
        }

        const phaseStatusResult = await pool.query(
            `SELECT DISTINCT ON (order_number, company, phase) order_number, company, phase, new_status, comment
             FROM order_history
             ORDER BY order_number, company, phase, changed_at DESC`
        );

        const phaseMap = new Map();
        const phaseSet = new Set();
        phaseStatusResult.rows.forEach(r => {
            const key = `${r.order_number}||${r.company}`;
            if (!phaseMap.has(key)) phaseMap.set(key, {});
            phaseMap.get(key)[r.phase] = { status: r.new_status, comment: r.comment || '' };
            phaseSet.add(r.phase);
        });
        const phases = [...phaseSet].sort((a, b) => parseInt(a) - parseInt(b));
        const finalPhases = phases.length ? phases : ['Krojenje', 'Serigrafija', 'Vez', 'Šivenje', 'Poslato'];

        const statusFill = s => s === 'completed' ? 'FFC6F6D5' : s === 'problem' ? 'FFFED7D7' : null;
        const statusFont = s => s === 'completed' ? 'FF276749' : s === 'problem' ? 'FF9B2C2C' : 'FF4A5568';
        const statusIcon = s => s === 'completed' ? '✅ Urađeno' : s === 'problem' ? '⚠️ Problem' : '';
        const phaseCellText = (entry) => {
            if (!entry) return '';
            const label = statusIcon(entry.status);
            const comment = (entry.comment || '').trim();
            if (label && comment) return `${label}\n${comment}`;
            if (label) return label;
            if (comment) return `💬 ${comment}`;
            return '';
        };

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Production Tracker';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('Istorija', {
            views: [{ state: 'frozen', ySplit: 3 }],
            pageSetup: { orientation: 'landscape', fitToPage: true }
        });

        const fixedCols = [
            { key: 'changed_at', width: 20 },
            { key: 'company', width: 22 },
            { key: 'order_number', width: 15 }
        ];
        const phaseCols = finalPhases.map(p => ({ key: 'phase_' + p, width: 26 }));
        const tailCols = [
            { key: 'changed_by', width: 16 }
        ];
        sheet.columns = [...fixedCols, ...phaseCols, ...tailCols];

        const totalCols = sheet.columns.length;
        const lastColLetter = sheet.getColumn(totalCols).letter;

        sheet.mergeCells(`A1:${lastColLetter}1`);
        const titleCell = sheet.getCell('A1');
        titleCell.value = `Istorija aktivnosti — Firma: ${company || 'sve firme'} — Period: ${dateFrom || 'početak'} do ${dateTo || 'danas'} — Generisano: ${new Date().toLocaleString('sr-RS')}`;
        titleCell.font = { name: 'Arial', size: 11, bold: true, italic: true, color: { argb: 'FF4A5568' } };
        titleCell.alignment = { vertical: 'middle' };
        sheet.getRow(1).height = 22;
        sheet.mergeCells(`A2:${lastColLetter}2`);

        const headerRow = sheet.getRow(3);
        headerRow.values = [
            'Datum i vreme', 'Firma', 'Nalog',
            ...finalPhases.map(p => `Faza ${p}`),
            'Izmenio'
        ];
        headerRow.eachCell(cell => {
            cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });
        headerRow.height = 26;
        sheet.autoFilter = { from: `A3`, to: `${lastColLetter}3` };

        lastActivityResult.rows.forEach((r, i) => {
            const key = `${r.order_number}||${r.company}`;
            const phaseData = phaseMap.get(key) || {};
            const rowData = {
                changed_at: new Date(r.changed_at).toLocaleString('sr-RS'),
                company: r.company,
                order_number: r.order_number,
                changed_by: r.changed_by || ''
            };
            finalPhases.forEach(p => { rowData['phase_' + p] = phaseCellText(phaseData[p]); });

            const row = sheet.addRow(rowData);
            row.font = { name: 'Arial', size: 10 };
            row.alignment = { vertical: 'middle', wrapText: true };
            row.eachCell(cell => {
                cell.border = { top: { style: 'thin', color: { argb: 'FFE2E8F0' } }, bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }, left: { style: 'thin', color: { argb: 'FFE2E8F0' } }, right: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
                if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } };
            });

            let hasComment = false;
            finalPhases.forEach((p, idx) => {
                const entry = phaseData[p];
                const cell = row.getCell(4 + idx);
                const fill = entry ? statusFill(entry.status) : null;
                cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
                cell.font = { name: 'Arial', size: 10, bold: !!(entry && entry.status && entry.status !== 'pending'), color: { argb: entry ? statusFont(entry.status) : 'FF4A5568' } };
                if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
                if (entry && (entry.comment || '').trim()) hasComment = true;
            });
            row.height = hasComment ? 34 : 18;
        });

        const fileName = `istorija_${company || 'sve-firme'}_${dateFrom || 'x'}_${dateTo || 'x'}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) {
        console.error('❌ History export error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ SEND REPORT ============
app.post('/api/send-report', authenticate, async (req, res) => {
    try {
        if (!transporter) {
            return res.status(400).json({ error: 'Email not configured' });
        }

        const { email, date } = req.body;
        const today = date || new Date().toLocaleDateString('sr-RS');

        const ordersResult = await pool.query(
            `SELECT o.*, 
                    COALESCE(json_agg(json_build_object('phase', p.phase, 'status', p.status, 'comment', p.comment, 'updatedAt', p.updated_at) ORDER BY p.phase) 
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

        ws.getColumn(1).width = 15;  // Nalog
        ws.getColumn(2).width = 25;  // Artikal
        ws.getColumn(3).width = 12;  // Šifra
        ws.getColumn(4).width = 12;  // Količina
        ws.getColumn(5).width = 15;  // Datum isporuke
        ws.getColumn(6).width = 18;  // Krojenje
        ws.getColumn(7).width = 18;  // Serigrafija
        ws.getColumn(8).width = 18;  // Vez
        ws.getColumn(9).width = 18;  // Šivenje
        ws.getColumn(10).width = 18; // Poslato
        ws.getColumn(11).width = 30; // Komentar

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

        // ⭐ NOVI HEADERI BEZ "FAZA" PREFIKSA
        const headers = ['Nalog', 'Artikal', 'Šifra', 'Količina', 'Datum isporuke',
            'Krojenje', 'Serigrafija', 'Vez', 'Šivenje', 'Poslato', 'Komentar'];
        const hr = ws.addRow(headers);
        hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
        hr.alignment = { horizontal: 'center', vertical: 'middle' };

        // ⭐ FUNKCIJA ZA STATUS (samo ✅ ili ⚠️ + datum)
        const getPhaseCell = (phaseObj) => {
            if (!phaseObj) return '';
            const status = phaseObj.status || 'pending';
            if (status === 'pending') return '';
            const date = phaseObj.updatedAt ? new Date(phaseObj.updatedAt).toLocaleDateString('sr-RS', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            }) : '';
            if (status === 'completed') return `✅ ${date}`;
            if (status === 'problem') return `⚠️ ${date}`;
            return '';
        };

        activeOrders.forEach(order => {
            const phasesMap = {};
            (order.progress || []).forEach(p => {
                phasesMap[p.phase] = p;
            });

            // ⭐ KOMENTARI BEZ PREFIKSA "Faza X:"
            const allComments = (order.progress || [])
                .filter(p => p.comment && p.comment.trim() !== '')
                .map(p => p.comment.trim())
                .join('; ');

            const row = ws.addRow([
                order.order_number || '',
                order.name || '',
                order.code || '',
                order.quantity || 0,
                order.delivery_date || '',
                getPhaseCell(phasesMap['Krojenje']),
                getPhaseCell(phasesMap['Serigrafija']),
                getPhaseCell(phasesMap['Vez']),
                getPhaseCell(phasesMap['Šivenje']),
                getPhaseCell(phasesMap['Poslato']),
                allComments
            ]);

            // Bojenje ćelija
            const phaseCols = [6, 7, 8, 9, 10];
            const phaseNames = ['Krojenje', 'Serigrafija', 'Vez', 'Šivenje', 'Poslato'];
            phaseCols.forEach((colIdx, idx) => {
                const cell = row.getCell(colIdx);
                const phaseName = phaseNames[idx];
                const phaseData = phasesMap[phaseName];
                if (phaseData) {
                    const status = phaseData.status || 'pending';
                    if (status === 'completed') {
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } };
                        cell.font = { bold: true, color: { argb: 'FF1A6B3C' } };
                    } else if (status === 'problem') {
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
                        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                    }
                }
                cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
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

// ============ POKRENI SERVER ============
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🗄️ PostgreSQL: ${process.env.DATABASE_URL ? '✅' : '❌'}`);
    console.log(`📧 Email: ${transporter ? '✅' : '❌'}`);
});