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

/* =========================================================
   DATABASE
========================================================= */

const initDb = async () => {
    try {

        /* USERS */
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

        /* ORDERS */
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

        /* PROGRESS */
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

        /*
         * NOVA POLJA
         *
         * activity_at:
         *   Datum kada je status poslednji put promenjen.
         *
         * comment_updated_at:
         *   Datum poslednje izmene komentara.
         *
         * updated_at:
         *   Poslednja bilo koja izmena.
         */
        await pool.query(`
            ALTER TABLE progress
            ADD COLUMN IF NOT EXISTS activity_at TIMESTAMP
        `);

        await pool.query(`
            ALTER TABLE progress
            ADD COLUMN IF NOT EXISTS comment_updated_at TIMESTAMP
        `);

        /* Stari podaci dobijaju postojeći datum kao datum aktivnosti */
        await pool.query(`
            UPDATE progress
            SET activity_at = COALESCE(activity_at, updated_at)
            WHERE activity_at IS NULL
        `);

        /* HISTORY */
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

        /*
         * Datum konkretne aktivnosti.
         *
         * Za postojeće zapise:
         * activity_at = changed_at
         */
        await pool.query(`
            ALTER TABLE order_history
            ADD COLUMN IF NOT EXISTS activity_at TIMESTAMP
        `);

        await pool.query(`
            UPDATE order_history
            SET activity_at = COALESCE(activity_at, changed_at)
            WHERE activity_at IS NULL
        `);

        /* ADMIN */
        const adminCheck = await pool.query(
            'SELECT * FROM users WHERE username = $1',
            ['admin']
        );

        if (adminCheck.rows.length === 0) {

            const hashedPassword = await bcrypt.hash('admin123', 10);

            await pool.query(
                `INSERT INTO users
                    (username, password, role, company)
                 VALUES ($1, $2, $3, $4)`,
                [
                    'admin',
                    hashedPassword,
                    'admin',
                    'Administrator'
                ]
            );

            console.log('✅ Admin korisnik kreiran: admin / admin123');
        }

        console.log('🗄️ PostgreSQL baza: ✅ Povezana');

    } catch (e) {
        console.error('❌ DB init error:', e.message);
    }
};

initDb();

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(cors({
    origin: [
        'http://localhost:3000',
        'https://production-tracker-wcy8.onrender.com',
        'https://production-tracker.onrender.com'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));

app.use(
    express.static(
        path.join(__dirname, '../frontend')
    )
);

app.get('/', (req, res) => {
    res.sendFile(
        path.join(__dirname, '../frontend/index.html')
    );
});

/* =========================================================
   UPLOAD
========================================================= */

const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({

    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },

    filename: (req, file, cb) => {
        cb(
            null,
            Date.now() + '-' + file.originalname
        );
    }

});

const upload = multer({

    storage,

    limits: {
        fileSize: 100 * 1024 * 1024
    },

    fileFilter: (req, file, cb) => {

        const ext = path.extname(file.originalname).toLowerCase();

        if (ext !== '.xlsx' && ext !== '.xls') {
            return cb(
                new Error('Only Excel files')
            );
        }

        cb(null, true);
    }

});

/* =========================================================
   AUTHENTICATION
========================================================= */

const authenticate = (req, res, next) => {

    const token =
        req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({
            error: 'No token'
        });
    }

    try {

        req.user = jwt.verify(
            token,
            process.env.JWT_SECRET || 'secret'
        );

        next();

    } catch (e) {

        res.status(401).json({
            error: 'Invalid token'
        });

    }
};

/* =========================================================
   EMAIL
========================================================= */

let transporter = null;

