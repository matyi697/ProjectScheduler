const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// =========================================================================
// 1. ADATBÁZIS KAPCSOLATOK
// =========================================================================

// A) Kapcsolat a felhasználók adatbázisához (Bejelentkezéshez)
const poolUsers = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'user_management',
    password: 'admin', // Írd át, ha más a jelszavad!
    port: 5432,
});

// B) Kapcsolat a munkák adatbázisához (A csomagokhoz és feladatokhoz)
const poolUtemterv = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'utemterv_beta',
    password: 'admin', // Írd át, ha más a jelszavad!
    port: 5432,
});


// =========================================================================
// 2. SZERVER BEÁLLÍTÁSOK
// =========================================================================

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true })); 
app.use(express.json()); // <--- EZ HIÁNYZIK! Ez tanítja meg a szervert JSON-t olvasni.
app.use(express.static('public'));

app.use(session({
    secret: 'labor_titkos_kulcs_2026_nagyon_biztonsagos',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 óra
}));


// =========================================================================
// 3. BEJELENTKEZÉS ÉS KIJELENTKEZÉS
// =========================================================================

app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    res.render('login', { error: null }); 
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex').toUpperCase();

    try {
        const result = await poolUsers.query(
            'SELECT id, username FROM users WHERE username = $1 AND password = $2',
            [username, hashedPassword]
        );

        if (result.rows.length > 0) {
            req.session.userId = result.rows[0].id;
            req.session.username = result.rows[0].username;
            res.redirect('/dashboard');
        } else {
            res.render('login', { error: 'Hibás felhasználónév vagy jelszó!' });
        }
    } catch (err) {
        console.error("Belépési hiba:", err);
        res.render('login', { error: 'Adatbázis hiba történt.' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});


// =========================================================================
// 4. VÉDETT OLDALAK (CSAK BEJELENTKEZVE)
// =========================================================================

// ---> A) DASHBOARD (Műszerfal) <---
app.get('/dashboard', async (req, res) => {
    if (!req.session.userId) return res.redirect('/'); 

    try {
        // 1. Lekérdezzük a MUNKÁKAT (Sub-jobs - ez a részletes nézet)
        const jobsResult = await poolUtemterv.query(`
            SELECT 
                s.id AS munka_id,
                m.id AS csomag_id,
                m.job_year || '/' || m.job_number || '/' || s.sub_number AS azonosito, 
                m.company_name, 
                TO_CHAR(s.arrival_date, 'YYYY-MM-DD') AS datum, 
                s.is_cleaned, s.is_serviced, s.is_calibrated, s.is_sent, s.is_maintained
            FROM sub_job s
            JOIN main_job m ON s.main_job_id = m.id
            ORDER BY m.job_year DESC, m.job_number DESC, s.sub_number ASC
        `);

        // 2. Lekérdezzük a CSOMAGOKAT (Main-jobs - ez a logisztikai nézet)
        const packagesResult = await poolUtemterv.query(`
            SELECT 
                id, 
                job_year || '/' || job_number AS azonosito,
                company_name,
                TO_CHAR(arrival_date, 'YYYY-MM-DD') AS datum,
                TO_CHAR(due_date, 'YYYY-MM-DD') AS hatarido,
                is_closed,
                (SELECT COUNT(*) FROM sub_job WHERE main_job_id = main_job.id) AS al_munkak_szama
            FROM main_job
            ORDER BY id DESC
        `);

        res.render('dashboard', { 
            username: req.session.username, 
            jobs: jobsResult.rows,
            packages: packagesResult.rows 
        });
    } catch (err) {
        console.error("Dashboard hiba:", err); 
        res.send("Hiba a betöltéskor.");
    }
});

// ---> B) ÚJ MUNKA (Űrlap megjelenítése) <---
app.get('/uj-munka', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.render('uj_munka', { username: req.session.username });
});

