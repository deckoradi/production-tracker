const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

console.log('📧 RESEND_API_KEY:', process.env.RESEND_API_KEY ? '✅' : '❌');
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
                email VARCHAR(255),
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
                last_changed_by VARCHAR(100),
                last_client_changed_by VARCHAR(100),
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

        // Dodaj kolone ako ne postoje (za postojeće baze)
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_changed_by VARCHAR(100)`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_client_changed_by VARCHAR(100)`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)`);

        const adminCheck = await pool.query('SELECT * FROM users WHERE username = $1', ['admin']);
        if (adminCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await pool.query(
                'INSERT INTO users (username, password, role, company, email) VALUES ($1, $2, $3, $4, $5)',
                ['admin', hashedPassword, 'admin', 'Administrator', null]
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

// ============ EMAIL (Resend) ============
async function sendEmail({ to, subject, html }) {
    if (!process.env.RESEND_API_KEY) {
        throw new Error('Email nije podešen (RESEND_API_KEY nedostaje na serveru).');
    }
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: 'Production Tracker <onboarding@resend.dev>',
            to: [to],
            subject,
            html
        })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
        throw new Error(data.message || `Resend greška (HTTP ${r.status})`);
    }
    return data;
}
console.log('📧 Email (Resend): ' + (process.env.RESEND_API_KEY ? '✅' : '❌'));

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
            { id: user.id, username: user.username, role: user.role, company: user.company, email: user.email },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '24h' }
        );
        res.json({ token, user: { id: user.id, username: user.username, role: user.role, company: user.company, email: user.email } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/users', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    try {
        const result = await pool.query('SELECT id, username, role, company, email FROM users');
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
        const { username, company, role, email } = req.body;
        const finalRole = role === 'kontrola' ? 'kontrola' : 'user';
        const exists = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (exists.rows.length > 0) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        const plainPassword = generatePassword();
        const hashedPassword = await bcrypt.hash(plainPassword, 10);
        const result = await pool.query(
            'INSERT INTO users (username, password, role, company, email) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, role, company, email',
            [username, hashedPassword, finalRole, company || (finalRole === 'kontrola' ? 'Kontrola' : ''), email || null]
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
                    `INSERT INTO orders (id, company, code, name, order_number, quantity, delivery_date, last_changed_by, last_client_changed_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL)`,
                    [newId, company, code, name, orderNumber, quantity, deliveryDate]
                );

                let anyRestoredForThisOrder = false;

                for (const phase of ['100', '200', '300', '400', '500', 'NAPOMENA', 'PRIJEM']) {
                    const histResult = await pool.query(
                        `SELECT new_status, comment, changed_at FROM order_history
                         WHERE order_number = $1 AND company = $2 AND phase = $3
                         ORDER BY changed_at DESC LIMIT 1`,
                        [orderNumber, company, phase]
                    );

                    const restoredStatus = histResult.rows[0]?.new_status || 'pending';
                    const restoredComment = histResult.rows[0]?.comment || '';
                    const restoredDate = histResult.rows[0]?.changed_at || new Date();

                    if (histResult.rows.length > 0) {
                        anyRestoredForThisOrder = true;
                    }

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

        const countQuery = `SELECT COUNT(*) FROM orders ${whereClause}`;
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        const dataQuery = `
            SELECT o.*, o.last_changed_by, o.last_client_changed_by,
                   COALESCE(json_agg(json_build_object(
                        'phase', p.phase, 'status', p.status, 'comment', p.comment, 'updatedAt', p.updated_at,
                        'lastProblemAt', lastprob.changed_at, 'lastProblemComment', lastprob.comment
                   ) ORDER BY p.phase) 
                   FILTER (WHERE p.phase IS NOT NULL), '[]') as progress
            FROM orders o
            LEFT JOIN progress p ON o.id = p.order_id ${isPrivileged ? '' : "AND p.phase != 'PRIJEM'"}
            LEFT JOIN LATERAL (
                SELECT changed_at, comment FROM order_history oh
                WHERE oh.order_number = o.order_number AND oh.company = o.company
                  AND oh.phase = p.phase AND oh.new_status = 'problem'
                ORDER BY oh.changed_at DESC LIMIT 1
            ) lastprob ON true
            ${whereClause}
            GROUP BY o.id, o.last_changed_by, o.last_client_changed_by
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
            lastChangedBy: row.last_changed_by,
            lastClientChangedBy: row.last_client_changed_by,
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

        // PRAVA PRISTUPA PO ULOZI
        if (req.user.role === 'kontrola' && phase !== 'PRIJEM') {
            return res.status(403).json({ error: 'Kontrola može da menja isključivo fazu Prijem.' });
        }
        if (req.user.role !== 'admin' && req.user.role !== 'kontrola' && phase === 'PRIJEM') {
            return res.status(403).json({ error: 'Nemate dozvolu za ovu fazu.' });
        }

        // ZAKLJUČAVANJE PO DANU (samo za klijente, admin nema ograničenja)
        if (req.user.role !== 'admin') {
            // NEMA više trajnog zaključavanja za 'nema' – brišemo taj blok
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
                // Jedini izuzetak posle isteka dana: Problem -> Urađeno (bez menjanja komentara)
                const isProblemToCompleted = oldStatus === 'problem' && status === 'completed' && finalComment === oldComment;
                if (!isProblemToCompleted) {
                    return res.status(403).json({
                        error: '🔒 Ova stavka je zaključana (poslednja izmena je bila ranijeg dana). Obratite se administratoru.'
                    });
                }
            }
        }

        await pool.query(
            `INSERT INTO progress (order_id, phase, status, comment, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (order_id, phase) DO UPDATE SET
             status = EXCLUDED.status, 
             comment = EXCLUDED.comment, 
             updated_at = NOW()`,
            [orderId, phase, status, finalComment]
        );

        // Ažuriraj orders sa podatkom ko je poslednji radio
        await pool.query(
            `UPDATE orders 
             SET last_changed_by = $1,
                 last_client_changed_by = CASE WHEN $2 = 'user' THEN $1 ELSE last_client_changed_by END
             WHERE id = $3`,
            [req.user.username, req.user.role, orderId]
        );

        // Upis u istoriju
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