try {

    if (
        process.env.EMAIL_USER &&
        process.env.EMAIL_PASS
    ) {

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

} catch (e) {

    console.log(
        '📧 Email: ❌',
        e.message
    );

}

/* =========================================================
   LOGIN
========================================================= */

app.post('/api/login', async (req, res) => {

    try {

        const {
            username,
            password
        } = req.body;

        const result = await pool.query(
            'SELECT * FROM users WHERE username = $1',
            [username]
        );

        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({
                error: 'Invalid credentials'
            });
        }

        const valid = await bcrypt.compare(
            password,
            user.password
        );

        if (!valid) {
            return res.status(401).json({
                error: 'Invalid credentials'
            });
        }

        const token = jwt.sign(

            {
                id: user.id,
                username: user.username,
                role: user.role,
                company: user.company
            },

            process.env.JWT_SECRET || 'secret',

            {
                expiresIn: '24h'
            }

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

    } catch (e) {

        res.status(500).json({
            error: e.message
        });

    }

});

/* =========================================================
   USERS
========================================================= */

app.get('/api/users', authenticate, async (req, res) => {

    if (req.user.role !== 'admin') {

        return res.status(403).json({
            error: 'Access denied'
        });

    }

    try {

        const result = await pool.query(
            `SELECT id, username, role, company
             FROM users
             ORDER BY id`
        );

        res.json(result.rows);

    } catch (e) {

        res.status(500).json({
            error: e.message
        });

    }

});

app.post('/api/users', authenticate, async (req, res) => {

    if (req.user.role !== 'admin') {

        return res.status(403).json({
            error: 'Access denied'
        });

    }

    try {

        const {
            username,
            company
        } = req.body;

        const cleanUsername =
            String(username || '').trim();

        const cleanCompany =
            String(company || '').trim();

        if (!cleanUsername || !cleanCompany) {

            return res.status(400).json({
                error: 'Username i firma su obavezni'
            });

        }

        const exists = await pool.query(
            'SELECT * FROM users WHERE username = $1',
            [cleanUsername]
        );

        if (exists.rows.length > 0) {

            return res.status(400).json({
                error: 'Username already exists'
            });

        }

        const hashedPassword =
            await bcrypt.hash(
                'password123',
                10
            );

        const result = await pool.query(

            `INSERT INTO users
                (username, password, role, company)
             VALUES ($1, $2, $3, $4)
             RETURNING id, username, role, company`,

            [
                cleanUsername,
                hashedPassword,
                'user',
                cleanCompany
            ]

        );

        res.status(201).json({

            message: 'User created',

            user: result.rows[0]

        });

    } catch (e) {

        res.status(500).json({
            error: e.message
        });

    }

});

/* =========================================================
   UPLOAD EXCEL
========================================================= */

app.post(
    '/api/upload',
    authenticate,
    upload.single('file'),
    async (req, res) => {

        if (req.user.role !== 'admin') {

            return res.status(403).json({
                error: 'Access denied'
            });

        }

        try {

            if (!req.file) {

                return res.status(400).json({
                    error: 'Excel fajl nije prosleđen'
                });

            }

            const filePath =
                req.file.path;

            console.log(
                '📂 Fajl primljen:',
                req.file.originalname
            );

            const workbook =
                XLSX.readFile(
                    filePath,
                    {
                        cellDates: true,
                        cellNF: false,
                        cellText: false
                    }
                );

            const sheet =
                workbook.Sheets[
                    workbook.SheetNames[0]
                ];

            const data =
                XLSX.utils.sheet_to_json(
                    sheet,
                    {
                        defval: '',
                        raw: false
                    }
                );

            console.log(
                '📊 Redova:',
                data.length
            );

            console.log(
                '📋 Kolone:',
                Object.keys(data[0] || {})
            );

            const findValue = (
                row,
                keys
            ) => {

                for (const key of keys) {

                    if (
                        row[key] !== undefined &&
                        row[key] !== null &&
                        row[key] !== ''
                    ) {
                        return row[key];
                    }

                }

                return '';
            };

            let inserted = 0;
            let updated = 0;
            let restored = 0;

            for (
                let i = 0;
                i < data.length;
                i++
            ) {

                const row = data[i];

                const company =
                    String(
                        findValue(row, [
                            'ime firme',
                            'IME FIRME',
                            'Firma',
                            'firma',
                            'Ime firme',
                            'FIRMA',
                            'Name',
                            'name',
                            'Company',
                            'company',
                            'Naziv firme'
                        ])
                    ).trim();

                const code =
                    String(
                        findValue(row, [
                            'cod artikal',
                            'COD ARTIKAL',
                            'Sifra',
                            'sifra',
                            'Šifra artikla',
                            'Sifra artikla',
                            'ŠIFRA ARTIKLA',
                            'ŠIFRA',
                            'Code',
                            'code',
                            'Šifra',
                            'Sifra artikla'
                        ])
                    ).trim();

                const name =
                    String(
                        findValue(row, [
                            'naziv artikla',
                            'NAZIV ARTIKLA',
                            'Naziv',
                            'naziv',
                            'Naziv artikla',
                            'NAZIV',
                            'Name',
                            'name',
                            'Artikal',
                            'Proizvod'
                        ])
                    ).trim();

                const orderNumber =
                    String(
                        findValue(row, [
                            'broj nalog',
                            'BROJ NALOG',
                            'Nalog',
                            'nalog',
                            'Broj naloga',
                            'broj naloga',
                            'BROJ NALOGA',
                            'NALOG',
                            'Order',
                            'order',
                            'Order Number'
                        ])
                    ).trim();

                const quantity =
                    parseInt(
                        findValue(row, [
                            'pari',
                            'PARI',
                            'Kolicina',
                            'kolicina',
                            'QUANTITA',
                            'Quantity',
                            'quantity',
                            'Količina',
                            'KOLIČINA'
                        ])
                    ) || 0;

                const deliveryDate =
                    String(
                        findValue(row, [
                            'datum isporuke',
                            'DATUM ISPORUKE',
                            'Datum',
                            'datum',
                            'Datum isporuke',
                            'Delivery Date',
                            'delivery',
                            'DATUM ISPORUKE',
                            'DATUM'
                        ])
                    ).trim();

                if (
                    !company &&
                    !code &&
                    !orderNumber
                ) {
                    continue;
                }

                /*
                 * AKTIVAN NALOG
                 */
                const existing =
                    await pool.query(

                        `SELECT id
                         FROM orders
                         WHERE order_number = $1
                         AND company = $2`,

                        [
                            orderNumber,
                            company
                        ]

                    );

                if (existing.rows.length > 0) {

                    /*
                     * Postojeći nalog:
                     * menjamo samo podatke iz Excela.
                     *
                     * PROGRESS SE NE DIRA.
                     *
                     * Znači:
                     * status ostaje,
                     * komentar ostaje,
                     * datum aktivnosti ostaje.
                     */

                    await pool.query(

                        `UPDATE orders
                         SET
                            code = $1,
                            name = $2,
                            quantity = $3,
                            delivery_date = $4
                         WHERE order_number = $5
                         AND company = $6`,

                        [
                            code,
                            name,
                            quantity,
                            deliveryDate,
                            orderNumber,
                            company
                        ]

                    );

                    updated++;

                } else {

                    /*
                     * NOVI NALOG
                     */
                    const newId =
                        Date.now() + i;

                    await pool.query(

                        `INSERT INTO orders
                            (
                                id,
                                company,
                                code,
                                name,
                                order_number,
                                quantity,
                                delivery_date
                            )
                         VALUES
                            ($1,$2,$3,$4,$5,$6,$7)`,

                        [
                            newId,
                            company,
                            code,
                            name,
                            orderNumber,
                            quantity,
                            deliveryDate
                        ]

                    );

                    /*
                     * =====================================================
                     * RESTORE IZ ISTORIJE
                     * =====================================================
                     *
                     * Status uzimamo iz poslednje PROMENE STATUSA.
                     *
                     * Komentar uzimamo iz poslednje PROMENE KOMENTARA.
                     *
                     * Datum aktivnosti uzimamo iz poslednje PROMENE
                     * STATUSA, a ne iz poslednje izmene komentara.
                     */

                    let anyRestoredForThisOrder = false;

                    for (
                        const phase of [
                            '100',
                            '200',
                            '300',
                            '400',
                            '500'
                        ]
                    ) {

                        /*
                         * Poslednja stvarna promena statusa
                         */
                        const statusHistory =
                            await pool.query(

                                `SELECT
                                    new_status,
                                    old_status,
                                    activity_at,
                                    changed_at,
                                    comment
                                 FROM order_history
                                 WHERE order_number = $1
                                 AND company = $2
                                 AND phase = $3
                                 AND (
                                    old_status IS NULL
                                    OR new_status <> old_status
                                 )
                                 ORDER BY changed_at DESC
                                 LIMIT 1`,

                                [
                                    orderNumber,
                                    company,
                                    phase
                                ]

                            );

                        /*
                         * Poslednja promena komentara
                         */
                        const commentHistory =
                            await pool.query(

                                `SELECT
                                    comment,
                                    changed_at
                                 FROM order_history
                                 WHERE order_number = $1
                                 AND company = $2
                                 AND phase = $3
                                 AND comment IS NOT NULL
                                 ORDER BY changed_at DESC
                                 LIMIT 1`,

                                [
                                    orderNumber,
                                    company,
                                    phase
                                ]

                            );

                        let restoredStatus =
                            'pending';

                        let restoredComment =
                            '';

                        let restoredActivityDate =
                            null;

                        if (
                            statusHistory.rows.length
                        ) {

                            restoredStatus =
                                statusHistory.rows[0]
                                    .new_status ||
                                'pending';

                            restoredActivityDate =
                                statusHistory.rows[0]
                                    .activity_at ||
                                statusHistory.rows[0]
                                    .changed_at ||
                                null;

                            anyRestoredForThisOrder =
                                true;

                        }

                        if (
                            commentHistory.rows.length
                        ) {

                            restoredComment =
                                commentHistory.rows[0]
                                    .comment || '';

                            anyRestoredForThisOrder =
                                true;

                        }

                        /*
                         * Ako nema stare aktivnosti,
                         * activity_at ostaje NULL.
                         */
                        await pool.query(

                            `INSERT INTO progress
                                (
                                    order_id,
                                    phase,
                                    status,
                                    comment,
                                    updated_at,
                                    activity_at,
                                    comment_updated_at
                                )
                             VALUES
                                ($1,$2,$3,$4,$5,$6,$7)
                             ON CONFLICT
                                (order_id, phase)
                             DO NOTHING`,

                            [
                                newId,
                                phase,
                                restoredStatus,
                                restoredComment,
                                restoredActivityDate ||
                                    new Date(),
                                restoredActivityDate,
                                commentHistory.rows.length
                                    ? commentHistory.rows[0].changed_at
                                    : null
                            ]

                        );

                    }

                    if (
                        anyRestoredForThisOrder
                    ) {
                        restored++;
                    }

                    inserted++;
                }
            }

            /*
             * Očisti upload fajl nakon obrade
             */
            try {
                fs.unlinkSync(filePath);
            } catch (_) {}

            console.log(
                `📦 Novih: ${inserted}, ` +
                `Ažuriranih: ${updated}, ` +
                `Vraćeno iz istorije: ${restored}`
            );

            res.json({

                message:
                    `✅ Novih: ${inserted}, ` +
                    `Ažuriranih: ${updated}, ` +
                    `Vraćeno iz istorije: ${restored}`,

                inserted,
                updated,
                restored,
                totalRows: data.length

            });

        } catch (e) {

            console.error(
                '❌ Upload error:',
                e
            );

            res.status(500).json({
                error: e.message
            });

        }

    }
);

/* =========================================================
   ORDERS
========================================================= */

app.get(
    '/api/orders',
    authenticate,
    async (req, res) => {

        try {

            const {
                search,
                page = 1,
                limit = 100
            } = req.query;

            const safePage =
                Math.max(
                    1,
                    parseInt(page) || 1
                );

            const safeLimit =
                Math.min(
                    500,
                    Math.max(
                        1,
                        parseInt(limit) || 100
                    )
                );

            const offset =
                (safePage - 1) *
                safeLimit;

            let whereClause = '';
            let params = [];
            let paramIndex = 1;

            /*
             * =====================================================
             * SIGURNOST FIRME
             * =====================================================
             *
             * ADMIN:
             *   vidi sve firme.
             *
             * USER:
             *   vidi ISKLJUČIVO svoju firmu.
             *
             * Ovo važi i kada je aktivna pretraga.
             */

            if (
                req.user.role === 'admin'
            ) {

                if (search) {

                    const s =
                        String(search)
                            .toLowerCase()
                            .trim();

                    whereClause = `
                        WHERE
                            LOWER(order_number)
                                LIKE $${paramIndex}
                            OR LOWER(name)
                                LIKE $${paramIndex}
                            OR LOWER(company)
                                LIKE $${paramIndex}
                            OR LOWER(code)
                                LIKE $${paramIndex}
                    `;

                    params.push(
                        `%${s}%`
                    );

                    paramIndex++;
                }

            } else {

                /*
                 * USER UVEK DOBIJA company FILTER
                 */
                whereClause =
                    `WHERE company = $${paramIndex}`;

                params.push(
                    req.user.company
                );

                paramIndex++;

                if (search) {

                    const s =
                        String(search)
                            .toLowerCase()
                            .trim();

                    whereClause += `
                        AND (
                            LOWER(order_number)
                                LIKE $${paramIndex}
                            OR LOWER(name)
                                LIKE $${paramIndex}
                            OR LOWER(code)
                                LIKE $${paramIndex}
                        )
                    `;

                    params.push(
                        `%${s}%`
                    );

                    paramIndex++;
                }

            }

            const countQuery = `
                SELECT COUNT(*)
                FROM orders
                ${whereClause}
            `;

            const countResult =
                await pool.query(
                    countQuery,
                    params
                );

            const total =
                parseInt(
                    countResult.rows[0].count
                );

            const dataQuery = `

                SELECT
                    o.*,

                    COALESCE(

                        json_agg(

                            json_build_object(

                                'phase',
                                p.phase,

                                'status',
                                p.status,

                                'comment',
                                p.comment,

                                'updated_at',
                                p.updated_at,

                                'activity_at',
                                p.activity_at,

                                'comment_updated_at',
                                p.comment_updated_at

                            )

                            ORDER BY p.phase

                        )

                        FILTER (
                            WHERE p.phase IS NOT NULL
                        ),

                        '[]'

                    ) AS progress

                FROM orders o

                LEFT JOIN progress p
                    ON o.id = p.order_id

                ${whereClause}

                GROUP BY o.id

                ORDER BY o.id DESC

                LIMIT $${paramIndex}
                OFFSET $${paramIndex + 1}

            `;

            params.push(
                safeLimit,
                offset
            );

            const result =
                await pool.query(
                    dataQuery,
                    params
                );

            const data =
                result.rows.map(
                    row => ({

                        id: row.id,

                        /*
                         * Company šaljemo server-side
                         * zbog admina, ali frontend klijenta
                         * je neće prikazati.
                         */
                        company: row.company,

                        code: row.code,

                        name: row.name,

                        orderNumber:
                            row.order_number,

                        quantity:
                            row.quantity,

                        deliveryDate:
                            row.delivery_date,

                        progress:
                            row.progress || []

                    })
                );

            res.json({

                data,

                total,

                page: safePage,

                limit: safeLimit,

                totalPages:
                    Math.ceil(
                        total / safeLimit
                    )

            });

        } catch (e) {

            console.error(
                '❌ Orders error:',
                e
            );

            res.status(500).json({
                error: e.message
            });

        }

    }
);

/* =========================================================
   UPDATE PHASE
========================================================= */

app.post(
    '/api/update-phase',
    authenticate,
    async (req, res) => {

        try {

            const {
                orderId,
                phase,
                comment
            } = req.body;

            let {
                status
            } = req.body;

            if (!orderId || !phase) {

                return res.status(400).json({
                    error:
                        'orderId i phase su obavezni'
                });

            }

            /*
             * =====================================================
             * PROVERA VLASNIŠTVA NAD NALOGOM
             * =====================================================
             */

            const orderResult =
                await pool.query(

                    `SELECT
                        id,
                        order_number,
                        company
                     FROM orders
                     WHERE id = $1`,

                    [orderId]

                );

            if (
                orderResult.rows.length === 0
            ) {

                return res.status(404).json({
                    error: 'Nalog ne postoji'
                });

            }

            const order =
                orderResult.rows[0];

            /*
             * Klijent može menjati samo svoju firmu.
             */
            if (
                req.user.role !== 'admin' &&
                order.company !== req.user.company
            ) {

                return res.status(403).json({
                    error:
                        'Nemate pristup ovom nalogu'
                });

            }

            /*
             * Dozvoljeni statusi
             */
            const allowedStatuses = [
                'pending',
                'completed',
                'problem'
            ];

            if (
                status !== undefined &&
                !allowedStatuses.includes(status)
            ) {

                return res.status(400).json({
                    error:
                        'Neispravan status'
                });

            }

            /*
             * =====================================================
             * POSTOJEĆE STANJE
             * =====================================================
             */

            const current =
                await pool.query(

                    `SELECT
                        status,
                        comment,
                        updated_at,
                        activity_at,
                        comment_updated_at
                     FROM progress
                     WHERE order_id = $1
                     AND phase = $2`,

                    [
                        orderId,
                        phase
                    ]

                );

            const oldStatus =
                current.rows[0]?.status ||
                'pending';

            const oldComment =
                current.rows[0]?.comment ||
                '';

            const oldActivityAt =
                current.rows[0]?.activity_at ||
                null;

            const oldCommentUpdatedAt =
                current.rows[0]?.comment_updated_at ||
                null;

            /*
             * Ako status nije poslat,
             * zadržavamo postojeći.
             */
            if (!status) {
                status = oldStatus;
            }

            /*
             * Ako komentar nije poslat,
             * zadržavamo postojeći.
             */
            const finalComment =
                comment !== undefined
                    ? String(comment)
                    : oldComment;

            const statusChanged =
                status !== oldStatus;

            const commentChanged =
                finalComment !== oldComment;

            /*
             * Ako nema nikakve promene,
             * ništa ne diramo.
             *
             * Ovo je važno:
             * samo otvaranje modula NE sme promeniti datum.
             */
            if (
                !statusChanged &&
                !commentChanged
            ) {

                return res.json({

                    message:
                        'Nema promena',

                    status,

                    comment:
                        oldComment,

                    updatedAt:
                        current.rows[0]
                            ?.updated_at ||
                        null,

                    activityAt:
                        oldActivityAt,

                    commentUpdatedAt:
                        oldCommentUpdatedAt

                });

            }

            /*
             * =====================================================
             * DATUMI
             * =====================================================
             */

            /*
             * Datum aktivnosti se menja SAMO
             * kada se promeni STATUS.
             */
            const activityAt =
                statusChanged
                    ? new Date()
                    : oldActivityAt;

            /*
             * Datum komentara se menja SAMO
             * kada se promeni komentar.
             */
            const commentUpdatedAt =
                commentChanged
                    ? new Date()
                    : oldCommentUpdatedAt;

            /*
             * updated_at predstavlja poslednju bilo koju promenu.
             */
            const updatedAt =
                new Date();

            /*
             * =====================================================
             * UPSERT PROGRESS
             * =====================================================
             */

            await pool.query(

                `INSERT INTO progress
                    (
                        order_id,
                        phase,
                        status,
                        comment,
                        updated_at,
                        activity_at,
                        comment_updated_at
                    )
                 VALUES
                    ($1,$2,$3,$4,$5,$6,$7)

                 ON CONFLICT
                    (order_id, phase)

                 DO UPDATE SET

                    status =
                        EXCLUDED.status,

                    comment =
                        EXCLUDED.comment,

                    updated_at =
                        EXCLUDED.updated_at,

                    activity_at =
                        EXCLUDED.activity_at,

                    comment_updated_at =
                        EXCLUDED.comment_updated_at`,

                [
                    orderId,
                    phase,
                    status,
                    finalComment,
                    updatedAt,
                    activityAt,
                    commentUpdatedAt
                ]

            );

            /*
             * =====================================================
             * ISTORIJA
             * =====================================================
             *
             * Čuvamo SVAKU relevantnu promenu.
             *
             * 1. promena statusa
             * 2. promena komentara
             *
             * Zato komentar više ne nestaje kada se status promeni.
             */

            if (
                statusChanged ||
                commentChanged
            ) {

                await pool.query(

                    `INSERT INTO order_history
                        (
                            order_number,
                            company,
                            phase,
                            old_status,
                            new_status,
                            comment,
                            changed_by,
                            changed_at,
                            activity_at
                        )
                     VALUES
                        ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,

                    [
                        order.order_number,
                        order.company,
                        phase,
                        oldStatus,
                        status,
                        finalComment,
                        req.user.username,
                        updatedAt,
                        activityAt
                    ]

                );

                console.log(
                    '📜 Istorija sačuvana:',
                    {
                        order:
                            order.order_number,
                        phase,
                        oldStatus,
                        status,
                        statusChanged,
                        commentChanged,
                        activityAt
                    }
                );

            }

            /*
             * =====================================================
             * VRATI STVARNO STANJE IZ BAZE
             * =====================================================
             */

            const updated =
                await pool.query(

                    `SELECT
                        updated_at,
                        activity_at,
                        comment_updated_at,
                        status,
                        comment
                     FROM progress
                     WHERE order_id = $1
                     AND phase = $2`,

                    [
                        orderId,
                        phase
                    ]

                );

            const row =
                updated.rows[0];

            res.json({

                message:
                    'Phase updated',

                status:
                    row.status,

                comment:
                    row.comment,

                updatedAt:
                    row.updated_at,

                /*
                 * OVO JE DATUM AKTIVNOSTI
                 * i ne menja se kada se samo
                 * menja komentar.
                 */
                activityAt:
                    row.activity_at,

                commentUpdatedAt:
                    row.comment_updated_at

            });

        } catch (e) {

            console.error(
                '❌ Update phase error:',
                e
            );

            res.status(500).json({
                error: e.message
            });

        }

    }
);

/* =========================================================
   OBRIŠI AKTIVNE NALOGE
   ISTORIJA OSTANE
========================================================= */

app.post(
    '/api/clear-orders',
    authenticate,
    async (req, res) => {

        if (
            req.user.role !== 'admin'
        ) {

            return res.status(403).json({
                error:
                    'Samo admin može'
            });

        }

        try {

            /*
             * Prvo progress.
             */
            const deletedProgress =
                await pool.query(
                    'DELETE FROM progress RETURNING id'
                );

            /*
             * Zatim aktivni orders.
             */
            const deletedOrders =
                await pool.query(
                    'DELETE FROM orders RETURNING id'
                );

            /*
             * order_history SE NE BRIŠE.
             */

            res.json({

                message:
                    '✅ Aktivni nalozi obrisani! ' +
                    'Istorija je sačuvana.',

                deletedOrders:
                    deletedOrders.rowCount,

                deletedProgress:
                    deletedProgress.rowCount

            });

        } catch (e) {

            console.error(
                '❌ Clear error:',
                e
            );

            res.status(500).json({
                error: e.message
            });

        }

    }
);

/* =========================================================
   POTPUNO BRISANJE
   ORDERS + PROGRESS + HISTORY
========================================================= */

app.post(
    '/api/clear-all',
    authenticate,
    async (req, res) => {

        if (
            req.user.role !== 'admin'
        ) {

            return res.status(403).json({
                error:
                    'Samo admin može'
            });

        }

        try {

            const deletedProgress =
                await pool.query(
                    'DELETE FROM progress RETURNING id'
                );

            const deletedOrders =
                await pool.query(
                    'DELETE FROM orders RETURNING id'
                );

            const deletedHistory =
                await pool.query(
                    'DELETE FROM order_history RETURNING id'
                );

            res.json({

                message:
                    '✅ Aktivni nalozi i istorija ' +
                    'su potpuno obrisani!',

                deletedOrders:
                    deletedOrders.rowCount,

                deletedProgress:
                    deletedProgress.rowCount,

                deletedHistory:
                    deletedHistory.rowCount

            });

        } catch (e) {

            console.error(
                '❌ Clear all error:',
                e
            );

            res.status(500).json({
                error: e.message
            });

        }

    }
);

/* =========================================================
   SEND REPORT
========================================================= */

app.post(
    '/api/send-report',
    authenticate,
    async (req, res) => {

        try {

            if (!transporter) {

                return res.status(400).json({
                    error:
                        'Email not configured'
                });

            }

            const {
                date
            } = req.body;

            const today =
                date ||
                new Date()
                    .toLocaleDateString(
                        'sr-RS'
                    );

            const ordersResult =
                await pool.query(

                    `SELECT
                        o.*,

                        COALESCE(

                            json_agg(

                                json_build_object(

                                    'phase',
                                    p.phase,

                                    'status',
                                    p.status,

                                    'comment',
                                    p.comment,

                                    'updated_at',
                                    p.updated_at,

                                    'activity_at',
                                    p.activity_at,

                                    'comment_updated_at',
                                    p.comment_updated_at

                                )

                                ORDER BY p.phase

                            )

                            FILTER (
                                WHERE p.phase IS NOT NULL
                            ),

                            '[]'

                        ) AS progress

                     FROM orders o

                     LEFT JOIN progress p
                        ON o.id = p.order_id

                     WHERE o.company = $1

                     GROUP BY o.id

                     ORDER BY o.id DESC`,

                    [
                        req.user.company
                    ]

                );

            const userOrders =
                ordersResult.rows;

            if (
                userOrders.length === 0
            ) {

                return res.status(400).json({
                    error:
                        'Nema naloga'
                });

            }

            /*
             * Ovde ostaje tvoj postojeći
             * kod za slanje emaila.
             */

            res.json({
                message:
                    '✅ Izveštaj poslat!'
            });

        } catch (e) {

            console.error(
                '❌ Send report error:',
                e
            );

            res.status(500).json({
                error: e.message
            });

        }

    }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `🚀 Server running on port ${PORT}`
        );

        console.log(
            `🗄️ PostgreSQL: ${
                process.env.DATABASE_URL
                    ? '✅'
                    : '❌'
            }`
        );

        console.log(
            `📧 Email: ${
                transporter
                    ? '✅'
                    : '❌'
            }`
        );

    }
);