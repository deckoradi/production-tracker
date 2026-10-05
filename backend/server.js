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
        const finalRole = role === 'kontrola' ? 'kontrola' : 'user';
        const exists = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (exists.rows.length > 0) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        const plainPassword = generatePassword();
        const hashedPassword = await bcrypt.hash(plainPassword, 10);
        const result = await pool.query(
            'INSERT INTO users (username, password, role, company) VALUES ($1, $2, $3, $4) RETURNING id, username, role, company',
            [username, hashedPassword, finalRole, company || (finalRole === 'kontrola' ? 'Kontrola' : '')]
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

// ============ NOVA RUTA: SLANJE OTPREMNICE MAIL-OM ============
app.post('/api/poslji-otpremnicu-mail', authenticate, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'kontrola') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const { company, number, text, excelBase64, fileName } = req.body;
        if (!company) return res.status(400).json({ error: 'Firma je obavezna.' });
        if (!text) return res.status(400).json({ error: 'Tekst je obavezan.' });
        if (!excelBase64) return res.status(400).json({ error: 'Excel nije priložen.' });

        // Primaoci: admin + fiksni + email firme
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

        const isPrivileged = req.user.role === 'admin' || req.user.role === 'kontrola';

        if (!isPrivileged) {
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

        if (isPrivileged && search) {
            const s = search.toLowerCase();
            if (whereClause) {
                whereClause += ` AND (LOWER(order_number) LIKE $${paramIndex} OR LOWER(name) LIKE $${paramIndex} OR LOWER(company) LIKE $${paramIndex} OR LOWER(code) LIKE $${paramIndex})`;
            } else {
                whereClause = `WHERE LOWER(order_number) LIKE $${paramIndex} OR LOWER(name) LIKE $${paramIndex} OR LOWER(company) LIKE $${paramIndex} OR LOWER(code) LIKE $${paramIndex}`;
            }
            params.push(`%${s}%`);
            paramIndex++;
        }

        if (!isPrivileged) {
            const claimClause = `NOT EXISTS (
                SELECT 1 FROM progress pclaim
                WHERE pclaim.order_id = o.id
                  AND pclaim.phase IN ('100','200','300','400','NAPOMENA')
                  AND pclaim.updated_by_company IS NOT NULL
                  AND pclaim.updated_by_company != $${paramIndex}
                  AND (pclaim.status != 'pending' OR (pclaim.comment IS NOT NULL AND pclaim.comment != ''))
            )`;
            whereClause += whereClause ? ` AND ${claimClause}` : `WHERE ${claimClause}`;
            params.push(req.user.company);
            paramIndex++;
        }

        const countQuery = `SELECT COUNT(*) FROM orders o ${whereClause}`;
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        const dataQuery = `
            SELECT o.*, 
                   COALESCE(json_agg(json_build_object(
                        'phase', p.phase, 'status', p.status, 'comment', p.comment, 'updatedAt', p.updated_at,
                        'updatedBy', p.updated_by, 'updatedByCompany', p.updated_by_company,
                        'lastProblemAt', lastprob.changed_at, 'lastProblemComment', lastprob.comment
                   ) ORDER BY p.phase) 
                   FILTER (WHERE p.phase IS NOT NULL), '[]') as progress,
                   rep.id as rep_id, rep.items as rep_items, rep.note as rep_note,
                   rep.deadline_date as rep_deadline_date, rep.created_at as rep_created_at,
                   rep.client_confirmed_at as rep_client_confirmed_at, rep.client_confirmed_by as rep_client_confirmed_by,
                   rep.client_confirmed_by_company as rep_client_confirmed_by_company,
                   rep.kontrola_confirmed_at as rep_kontrola_confirmed_at, rep.kontrola_confirmed_by as rep_kontrola_confirmed_by,
                   prijemSt.status as prijem_status, prijemSt.comment as prijem_comment
            FROM orders o
            LEFT JOIN progress p ON o.id = p.order_id ${isPrivileged ? '' : "AND p.phase != 'PRIJEM'"}
            LEFT JOIN LATERAL (
                SELECT changed_at, comment FROM order_history oh
                WHERE oh.order_number = o.order_number AND oh.company = o.company
                  AND oh.phase = p.phase AND oh.new_status = 'problem'
                ORDER BY oh.changed_at DESC LIMIT 1
            ) lastprob ON true
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
            ${whereClause}
            GROUP BY o.id, rep.id, rep.items, rep.note, rep.deadline_date, rep.created_at,
                     rep.client_confirmed_at, rep.client_confirmed_by, rep.client_confirmed_by_company,
                     rep.kontrola_confirmed_at, rep.kontrola_confirmed_by, prijemSt.status, prijemSt.comment
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
            'SELECT status, comment, updated_at FROM progress WHERE order_id = $1 AND phase = $2',
            [orderId, phase]
        );
        const oldStatus = current.rows[0]?.status || 'pending';
        const oldComment = current.rows[0]?.comment || '';
        const oldUpdatedAt = current.rows[0]?.updated_at || null;

        if (!status) status = oldStatus;
        const finalComment = comment !== undefined ? comment : oldComment;

        if (req.user.role === 'kontrola' && phase !== 'PRIJEM') {
            return res.status(403).json({ error: 'Kontrola može da menja isključivo fazu Prijem.' });
        }
        if (req.user.role !== 'admin' && req.user.role !== 'kontrola' && phase === 'PRIJEM') {
            return res.status(403).json({ error: 'Nemate dozvolu za ovu fazu.' });
        }

        if (req.user.role === 'user' && ['100', '200', '300', '400', 'NAPOMENA'].includes(phase)) {
            const claimCheck = await pool.query(
                `SELECT DISTINCT updated_by_company FROM progress
                 WHERE order_id = $1 AND phase IN ('100','200','300','400','NAPOMENA')
                   AND updated_by_company IS NOT NULL AND updated_by_company != $2
                   AND (status != 'pending' OR (comment IS NOT NULL AND comment != ''))
                 LIMIT 1`,
                [orderId, req.user.company]
            );
            if (claimCheck.rows.length > 0) {
                return res.status(403).json({
                    error: `🔒 Ovaj nalog je već preuzet od strane firme "${claimCheck.rows[0].updated_by_company}" i nije Vam dostupan.`
                });
            }
        }

        if (req.user.role === 'user' && ['100', '200', '300', '400', '500'].includes(phase) && status !== 'pending') {
            const phaseOrder = ['100', '200', '300', '400', '500'];
            const idx = phaseOrder.indexOf(phase);
            if (idx > 0) {
                const priorPhases = phaseOrder.slice(0, idx);
                const priorResult = await pool.query(
                    `SELECT phase, status FROM progress WHERE order_id = $1 AND phase = ANY($2::text[])`,
                    [orderId, priorPhases]
                );
                const statusMap = new Map(priorResult.rows.map(r => [r.phase, r.status]));
                const unresolved = priorPhases.find(p => !statusMap.has(p) || statusMap.get(p) === 'pending' || statusMap.get(p) === 'problem');
                if (unresolved) {
                    return res.status(403).json({
                        error: `⛔ Morate prvo rešiti fazu "${phaseLabel(unresolved)}" pre nego što označite "${phaseLabel(phase)}".`
                    });
                }
            }
        }

        if (req.user.role !== 'admin') {
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
                if (!isProblemToCompleted) {
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
            const orderInfo = await pool.query(
                'SELECT order_number, company FROM orders WHERE id = $1',
                [orderId]
            );
            if (orderInfo.rows.length > 0) {
                const { order_number, company } = orderInfo.rows[0];
                await pool.query(
                    `INSERT INTO order_history 
                        (order_number, company, phase, old_status, new_status, comment, changed_by, changed_by_company)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [order_number, company, phase, oldStatus, status, finalCommentToStore, req.user.username, req.user.company]
                );
            }
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
        const isPrivileged = req.user.role === 'admin' || req.user.role === 'kontrola';
        let rows;
        if (isPrivileged) {
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
        } else {
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

// ============ EXPORT ISTORIJE U EXCEL ============
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

        const phaseStatusResult = await pool.query(
            `SELECT DISTINCT ON (order_number, company, phase) order_number, company, phase, new_status, comment, changed_at
             FROM order_history
             ORDER BY order_number, company, phase, changed_at DESC`
        );

        const lastProblemResult = await pool.query(
            `SELECT DISTINCT ON (order_number, company, phase) order_number, company, phase, comment, changed_at
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
        const problemMap = new Map();
        lastProblemResult.rows.forEach(r => {
            problemMap.set(`${r.order_number}||${r.company}||${r.phase}`, { comment: r.comment || '', changedAt: r.changed_at });
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
            phaseMap.get(key)[r.phase] = { status: r.new_status, comment: r.comment || '', changedAt: r.changed_at };
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
        const phaseCellText = (entry, orderNumber, comp, phaseCode) => {
            if (!entry) return '';
            const comment = (entry.comment || '').trim();
            const dateStr = entry.changedAt ? new Date(entry.changedAt).toLocaleDateString('sr-RS') : '';
            const lines = [];

            if (entry.status === 'completed') {
                lines.push(dateStr ? `✅ ${dateStr}` : '✅');
            } else if (entry.status === 'nema') {
                lines.push('🚫 Nema');
            } else if (entry.status === 'problem') {
                lines.push([`⚠️ ${dateStr}`, comment].filter(Boolean).join('  '));
            } else if (comment) {
                lines.push([`💬 ${dateStr}`, comment].filter(Boolean).join('  '));
            }

            if (entry.status !== 'problem') {
                const prob = problemMap.get(`${orderNumber}||${comp}||${phaseCode}`);
                if (prob) {
                    const probDateStr = prob.changedAt ? new Date(prob.changedAt).toLocaleDateString('sr-RS') : '';
                    lines.push([`⚠️ ${probDateStr}`, prob.comment].filter(Boolean).join('  '));
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
        const phaseCols = finalPhases.map(p => ({ key: 'phase_' + p, width: 26 }));
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

// ============ PRIJEM - ŠABLONSKI TEKST ZA COPY-PASTE U MAIL (SA BROJEM OTPREMNICE, FILTRIRA KAO EXCEL) ============
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

// ============ OTPREMNICA - EXCEL EXPORT (SA A4 PRINT SETUP) ============
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
// PRODUCTION TRACKER - orders.js
let currentUser=null,orders=[],selectedOrderId=null,currentPage=1,totalPages=1,totalOrders=0;
const LIMIT=100;
const $=id=>document.getElementById(id);
const token=localStorage.getItem('token'),userStr=localStorage.getItem('user');
if(!token||!userStr){location.href='index.html'}else{try{currentUser=JSON.parse(userStr)}catch(e){localStorage.clear();location.href='index.html'}}
const companyDisplay=$('companyDisplay'),adminPanel=$('adminPanel'),ordersContainer=$('ordersContainer'),searchInput=$('searchInput'),searchBtn=$('searchBtn'),clearSearchBtn=$('clearSearchBtn'),logoutBtn=$('logoutBtn'),sendReportBtn=$('sendReportBtn'),changePasswordBtn=$('changePasswordBtn'),phaseModal=$('phaseModal'),modalOrderNumber=$('modalOrderNumber'),modalOrderInfo=$('modalOrderInfo'),phasesContainer=$('phasesContainer'),closeModal=document.querySelector('.close-modal'),orderCount=$('orderCount');
if(companyDisplay)companyDisplay.textContent=currentUser?.company||'';
const headers=json=>{const h={Authorization:`Bearer ${token}`};if(json)h['Content-Type']='application/json';return h};
async function api(url,opt={}){const r=await fetch(url,opt);let d={};try{d=await r.json()}catch(_){}if(r.status===401){localStorage.clear();location.href='index.html';throw Error(t('msg_session_expired'))}if(!r.ok)throw Error(d.error||`HTTP ${r.status}`);return d}

// ============ INDEXEDDB za čuvanje FileSystemDirectoryHandle ============
const IDB_NAME='production-tracker-fs';
const IDB_STORE='handles';
function idbOpen(){return new Promise((resolve,reject)=>{const req=indexedDB.open(IDB_NAME,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(IDB_STORE))req.result.createObjectStore(IDB_STORE)};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function idbSet(key,val){const db=await idbOpen();return new Promise((resolve,reject)=>{const tx=db.transaction(IDB_STORE,'readwrite');tx.objectStore(IDB_STORE).put(val,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})}
async function idbGet(key){const db=await idbOpen();return new Promise((resolve,reject)=>{const tx=db.transaction(IDB_STORE,'readonly');const req=tx.objectStore(IDB_STORE).get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}

// ============ FILE SYSTEM ACCESS API ============
const BROJ_FILE_NAME='broj.txt';
let otpremnicaFolderHandle=null;
let lastGeneratedExcelBlob=null;
let lastGeneratedFileName=null;

async function loadFolderHandleFromIdb(){
  try{
    const h=await idbGet('otpremnicaFolder');
    if(!h)return;
    otpremnicaFolderHandle=h;
    const perm=await h.queryPermission({mode:'readwrite'});
    if(perm!=='granted'){updateFolderStatusNeedsPermission();return}
    updateFolderStatus();
    const n=await readBrojFromFile(h);
    if(n!==null&&$('otpremnicaBrojInput'))$('otpremnicaBrojInput').value=n;
  }catch(e){console.error('loadFolderHandleFromIdb:',e)}
}

async function chooseFolder(){
  if(!window.showDirectoryPicker){alert('❌ Tvoj browser ne podržava File System Access API.\nKoristi Chrome ili Edge.');return}
  try{
    const h=await window.showDirectoryPicker({mode:'readwrite'});
    otpremnicaFolderHandle=h;
    await idbSet('otpremnicaFolder',h);
    updateFolderStatus();
    const brojPolje=$('otpremnicaBrojInput');
    if(brojPolje){
      const n=await readBrojFromFile(h);
      if(n!==null){brojPolje.value=n}
      else{await writeBrojToFile(h,parseInt(brojPolje.value)||2450)}
    }
  }catch(e){if(e.name!=='AbortError')alert('❌ Greška: '+e.message)}
}

async function grantFolderPermission(){
  if(!otpremnicaFolderHandle)return chooseFolder();
  try{
    const req=await otpremnicaFolderHandle.requestPermission({mode:'readwrite'});
    if(req==='granted'){
      updateFolderStatus();
      const n=await readBrojFromFile(otpremnicaFolderHandle);
      if(n!==null&&$('otpremnicaBrojInput'))$('otpremnicaBrojInput').value=n;
    }else{alert('❌ Pristup folderu nije odobren.')}
  }catch(e){alert('❌ '+e.message)}
}

async function readBrojFromFile(dirHandle){
  try{
    const fh=await dirHandle.getFileHandle(BROJ_FILE_NAME);
    const file=await fh.getFile();
    const text=await file.text();
    const n=parseInt(text.trim());
    return isNaN(n)?null:n;
  }catch(_){return null}
}

async function writeBrojToFile(dirHandle,broj){
  const fh=await dirHandle.getFileHandle(BROJ_FILE_NAME,{create:true});
  const w=await fh.createWritable();
  await w.write(String(broj));
  await w.close();
}

function updateFolderStatus(){
  const status=$('otpremnicaFolderStatus');
  if(!status)return;
  const btn=$('otpremnicaFolderBtn');
  if(otpremnicaFolderHandle){
    status.textContent=`✅ Folder: ${otpremnicaFolderHandle.name}`;
    status.style.color='var(--green)';
    if(btn){btn.textContent='📁 Promeni folder';btn.onclick=chooseFolder}
  }else{
    status.textContent='⚠️ Folder nije izabran';
    status.style.color='var(--red)';
    if(btn){btn.textContent='📁 Izaberi folder';btn.onclick=chooseFolder}
  }
}

function updateFolderStatusNeedsPermission(){
  const status=$('otpremnicaFolderStatus');
  if(!status)return;
  status.textContent='⚠️ Klikni "Omogući pristup folderu"';
  status.style.color='var(--red)';
  const btn=$('otpremnicaFolderBtn');
  if(btn){btn.textContent='🔓 Omogući pristup folderu';btn.onclick=grantFolderPermission}
}

document.addEventListener('DOMContentLoaded',()=>{ setTimeout(loadFolderHandleFromIdb,300); });

document.addEventListener('DOMContentLoaded',()=>{if(currentUser?.role==='admin'){adminPanel?.classList.remove('hidden');addAdminControls();loadUsers();addCompanyInfoControls();addFixedRecipientsControls();addOtpremnicaLogControls()}addClientExportControls();if(currentUser?.role==='kontrola'){addKontrolaControls()}loadOrders();checkReminders()});

// ============ PODSETNICI ============
async function checkReminders(){
  try{
    const d=await api('/api/reminders',{headers:headers()});
    const list=d.reminders||[];
    if(list.length===0)return;
    showRemindersModal(list);
  }catch(e){console.error('Reminders error:',e.message)}
}

function showRemindersModal(list){
  let div=$('remindersModal');
  if(!div){div=document.createElement('div');div.id='remindersModal';div.className='modal';document.body.appendChild(div)}
  const rows=list.map(r=>{
    const days=Math.floor((Date.now()-new Date(r.deadlineDate).getTime())/86400000);
    const waitLabel=r.waitingOn==='kontrola'?t('msg_waiting_kontrola_confirm'):r.waitingOn==='klijent'?t('msg_waiting_your_confirm'):t('msg_waiting_both');
    const dayWord=days===1?t('msg_day'):t('msg_days');
    return `<div style="padding:10px 12px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;cursor:pointer" onclick="closeRemindersModal();openOrder(${r.orderId})">
      <b>${t('th_order')} #${esc(r.orderNumber)}</b>${r.name?` — ${esc(r.name)}`:''}<br>
      <span style="color:var(--muted);font-size:13px">${esc(r.company)} — ${t('msg_late_days')} ${days} ${dayWord} — ${waitLabel}</span>
    </div>`;
  }).join('');
  div.innerHTML=`<div class="modal-content" style="max-width:520px">
    <span class="close-modal" onclick="closeRemindersModal()">&times;</span>
    <h2 style="font-size:18px">${t('msg_reminder_title')}</h2>
    <div style="margin-top:12px;max-height:60vh;overflow-y:auto">${rows}</div>
  </div>`;
  div.classList.remove('hidden');
}
function closeRemindersModal(){$('remindersModal')?.classList.add('hidden')}
let searchDebounce=null;
searchInput?.addEventListener('input',()=>{clearTimeout(searchDebounce);searchDebounce=setTimeout(()=>loadOrders(searchInput.value,1),300)});
searchBtn?.addEventListener('click',()=>loadOrders(searchInput?.value||'',1));searchInput?.addEventListener('keyup',e=>{if(e.key==='Enter')loadOrders(searchInput.value,1)});clearSearchBtn?.addEventListener('click',()=>{if(searchInput)searchInput.value='';loadOrders('',1)});logoutBtn?.addEventListener('click',()=>{localStorage.clear();location.href='index.html'});closeModal?.addEventListener('click',()=>phaseModal?.classList.add('hidden'));window.addEventListener('click',e=>{if(e.target===phaseModal)phaseModal.classList.add('hidden')});

function addAdminControls(){if(!adminPanel||$('orderManagementPanel'))return;const p=document.createElement('div');p.id='orderManagementPanel';p.className='admin-section';p.innerHTML=`<h3>🗂️ Upravljanje nalozima</h3><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px"><button id="deleteActiveOrdersBtn" class="btn-tag btn-tag--problem" style="padding:10px 16px;font-size:13px">🗑️ Obriši aktivne naloge</button><button id="deleteAllHistoryBtn" class="btn-tag btn-tag--reset" style="padding:10px 16px;font-size:13px">🧹 Obriši sve + istoriju</button></div><div id="orderManagementStatus"></div>`;adminPanel.appendChild(p);$('deleteActiveOrdersBtn').onclick=clearActive;$('deleteAllHistoryBtn').onclick=clearAll;
  const h=document.createElement('div');h.id='historyExportPanel';h.className='admin-section';
  h.innerHTML=`<h3>📊 Istorija aktivnosti (Excel izveštaj)</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
      <select id="historyCompany" style="padding:10px;border:2px solid var(--line);border-radius:6px;flex:1;min-width:150px;font-family:var(--font-body);background:var(--card)">
        <option value="">Sve firme</option>
      </select>
      <input type="date" id="historyDateFrom" style="padding:10px;border:2px solid var(--line);border-radius:6px;background:var(--card)">
      <input type="date" id="historyDateTo" style="padding:10px;border:2px solid var(--line);border-radius:6px;background:var(--card)">
      <button id="exportHistoryBtn" class="btn-success" style="padding:10px 16px">📥 Preuzmi Excel</button>
    </div>
    <div id="historyExportStatus"></div>`;
  adminPanel.appendChild(h);
  $('exportHistoryBtn').onclick=exportHistory;
}

// ============ COMPANY INFO ============
function addCompanyInfoControls(){
  if(!adminPanel||$('companyInfoPanel'))return;
  const div=document.createElement('div');div.id='companyInfoPanel';div.className='admin-section';
  div.innerHTML=`<h3>📇 Podaci o firmama (email, mesto, ulica)</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:flex-end">
      <div style="flex:1;min-width:160px">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Firma</label>
        <select id="ciCompany" style="padding:10px;border:2px solid var(--line);border-radius:6px;width:100%;background:var(--card);font-family:var(--font-body)"></select>
      </div>
      <div style="flex:1;min-width:160px">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Email</label>
        <input type="email" id="ciEmail" placeholder="email@firma.com" style="padding:10px;border:2px solid var(--line);border-radius:6px;width:100%;background:var(--card)">
      </div>
      <div style="flex:1;min-width:120px">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Mesto</label>
        <input type="text" id="ciMesto" placeholder="Mesto" style="padding:10px;border:2px solid var(--line);border-radius:6px;width:100%;background:var(--card)">
      </div>
      <div style="flex:1;min-width:140px">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Ulica</label>
        <input type="text" id="ciUlica" placeholder="Ulica i broj" style="padding:10px;border:2px solid var(--line);border-radius:6px;width:100%;background:var(--card)">
      </div>
      <button id="ciSaveBtn" class="btn-success" style="padding:10px 16px">💾 Sačuvaj</button>
    </div>
    <div id="ciStatus" style="margin-top:8px"></div>
    <div id="ciList" style="margin-top:12px"></div>`;
  adminPanel.appendChild(div);
  $('ciSaveBtn').onclick=saveCompanyInfo;
  loadCompanyInfo();
}

async function loadCompanyInfo(){
  try{
    const companies=await api('/api/companies',{headers:headers()});
    const sel=$('ciCompany');
    if(sel)sel.innerHTML='<option value="">— Izaberi firmu —</option>'+companies.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    const info=await api('/api/company-info',{headers:headers()});
    const list=$('ciList');
    if(!info.length){list.innerHTML='<p style="color:var(--muted);font-size:13px">Još nema unetih podataka.</p>';return}
    list.innerHTML='<table style="width:100%;font-size:13px;border-collapse:collapse">'+
      '<thead><tr style="background:var(--paper);text-align:left">'+
      '<th style="padding:6px">Firma</th><th style="padding:6px">Email</th><th style="padding:6px">Mesto</th><th style="padding:6px">Ulica</th><th style="padding:6px"></th>'+
      '</tr></thead><tbody>'+
      info.map(r=>`<tr style="border-bottom:1px solid var(--line)">
        <td style="padding:6px;font-weight:600">${esc(r.company)}</td>
        <td style="padding:6px">${esc(r.email||'')}</td>
        <td style="padding:6px">${esc(r.mesto||'')}</td>
        <td style="padding:6px">${esc(r.ulica||'')}</td>
        <td style="padding:6px;text-align:right">
          <span class="clickable" style="color:var(--red);font-weight:700" onclick="deleteCompanyInfo('${js(r.company)}')" title="Obriši">🗑️</span>
        </td>
      </tr>`).join('')+'</tbody></table>';
  }catch(e){console.error(e)}
}

async function saveCompanyInfo(){
  const status=$('ciStatus');
  const company=$('ciCompany')?.value||'';
  const email=$('ciEmail')?.value.trim()||'';
  const mesto=$('ciMesto')?.value.trim()||'';
  const ulica=$('ciUlica')?.value.trim()||'';
  if(!company){status.textContent='❌ Izaberi firmu.';status.className='error';return}
  status.textContent='⏳ Čuvam...';status.className='';
  try{
    await api('/api/company-info',{method:'POST',headers:headers(true),body:JSON.stringify({company,email,mesto,ulica})});
    status.textContent='✅ Sačuvano.';status.className='success';
    $('ciEmail').value='';$('ciMesto').value='';$('ciUlica').value='';$('ciCompany').value='';
    loadCompanyInfo();
  }catch(e){status.textContent='❌ '+e.message;status.className='error'}
}

async function deleteCompanyInfo(company){
  if(!confirm(`Obrisati podatke za "${company}"?`))return;
  try{
    await api(`/api/company-info/${encodeURIComponent(company)}`,{method:'DELETE',headers:headers()});
    loadCompanyInfo();
  }catch(e){alert('❌ '+e.message)}
}

// ============ FIXED RECIPIENTS ============
function addFixedRecipientsControls(){
  if(!adminPanel||$('fixedRecipientsPanel'))return;
  const div=document.createElement('div');div.id='fixedRecipientsPanel';div.className='admin-section';
  div.innerHTML=`<h3>📧 Fiksni primaoci (uvek primaju izveštaj)</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:flex-end">
      <div style="flex:1;min-width:200px">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Email adresa</label>
        <input type="email" id="frEmail" placeholder="email@primer.com" style="padding:10px;border:2px solid var(--line);border-radius:6px;width:100%;background:var(--card)">
      </div>
      <button id="frAddBtn" class="btn-success" style="padding:10px 16px">➕ Dodaj</button>
    </div>
    <div id="frStatus" style="margin-top:8px"></div>
    <div id="frList" style="margin-top:12px"></div>`;
  adminPanel.appendChild(div);
  $('frAddBtn').onclick=addFixedRecipient;
  $('frEmail')?.addEventListener('keyup',e=>{if(e.key==='Enter')addFixedRecipient()});
  loadFixedRecipients();
}

async function loadFixedRecipients(){
  try{
    const list=await api('/api/fixed-recipients',{headers:headers()});
    const el=$('frList');
    if(!list.length){el.innerHTML='<p style="color:var(--muted);font-size:13px">Još nema fiksnih primalaca.</p>';return}
    el.innerHTML='<table style="width:100%;font-size:13px;border-collapse:collapse">'+
      '<thead><tr style="background:var(--paper);text-align:left">'+
      '<th style="padding:6px">Email</th><th style="padding:6px"></th>'+
      '</tr></thead><tbody>'+
      list.map(r=>`<tr style="border-bottom:1px solid var(--line)">
        <td style="padding:6px">${esc(r.email)}</td>
        <td style="padding:6px;text-align:right">
          <span class="clickable" style="color:var(--red);font-weight:700" onclick="deleteFixedRecipient(${r.id})" title="Obriši">🗑️</span>
        </td>
      </tr>`).join('')+'</tbody></table>';
  }catch(e){console.error(e)}
}

async function addFixedRecipient(){
  const status=$('frStatus');
  const email=$('frEmail')?.value.trim()||'';
  if(!email){status.textContent='❌ Unesi email.';status.className='error';return}
  status.textContent='⏳ Dodajem...';status.className='';
  try{
    await api('/api/fixed-recipients',{method:'POST',headers:headers(true),body:JSON.stringify({email})});
    status.textContent='✅ Dodato.';status.className='success';
    $('frEmail').value='';
    loadFixedRecipients();
  }catch(e){status.textContent='❌ '+e.message;status.className='error'}
}

async function deleteFixedRecipient(id){
  if(!confirm('Obrisati ovaj email iz fiksne grupe?'))return;
  try{
    await api(`/api/fixed-recipients/${id}`,{method:'DELETE',headers:headers()});
    loadFixedRecipients();
  }catch(e){alert('❌ '+e.message)}
}

// ============ OTPREMNICA LOG ============
function addOtpremnicaLogControls(){
  if(!adminPanel||$('otpremnicaLogPanel'))return;
  const div=document.createElement('div');div.id='otpremnicaLogPanel';div.className='admin-section';
  div.innerHTML=`<h3>🗑️ Log otpremnica</h3>
    <p style="font-size:12px;color:var(--muted);margin-top:6px">Briše evidenciju o tome koje su reparacije već poslate u otpremnici. Sledeći put će se ponovo pojaviti u otpremnici.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      <button id="clearOtpremnicaLogBtn" class="btn-tag btn-tag--problem" style="padding:10px 16px;font-size:13px">🗑️ Obriši log otpremnica</button>
    </div>
    <div id="otpremnicaLogStatus" style="margin-top:8px"></div>`;
  adminPanel.appendChild(div);
  $('clearOtpremnicaLogBtn').onclick=clearOtpremnicaLog;
}

async function clearOtpremnicaLog(){
  if(!confirm('Obrisati ceo log otpremnica? Sledeći put će se sve reparacije ponovo pojaviti u otpremnici.'))return;
  const status=$('otpremnicaLogStatus');
  status.textContent='⏳ Brišem...';status.className='';
  try{
    const d=await api('/api/otpremnica-log',{method:'DELETE',headers:headers()});
    status.textContent=`✅ ${d.message}`;status.className='success';
  }catch(e){status.textContent='❌ '+e.message;status.className='error'}
}

async function exportHistory(){
  const status=$('historyExportStatus');
  const company=$('historyCompany')?.value||'';
  const dateFrom=$('historyDateFrom')?.value||'';
  const dateTo=$('historyDateTo')?.value||'';
  status.textContent='⏳ Generišem Excel...';status.className='';
  try{
    const params=new URLSearchParams();
    if(company)params.append('company',company);
    if(dateFrom)params.append('dateFrom',dateFrom);
    if(dateTo)params.append('dateTo',dateTo);
    const r=await fetch(`/api/history/export?${params.toString()}`,{headers:headers()});
    if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||`HTTP ${r.status}`)}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=`istorija_${company||'sve-firme'}_${dateFrom||'x'}_${dateTo||'x'}.xlsx`;
    document.body.appendChild(a);a.click();a.remove();
    URL.revokeObjectURL(url);
    status.textContent='✅ Fajl preuzet';status.className='success';
  }catch(e){status.textContent='❌ '+e.message;status.className='error'}
}

