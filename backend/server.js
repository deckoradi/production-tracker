const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

const hasResend = !!process.env.RESEND_API_KEY;
const hasSmtp = !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
console.log('📧 RESEND_API_KEY:', hasResend ? '✅' : '❌');
console.log('📧 EMAIL_USER/EMAIL_PASS (SMTP):', hasSmtp ? '✅' : '❌');
console.log('📧 ADMIN_EMAIL:', process.env.ADMIN_EMAIL ? '✅' : '❌');
console.log('🗄️ DATABASE_URL:', process.env.DATABASE_URL ? '✅' : '❌');

const app = express();
const PORT = process.env.PORT || 5001;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ============================================================
// POMOĆNE FUNKCIJE ZA ROLE
// ============================================================
const isAdmin = (user) => user.role === 'admin';
const isKontrola = (user) => user.role === 'kontrola';
const isVez = (user) => user.role === 'vez';
const isSerigrafija = (user) => user.role === 'serigrafija';
const isUser = (user) => user.role === 'user';
const isPrivileged = (user) => isAdmin(user) || isKontrola(user);
const isExternalWorker = (user) => isVez(user) || isSerigrafija(user);

const WORKER_PHASE = { 'vez': '300', 'serigrafija': '200' };

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
                updated_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(order_id, phase)
            )
        `);
        await pool.query(`ALTER TABLE progress ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100)`);
        await pool.query(`ALTER TABLE progress ADD COLUMN IF NOT EXISTS updated_by_company VARCHAR(255)`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_history (
                id SERIAL PRIMARY KEY,
                order_number VARCHAR(100) NOT NULL,
                company VARCHAR(255) NOT NULL,
                phase VARCHAR(10) NOT NULL,
                old_status VARCHAR(20),
                new_status VARCHAR(20) NOT NULL,
                comment TEXT,
                changed_by VARCHAR(100),
                changed_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`ALTER TABLE order_history ADD COLUMN IF NOT EXISTS changed_by_company VARCHAR(255)`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS reparacije (
                id SERIAL PRIMARY KEY,
                order_id BIGINT NOT NULL,
                items JSONB DEFAULT '[]',
                note TEXT DEFAULT '',
                deadline_days INT DEFAULT 7,
                created_at TIMESTAMP DEFAULT NOW(),
                created_by VARCHAR(100),
                deadline_date TIMESTAMP,
                client_confirmed_at TIMESTAMP,
                client_confirmed_by VARCHAR(100),
                client_confirmed_by_company VARCHAR(255),
                kontrola_confirmed_at TIMESTAMP,
                kontrola_confirmed_by VARCHAR(100)
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_reparacije_order ON reparacije(order_id)`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS report_log (
                id SERIAL PRIMARY KEY,
                company VARCHAR(255) UNIQUE NOT NULL,
                last_sent_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS company_info (
                id SERIAL PRIMARY KEY,
                company VARCHAR(255) UNIQUE NOT NULL,
                email VARCHAR(255) DEFAULT '',
                mesto VARCHAR(255) DEFAULT '',
                ulica VARCHAR(255) DEFAULT '',
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS fixed_recipients (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS otpremnica_log (
                id SERIAL PRIMARY KEY,
                order_number VARCHAR(100) NOT NULL,
                company VARCHAR(255) NOT NULL,
                repair_changed_at TIMESTAMP NOT NULL,
                sent_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(order_number, company, repair_changed_at)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_claims (
                id SERIAL PRIMARY KEY,
                order_id BIGINT NOT NULL,
                claimed_by_company VARCHAR(255) NOT NULL,
                claimed_by_user VARCHAR(100) NOT NULL,
                original_company VARCHAR(255) NOT NULL,
                claimed_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(order_id)
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_claims_order ON order_claims(order_id)`);

        await pool.query(`CREATE INDEX IF NOT EXISTS idx_history_lookup ON order_history(order_number, company, phase, changed_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_progress_order ON progress(order_id, phase)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_reparacije_order_created ON reparacije(order_id, created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_company ON orders(company)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_number_company ON orders(order_number, company)`);

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

const restoreReparacijaFromHistory = async (orderId, orderNumber, company) => {
    const lastPrijemHist = await pool.query(
        `SELECT new_status, comment, changed_at FROM order_history
         WHERE order_number = $1 AND company = $2 AND phase = 'PRIJEM'
         ORDER BY changed_at DESC LIMIT 1`,
        [orderNumber, company]
    );
    if (lastPrijemHist.rows.length === 0) return false;
    if (lastPrijemHist.rows[0].new_status !== 'problem') return false;
    let parsedPrijemHist = {};
    try { parsedPrijemHist = JSON.parse(lastPrijemHist.rows[0].comment || '{}'); } catch (_) { return false; }
    if (parsedPrijemHist.outcome !== 'reparacija') return false;

    const restoredDeadlineDays = parseInt(parsedPrijemHist.deadlineDays) > 0 ? parseInt(parsedPrijemHist.deadlineDays) : 7;
    await pool.query(
        `INSERT INTO reparacije (order_id, items, note, deadline_days, created_at, deadline_date, created_by)
         VALUES ($1, $2, $3, $4, $5::timestamp, $5::timestamp + make_interval(days => $4), $6)`,
        [orderId, JSON.stringify(parsedPrijemHist.items || []), parsedPrijemHist.note || '', restoredDeadlineDays, lastPrijemHist.rows[0].changed_at, 'sistem (obnovljeno iz istorije)']
    );
    console.log(`✅ Restore reparacije #${orderNumber} (${company})`);
    return true;
};

let smtpTransporter = null;
if (hasSmtp) {
    smtpTransporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
}

async function sendEmail({ to, subject, html, attachments }) {
    if (hasResend) {
        const body = {
            from: 'Production Tracker <onboarding@resend.dev>',
            to: Array.isArray(to) ? to : [to],
            subject,
            html
        };
        if (attachments && attachments.length > 0) {
            body.attachments = attachments.map(a => ({
                filename: a.filename,
                content: a.content.toString('base64')
            }));
        }
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            throw new Error(data.message || `Resend greška (HTTP ${r.status})`);
        }
        return data;
    }

    if (smtpTransporter) {
        const mailOptions = {
            from: `Production Tracker <${process.env.EMAIL_USER}>`,
            to: Array.isArray(to) ? to.join(', ') : to,
            subject,
            html
        };
        if (attachments && attachments.length > 0) {
            mailOptions.attachments = attachments;
        }
        return smtpTransporter.sendMail(mailOptions);
    }

    throw new Error('Email nije podešen (nedostaje RESEND_API_KEY ili EMAIL_USER/EMAIL_PASS na serveru).');
}
console.log('📧 Email spreman preko: ' + (hasResend ? 'Resend' : hasSmtp ? 'SMTP (nodemailer)' : '❌ NIJE PODEŠEN'));

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

function generatePassword(length = 8) {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let pass = '';
    for (let i = 0; i < length; i++) pass += chars[Math.floor(Math.random() * chars.length)];
    return pass;
}

app.post('/api/users', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    try {
        const { username, company, role } = req.body;
        const allowedRoles = ['user', 'kontrola', 'vez', 'serigrafija'];
        const finalRole = allowedRoles.includes(role) ? role : 'user';
        const exists = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (exists.rows.length > 0) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        const plainPassword = generatePassword();
        const hashedPassword = await bcrypt.hash(plainPassword, 10);
        const defaultCompany = finalRole === 'kontrola' ? 'Kontrola'
            : finalRole === 'vez' ? 'Vez'
            : finalRole === 'serigrafija' ? 'Serigrafija'
            : '';
        const result = await pool.query(
            'INSERT INTO users (username, password, role, company) VALUES ($1, $2, $3, $4) RETURNING id, username, role, company',
            [username, hashedPassword, finalRole, company || defaultCompany]
        );
        res.status(201).json({ message: 'User created', user: result.rows[0], password: plainPassword });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/users/:id/reset-password', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    try {
        const { id } = req.params;
        const target = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        if (target.rows.length === 0) return res.status(404).json({ error: 'Korisnik ne postoji' });
        const plainPassword = generatePassword();
        const hashedPassword = await bcrypt.hash(plainPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, id]);
        res.json({ message: `Nova lozinka za "${target.rows[0].username}" generisana.`, password: plainPassword });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/users/:id', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    try {
        const { id } = req.params;
        const target = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        if (target.rows.length === 0) return res.status(404).json({ error: 'Korisnik ne postoji' });
        if (target.rows[0].role === 'admin') return res.status(400).json({ error: 'Ne može se obrisati admin nalog' });
        if (String(target.rows[0].id) === String(req.user.id)) return res.status(400).json({ error: 'Ne možete obrisati sami sebe' });
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ message: `Korisnik "${target.rows[0].username}" obrisan` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/companies', authenticate, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'kontrola') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const result = await pool.query('SELECT DISTINCT company FROM orders WHERE company IS NOT NULL ORDER BY company');
        res.json(result.rows.map(r => r.company));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/company-info', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const result = await pool.query(
            'SELECT company, email, mesto, ulica FROM company_info ORDER BY company'
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/company-info', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const { company, email, mesto, ulica } = req.body;
        if (!company || !company.trim()) {
            return res.status(400).json({ error: 'Firma je obavezna.' });
        }
        const result = await pool.query(
            `INSERT INTO company_info (company, email, mesto, ulica, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (company) DO UPDATE SET
                email = EXCLUDED.email,
                mesto = EXCLUDED.mesto,
                ulica = EXCLUDED.ulica,
                updated_at = NOW()
             RETURNING company, email, mesto, ulica`,
            [company.trim(), email || '', mesto || '', ulica || '']
        );
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/company-info/:company', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const { company } = req.params;
        const result = await pool.query(
            'DELETE FROM company_info WHERE company = $1 RETURNING company',
            [company]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Firma nije pronađena.' });
        }
        res.json({ message: `Podaci za "${company}" obrisani.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/fixed-recipients', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const result = await pool.query(
            'SELECT id, email, created_at FROM fixed_recipients ORDER BY created_at ASC'
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/fixed-recipients', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const { email } = req.body;
        if (!email || !email.trim()) {
            return res.status(400).json({ error: 'Email je obavezan.' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            return res.status(400).json({ error: 'Email nije validan.' });
        }
        const result = await pool.query(
            `INSERT INTO fixed_recipients (email) VALUES ($1)
             ON CONFLICT (email) DO NOTHING
             RETURNING id, email, created_at`,
            [email.trim().toLowerCase()]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Taj email je već dodat.' });
        }
        res.status(201).json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/fixed-recipients/:id', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const { id } = req.params;
        const result = await pool.query(
            'DELETE FROM fixed_recipients WHERE id = $1 RETURNING email',
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Email nije pronađen.' });
        }
        res.json({ message: `Email "${result.rows[0].email}" obrisan.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/otpremnica-log', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const result = await pool.query('DELETE FROM otpremnica_log RETURNING id');
        res.json({ message: `Obrisano ${result.rowCount} zapisa iz log-a otpremnica.`, deleted: result.rowCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/change-password', authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Unesi trenutnu i novu lozinku.' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Nova lozinka mora imati bar 6 karaktera.' });
        }
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: 'Korisnik ne postoji.' });
        if (!await bcrypt.compare(currentPassword, user.password)) {
            return res.status(401).json({ error: 'Trenutna lozinka nije tačna.' });
        }
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, req.user.id]);
        res.json({ message: '✅ Lozinka je promenjena.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============ WORKER EXPORT (VEZ / SERIGRAFIJA) ============
app.get('/api/worker/export', authenticate, async (req, res) => {
    if (!isExternalWorker(req.user)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const { dateFrom, dateTo } = req.query;
        const phase = WORKER_PHASE[req.user.role];
        if (!phase) return res.status(400).json({ error: 'Nepoznata rola.' });

        let where = [`oh.phase = $1`, `oh.new_status IN ('poslato','uradjeno','problem','completed')`];
        let params = [phase];
        let idx = 2;

        if (dateFrom) {
            where.push(`oh.changed_at >= $${idx}`);
            params.push(dateFrom + ' 00:00:00');
            idx++;
        }
        if (dateTo) {
            where.push(`oh.changed_at <= $${idx}`);
            params.push(dateTo + ' 23:59:59');
            idx++;
        }
        const whereClause = 'WHERE ' + where.join(' AND ');

        const result = await pool.query(
            `SELECT oh.order_number, oh.company, oh.new_status, oh.comment, oh.changed_by, oh.changed_by_company, oh.changed_at,
                    o.name, o.code
             FROM order_history oh
             LEFT JOIN orders o ON o.order_number = oh.order_number AND o.company = oh.company
             ${whereClause}
             ORDER BY oh.changed_at DESC`,
            params
        );

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Production Tracker';
        workbook.created = new Date();
        const phaseLabelMap = { '200': 'Serigrafija', '300': 'Vez' };
        const sheet = workbook.addWorksheet(phaseLabelMap[phase] || ('Faza ' + phase));
        sheet.columns = [
            { header: 'Datum i vreme', key: 'date', width: 20 },
            { header: 'Nalog', key: 'order', width: 15 },
            { header: 'Firma', key: 'company', width: 24 },
            { header: 'Naziv artikla', key: 'name', width: 32 },
            { header: 'Šifra', key: 'code', width: 14 },
            { header: 'Status', key: 'status', width: 20 },
            { header: 'Komentar', key: 'comment', width: 40 },
            { header: 'Izmenio', key: 'changed_by', width: 18 }
        ];
        sheet.getRow(1).eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B4570' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        const STATUS_LABELS = {
            'poslato': '📤 Poslato',
            'uradjeno': '📤 Urađeno',
            'problem': '⚠️ Problem',
            'completed': '📥 Primljeno'
        };
        result.rows.forEach(r => {
            sheet.addRow({
                date: new Date(r.changed_at).toLocaleString('sr-RS'),
                order: r.order_number,
                company: r.company,
                name: r.name || '',
                code: r.code || '',
                status: STATUS_LABELS[r.new_status] || r.new_status,
                comment: r.comment || '',
                changed_by: r.changed_by || ''
            });
        });

        const fileName = `${phaseLabelMap[phase] || phase}_${dateFrom || 'pocetak'}_${dateTo || 'danas'}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) {
        console.error('❌ Worker export error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/poslji-otpremnicu-mail', authenticate, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'kontrola') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const { company, number, text, excelBase64, fileName } = req.body;
        if (!company) return res.status(400).json({ error: 'Firma je obavezna.' });
        if (!text) return res.status(400).json({ error: 'Tekst je obavezan.' });
        if (!excelBase64) return res.status(400).json({ error: 'Excel nije priložen.' });

        const recipients = new Set();
        if (process.env.ADMIN_EMAIL) {
            recipients.add(process.env.ADMIN_EMAIL.trim().toLowerCase());
        }
        try {
            const fixedResult = await pool.query('SELECT email FROM fixed_recipients');
            fixedResult.rows.forEach(r => recipients.add(r.email.trim().toLowerCase()));
        } catch (_) {}
        try {
            const companyResult = await pool.query(
                'SELECT email FROM company_info WHERE company = $1',
                [company]
            );
            if (companyResult.rows[0]?.email) {
                recipients.add(companyResult.rows[0].email.trim().toLowerCase());
            }
        } catch (_) {}

        if (recipients.size === 0) {
            return res.status(400).json({ error: 'Nema primalaca (ADMIN_EMAIL nije podešen, niti ima fiksnih primalaca, niti email firme).' });
        }

        const excelBuffer = Buffer.from(excelBase64, 'base64');
        const finalFileName = fileName || `Otpremnica_${number||'?'}_${company.replace(/\s+/g,'_')}.xlsx`;

        await sendEmail({
            to: Array.from(recipients),
            subject: `📦 Otpremnica br. ${number||'?'} — ${company}`,
            html: `<pre style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${text.replace(/</g,'&lt;')}</pre>`,
            attachments: [{
                filename: finalFileName,
                content: excelBuffer
            }]
        });

        res.json({
            message: `✅ Otpremnica poslata na ${recipients.size} primalaca`,
            recipients: Array.from(recipients)
        });
    } catch (e) {
        console.error('❌ Poslji otpremnicu mail error:', e);
        res.status(500).json({ error: e.message });
    }
});

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

        const findValue = (row, keys) => {
            for (let key of keys) {
                if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
                    return row[key];
                }
            }
            return '';
        };

        let inserted = 0;
        let updated = 0;
        let restored = 0;

        const processRow = async (row, i) => {
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

            if (!company && !code && !orderNumber) return { kind: 'skip' };

            const existing = await pool.query('SELECT id FROM orders WHERE order_number = $1 AND company = $2', [orderNumber, company]);

            if (existing.rows.length > 0) {
                const existingOrderId = existing.rows[0].id;
                await pool.query(
                    `UPDATE orders SET 
                        code = $1, name = $2, quantity = $3, delivery_date = $4
                     WHERE order_number = $5 AND company = $6`,
                    [code, name, quantity, deliveryDate, orderNumber, company]
                );

                const hasAnyRep = await pool.query('SELECT id FROM reparacije WHERE order_id = $1 LIMIT 1', [existingOrderId]);
                if (hasAnyRep.rows.length === 0) {
                    await restoreReparacijaFromHistory(existingOrderId, orderNumber, company);
                }
                return { kind: 'updated' };
            } else {
                const newId = Date.now() + i;
                await pool.query(
                    `INSERT INTO orders (id, company, code, name, order_number, quantity, delivery_date)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [newId, company, code, name, orderNumber, quantity, deliveryDate]
                );

                const phaseResults = await Promise.all(['100', '200', '300', '400', '500', 'NAPOMENA', 'PRIJEM'].map(async phase => {
                    const histResult = await pool.query(
                        `SELECT new_status, comment, changed_at FROM order_history
                         WHERE order_number = $1 AND company = $2 AND phase = $3
                         ORDER BY changed_at DESC LIMIT 1`,
                        [orderNumber, company, phase]
                    );

                    const restoredStatus = histResult.rows[0]?.new_status || 'pending';
                    const restoredComment = histResult.rows[0]?.comment || '';
                    const restoredDate = histResult.rows[0]?.changed_at || new Date();

                    await pool.query(
                        `INSERT INTO progress (order_id, phase, status, comment, updated_at)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (order_id, phase) DO NOTHING`,
                        [newId, phase, restoredStatus, restoredComment, restoredDate]
                    );

                    return histResult.rows.length > 0;
                }));
                const anyRestoredForThisOrder = phaseResults.some(Boolean);

                await restoreReparacijaFromHistory(newId, orderNumber, company);

                return { kind: 'inserted', restored: anyRestoredForThisOrder };
            }
        };

        const CONCURRENCY = 8;
        let nextIndex = 0;
        const worker = async () => {
            while (true) {
                const i = nextIndex++;
                if (i >= data.length) return;
                const result = await processRow(data[i], i);
                if (result.kind === 'updated') updated++;
                else if (result.kind === 'inserted') {
                    inserted++;
                    if (result.restored) restored++;
                }
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));

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

        const privileged = isPrivileged(req.user);
        const externalWorker = isExternalWorker(req.user);
        const workerPhase = externalWorker ? WORKER_PHASE[req.user.role] : null;

        // ============================================================
        // KLIJENT (user) — vidi SVOJE + preuzete + pretraga za tuđe
        // ============================================================
        if (isUser(req.user)) {
            const userCompany = req.user.company;

            if (search) {
                const s = search.toLowerCase();
                whereClause = `WHERE (LOWER(o.order_number) LIKE $${paramIndex} OR LOWER(o.name) LIKE $${paramIndex} OR LOWER(o.code) LIKE $${paramIndex})`;
                params.push(`%${s}%`);
                paramIndex++;
            } else {
                whereClause = `WHERE (
                    o.company = $${paramIndex}
                    OR EXISTS (SELECT 1 FROM order_claims oc WHERE oc.order_id = o.id AND oc.claimed_by_company = $${paramIndex})
                )`;
                params.push(userCompany);
                paramIndex++;
            }
        }

        // ============================================================
        // RADNIK (vez / serigrafija)
        // ============================================================
        if (externalWorker) {
            if (search) {
                const s = search.toLowerCase();
                whereClause = `WHERE EXISTS (
                    SELECT 1 FROM progress pw
                    WHERE pw.order_id = o.id
                      AND pw.phase = $${paramIndex}
                      AND pw.status IN ('poslato','uradjeno','problem')
                ) AND (LOWER(order_number) LIKE $${paramIndex + 1} OR LOWER(name) LIKE $${paramIndex + 1} OR LOWER(company) LIKE $${paramIndex + 1} OR LOWER(code) LIKE $${paramIndex + 1})`;
                params.push(workerPhase);
                params.push(`%${s}%`);
                paramIndex += 2;
            } else {
                whereClause = `WHERE EXISTS (
                    SELECT 1 FROM progress pw
                    WHERE pw.order_id = o.id
                      AND pw.phase = $${paramIndex}
                      AND pw.status IN ('poslato','uradjeno','problem')
                )`;
                params.push(workerPhase);
                paramIndex++;
            }
        }

        // ============================================================
        // ADMIN / KONTROLA
        // ============================================================
        if (privileged && search) {
            const s = search.toLowerCase();
            whereClause = `WHERE (LOWER(order_number) LIKE $${paramIndex} OR LOWER(name) LIKE $${paramIndex} OR LOWER(company) LIKE $${paramIndex} OR LOWER(code) LIKE $${paramIndex})`;
            params.push(`%${s}%`);
            paramIndex++;
        }

        const countQuery = `SELECT COUNT(*) FROM orders o ${whereClause}`;
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        const hidePrijem = !privileged;

        const dataQuery = `
            SELECT o.*, 
                   COALESCE(json_agg(json_build_object(
                        'phase', p.phase, 'status', p.status, 'comment', p.comment, 'updatedAt', p.updated_at,
                        'updatedBy', p.updated_by, 'updatedByCompany', p.updated_by_company,
                        'lastProblemAt', lastprob.changed_at, 'lastProblemComment', lastprob.comment,
                        'history', COALESCE(phaseHist.history, '[]'::json)
                   ) ORDER BY p.phase) 
                   FILTER (WHERE p.phase IS NOT NULL), '[]') as progress,
                   rep.id as rep_id, rep.items as rep_items, rep.note as rep_note,
                   rep.deadline_date as rep_deadline_date, rep.created_at as rep_created_at,
                   rep.client_confirmed_at as rep_client_confirmed_at, rep.client_confirmed_by as rep_client_confirmed_by,
                   rep.client_confirmed_by_company as rep_client_confirmed_by_company,
                   rep.kontrola_confirmed_at as rep_kontrola_confirmed_at, rep.kontrola_confirmed_by as rep_kontrola_confirmed_by,
                   prijemSt.status as prijem_status, prijemSt.comment as prijem_comment,
                   oc.claimed_by_company as claim_by_company,
                   oc.claimed_by_user as claim_by_user,
                   oc.original_company as claim_original_company,
                   oc.claimed_at as claim_at
            FROM orders o
            LEFT JOIN progress p ON o.id = p.order_id ${hidePrijem ? "AND p.phase != 'PRIJEM'" : ''}
            LEFT JOIN LATERAL (
                SELECT changed_at, comment FROM order_history oh
                WHERE oh.order_number = o.order_number AND oh.company = o.company
                  AND oh.phase = p.phase AND oh.new_status = 'problem'
                ORDER BY oh.changed_at DESC LIMIT 1
            ) lastprob ON true
            LEFT JOIN LATERAL (
                SELECT json_agg(json_build_object(
                    'status', oh2.new_status,
                    'oldStatus', oh2.old_status,
                    'comment', oh2.comment,
                    'changedAt', oh2.changed_at,
                    'changedBy', oh2.changed_by,
                    'changedByCompany', oh2.changed_by_company
                ) ORDER BY oh2.changed_at ASC) as history
                FROM order_history oh2
                WHERE oh2.order_number = o.order_number AND oh2.company = o.company
                  AND oh2.phase = p.phase
                  AND oh2.new_status IS NOT NULL
                  AND oh2.new_status != 'pending'
            ) phaseHist ON true
            LEFT JOIN LATERAL (
                SELECT * FROM reparacije r
                WHERE r.order_id = o.id
                ORDER BY r.created_at DESC LIMIT 1
            ) rep ON true
            LEFT JOIN LATERAL (
                SELECT status, comment FROM progress p4
                WHERE p4.order_id = o.id AND p4.phase = 'PRIJEM'
                LIMIT 1
            ) prijemSt ON true
            LEFT JOIN order_claims oc ON oc.order_id = o.id
            ${whereClause}
            GROUP BY o.id, rep.id, rep.items, rep.note, rep.deadline_date, rep.created_at,
                     rep.client_confirmed_at, rep.client_confirmed_by, rep.client_confirmed_by_company,
                     rep.kontrola_confirmed_at, rep.kontrola_confirmed_by, prijemSt.status, prijemSt.comment,
                     oc.claimed_by_company, oc.claimed_by_user, oc.original_company, oc.claimed_at
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
            progress: row.progress || [],
            prijem: row.prijem_status ? { status: row.prijem_status, comment: row.prijem_comment } : null,
            claim: row.claim_by_company ? {
                claimedByCompany: row.claim_by_company,
                claimedByUser: row.claim_by_user,
                originalCompany: row.claim_original_company,
                claimedAt: row.claim_at
            } : null,
            reparacija: row.rep_id ? {
                id: row.rep_id,
                items: row.rep_items || [],
                note: row.rep_note || '',
                deadlineDate: row.rep_deadline_date,
                createdAt: row.rep_created_at,
                clientConfirmedAt: row.rep_client_confirmed_at,
                clientConfirmedBy: row.rep_client_confirmed_by,
                clientConfirmedByCompany: row.rep_client_confirmed_by_company,
                kontrolaConfirmedAt: row.rep_kontrola_confirmed_at,
                kontrolaConfirmedBy: row.rep_kontrola_confirmed_by
            } : null
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

// ============ UPDATE PHASE SA ISTORIJOM ============
app.post('/api/update-phase', authenticate, async (req, res) => {
    try {
        const { orderId, phase, comment } = req.body;
        let { status } = req.body;
        console.log(`🔄 Menjam fazu ${phase} za nalog ${orderId}`, status ? `na ${status}` : '(samo komentar)');

        const current = await pool.query(
            'SELECT status, comment, updated_at, updated_by_company FROM progress WHERE order_id = $1 AND phase = $2',
            [orderId, phase]
        );
        const oldStatus = current.rows[0]?.status || 'pending';
        const oldComment = current.rows[0]?.comment || '';
        const oldUpdatedAt = current.rows[0]?.updated_at || null;
        const oldUpdatedByCompany = current.rows[0]?.updated_by_company || null;

        if (!status) status = oldStatus;
        const finalComment = comment !== undefined ? comment : oldComment;

        const orderInfo = await pool.query('SELECT order_number, company FROM orders WHERE id = $1', [orderId]);
        const orderCompany = orderInfo.rows[0]?.company || '';

        const claimInfo = await pool.query('SELECT * FROM order_claims WHERE order_id = $1', [orderId]);
        const existingClaim = claimInfo.rows[0] || null;

        // ============================================================
        // 1) KONTROLA — može samo PRIJEM
        // ============================================================
        if (isKontrola(req.user) && phase !== 'PRIJEM') {
            return res.status(403).json({ error: 'Kontrola može da menja isključivo fazu Prijem.' });
        }

        // ============================================================
        // 2) ADMIN I KONTROLA — samo oni mogu PRIJEM
        // ============================================================
        if (!isAdmin(req.user) && !isKontrola(req.user) && phase === 'PRIJEM') {
            return res.status(403).json({ error: 'Nemate dozvolu za ovu fazu.' });
        }

        // ============================================================
        // 3) KONTROLA — LOCK
        // ============================================================
        if (isKontrola(req.user) && phase === 'PRIJEM') {
            if (oldStatus === 'completed') {
                return res.status(403).json({ error: '🔒 Prijem je već potvrđen. Ne možete menjati.' });
            }
            if (oldStatus === 'problem') {
                let parsed = {};
                try { parsed = JSON.parse(oldComment || '{}'); } catch (_) {}
                if (parsed.outcome === 'anulirano') {
                    return res.status(403).json({ error: '🔒 Prijem je anuliran. Ne možete menjati.' });
                }
                if (parsed.outcome === 'reparacija') {
                    const rep = await pool.query(
                        'SELECT client_confirmed_at, kontrola_confirmed_at FROM reparacije WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
                        [orderId]
                    );
                    const clientConfirmed = rep.rows[0]?.client_confirmed_at;
                    const kontrolaConfirmed = rep.rows[0]?.kontrola_confirmed_at;
                    if (kontrolaConfirmed) {
                        return res.status(403).json({ error: '🔒 Reparacija je već zatvorena.' });
                    }
                    if (!clientConfirmed && status === 'completed') {
                        return res.status(403).json({ error: '🔒 Klijent još nije potvrdio da je reparacija urađena.' });
                    }
                }
            }
        }

        // ============================================================
        // 4) RADNIK (vez / serigrafija)
        // ============================================================
        if (isExternalWorker(req.user)) {
            const workerPhase = WORKER_PHASE[req.user.role];
            if (phase !== workerPhase) {
                return res.status(403).json({ error: `Možete menjati samo fazu "${workerPhase}".` });
            }

            const allowedStatuses = ['uradjeno', 'problem'];
            if (status && !allowedStatuses.includes(status)) {
                return res.status(403).json({ error: 'Nedozvoljen status za radnike (dozvoljeno: Urađeno, Problem).' });
            }

            if (oldStatus === 'pending' || !oldStatus) {
                return res.status(403).json({ error: 'Klijent još nije poslao nalog za ovu fazu.' });
            }
        }

        // ============================================================
        // 5) KLIJENT (user)
        // ============================================================
        if (isUser(req.user)) {
            const userCompany = req.user.company;
            const isOwnOrder = (orderCompany === userCompany);
            const isClaimedByMe = existingClaim && existingClaim.claimed_by_company === userCompany;

            if (!isOwnOrder && !isClaimedByMe) {
                if (phase !== '100') {
                    return res.status(403).json({ error: '🔒 Ovo je tuđi nalog. Možete ga preuzeti samo klikom na fazu Krojenje.' });
                }
                if (oldStatus !== 'pending' || oldComment.trim() !== '') {
                    return res.status(403).json({ error: '🔒 Nalog je već zauzet (Krojenje je već započeto).' });
                }
                if (status !== 'completed') {
                    return res.status(403).json({ error: '🔒 Da preuzmete nalog, kliknite Krojenje → Urađeno.' });
                }
                await pool.query(
                    `INSERT INTO order_claims (order_id, claimed_by_company, claimed_by_user, original_company)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (order_id) DO NOTHING`,
                    [orderId, userCompany, req.user.username, orderCompany]
                );
                console.log(`📢 PREUZIMANJE: ${userCompany} (${req.user.username}) je preuzeo nalog ${orderInfo.rows[0].order_number} od ${orderCompany}`);
            }

            if (isOwnOrder && existingClaim && existingClaim.claimed_by_company !== userCompany) {
                return res.status(403).json({
                    error: `🔒 Ovaj nalog je preuzet od strane firme "${existingClaim.claimed_by_company}" i nije Vam dostupan.`
                });
            }

            if (['100', '400', 'NAPOMENA'].includes(phase)) {
                const claimCheck = await pool.query(
                    `SELECT DISTINCT updated_by_company FROM progress
                     WHERE order_id = $1 AND phase IN ('100','400','NAPOMENA')
                       AND updated_by_company IS NOT NULL AND updated_by_company != $2
                       AND (status != 'pending' OR (comment IS NOT NULL AND comment != ''))
                     LIMIT 1`,
                    [orderId, userCompany]
                );
                if (claimCheck.rows.length > 0) {
                    return res.status(403).json({
                        error: `🔒 Ovaj nalog je već preuzet od strane firme "${claimCheck.rows[0].updated_by_company}" i nije Vam dostupan.`
                    });
                }
            }

            if (['100', '200', '300', '400', '500'].includes(phase) && status !== 'pending') {
                const phaseOrder = ['100', '200', '300', '400', '500'];
                const idx = phaseOrder.indexOf(phase);
                if (idx > 0) {
                    const priorPhases = phaseOrder.slice(0, idx);
                    const priorResult = await pool.query(
                        `SELECT phase, status FROM progress WHERE order_id = $1 AND phase = ANY($2::text[])`,
                        [orderId, priorPhases]
                    );
                    const statusMap = new Map(priorResult.rows.map(r => [r.phase, r.status]));
                    const unresolved = priorPhases.find(p => {
                        const st = statusMap.get(p);
                        return !st || (st !== 'completed' && st !== 'nema');
                    });
                    if (unresolved) {
                        const unresolvedLabel = phaseLabel(unresolved);
                        return res.status(403).json({
                            error: `⛔ Morate prvo završiti fazu "${unresolvedLabel}" (poslato → urađeno → primljeno) pre nego što nastavite.`
                        });
                    }
                }
            }
        }

        // ============================================================
        // 6) LOCK PO DANU — samo za klijenta
        // ============================================================
        if (isUser(req.user)) {
            const hasPriorActivity = oldStatus !== 'pending' || oldComment.trim() !== '';
            let sameDay = true;
            if (hasPriorActivity && oldUpdatedAt) {
                const oldDate = new Date(oldUpdatedAt);
                const now = new Date();
                sameDay = oldDate.getFullYear() === now.getFullYear()
                    && oldDate.getMonth() === now.getMonth()
                    && oldDate.getDate() === now.getDate();
            }
            if (hasPriorActivity && !sameDay) {
                const isProblemToCompleted = oldStatus === 'problem' && status === 'completed' && finalComment === oldComment;
                const isUradjenoToCompleted = oldStatus === 'uradjeno' && status === 'completed';
                const isPoslatoToProblem = oldStatus === 'poslato' && status === 'problem';
                if (!isProblemToCompleted && !isUradjenoToCompleted && !isPoslatoToProblem) {
                    return res.status(403).json({
                        error: '🔒 Ova stavka je zaključana (poslednja izmena je bila ranijeg dana). Obratite se administratoru.'
                    });
                }
            }
        }

        let finalCommentToStore = finalComment;
        if (phase === 'PRIJEM' && status === 'problem') {
            try {
                const parsedForEnrich = JSON.parse(finalComment || '{}');
                if (parsedForEnrich.outcome === 'reparacija') {
                    const deadlineDaysToStore = parseInt(req.body.deadlineDays) > 0 ? parseInt(req.body.deadlineDays) : 7;
                    parsedForEnrich.deadlineDays = deadlineDaysToStore;
                    finalCommentToStore = JSON.stringify(parsedForEnrich);
                }
            } catch (_) {}
        }

        await pool.query(
            `INSERT INTO progress (order_id, phase, status, comment, updated_at, updated_by, updated_by_company)
             VALUES ($1, $2, $3, $4, NOW(), $5, $6)
             ON CONFLICT (order_id, phase) DO UPDATE SET
             status = EXCLUDED.status, 
             comment = EXCLUDED.comment, 
             updated_at = NOW(),
             updated_by = EXCLUDED.updated_by,
             updated_by_company = EXCLUDED.updated_by_company`,
            [orderId, phase, status, finalCommentToStore, req.user.username, req.user.company]
        );

        if (status !== oldStatus || finalCommentToStore !== oldComment) {
            await pool.query(
                `INSERT INTO order_history 
                    (order_number, company, phase, old_status, new_status, comment, changed_by, changed_by_company)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [orderInfo.rows[0].order_number, orderCompany, phase, oldStatus, status, finalCommentToStore, req.user.username, req.user.company]
            );
        }

        if (phase === 'PRIJEM') {
            if (status === 'problem') {
                let parsedPrijem = {};
                try { parsedPrijem = JSON.parse(finalCommentToStore || '{}'); } catch (_) {}
                if (parsedPrijem.outcome === 'reparacija') {
                    const deadlineDays = parseInt(req.body.deadlineDays) > 0 ? parseInt(req.body.deadlineDays) : 7;
                    const existingRep = await pool.query(
                        `SELECT id FROM reparacije WHERE order_id = $1 AND kontrola_confirmed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
                        [orderId]
                    );
                    if (existingRep.rows.length > 0) {
                        await pool.query(
                            `UPDATE reparacije SET items = $1, note = $2, deadline_days = $3,
                             deadline_date = NOW() + make_interval(days => $3), created_at = NOW(), created_by = $4,
                             client_confirmed_at = NULL, client_confirmed_by = NULL, client_confirmed_by_company = NULL
                             WHERE id = $5`,
                            [JSON.stringify(parsedPrijem.items || []), parsedPrijem.note || '', deadlineDays, req.user.username, existingRep.rows[0].id]
                        );
                    } else {
                        await pool.query(
                            `INSERT INTO reparacije (order_id, items, note, deadline_days, deadline_date, created_by)
                             VALUES ($1, $2, $3, $4, NOW() + make_interval(days => $4), $5)`,
                            [orderId, JSON.stringify(parsedPrijem.items || []), parsedPrijem.note || '', deadlineDays, req.user.username]
                        );
                    }
                } else if (parsedPrijem.outcome === 'anulirano') {
                    await pool.query(`DELETE FROM reparacije WHERE order_id = $1 AND kontrola_confirmed_at IS NULL`, [orderId]);
                }
            } else if (status === 'completed') {
                await pool.query(`DELETE FROM reparacije WHERE order_id = $1 AND kontrola_confirmed_at IS NULL`, [orderId]);
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

app.post('/api/reparacija/:id/client-confirm', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const r = await pool.query(
            `UPDATE reparacije SET client_confirmed_at = NOW(), client_confirmed_by = $1, client_confirmed_by_company = $2
             WHERE id = $3 AND client_confirmed_at IS NULL AND kontrola_confirmed_at IS NULL
             RETURNING *`,
            [req.user.username, req.user.company, id]
        );
        if (r.rows.length === 0) {
            return res.status(404).json({ error: 'Reparacija nije pronađena ili je već potvrđena.' });
        }
        res.json(r.rows[0]);
    } catch (e) {
        console.error('❌ Reparacija client-confirm error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/reparacija/:id/kontrola-confirm', authenticate, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'kontrola') {
        return res.status(403).json({ error: 'Nemate dozvolu za ovu akciju.' });
    }
    try {
        const { id } = req.params;
        const check = await pool.query('SELECT client_confirmed_at, kontrola_confirmed_at FROM reparacije WHERE id = $1', [id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Reparacija nije pronađena.' });
        if (check.rows[0].kontrola_confirmed_at) return res.status(400).json({ error: 'Reparacija je već zatvorena.' });
        if (!check.rows[0].client_confirmed_at) return res.status(400).json({ error: 'Klijent još nije potvrdio da je urađeno.' });

        const r = await pool.query(
            `UPDATE reparacije SET kontrola_confirmed_at = NOW(), kontrola_confirmed_by = $1 WHERE id = $2 RETURNING *`,
            [req.user.username, id]
        );
        res.json(r.rows[0]);
    } catch (e) {
        console.error('❌ Reparacija kontrola-confirm error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/reminders', authenticate, async (req, res) => {
    try {
        const privileged = isPrivileged(req.user);
        let rows;
        if (privileged) {
            const result = await pool.query(
                `SELECT r.*, o.order_number, o.company, o.name
                 FROM reparacije r
                 JOIN orders o ON o.id = r.order_id
                 WHERE r.kontrola_confirmed_at IS NULL AND r.deadline_date < NOW()
                 ORDER BY r.deadline_date ASC`
            );
            rows = result.rows.map(r => ({
                id: r.id, orderId: r.order_id, orderNumber: r.order_number, company: r.company, name: r.name,
                deadlineDate: r.deadline_date, clientConfirmedAt: r.client_confirmed_at,
                waitingOn: r.client_confirmed_at ? 'kontrola' : 'klijent i kontrola'
            }));
        } else if (isUser(req.user)) {
            const result = await pool.query(
                `SELECT r.*, o.order_number, o.company, o.name
                 FROM reparacije r
                 JOIN orders o ON o.id = r.order_id
                 LEFT JOIN LATERAL (
                     SELECT updated_by_company FROM progress p
                     WHERE p.order_id = o.id AND p.phase IN ('100','200','300','400')
                     ORDER BY p.updated_at DESC LIMIT 1
                 ) lastEditor ON true
                 WHERE r.kontrola_confirmed_at IS NULL AND r.client_confirmed_at IS NULL AND r.deadline_date < NOW()
                   AND (o.company = $1 OR lastEditor.updated_by_company = $1)
                 ORDER BY r.deadline_date ASC`,
                [req.user.company]
            );
            rows = result.rows.map(r => ({
                id: r.id, orderId: r.order_id, orderNumber: r.order_number, company: r.company, name: r.name,
                deadlineDate: r.deadline_date, waitingOn: 'klijent'
            }));
        } else {
            rows = [];
        }
        res.json({ reminders: rows });
    } catch (e) {
        console.error('❌ Reminders error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/clear-orders', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Samo admin može' });
    }
    try {
        await pool.query('DELETE FROM reparacije');
        await pool.query('DELETE FROM order_claims');
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

app.post('/api/clear-all', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Samo admin može' });
    }
    try {
        await pool.query('DELETE FROM reparacije');
        await pool.query('DELETE FROM order_claims');
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

// ============ NAZIVI FAZA ============
const PHASE_LABELS = { '100': 'Krojenje', '200': 'Serigrafija', '300': 'Vez', '400': 'Šivenje', '500': 'Poslato' };
function phaseLabel(p) { return PHASE_LABELS[String(p)] || `Faza ${p}`; }

// ============ EXPORT ISTORIJE U EXCEL (SA PRIKAZOM KO JE URADIO) ============
app.get('/api/history/export', authenticate, async (req, res) => {
    try {
        let { company, dateFrom, dateTo } = req.query;
        let changedBy = null;
        if (req.user.role !== 'admin') {
            company = null;
            changedBy = req.user.username;
        }
        let where = [];
        let params = [];
        let idx = 1;

        if (company) {
            where.push(`company = $${idx}`);
            params.push(company);
            idx++;
        }
        if (changedBy) {
            where.push(`changed_by = $${idx}`);
            params.push(changedBy);
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

        // ============================================================
        // NOVO: phaseStatusResult sada vraća i changed_by i changed_by_company
        // ============================================================
        const phaseStatusResult = await pool.query(
            `SELECT DISTINCT ON (order_number, company, phase) order_number, company, phase, new_status, comment, changed_at, changed_by, changed_by_company
             FROM order_history
             ORDER BY order_number, company, phase, changed_at DESC`
        );

        const lastProblemResult = await pool.query(
            `SELECT DISTINCT ON (order_number, company, phase) order_number, company, phase, comment, changed_at, changed_by, changed_by_company
             FROM order_history
             WHERE new_status = 'problem'
             ORDER BY order_number, company, phase, changed_at DESC`
        );

        const repairResult = await pool.query(
            `SELECT o.order_number, o.company, r.items, r.note, r.created_at,
                    r.client_confirmed_at, r.client_confirmed_by, r.client_confirmed_by_company,
                    r.kontrola_confirmed_at, r.kontrola_confirmed_by
             FROM reparacije r
             JOIN orders o ON o.id = r.order_id
             ORDER BY r.created_at DESC`
        );
        const repairMap = new Map();
        repairResult.rows.forEach(r => {
            const key = `${r.order_number}||${r.company}`;
            if (!repairMap.has(key)) repairMap.set(key, r);
        });

        // ============================================================
        // NOVO: problemMap sada ima changedBy i changedByCompany
        // ============================================================
        const problemMap = new Map();
        lastProblemResult.rows.forEach(r => {
            problemMap.set(`${r.order_number}||${r.company}||${r.phase}`, { 
                comment: r.comment || '', 
                changedAt: r.changed_at,
                changedBy: r.changed_by || '',
                changedByCompany: r.changed_by_company || ''
            });
        });

        const phaseMap = new Map();
        const napomenaMap = new Map();
        const prijemMap = new Map();
        const phaseSet = new Set();
        phaseStatusResult.rows.forEach(r => {
            const key = `${r.order_number}||${r.company}`;
            if (r.phase === 'NAPOMENA') {
                napomenaMap.set(key, { comment: r.comment || '', changedAt: r.changed_at });
                return;
            }
            if (r.phase === 'PRIJEM') {
                prijemMap.set(key, { status: r.new_status, comment: r.comment || '', changedAt: r.changed_at });
                return;
            }
            if (!phaseMap.has(key)) phaseMap.set(key, {});
            // ============================================================
            // NOVO: skladištimo changedBy i changedByCompany
            // ============================================================
            phaseMap.get(key)[r.phase] = { 
                status: r.new_status, 
                comment: r.comment || '', 
                changedAt: r.changed_at,
                changedBy: r.changed_by || '',
                changedByCompany: r.changed_by_company || ''
            };
            phaseSet.add(r.phase);
        });
        const phases = [...phaseSet].sort((a, b) => parseInt(a) - parseInt(b));
        const finalPhases = phases.length ? phases : ['100', '200', '300', '400', '500'];

        const prijemCellText = (entry, key) => {
            if (!entry || entry.status === 'pending') return '';
            const dateStr = entry.changedAt ? new Date(entry.changedAt).toLocaleDateString('sr-RS') : '';
            if (entry.status === 'completed') return [`✅ ${dateStr}`].filter(Boolean).join('  ');
            try {
                const d = JSON.parse(entry.comment || '{}');
                if (d.outcome === 'anulirano') {
                    const items = (d.items || []).map(it => `vel.${it.size} - ${it.qty} pa.`).join(', ');
                    return [`❌ ANULIRANO ${dateStr}`, items, d.note].filter(Boolean).join('  —  ');
                }
                const rep = repairMap.get(key);
                if (rep && rep.kontrola_confirmed_at) {
                    return `✅ ${new Date(rep.kontrola_confirmed_at).toLocaleDateString('sr-RS')}`;
                }
                if (rep && rep.client_confirmed_at) {
                    return `${new Date(rep.client_confirmed_at).toLocaleDateString('sr-RS')} — ${rep.client_confirmed_by || ''}`;
                }
                const items = (d.items || []).map(it => `vel.${it.size} - ${it.qty} pa.`).join(', ');
                return [`🔧 REPARACIJA ${dateStr}`, items, d.note].filter(Boolean).join('  —  ');
            } catch (_) {
                return [`⚠️ ${dateStr}`, entry.comment].filter(Boolean).join('  ');
            }
        };

        const statusFill = s => s === 'completed' ? 'FFC6F6D5' : s === 'problem' ? 'FFFED7D7' : null;
        const statusFont = s => s === 'completed' ? 'FF276749' : s === 'problem' ? 'FF9B2C2C' : 'FF4A5568';

        // ============================================================
        // NOVO: phaseCellText sada prikazuje i ko je uradio
        // ============================================================
        const phaseCellText = (entry, orderNumber, comp, phaseCode) => {
            if (!entry) return '';
            const comment = (entry.comment || '').trim();
            const dateStr = entry.changedAt ? new Date(entry.changedAt).toLocaleDateString('sr-RS') : '';
            // Ko je uradio? Firma ima prioritet (npr. "Serigrafija", "Vez", "Kontrola", "Administrator", "Firma A")
            const byCompany = (entry.changedByCompany || '').trim();
            const byUser = (entry.changedBy || '').trim();
            const byLabel = byCompany || byUser;
            const byStr = byLabel ? `(${byLabel})` : '';

            const lines = [];

            if (entry.status === 'completed') {
                lines.push([dateStr ? `✅ ${dateStr}` : '✅', byStr].filter(Boolean).join('  '));
            } else if (entry.status === 'nema') {
                lines.push([`🚫 Nema ${dateStr}`, byStr].filter(Boolean).join('  '));
            } else if (entry.status === 'problem') {
                lines.push([`⚠️ ${dateStr}`, byStr, comment].filter(Boolean).join('  '));
            } else if (entry.status === 'poslato') {
                lines.push([`📤 Poslato ${dateStr}`, byStr, comment].filter(Boolean).join('  '));
            } else if (entry.status === 'uradjeno') {
                lines.push([`📤 Urađeno ${dateStr}`, byStr, comment].filter(Boolean).join('  '));
            } else if (comment) {
                lines.push([`💬 ${dateStr}`, byStr, comment].filter(Boolean).join('  '));
            }

            if (entry.status !== 'problem') {
                const prob = problemMap.get(`${orderNumber}||${comp}||${phaseCode}`);
                if (prob) {
                    const probDateStr = prob.changedAt ? new Date(prob.changedAt).toLocaleDateString('sr-RS') : '';
                    const probByCompany = (prob.changedByCompany || '').trim();
                    const probByUser = (prob.changedBy || '').trim();
                    const probByLabel = probByCompany || probByUser;
                    const probByStr = probByLabel ? `(${probByLabel})` : '';
                    lines.push([`⚠️ ${probDateStr}`, probByStr, prob.comment].filter(Boolean).join('  '));
                }
            }
            return lines.join('\n');
        };

        const isPrijemFinished = (entry, key) => {
            if (!entry || entry.status === 'pending') return false;
            if (entry.status === 'completed') return true;
            try {
                const d = JSON.parse(entry.comment || '{}');
                if (d.outcome === 'reparacija') {
                    const rep = repairMap.get(key);
                    return !!(rep && rep.kontrola_confirmed_at);
                }
            } catch (_) {}
            return false;
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
        const phaseCols = finalPhases.map(p => ({ key: 'phase_' + p, width: 30 }));
        const tailCols = [
            { key: 'prijem', width: 36 },
            { key: 'napomena', width: 30 },
            { key: 'changed_by', width: 16 }
        ];
        sheet.columns = [...fixedCols, ...phaseCols, ...tailCols];

        const totalCols = sheet.columns.length;
        const lastColLetter = sheet.getColumn(totalCols).letter;

        sheet.mergeCells(`A1:${lastColLetter}1`);
        const titleCell = sheet.getCell('A1');
        titleCell.value = `Istorija aktivnosti — Firma: ${company || 'sve firme'}${changedBy ? ` — Korisnik: ${changedBy}` : ''} — Period: ${dateFrom || 'početak'} do ${dateTo || 'danas'} — Generisano: ${new Date().toLocaleString('sr-RS')}`;
        titleCell.font = { name: 'Arial', size: 11, bold: true, italic: true, color: { argb: 'FF4A5568' } };
        titleCell.alignment = { vertical: 'middle' };
        sheet.getRow(1).height = 22;
        sheet.mergeCells(`A2:${lastColLetter}2`);

        const headerRow = sheet.getRow(3);
        headerRow.values = [
            'Datum i vreme', 'Firma', 'Nalog',
            ...finalPhases.map(p => phaseLabel(p)),
            'Prijem',
            'Napomena', 'Izmenio'
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
            const napomena = napomenaMap.get(key);
            const visibleCompany = (req.user.role === 'admin' || req.user.role === 'kontrola' || r.company === req.user.company) ? r.company : '—';
            const rowData = {
                changed_at: new Date(r.changed_at).toLocaleString('sr-RS'),
                company: visibleCompany,
                order_number: r.order_number,
                prijem: prijemCellText(prijemMap.get(key), key),
                napomena: napomena && napomena.comment ? napomena.comment : '',
                changed_by: r.changed_by || ''
            };
            finalPhases.forEach(p => { rowData['phase_' + p] = phaseCellText(phaseData[p], r.order_number, r.company, p); });

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

            const prijemColIndex = fixedCols.length + phaseCols.length + 1;
            const prijemCell = row.getCell(prijemColIndex);
            prijemCell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            if (isPrijemFinished(prijemMap.get(key), key)) {
                prijemCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF276749' } };
                prijemCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6F6D5' } };
            } else if (prijemMap.get(key) && prijemMap.get(key).status === 'problem') {
                prijemCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF9B2C2C' } };
                prijemCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFED7D7' } };
            }

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

// ============ PRIJEM - ŠABLONSKI TEKST ============
app.get('/api/prijem-template', authenticate, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'kontrola') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const { company, date, number } = req.query;
        if (!company) return res.status(400).json({ error: 'Firma je obavezna.' });
        const targetDate = date || new Date().toLocaleDateString('en-CA');
        const otpremnicaNumber = number ? String(number).trim() : '-----';

        const rawResult = await pool.query(
            `SELECT DISTINCT ON (order_number, company) order_number, company, new_status, comment, changed_at
             FROM order_history
             WHERE phase = 'PRIJEM' AND new_status = 'problem'
               AND changed_at >= $1::date AND changed_at < ($1::date + INTERVAL '1 day')
             ORDER BY order_number, company, changed_at DESC`,
            [targetDate]
        );

        const effectiveResult = await pool.query(
            `SELECT DISTINCT ON (order_number, company) order_number, company, changed_by, changed_by_company
             FROM order_history
             WHERE phase IN ('100','200','300','400') AND changed_by_company IS NOT NULL
             ORDER BY order_number, company, changed_at DESC`
        );
        const effectiveMap = new Map();
        effectiveResult.rows.forEach(r => {
            effectiveMap.set(`${r.order_number}||${r.company}`, { changedBy: r.changed_by, changedByCompany: r.changed_by_company });
        });

        const filteredRows = rawResult.rows.filter(r => {
            const eff = effectiveMap.get(`${r.order_number}||${r.company}`);
            const effectiveCompany = (eff && eff.changedByCompany) ? eff.changedByCompany : r.company;
            if (effectiveCompany !== company) return false;
            let d = {};
            try { d = JSON.parse(r.comment || '{}'); } catch (_) {}
            return d.outcome === 'reparacija';
        });

        const skipKeys = new Set();
        if (filteredRows.length > 0) {
            const logResult = await pool.query(
                `SELECT order_number, company, repair_changed_at FROM otpremnica_log`
            );
            logResult.rows.forEach(l => {
                skipKeys.add(`${l.order_number}||${l.company}||${new Date(l.repair_changed_at).toISOString()}`);
            });
        }

        const result = { rows: filteredRows.filter(r => !skipKeys.has(`${r.order_number}||${r.company}||${new Date(r.changed_at).toISOString()}`)) };

        if (result.rows.length === 0) {
            return res.json({ text: `Nema novih reparacija za "${company}" na dan ${targetDate} (sve su već poslate u otpremnici).` });
        }

        const orderNumbers = [...new Set(result.rows.map(r => r.order_number))];
        const nominalCompanies = [...new Set(result.rows.map(r => r.company))];
        const infoResult = await pool.query(
            `SELECT order_number, company, name FROM orders WHERE order_number = ANY($1::text[]) AND company = ANY($2::text[])`,
            [orderNumbers, nominalCompanies]
        );
        const nameMap = new Map(infoResult.rows.map(r => [`${r.order_number}||${r.company}`, r.name]));

        const itemLines = [];
        result.rows.forEach(r => {
            const naziv = nameMap.get(`${r.order_number}||${r.company}`) || '';
            let d = {};
            try { d = JSON.parse(r.comment || '{}'); } catch (_) {}
            const items = (d.items || []).map(it => `vel.${it.size} - ${it.qty} pa.`).join(', ');

            itemLines.push(`Nalog #${r.order_number}${naziv ? ' — ' + naziv : ''}`);
            itemLines.push('🔧 REPARACIJA');
            if (items) itemLines.push(items);
            if (d.note) itemLines.push(`Napomena: ${d.note}`);
            itemLines.push('');
        });

        const lines = [];
        lines.push('Poštovani,');
        lines.push('');
        lines.push(`danas Vam vraćamo po otpremnici br. ${otpremnicaNumber} sledeće artikle:`);
        lines.push('');
        lines.push(...itemLines);
        lines.push('Molimo Vas da uradite reparacije što pre, kako ne bismo kasnili sa isporukama.');
        lines.push('');
        lines.push('Hvala,');
        lines.push('pozdrav.');

        res.json({ text: lines.join('\n') });
    } catch (e) {
        console.error('❌ Prijem template error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ OTPREMNICA - EXCEL EXPORT ============
app.get('/api/otpremnica/export', authenticate, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'kontrola') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const { company, date, number } = req.query;
        if (!company) return res.status(400).json({ error: 'Firma je obavezna.' });
        const targetDate = date || new Date().toLocaleDateString('en-CA');
        const otpremnicaNumber = number ? String(number).trim() : '2450';

        const rawResult = await pool.query(
            `SELECT DISTINCT ON (order_number, company) order_number, company, new_status, comment, changed_at
             FROM order_history
             WHERE phase = 'PRIJEM' AND new_status = 'problem'
               AND changed_at >= $1::date AND changed_at < ($1::date + INTERVAL '1 day')
             ORDER BY order_number, company, changed_at DESC`,
            [targetDate]
        );

        const effectiveResult = await pool.query(
            `SELECT DISTINCT ON (order_number, company) order_number, company, changed_by, changed_by_company
             FROM order_history
             WHERE phase IN ('100','200','300','400') AND changed_by_company IS NOT NULL
             ORDER BY order_number, company, changed_at DESC`
        );
        const effectiveMap = new Map();
        effectiveResult.rows.forEach(r => {
            effectiveMap.set(`${r.order_number}||${r.company}`, { changedBy: r.changed_by, changedByCompany: r.changed_by_company });
        });

        const filteredRows = rawResult.rows
            .filter(r => {
                const eff = effectiveMap.get(`${r.order_number}||${r.company}`);
                const effectiveCompany = (eff && eff.changedByCompany) ? eff.changedByCompany : r.company;
                if (effectiveCompany !== company) return false;
                let d = {};
                try { d = JSON.parse(r.comment || '{}'); } catch (_) {}
                return d.outcome === 'reparacija';
            });

        const skipKeys = new Set();
        if (filteredRows.length > 0) {
            const logResult = await pool.query(
                `SELECT order_number, company, repair_changed_at FROM otpremnica_log`
            );
            logResult.rows.forEach(l => {
                skipKeys.add(`${l.order_number}||${l.company}||${new Date(l.repair_changed_at).toISOString()}`);
            });
        }

        const rows = filteredRows
            .filter(r => !skipKeys.has(`${r.order_number}||${r.company}||${new Date(r.changed_at).toISOString()}`))
            .map(r => {
                let d = {};
                try { d = JSON.parse(r.comment || '{}'); } catch (_) {}
                return {
                    orderNumber: r.order_number,
                    company: r.company,
                    changedAt: r.changed_at,
                    items: d.items || [],
                    note: d.note || ''
                };
            });

        if (rows.length === 0) {
            return res.status(404).json({ error: `Nema novih reparacija za "${company}" na dan ${targetDate} (sve su već poslate u otpremnici).` });
        }

        const orderNumbers = [...new Set(rows.map(r => r.orderNumber))];
        const nominalCompanies = [...new Set(rows.map(r => r.company))];
        const infoResult = await pool.query(
            `SELECT order_number, company, name FROM orders WHERE order_number = ANY($1::text[]) AND company = ANY($2::text[])`,
            [orderNumbers, nominalCompanies]
        );
        const nameMap = new Map(infoResult.rows.map(r => [`${r.order_number}||${r.company}`, r.name]));

        const infoCompany = await pool.query(
            'SELECT mesto, ulica FROM company_info WHERE company = $1',
            [company]
        );
        const mesto = infoCompany.rows[0]?.mesto || '';
        const ulica = infoCompany.rows[0]?.ulica || '';

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Production Tracker';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('OTPREMNICA', {
            pageSetup: {
                paperSize: 9,
                orientation: 'portrait',
                fitToPage: true,
                fitToWidth: 1,
                fitToHeight: 0,
                margins: {
                    left: 0.3, right: 0.3,
                    top: 0.3, bottom: 0.3,
                    header: 0.1, footer: 0.1
                },
                horizontalCentered: true
            }
        });

        sheet.columns = [
            { key: 'a', width: 6 },
            { key: 'b', width: 38 },
            { key: 'c', width: 28 },
            { key: 'd', width: 16 },
            { key: 'e', width: 10 },
            { key: 'f', width: 10 }
        ];

        const headerLeft = [
            'DRAGANA-STROBEL',
            '"FALC EAST" d.o.o.',
            '19350 KNJAZEVAC',
            'Ul.Lole Ribara 26',
            'Tel: 019/737-919; 019/737929',
            'PIB: 103463928',
            'Mat.broj 17576984',
            'Tekući rač: 205-77715-34',
            '"Komercijalna banka"'
        ];

        headerLeft.forEach((text, i) => {
            const rowNum = i + 1;
            const cell = sheet.getCell(`B${rowNum}`);
            cell.value = text;
            cell.font = { name: 'Arial', size: i === 0 ? 12 : 10, bold: i === 0, italic: i === 1 };
            cell.alignment = { vertical: 'middle', horizontal: 'left' };
        });

        sheet.getCell('E2').value = 'DATUM';
        sheet.getCell('E2').font = { name: 'Arial', size: 10, bold: true };
        sheet.getCell('E2').alignment = { vertical: 'middle', horizontal: 'right' };
        sheet.getCell('F2').value = new Date().toLocaleDateString('sr-RS');
        sheet.getCell('F2').font = { name: 'Arial', size: 10 };
        sheet.getCell('F2').alignment = { vertical: 'middle', horizontal: 'right' };

        sheet.getCell('C4').value = 'OTPREMNICA Br.';
        sheet.getCell('C4').font = { name: 'Arial', size: 10, bold: true };
        sheet.getCell('C4').alignment = { vertical: 'middle', horizontal: 'right' };
        sheet.getCell('D4').value = otpremnicaNumber;
        sheet.getCell('D4').font = { name: 'Arial', size: 12, bold: true };
        sheet.getCell('D4').alignment = { vertical: 'middle', horizontal: 'left' };

        sheet.getCell('C6').value = 'Kupac:';
        sheet.getCell('C6').font = { name: 'Arial', size: 10, bold: true };
        sheet.getCell('C6').alignment = { vertical: 'middle', horizontal: 'right' };
        sheet.getCell('D6').value = company;
        sheet.getCell('D6').font = { name: 'Arial', size: 10 };
        sheet.getCell('D6').alignment = { vertical: 'middle', horizontal: 'left' };

        sheet.getCell('C7').value = 'Mesto:';
        sheet.getCell('C7').font = { name: 'Arial', size: 10, bold: true };
        sheet.getCell('C7').alignment = { vertical: 'middle', horizontal: 'right' };
        sheet.getCell('D7').value = mesto;
        sheet.getCell('D7').font = { name: 'Arial', size: 10 };
        sheet.getCell('D7').alignment = { vertical: 'middle', horizontal: 'left' };

        sheet.getCell('C8').value = 'Ulica:';
        sheet.getCell('C8').font = { name: 'Arial', size: 10, bold: true };
        sheet.getCell('C8').alignment = { vertical: 'middle', horizontal: 'right' };
        sheet.getCell('D8').value = ulica;
        sheet.getCell('D8').font = { name: 'Arial', size: 10 };
        sheet.getCell('D8').alignment = { vertical: 'middle', horizontal: 'left' };

        sheet.getCell('C9').value = 'Način otpreme:';
        sheet.getCell('C9').font = { name: 'Arial', size: 10, bold: true };
        sheet.getCell('C9').alignment = { vertical: 'middle', horizontal: 'right' };
        sheet.getCell('D9').value = 'vozilom';
        sheet.getCell('D9').font = { name: 'Arial', size: 10 };
        sheet.getCell('D9').alignment = { vertical: 'middle', horizontal: 'left' };

        sheet.getCell('C10').value = 'Reg. broj vozila:';
        sheet.getCell('C10').font = { name: 'Arial', size: 10, bold: true };
        sheet.getCell('C10').alignment = { vertical: 'middle', horizontal: 'right' };

        const headerRowNum = 12;
        const headers = ['RB', 'REPARACIJE:', 'NAZIV ARTIKLA', 'BOLA', 'JED.MERE', 'KOLIČINA'];
        headers.forEach((h, i) => {
            const col = String.fromCharCode(65 + i);
            const cell = sheet.getCell(`${col}${headerRowNum}`);
            cell.value = h;
            cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });
        sheet.getRow(headerRowNum).height = 22;

        let currentRow = headerRowNum + 1;
        let totalQty = 0;

        rows.forEach((r, idx) => {
            const velicinaStr = (r.items || []).map(it => `${it.size}/${it.qty}`).join(' ');
            const ukupnoQty = (r.items || []).reduce((sum, it) => sum + (parseInt(it.qty) || 0), 0);
            totalQty += ukupnoQty;
            const naziv = nameMap.get(`${r.orderNumber}||${r.company}`) || '';
            const bola = `${r.orderNumber}`;

            const cells = [
                { col: 'A', val: idx + 1, align: 'center' },
                { col: 'B', val: velicinaStr, align: 'left' },
                { col: 'C', val: naziv, align: 'left' },
                { col: 'D', val: bola, align: 'center' },
                { col: 'E', val: 'PA', align: 'center' },
                { col: 'F', val: ukupnoQty, align: 'center' }
            ];
            cells.forEach(c => {
                const cell = sheet.getCell(`${c.col}${currentRow}`);
                cell.value = c.val;
                cell.font = { name: 'Arial', size: 10 };
                cell.alignment = { vertical: 'middle', horizontal: c.align, wrapText: true };
                cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            });
            sheet.getRow(currentRow).height = 20;
            currentRow++;
        });

        const totalRowNum = currentRow;
        sheet.mergeCells(`C${totalRowNum}:D${totalRowNum}`);
        sheet.getCell(`C${totalRowNum}`).value = 'UKUPNO';
        sheet.getCell(`C${totalRowNum}`).font = { name: 'Arial', size: 10, bold: true };
        sheet.getCell(`C${totalRowNum}`).alignment = { vertical: 'middle', horizontal: 'right' };
        sheet.getCell(`F${totalRowNum}`).value = totalQty;
        sheet.getCell(`F${totalRowNum}`).font = { name: 'Arial', size: 10, bold: true };
        sheet.getCell(`F${totalRowNum}`).alignment = { vertical: 'middle', horizontal: 'center' };
        sheet.getCell(`F${totalRowNum}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

        const potpisRow = totalRowNum + 3;
        sheet.getCell(`B${potpisRow}`).value = 'Robu izdao:';
        sheet.getCell(`B${potpisRow}`).font = { name: 'Arial', size: 10 };
        sheet.getCell(`C${potpisRow}`).value = 'M.M.';
        sheet.getCell(`C${potpisRow}`).font = { name: 'Arial', size: 10, bold: true };

        sheet.getCell(`D${potpisRow}`).value = 'Robu primio:';
        sheet.getCell(`D${potpisRow}`).font = { name: 'Arial', size: 10 };

        const potpisRow2 = potpisRow + 2;
        sheet.getCell(`B${potpisRow2}`).value = '__________________________';
        sheet.getCell(`D${potpisRow2}`).value = '__________________________';

        for (const r of rows) {
            await pool.query(
                `INSERT INTO otpremnica_log (order_number, company, repair_changed_at)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (order_number, company, repair_changed_at) DO NOTHING`,
                [r.orderNumber, r.company, r.changedAt]
            );
        }
        console.log(`📦 Otpremnica: ${rows.length} reparacija upisano u log.`);

        const fileName = `Otpremnica_${otpremnicaNumber}_${company.replace(/\s+/g, '_')}_${targetDate}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (e) {
        console.error('❌ Otpremnica export error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ SEND REPORT ============
app.post('/api/send-report', authenticate, async (req, res) => {
    try {
        const logResult = await pool.query(
            'SELECT last_sent_at FROM report_log WHERE company = $1',
            [req.user.company]
        );
        const lastSentAt = logResult.rows[0]?.last_sent_at || null;

        const dateFrom = lastSentAt
            ? new Date(lastSentAt).toISOString().slice(0, 10)
            : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const dateTo = new Date().toISOString().slice(0, 10);

        console.log(`📊 Izveštaj za "${req.user.company}" od ${dateFrom} do ${dateTo}`);

        const historyResult = await pool.query(
            `SELECT DISTINCT ON (order_number, company) 
                order_number, company, phase, new_status, comment, changed_by, changed_at
             FROM order_history
             WHERE company = $1
               AND changed_at >= $2::date
               AND changed_at < ($3::date + INTERVAL '1 day')
             ORDER BY order_number, company, changed_at DESC`,
            [req.user.company, dateFrom, dateTo]
        );

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Production Tracker';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('Izveštaj');

        sheet.columns = [
            { header: 'Datum', key: 'date', width: 20 },
            { header: 'Nalog', key: 'order', width: 15 },
            { header: 'Faza', key: 'phase', width: 18 },
            { header: 'Status', key: 'status', width: 15 },
            { header: 'Komentar', key: 'comment', width: 40 },
            { header: 'Izmenio', key: 'changed_by', width: 18 }
        ];

        sheet.getRow(1).eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });

        const STATUS_LABELS = { 
            'completed': '✅ Urađeno', 
            'problem': '⚠️ Problem', 
            'pending': '⬜ U toku', 
            'nema': '🚫 Nema',
            'poslato': '📤 Poslato',
            'uradjeno': '📤 Urađeno (radnik)'
        };

        historyResult.rows.forEach(r => {
            sheet.addRow({
                date: new Date(r.changed_at).toLocaleString('sr-RS'),
                order: r.order_number,
                phase: PHASE_LABELS[r.phase] || r.phase,
                status: STATUS_LABELS[r.new_status] || r.new_status,
                comment: r.comment || '',
                changed_by: r.changed_by || ''
            });
        });

        const excelBuffer = await workbook.xlsx.writeBuffer();

        const recipients = new Set();

        if (process.env.ADMIN_EMAIL) {
            recipients.add(process.env.ADMIN_EMAIL.trim().toLowerCase());
        }

        try {
            const fixedResult = await pool.query('SELECT email FROM fixed_recipients');
            fixedResult.rows.forEach(r => recipients.add(r.email.trim().toLowerCase()));
        } catch (_) {}

        try {
            const companyResult = await pool.query(
                'SELECT email FROM company_info WHERE company = $1',
                [req.user.company]
            );
            if (companyResult.rows[0]?.email) {
                recipients.add(companyResult.rows[0].email.trim().toLowerCase());
            }
        } catch (_) {}

        if (recipients.size === 0) {
            return res.status(400).json({ error: 'Nema primalaca (ADMIN_EMAIL nije podešen, niti ima fiksnih primalaca).' });
        }

        const fileName = `izvestaj_${req.user.company.replace(/\s+/g, '_')}_${dateFrom}_${dateTo}.xlsx`;

        await sendEmail({
            to: Array.from(recipients),
            subject: `📊 Izveštaj — ${req.user.company} — ${dateFrom} do ${dateTo}`,
            html: `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
                    <h2 style="color:#2B4570">📊 Novi izveštaj</h2>
                    <p><b>Firma:</b> ${req.user.company}</p>
                    <p><b>Poslao:</b> ${req.user.username}</p>
                    <p><b>Period:</b> ${dateFrom} do ${dateTo}</p>
                    <p><b>Broj aktivnosti:</b> ${historyResult.rows.length}</p>
                    <p style="color:#70796F;font-size:13px;margin-top:20px">Excel fajl je u prilogu.</p>
                </div>`,
            attachments: [{
                filename: fileName,
                content: Buffer.from(excelBuffer)
            }]
        });

        await pool.query(
            `INSERT INTO report_log (company, last_sent_at) VALUES ($1, NOW())
             ON CONFLICT (company) DO UPDATE SET last_sent_at = NOW()`,
            [req.user.company]
        );

        res.json({
            message: `✅ Izveštaj poslat na ${recipients.size} primalaca (${historyResult.rows.length} aktivnosti)`,
            dateFrom,
            dateTo,
            count: historyResult.rows.length,
            recipients: Array.from(recipients)
        });
    } catch (e) {
        console.error('❌ Send report error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/report-log', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const result = await pool.query(
            'SELECT company, last_sent_at FROM report_log ORDER BY last_sent_at DESC'
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🗄️ PostgreSQL: ${process.env.DATABASE_URL ? '✅' : '❌'}`);
    console.log(`📧 Email spreman preko: ${hasResend ? 'Resend' : hasSmtp ? 'SMTP (nodemailer)' : '❌ NIJE PODEŠEN'}`);
});