// ============ OBRISI AKTIVNE NALOGE (ISTORIJA OSTAJE) ============
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

// ============ OBRISI AKTIVNE NALOGE + ISTORIJU (POTPUNO BRISANJE) ============
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
        const showPrijem = req.user.role === 'admin' || req.user.role === 'kontrola';

        const prijemCellText = (entry) => {
            if (!entry || entry.status === 'pending') return '';
            const dateStr = entry.changedAt ? new Date(entry.changedAt).toLocaleDateString('sr-RS') : '';
            if (entry.status === 'completed') return [`✅ ${dateStr}`].filter(Boolean).join('  ');
            try {
                const d = JSON.parse(entry.comment || '{}');
                const icon = d.outcome === 'anulirano' ? '❌ ANULIRANO' : '🔧 REPARACIJA';
                const items = (d.items || []).map(it => `vel.${it.size} - ${it.qty} pa.`).join(', ');
                return [`${icon} ${dateStr}`, items, d.note].filter(Boolean).join('  —  ');
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
            ...(showPrijem ? [{ key: 'prijem', width: 36 }] : []),
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
            ...(showPrijem ? ['Prijem'] : []),
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
                ...(showPrijem ? { prijem: prijemCellText(prijemMap.get(key)) } : {}),
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

// ============ PRIJEM - ŠABLONSKI TEKST ZA COPY-PASTE U MAIL (sa grupisanjem po poslednjem klijentu) ============
app.get('/api/prijem-template', authenticate, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'kontrola') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const { company, date } = req.query;
        if (!company) return res.status(400).json({ error: 'Firma je obavezna.' });
        const targetDate = date || new Date().toLocaleDateString('en-CA');

        const result = await pool.query(
            `SELECT DISTINCT ON (oh.order_number) 
                oh.order_number, oh.new_status, oh.comment, oh.changed_at, 
                o.last_client_changed_by, o.name
             FROM order_history oh
             JOIN orders o ON o.order_number = oh.order_number AND o.company = oh.company
             WHERE oh.company = $1 AND oh.phase = 'PRIJEM' AND oh.new_status = 'problem'
               AND oh.changed_at >= $2::date AND oh.changed_at < ($2::date + INTERVAL '1 day')
             ORDER BY oh.order_number, oh.changed_at DESC`,
            [company, targetDate]
        );

        if (result.rows.length === 0) {
            return res.json({
                text: `Nema Reparacija/Anulirano stavki za "${company}" na dan ${targetDate}.`,
                emails: []
            });
        }

        // Grupisanje po last_client_changed_by (ili company ako null)
        const groups = {};
        result.rows.forEach(r => {
            const key = r.last_client_changed_by || company;
            if (!groups[key]) groups[key] = { items: [], email: null };
            groups[key].items.push(r);
        });

        // Dohvati email za svaki key (ako je username)
        for (const key of Object.keys(groups)) {
            if (key !== company) {
                const userRes = await pool.query('SELECT email FROM users WHERE username = $1', [key]);
                groups[key].email = userRes.rows[0]?.email || null;
            } else {
                groups[key].email = process.env.ADMIN_EMAIL || null;
            }
        }

        // Generiši tekst za svaku grupu i kombinuj
        let combinedText = '';
        const emails = [];
        for (const [key, group] of Object.entries(groups)) {
            const lines = [];
            lines.push(`Poštovani ${key},`);
            lines.push('');
            lines.push('danas Vam vraćamo po otpremnici br. ----- sledeće artikle:');
            lines.push('');
            group.items.forEach(r => {
                const naziv = r.name || '';
                let d = {};
                try { d = JSON.parse(r.comment || '{}'); } catch(_) {}
                const isAnulirano = d.outcome === 'anulirano';
                const icon = isAnulirano ? '❌ ANULIRANO' : '🔧 REPARACIJA';
                const items = (d.items || []).map(it => `vel.${it.size} - ${it.qty} pa.`).join(', ');
                lines.push(`Nalog #${r.order_number}${naziv ? ' — ' + naziv : ''}`);
                lines.push(icon);
                if (items) lines.push(items);
                if (d.note) lines.push(`Napomena: ${d.note}`);
                lines.push('');
            });
            // Zajednički deo
            lines.push('Molimo Vas da uradite reparacije što pre, kako ne bismo kasnili sa isporukama.');
            lines.push('');
            lines.push('Hvala,');
            lines.push('pozdrav.');
            combinedText += lines.join('\n') + '\n\n---\n\n';
            if (group.email) emails.push(group.email);
        }
        combinedText = combinedText.trim();

        res.json({ text: combinedText, emails });
    } catch (e) {
        console.error('❌ Prijem template error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ SLANJE EMAIL-A ZA PRIJEM (na sve adrese iz grupa) ============
app.post('/api/send-prijem', authenticate, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'kontrola') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const { company, date } = req.body;
        if (!company) return res.status(400).json({ error: 'Firma je obavezna.' });
        const targetDate = date || new Date().toLocaleDateString('en-CA');

        // Ista logika kao u GET /prijem-template – izdvojiti u zajedničku funkciju radi DRY
        const result = await pool.query(
            `SELECT DISTINCT ON (oh.order_number) 
                oh.order_number, oh.new_status, oh.comment, oh.changed_at, 
                o.last_client_changed_by, o.name
             FROM order_history oh
             JOIN orders o ON o.order_number = oh.order_number AND o.company = oh.company
             WHERE oh.company = $1 AND oh.phase = 'PRIJEM' AND oh.new_status = 'problem'
               AND oh.changed_at >= $2::date AND oh.changed_at < ($2::date + INTERVAL '1 day')
             ORDER BY oh.order_number, oh.changed_at DESC`,
            [company, targetDate]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Nema stavki za slanje.' });
        }

        const groups = {};
        result.rows.forEach(r => {
            const key = r.last_client_changed_by || company;
            if (!groups[key]) groups[key] = { items: [], email: null };
            groups[key].items.push(r);
        });

        for (const key of Object.keys(groups)) {
            if (key !== company) {
                const userRes = await pool.query('SELECT email FROM users WHERE username = $1', [key]);
                groups[key].email = userRes.rows[0]?.email || null;
            } else {
                groups[key].email = process.env.ADMIN_EMAIL || null;
            }
        }

        // Pošalji svakoj grupi posebno (ili sve u jedan email – ovde šaljemo odvojeno)
        const sentEmails = [];
        for (const [key, group] of Object.entries(groups)) {
            if (!group.email) {
                console.warn(`Nema email za ${key}, preskačem.`);
                continue;
            }
            const lines = [];
            lines.push(`Poštovani ${key},`);
            lines.push('');
            lines.push('danas Vam vraćamo po otpremnici br. ----- sledeće artikle:');
            lines.push('');
            group.items.forEach(r => {
                const naziv = r.name || '';
                let d = {};
                try { d = JSON.parse(r.comment || '{}'); } catch(_) {}
                const isAnulirano = d.outcome === 'anulirano';
                const icon = isAnulirano ? '❌ ANULIRANO' : '🔧 REPARACIJA';
                const items = (d.items || []).map(it => `vel.${it.size} - ${it.qty} pa.`).join(', ');
                lines.push(`Nalog #${r.order_number}${naziv ? ' — ' + naziv : ''}`);
                lines.push(icon);
                if (items) lines.push(items);
                if (d.note) lines.push(`Napomena: ${d.note}`);
                lines.push('');
            });
            lines.push('Molimo Vas da uradite reparacije što pre, kako ne bismo kasnili sa isporukama.');
            lines.push('');
            lines.push('Hvala,');
            lines.push('pozdrav.');
            const text = lines.join('\n');
            const html = text.replace(/\n/g, '<br>');

            await sendEmail({
                to: group.email,
                subject: `🔧 Reparacije / Anulirano – ${company} – ${targetDate}`,
                html
            });
            sentEmails.push(group.email);
        }

        res.json({ message: `Email-ovi poslati na: ${sentEmails.join(', ')}` });
    } catch (e) {
        console.error('❌ Send prijem error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ SEND REPORT ============
app.post('/api/send-report', authenticate, async (req, res) => {
    try {
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

        const phaseSummary = (progress) => (progress || [])
            .filter(p => p.phase !== 'NAPOMENA')
            .map(p => {
                const icon = p.status === 'completed' ? '✅' : p.status === 'problem' ? '⚠️' : '⬜';
                return `${icon} ${phaseLabel(p.phase)}`;
            })
            .join(' &nbsp; ');

        const rowsHtml = userOrders.map(o => `
            <tr>
                <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-weight:600">${o.order_number}</td>
                <td style="padding:8px;border-bottom:1px solid #e2e8f0">${o.name || ''}</td>
                <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center">${o.quantity || 0}</td>
                <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:13px">${phaseSummary(o.progress)}</td>
            </tr>`).join('');

        const html = `
            <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
                <h2 style="color:#2B4570;margin-bottom:4px">📦 Dnevni izveštaj — ${req.user.company}</h2>
                <p style="color:#70796F;margin-top:0">Datum: ${today}</p>
                <table style="width:100%;border-collapse:collapse;margin-top:12px">
                    <thead>
                        <tr style="background:#2B4570;color:white">
                            <th style="padding:8px;text-align:left">Nalog</th>
                            <th style="padding:8px;text-align:left">Naziv</th>
                            <th style="padding:8px;text-align:center">Količina</th>
                            <th style="padding:8px;text-align:left">Status faza</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
                <p style="color:#A0AEC0;font-size:12px;margin-top:20px">Automatski generisano iz Production Tracker sistema.</p>
            </div>`;

        const recipient = email || process.env.ADMIN_EMAIL;
        if (!recipient) {
            return res.status(400).json({ error: 'Nije definisan primalac (ADMIN_EMAIL nije podešen na serveru).' });
        }

        await sendEmail({
            to: recipient,
            subject: `📦 Dnevni izveštaj — ${req.user.company} — ${today}`,
            html
        });

        res.json({ message: `✅ Izveštaj poslat na ${recipient}` });
    } catch (e) {
        console.error('❌ Send report error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ POKRENI SERVER ============
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🗄️ PostgreSQL: ${process.env.DATABASE_URL ? '✅' : '❌'}`);
    console.log(`📧 Email (Resend): ${process.env.RESEND_API_KEY ? '✅' : '❌'}`);
});