// ============ EXPORT ZA KLIJENTA ============
function addClientExportControls(){
  if(currentUser?.role==='admin')return;
  if($('clientExportPanel'))return;
  const div=document.createElement('div');div.id='clientExportPanel';div.className='panel';
  div.innerHTML=`<div class="panel-header"><h2>${t('panel_my_report')}</h2></div>
    <div class="panel-body">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input type="date" id="myDateFrom" style="padding:10px;border:2px solid var(--line);border-radius:6px;background:var(--card)">
        <input type="date" id="myDateTo" style="padding:10px;border:2px solid var(--line);border-radius:6px;background:var(--card)">
        <button id="myExportBtn" class="btn-success">${t('panel_my_report_download')}</button>
      </div>
      <div id="myExportStatus" style="margin-top:8px"></div>
    </div>`;
  adminPanel?.insertAdjacentElement('afterend',div);
  $('myExportBtn').onclick=exportMyHistory;
}
async function exportMyHistory(){
  const status=$('myExportStatus');
  const dateFrom=$('myDateFrom')?.value||'';
  const dateTo=$('myDateTo')?.value||'';
  status.textContent=t('export_generating');status.className='';
  try{
    const params=new URLSearchParams();
    if(dateFrom)params.append('dateFrom',dateFrom);
    if(dateTo)params.append('dateTo',dateTo);
    const r=await fetch(`/api/history/export?${params.toString()}`,{headers:headers()});
    if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||`HTTP ${r.status}`)}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=`moja_istorija_${dateFrom||'x'}_${dateTo||'x'}.xlsx`;
    document.body.appendChild(a);a.click();a.remove();
    URL.revokeObjectURL(url);
    status.textContent=t('export_done');status.className='success';
  }catch(e){status.textContent='❌ '+e.message;status.className='error'}
}