// ---> C) ÚJ MUNKA (Mentés az adatbázisba) <---
app.post('/uj-munka', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    let { 
        custom_job_id, company_name, contact_name, courier_info, arrival_date, due_date, notes, item_count,
        billing_country, billing_zip, billing_city, billing_street,
        shipping_country, shipping_zip, shipping_city, shipping_street
    } = req.body;

    arrival_date = arrival_date ? arrival_date : null;
    due_date = due_date ? due_date : null;

    let job_year = null, job_number = null;
    if (custom_job_id && custom_job_id.trim() !== '') {
        const parts = custom_job_id.split('/');
        if (parts.length === 2) {
            job_year = parseInt(parts[0]);
            job_number = parseInt(parts[1]);
        }
    }

    try {
        await poolUtemterv.query(
            `INSERT INTO main_job 
            (job_year, job_number, company_name, contact_name, courier_info, arrival_date, due_date, notes, item_count,
             billing_country, billing_zip, billing_city, billing_street,
             shipping_country, shipping_zip, shipping_city, shipping_street) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [job_year, job_number, company_name, contact_name, courier_info, arrival_date, due_date, notes, item_count,
             billing_country, billing_zip, billing_city, billing_street,
             shipping_country, shipping_zip, shipping_city, shipping_street]
        );
        res.redirect('/dashboard?success=1');
    } catch (err) {
        console.error("Új munka mentési hiba:", err); res.send("Adatbázis hiba!");
    }
});

// ---> D) RÉSZLETEK (Csomag adatlapja) <---
app.get('/reszletek/:csomag_id', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    
    try {
        const result = await poolUtemterv.query(`
            SELECT *, job_year || '/' || job_number AS azonosito,
            TO_CHAR(arrival_date, 'YYYY. MM. DD.') AS erkezes,
            TO_CHAR(due_date, 'YYYY. MM. DD.') AS hatarido
            FROM main_job WHERE id = $1
        `, [req.params.csomag_id]);

        if (result.rows.length === 0) return res.send("Csomag nem található.");
        res.render('reszletek', { username: req.session.username, csomag: result.rows[0] });
    } catch (err) {
        console.error("Részletek hiba:", err); res.send("Hiba a betöltéskor.");
    }
});

// ---> E) STÁTUSZ / PIPÁLÁS (Megjelenítés) <---
app.get('/statusz/:id', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const munkaId = req.params.id;

    try {
        const result = await poolUtemterv.query(`
            SELECT 
                s.id AS munka_id,
                m.job_year || '/' || m.job_number || '/' || s.sub_number AS azonosito,
                m.company_name,
                s.is_cleaned, s.is_serviced, s.is_calibrated, s.is_sent
            FROM sub_job s
            JOIN main_job m ON s.main_job_id = m.id
            WHERE s.id = $1
        `, [munkaId]);

        if (result.rows.length === 0) return res.send("Ez a munka nem található.");
        res.render('statusz', { username: req.session.username, munka: result.rows[0] });
    } catch (err) {
        console.error("Státusz betöltési hiba:", err); res.send("Hiba a betöltéskor.");
    }
});

// ---> F) STÁTUSZ / PIPÁLÁS (Mentés az adatbázisba) <---
app.post('/statusz/:id', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const munkaId = req.params.id;
    
    // HTML Checkboxok értékének átalakítása true/false-ra (Ha be van kapcsolva, az értéke 'on')
    const isCleaned = req.body.is_cleaned === 'on';
    const isServiced = req.body.is_serviced === 'on';
    const isCalibrated = req.body.is_calibrated === 'on';
    const isSent = req.body.is_sent === 'on';

    try {
        await poolUtemterv.query(`
            UPDATE sub_job 
            SET is_cleaned = $1, is_serviced = $2, is_calibrated = $3, is_sent = $4
            WHERE id = $5
        `, [isCleaned, isServiced, isCalibrated, isSent, munkaId]);

        res.redirect('/dashboard');
    } catch (err) {
        console.error("Státusz mentési hiba:", err); res.send("Hiba a mentéskor.");
    }
});

// ==========================================
// PARCELLÁZÁS / MUNKA KIOSZTÁS OLDAL
// ==========================================
app.get('/parcellazas', async (req, res) => {
    if (!req.session.userId) return res.redirect('/'); 

    try {
        // 1. Csomagok lekérése
        const resultCsomagok = await poolUtemterv.query(`
                SELECT id, job_year, job_number, company_name, 
                   TO_CHAR(arrival_date, 'YYYY-MM-DD') as formatted_arrival, 
                   TO_CHAR(due_date, 'YYYY-MM-DD') as formatted_due,
                   shipping_country, shipping_zip, shipping_city, shipping_street,
                   billing_country, billing_zip, billing_city, billing_street
            FROM main_job 
            WHERE is_closed = FALSE 
            ORDER BY id DESC
        `);
        
        // 2. Egyedi Gyártók lekérése az autocomplete-hez
        const resultGyartok = await poolUtemterv.query(`
            SELECT DISTINCT gyarto FROM pipetta_torzs WHERE gyarto IS NOT NULL ORDER BY gyarto
        `);
        
        // 3. Egyedi Típusok lekérése az autocomplete-hez
        const resultTipusok = await poolUtemterv.query(`
            SELECT DISTINCT tipus FROM pipetta_torzs WHERE tipus IS NOT NULL ORDER BY tipus
        `);

        // Adatok átadása az EJS oldalnak
        res.render('parcellazas', { 
            csomagok: resultCsomagok.rows,
            gyartok: resultGyartok.rows.map(r => r.gyarto),
            tipusok: resultTipusok.rows.map(r => r.tipus),
            username: req.session.username
        });

    } catch (error) {
        console.error("Hiba a parcellázás oldal betöltésekor:", error);
        res.status(500).send("Belső szerverhiba történt.");
    }
});
// Pipetta keresése matrica szám alapján (Autocomplete-hez)
app.get('/api/pipetta/:matrica', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Nincs bejelentkezve' });
    
    try {
        const result = await poolUtemterv.query(
            'SELECT * FROM pipetta_torzs WHERE matrica_szam = $1', 
            [req.params.matrica]
        );
        
        if (result.rows.length > 0) {
            res.json({ letezik: true, adat: result.rows[0] });
        } else {
            res.json({ letezik: false });
        }
    } catch (err) {
        res.status(500).json({ error: 'DB hiba' });
    }
});

app.post('/api/munka-mentes', async (req, res) => {
    const { munkaAdatok, pipettak } = req.body;
    const client = await poolUtemterv.connect();

    try {
        await client.query('BEGIN'); // Tranzakció indítása (vagy minden sikerül, vagy semmi)

        // 1. Megkeressük a legmagasabb sub_number-t a csomaghoz
        const subNumRes = await client.query(
            'SELECT COALESCE(MAX(sub_number), 0) + 1 as next_num FROM sub_job WHERE main_job_id = $1',
            [munkaAdatok.csomag_id]
        );
        const nextSubNum = subNumRes.rows[0].next_num;

        // 2. sub_job létrehozása
        const subJobRes = await client.query(
            `INSERT INTO sub_job (main_job_id, sub_number, arajanlat, meres, arrival_date, due_date, notes) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [munkaAdatok.csomag_id, nextSubNum, munkaAdatok.arajanlat, munkaAdatok.meres, munkaAdatok.arrival_date, munkaAdatok.due_date, munkaAdatok.notes]
        );
        const subJobId = subJobRes.rows[0].id;

        // 3. Pipetták mentése ciklusban
        for (let p of pipettak) {
            // Előbb a törzsbe (ha még nincs benne)
            await client.query(
                `INSERT INTO pipetta_torzs (matrica_szam, gyarto, tipus, fajta, terfogat)
                 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (matrica_szam) DO NOTHING`,
                [p.matrica, p.gyarto, p.tipus, p.fajta, p.terfogat]
            );

            // Aztán a mérések
            await client.query(
                `INSERT INTO pipetta_munka (sub_job_id, matrica_szam, kalibracios_pontok, ul_ertekek, inaccuracy_ertekek, imprecision_ertekek)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [subJobId, p.matrica, p.pontok, JSON.stringify(p.meresek.ul), JSON.stringify(p.meresek.inacc), JSON.stringify(p.meresek.imprec)]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

// Csomag lezárása (is_closed = TRUE)
app.post('/api/csomag-lezarasa/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false });

    try {
        await poolUtemterv.query(
            'UPDATE main_job SET is_closed = TRUE WHERE id = $1',
            [req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// ==========================================
// VÉGLEGES MUNKA ÉS PIPETTA MENTÉS (POST)
// ==========================================
app.post('/api/munka-mentes', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false, error: 'Nincs bejelentkezve' });

    const { munkaAdatok, pipettak } = req.body;
    const client = await poolUtemterv.connect(); // Külön klienst kérünk a tranzakcióhoz

    try {
        await client.query('BEGIN'); // Tranzakció indítása

        // 1. Kiszámoljuk a következő Al-munka számot (sub_number) az adott csomaghoz
        const subNumRes = await client.query(
            'SELECT COALESCE(MAX(sub_number), 0) + 1 as next_num FROM sub_job WHERE main_job_id = $1',
            [munkaAdatok.csomag_id]
        );
        const nextSubNum = subNumRes.rows[0].next_num;

        // 2. sub_job (Al-munka) létrehozása
        const subJobRes = await client.query(
            `INSERT INTO sub_job (main_job_id, sub_number, arajanlat, meres, arrival_date, due_date, notes) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
                munkaAdatok.csomag_id, 
                nextSubNum, 
                munkaAdatok.arajanlat, 
                munkaAdatok.meres, 
                munkaAdatok.arrival_date || null, 
                munkaAdatok.due_date || null, 
                munkaAdatok.notes
            ]
        );
        const subJobId = subJobRes.rows[0].id;

        // 3. Pipetták mentése (Ciklusban)
        for (let p of pipettak) {
            // A) Pipetta törzsadat mentése (Csak ha még nincs ilyen matrica szám)
            await client.query(
                `INSERT INTO pipetta_torzs (matrica_szam, gyarto, tipus, fajta, terfogat)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (matrica_szam) DO UPDATE SET 
                    gyarto = EXCLUDED.gyarto, 
                    tipus = EXCLUDED.tipus, 
                    fajta = EXCLUDED.fajta, 
                    terfogat = EXCLUDED.terfogat`,
                [p.matrica, p.gyarto, p.tipus, p.fajta, p.terfogat]
            );

            // B) Pipetta mérési adatok mentése az adott Al-munkához
            await client.query(
                `INSERT INTO pipetta_munka (sub_job_id, matrica_szam, kalibracios_pontok, ul_ertekek, inaccuracy_ertekek, imprecision_ertekek)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    subJobId, 
                    p.matrica, 
                    p.pontok, 
                    JSON.stringify(p.meresek.ul), 
                    JSON.stringify(p.meresek.inacc), 
                    JSON.stringify(p.meresek.imprec)
                ]
            );
        }

        await client.query('COMMIT'); // Ha minden sikerült, véglegesítjük
        res.json({ success: true });

    } catch (err) {
        await client.query('ROLLBACK'); // Hiba esetén mindent visszavonunk
        console.error("Mentési hiba a szerveren:", err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release(); // Kapcsolat visszaadása a poolnak
    }
});

app.get('/api/pipetta/:matrica', async (req, res) => {
    try {
        const result = await poolUtemterv.query(
            'SELECT * FROM pipetta_torzs WHERE matrica_szam = $1', 
            [req.params.matrica]
        );
        if (result.rows.length > 0) {
            res.json({ letezik: true, adat: result.rows[0] });
        } else {
            res.json({ letezik: false });
        }
    } catch (err) {
        res.status(500).json({ error: 'Adatbázis hiba' });
    }
});

// =========================================================================
// 5. SZERVER INDÍTÁSA
// =========================================================================
app.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(`🚀 A labor szerver sikeresen elindult!`);
    console.log(`🌐 Elérhető itt: http://localhost:${PORT}`);
    console.log(`=========================================\n`);
});