// ============ KONTROLA - PANEL SA ŠABLONOM ZA MAIL ============
async function addKontrolaControls(){
  if($('kontrolaPanel'))return;
  const div=document.createElement('div');div.id='kontrolaPanel';div.className='panel';
  div.innerHTML=`<div class="panel-header"><h2>📋 Šablon za Prijem (mail)</h2></div>
    <div class="panel-body">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
        <div>
          <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">OTPREMNICA Br.</label>
          <input type="number" id="otpremnicaBrojInput" value="2450" style="padding:10px;border:2px solid var(--line);border-radius:6px;background:var(--card);width:100px;font-weight:bold">
        </div>
        <div>
          <button id="otpremnicaFolderBtn" class="btn-secondary" type="button">📁 Izaberi folder</button>
          <div id="otpremnicaFolderStatus" style="font-size:12px;color:var(--red);margin-top:4px">⚠️ Folder nije izabran</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="prijemTplCompany" style="padding:10px;border:2px solid var(--line);border-radius:6px;flex:1;min-width:150px;font-family:var(--font-body);background:var(--card)">
          <option value="">Izaberi firmu...</option>
        </select>
        <input type="date" id="prijemTplDate" style="padding:10px;border:2px solid var(--line);border-radius:6px;background:var(--card)">
        <button id="prijemTplGenBtn" class="btn-success">📋 Generiši</button>
        <button id="prijemTplOtpremnicaBtn" class="btn-success" style="background:#2B4570;color:white">📥 Povuci Excel otpremnicu</button>
        <button id="prijemTplMailBtn" class="btn-success" style="background:#3F7A5C;color:white">📧 Pošalji mail</button>
        <button id="prijemTplPrintBtn" class="btn-secondary">🖨️ Štampaj 4 primerka</button>
      </div>
      <textarea id="prijemTplResult" class="phase-note" readonly style="margin-top:10px;min-height:180px;font-family:var(--font-mono);font-size:12.5px" placeholder="Ovde će se pojaviti tekst spreman za copy-paste u mail..."></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button id="prijemTplCopyBtn" class="btn-secondary">📋 Kopiraj tekst</button>
      </div>
      <div id="prijemTplStatus" style="margin-top:8px"></div>
    </div>`;
  const anchor=$('clientExportPanel')||adminPanel;
  anchor?.insertAdjacentElement('afterend',div);

  const dateInput=$('prijemTplDate');
  if(dateInput)dateInput.value=new Date().toISOString().slice(0,10);

  try{
    const companies=await api('/api/companies',{headers:headers()});
    const sel=$('prijemTplCompany');
    if(sel)sel.innerHTML='<option value="">Izaberi firmu...</option>'+companies.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  }catch(e){console.error(e)}

  $('prijemTplGenBtn').onclick=generatePrijemTemplate;
  $('prijemTplCopyBtn').onclick=copyPrijemTemplate;
  $('prijemTplOtpremnicaBtn').onclick=exportOtpremnica;
  $('prijemTplMailBtn').onclick=sendOtpremnicaMail;
  $('prijemTplPrintBtn').onclick=printOtpremnica;
  $('otpremnicaFolderBtn').onclick=chooseFolder;

  setTimeout(async()=>{
    if(otpremnicaFolderHandle){
      const n=await readBrojFromFile(otpremnicaFolderHandle);
      if(n!==null&&$('otpremnicaBrojInput'))$('otpremnicaBrojInput').value=n;
    }
  },500);
}