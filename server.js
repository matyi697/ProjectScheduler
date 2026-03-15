const express = require("express");
const { Pool } = require("pg");
const session = require("express-session");
const crypto = require("crypto");

const app = express();
const PORT = 3000;

// =========================================================================
// 1. ADATBÁZIS KAPCSOLATOK
// =========================================================================

const poolUsers = new Pool({
  user: "postgres",
  host: "localhost",
  database: "user_management",
  password: "admin",
  port: 5432,
});

const poolUtemterv = new Pool({
  user: "postgres",
  host: "localhost",
  database: "utemterv_beta",
  password: "admin",
  port: 5432,
});

// =========================================================================
// 2. SZERVER BEÁLLÍTÁSOK
// =========================================================================

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

app.use(
  session({
    secret: "labor_titkos_kulcs_2026_nagyon_biztonsagos",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 }, 
  }),
);

// =========================================================================
// 3. BEJELENTKEZÉS ÉS KIJELENTKEZÉS
// =========================================================================

app.get("/", (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = crypto.createHash("sha256").update(password).digest("hex").toUpperCase();

  try {
    const result = await poolUsers.query(
      "SELECT id, username FROM users WHERE username = $1 AND password = $2",
      [username, hashedPassword]
    );

    if (result.rows.length > 0) {
      req.session.userId = result.rows[0].id;
      req.session.username = result.rows[0].username;
      res.redirect("/dashboard");
    } else {
      res.render("login", { error: "Hibás felhasználónév vagy jelszó!" });
    }
  } catch (err) {
    console.error("Belépési hiba:", err);
    res.render("login", { error: "Adatbázis hiba történt." });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});


// =========================================================================
// 4. DASHBOARD ÉS MUNKÁK (VÉDETT OLDALAK)
// =========================================================================

app.get("/dashboard", async (req, res) => {
  if (!req.session.userId) return res.redirect("/");

  try {
    const jobsResult = await poolUtemterv.query(`
            SELECT 
                s.id AS munka_id,
                m.id AS csomag_id,
                m.job_year || '/' || m.job_number || '/' || s.sub_number AS azonosito, 
                m.company_name, 
                TO_CHAR(s.arrival_date, 'YYYY-MM-DD') AS datum,
                s.is_sent, -- ÚJ: Archiválva státusz lekérése
                (SELECT COUNT(*) FROM pipetta_munka WHERE sub_job_id = s.id) AS osszes_pipetta,
                (SELECT COUNT(*) FROM pipetta_munka 
                 WHERE sub_job_id = s.id 
                 AND is_cleaned = TRUE 
                 AND is_maintained = TRUE 
                 AND is_serviced = TRUE 
                 AND is_calibrated = TRUE) AS kesz_pipetta -- Kivettük az is_sent-et innen!
            FROM sub_job s
            JOIN main_job m ON s.main_job_id = m.id
            ORDER BY m.job_year DESC, m.job_number DESC, s.sub_number ASC
        `);

    const packagesResult = await poolUtemterv.query(`
            SELECT 
                id, job_year || '/' || job_number AS azonosito, company_name,
                TO_CHAR(arrival_date, 'YYYY-MM-DD') AS datum,
                TO_CHAR(due_date, 'YYYY-MM-DD') AS hatarido,
                is_closed,
                (SELECT COUNT(*) FROM sub_job WHERE main_job_id = main_job.id) AS al_munkak_szama,
                -- ÚJ: Kiszámoljuk hány munka van archiválva a csomagon belül
                (SELECT COUNT(*) FROM sub_job WHERE main_job_id = main_job.id AND is_sent = TRUE) AS kesz_munkak_szama
            FROM main_job
            ORDER BY id DESC
        `);

    res.render("dashboard", {
      username: req.session.username,
      jobs: jobsResult.rows,
      packages: packagesResult.rows,
    });
  } catch (err) {
    console.error("Dashboard hiba:", err);
    res.send("Hiba a betöltéskor.");
  }
});

app.get("/uj-munka", (req, res) => {
  if (!req.session.userId) return res.redirect("/");
  res.render("uj_munka", { username: req.session.username });
});

app.post("/uj-munka", async (req, res) => {
  if (!req.session.userId) return res.redirect("/");
  let { custom_job_id, company_name, contact_name, courier_info, arrival_date, due_date, notes, item_count, billing_country, billing_zip, billing_city, billing_street, shipping_country, shipping_zip, shipping_city, shipping_street } = req.body;

  arrival_date = arrival_date ? arrival_date : null;
  due_date = due_date ? due_date : null;
  let job_year = null, job_number = null;
  
  if (custom_job_id && custom_job_id.trim() !== "") {
    const parts = custom_job_id.split("/");
    if (parts.length === 2) { job_year = parseInt(parts[0]); job_number = parseInt(parts[1]); }
  }

  try {
    await poolUtemterv.query(
      `INSERT INTO main_job 
            (job_year, job_number, company_name, contact_name, courier_info, arrival_date, due_date, notes, item_count,
             billing_country, billing_zip, billing_city, billing_street, shipping_country, shipping_zip, shipping_city, shipping_street) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [job_year, job_number, company_name, contact_name, courier_info, arrival_date, due_date, notes, item_count, billing_country, billing_zip, billing_city, billing_street, shipping_country, shipping_zip, shipping_city, shipping_street]
    );
    res.redirect("/dashboard?success=1");
  } catch (err) {
    console.error(err); res.send("Adatbázis hiba!");
  }
});

// =========================================================================
// 5. PARCELLÁZÁS ÉS PIPETTA MENTÉS
// =========================================================================

app.get("/parcellazas", async (req, res) => {
  if (!req.session.userId) return res.redirect("/");
  try {
    const resultCsomagok = await poolUtemterv.query(`
            SELECT id, job_year, job_number, company_name, notes, -- ÚJ: notes lekérése
                   TO_CHAR(arrival_date, 'YYYY-MM-DD') as formatted_arrival, 
                   TO_CHAR(due_date, 'YYYY-MM-DD') as formatted_due,
                   shipping_country, shipping_zip, shipping_city, shipping_street,
                   billing_country, billing_zip, billing_city, billing_street
            FROM main_job WHERE is_closed = FALSE ORDER BY id DESC
        `);

    const resultGyartok = await poolUtemterv.query(`SELECT DISTINCT gyarto FROM pipetta_torzs WHERE gyarto IS NOT NULL ORDER BY gyarto`);
    const resultTipusok = await poolUtemterv.query(`SELECT DISTINCT tipus FROM pipetta_torzs WHERE tipus IS NOT NULL ORDER BY tipus`);

    res.render("parcellazas", {
      csomagok: resultCsomagok.rows,
      gyartok: resultGyartok.rows.map(r => r.gyarto),
      tipusok: resultTipusok.rows.map(r => r.tipus),
      username: req.session.username,
    });
  } catch (err) {
    console.error(err); res.status(500).send("Szerverhiba.");
  }
});

app.get("/api/pipetta/:matrica", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "Nincs bejelentkezve" });
  try {
    const result = await poolUtemterv.query("SELECT * FROM pipetta_torzs WHERE matrica_szam = $1", [req.params.matrica]);
    if (result.rows.length > 0) res.json({ letezik: true, adat: result.rows[0] });
    else res.json({ letezik: false });
  } catch (err) { res.status(500).json({ error: "DB hiba" }); }
});

app.post("/api/munka-mentes", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false });
  const { munkaAdatok, pipettak } = req.body;
  const client = await poolUtemterv.connect();

  try {
    await client.query("BEGIN"); 
    
    const subNumRes = await client.query("SELECT COALESCE(MAX(sub_number), 0) + 1 as next_num FROM sub_job WHERE main_job_id = $1", [munkaAdatok.csomag_id]);
    const nextSubNum = subNumRes.rows[0].next_num;

    const subJobRes = await client.query(
      `INSERT INTO sub_job (main_job_id, sub_number, arajanlat, meres, arrival_date, due_date, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [munkaAdatok.csomag_id, nextSubNum, munkaAdatok.arajanlat, munkaAdatok.meres, munkaAdatok.arrival_date || null, munkaAdatok.due_date || null, munkaAdatok.notes]
    );
    const subJobId = subJobRes.rows[0].id;

    for (let p of pipettak) {
      // ÚJ: gyari_szam beszúrása és frissítése
      await client.query(
        `INSERT INTO pipetta_torzs (matrica_szam, gyarto, tipus, fajta, terfogat, gyari_szam)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (matrica_szam) DO UPDATE SET 
            gyarto = EXCLUDED.gyarto, tipus = EXCLUDED.tipus, fajta = EXCLUDED.fajta, 
            terfogat = EXCLUDED.terfogat, gyari_szam = EXCLUDED.gyari_szam`,
        [p.matrica, p.gyarto, p.tipus, p.fajta, p.terfogat, p.gyari_szam]
      );

      await client.query(
        `INSERT INTO pipetta_munka (sub_job_id, matrica_szam, kalibracios_pontok, ul_ertekek, inaccuracy_ertekek, imprecision_ertekek)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [subJobId, p.matrica, p.pontok, JSON.stringify(p.meresek.ul), JSON.stringify(p.meresek.inacc), JSON.stringify(p.meresek.imprec)]
      );
    }
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Mentési hiba:", err); res.status(500).json({ success: false });
  } finally {
    client.release();
  }
});


// =========================================================================
// 6. RÉSZLETEK ÉS STÁTUSZ KEZELÉS
// =========================================================================

app.get("/reszletek/:csomag_id", async (req, res) => {
  if (!req.session.userId) return res.redirect("/");
  try {
    const csomagRes = await poolUtemterv.query(`
            SELECT *, job_year || '/' || job_number AS azonosito, TO_CHAR(arrival_date, 'YYYY-MM-DD') AS erkezes, TO_CHAR(due_date, 'YYYY-MM-DD') AS hatarido
            FROM main_job WHERE id = $1
        `, [req.params.csomag_id]);

    if (csomagRes.rows.length === 0) return res.send("Csomag nem található.");

    const munkakRes = await poolUtemterv.query(`
            SELECT *, sub_number, arajanlat, meres, is_sent 
            FROM sub_job WHERE main_job_id = $1 ORDER BY sub_number ASC
        `, [req.params.csomag_id]);

    res.render("reszletek", { username: req.session.username, csomag: csomagRes.rows[0], munkak: munkakRes.rows });
  } catch (err) { console.error(err); res.send("Hiba."); }
});

app.get("/statusz/:munka_id", async (req, res) => {
  if (!req.session.userId) return res.redirect("/");
  try {
    // 1. Munka adatok lekérése - HOZZÁADTUK az s.notes-t!
    const munkaRes = await poolUtemterv.query(`
            SELECT 
                s.id AS munka_id, 
                s.is_sent, 
                s.notes, -- Ez a fő megjegyzés a sub_job táblából
                m.company_name, 
                m.job_year || '/' || m.job_number || '/' || s.sub_number AS azonosito
            FROM sub_job s 
            JOIN main_job m ON s.main_job_id = m.id 
            WHERE s.id = $1
        `, [req.params.munka_id]);

    // 2. Pipetták lekérése - a pm.* miatt a 'megjegzes' oszlop is benne van
    const pipettakRes = await poolUtemterv.query(`
            SELECT pm.*, pt.gyarto, pt.tipus, pt.terfogat, pt.gyari_szam
            FROM pipetta_munka pm 
            JOIN pipetta_torzs pt ON pm.matrica_szam = pt.matrica_szam
            WHERE pm.sub_job_id = $1 
            ORDER BY pm.id ASC
        `, [req.params.munka_id]);

    if (munkaRes.rows.length === 0) return res.send("A munka nem található.");

    res.render("statusz", { 
      username: req.session.username, 
      munka: munkaRes.rows[0], 
      pipettak: pipettakRes.rows 
    });
  } catch (err) { 
    console.error("Statusz betöltési hiba:", err); 
    res.status(500).send("Hiba történt az adatok lekérésekor."); 
  }
});

app.post("/api/statusz-mentes", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false, error: "Nincs bejelentkezve" });

    const { munkaId, munkaMegjegyzes, statuszAdatok } = req.body;
    const client = await poolUtemterv.connect();

    try {
        await client.query('BEGIN');

        // 1. A fő munka (sub_job) megjegyzésének frissítése
        // Itt a sub_job táblában a mező neve 'notes'
        await client.query(`
            UPDATE sub_job 
            SET notes = $1 
            WHERE id = $2
        `, [munkaMegjegyzes, munkaId]);

        // 2. A pipetták státuszának és egyedi megjegyzésének frissítése
        // Figyelem: A tábládban a mező neve 'megjegzes'!
        for (const adat of statuszAdatok) {
            await client.query(`
                UPDATE pipetta_munka 
                SET is_cleaned = $1, 
                    is_maintained = $2, 
                    is_serviced = $3, 
                    is_calibrated = $4, 
                    megjegzes = $5
                WHERE id = $6
            `, [
                adat.cleaned, 
                adat.maintained, 
                adat.serviced, 
                adat.calibrated, 
                adat.notes, // A frontendről érkező adat
                adat.id     // A sor azonosítója
            ]);
        }

        await client.query('COMMIT');
        res.json({ success: true });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Hiba a státusz mentésekor:", err);
        res.status(500).json({ success: false, error: "Adatbázis hiba történt." });
    } finally {
        client.release();
    }
});

// =========================================================================
// 7. TÖRLÉSI ÉS ARCHIVÁLÁSI MŰVELETEK (ÚJ VÉGPONTOK)
// =========================================================================

app.post("/api/csomag-lezarasa/:id", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false });
  try { await poolUtemterv.query("UPDATE main_job SET is_closed = TRUE WHERE id = $1", [req.params.id]); res.json({ success: true }); } 
  catch (err) { res.status(500).json({ success: false }); }
});

app.post("/api/csomag-feloldasa/:id", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false });
  try { await poolUtemterv.query("UPDATE main_job SET is_closed = FALSE WHERE id = $1", [req.params.id]); res.json({ success: true }); } 
  catch (err) { res.status(500).json({ success: false }); }
});

// ÚJ: Munka Archiválása / Kiküldése (Ezzel lesz 'Kész' a munka)
app.post("/api/munka-kikuldese/:id", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false });
  try {
    // Az is_sent most már a sub_job táblában van!
    await poolUtemterv.query("UPDATE sub_job SET is_sent = TRUE WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// ÚJ: Csomag törlése (Az ON DELETE CASCADE miatt viszi a munkákat és pipettákat is!)
app.delete("/api/csomag-torlese/:id", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false });
  try {
    await poolUtemterv.query("DELETE FROM main_job WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// ÚJ: Munka törlése (Egyetlen parcellát töröl)
app.delete("/api/munka-torlese/:id", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false });
  try {
    await poolUtemterv.query("DELETE FROM sub_job WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// =========================================================================
// MUNKA (PARCELLA) SZERKESZTÉSE ÉS PIPETTÁK UTÓLAGOS KEZELÉSE
// =========================================================================

// 1. Szerkesztő űrlap betöltése
app.get("/munka-szerkesztes/:id", async (req, res) => {
    if (!req.session.userId) return res.redirect("/");
    
    try {
        // Munka adatok
        const result = await poolUtemterv.query(`
            SELECT s.*, m.company_name, m.job_year || '/' || m.job_number || '/' || s.sub_number AS azonosito,
                   TO_CHAR(s.arrival_date, 'YYYY-MM-DD') AS arrival_fmt,
                   TO_CHAR(s.due_date, 'YYYY-MM-DD') AS due_fmt
            FROM sub_job s
            JOIN main_job m ON s.main_job_id = m.id
            WHERE s.id = $1
        `, [req.params.id]);

        if (result.rows.length === 0) return res.send("A munka nem található.");

        // Jelenleg a munkához tartozó pipetták
        const pipettakRes = await poolUtemterv.query(`
            SELECT pm.*, pt.gyarto, pt.tipus, pt.terfogat, pt.gyari_szam
            FROM pipetta_munka pm
            JOIN pipetta_torzs pt ON pm.matrica_szam = pt.matrica_szam
            WHERE pm.sub_job_id = $1
            ORDER BY pm.id ASC
        `, [req.params.id]);
        
        res.render("munka_szerkesztes", { 
            username: req.session.username, 
            munka: result.rows[0],
            pipettak: pipettakRes.rows
        });
    } catch (err) {
        console.error("Hiba a szerkesztő betöltésekor:", err);
        res.status(500).send("Szerverhiba.");
    }
});

// 2. Munka alapadatait módosító végpont
app.post("/munka-szerkesztes/:id", async (req, res) => {
    if (!req.session.userId) return res.redirect("/");
    const { arajanlat, meres, arrival_date, due_date, notes } = req.body;
    try {
        await poolUtemterv.query(`
            UPDATE sub_job SET arajanlat = $1, meres = $2, arrival_date = $3, due_date = $4, notes = $5 WHERE id = $6
        `, [arajanlat, meres, arrival_date || null, due_date || null, notes, req.params.id]);
        res.redirect("/dashboard?success=1");
    } catch (err) { console.error(err); res.status(500).send("Hiba a mentés során."); }
});

// 3. ÚJ: Egy pipetta törlése a munkából
app.delete("/api/pipetta-torlese/:pipetta_munka_id", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false });
    try {
        await poolUtemterv.query("DELETE FROM pipetta_munka WHERE id = $1", [req.params.pipetta_munka_id]);
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// 4. ÚJ: Új pipetta hozzáadása egy már létező munkához
app.post("/api/pipetta-hozzaadasa/:munka_id", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const { matrica, gyarto, tipus, fajta, terfogat, gyari_szam, pontok, meresek } = req.body;
    const client = await poolUtemterv.connect();
    
    try {
        await client.query("BEGIN");
        
        // Törzsadat mentése / frissítése
        await client.query(
            `INSERT INTO pipetta_torzs (matrica_szam, gyarto, tipus, fajta, terfogat, gyari_szam)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (matrica_szam) DO UPDATE SET 
                gyarto = EXCLUDED.gyarto, tipus = EXCLUDED.tipus, fajta = EXCLUDED.fajta, 
                terfogat = EXCLUDED.terfogat, gyari_szam = EXCLUDED.gyari_szam`,
            [matrica, gyarto, tipus, fajta, terfogat, gyari_szam]
        );

        // Hozzárendelés a munkához
        await client.query(
            `INSERT INTO pipetta_munka (sub_job_id, matrica_szam, kalibracios_pontok, ul_ertekek, inaccuracy_ertekek, imprecision_ertekek)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [req.params.munka_id, matrica, pontok, JSON.stringify(meresek.ul), JSON.stringify(meresek.inacc), JSON.stringify(meresek.imprec)]
        );

        await client.query("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error(err); res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

// =========================================================================
// FŐ CSOMAG SZERKESZTÉSE
// =========================================================================

// 1. Szerkesztő űrlap betöltése
app.get("/csomag-szerkesztes/:id", async (req, res) => {
    if (!req.session.userId) return res.redirect("/");
    
    try {
        const result = await poolUtemterv.query(`
            SELECT *, job_year || '/' || job_number AS azonosito,
                   TO_CHAR(arrival_date, 'YYYY-MM-DD') AS arrival_fmt,
                   TO_CHAR(due_date, 'YYYY-MM-DD') AS due_fmt
            FROM main_job
            WHERE id = $1
        `, [req.params.id]);

        if (result.rows.length === 0) return res.send("A csomag nem található.");
        
        res.render("csomag_szerkesztes", { 
            username: req.session.username, 
            csomag: result.rows[0] 
        });
    } catch (err) {
        console.error("Hiba a csomag szerkesztő betöltésekor:", err);
        res.status(500).send("Szerverhiba.");
    }
});

// 2. Módosított csomag adatok mentése
app.post("/csomag-szerkesztes/:id", async (req, res) => {
    if (!req.session.userId) return res.redirect("/");
    
    const { 
        company_name, contact_name, courier_info, arrival_date, due_date, notes,
        billing_country, billing_zip, billing_city, billing_street,
        shipping_country, shipping_zip, shipping_city, shipping_street
    } = req.body;
    
    try {
        await poolUtemterv.query(`
            UPDATE main_job SET 
                company_name = $1, contact_name = $2, courier_info = $3, 
                arrival_date = $4, due_date = $5, notes = $6,
                billing_country = $7, billing_zip = $8, billing_city = $9, billing_street = $10,
                shipping_country = $11, shipping_zip = $12, shipping_city = $13, shipping_street = $14
            WHERE id = $15
        `, [
            company_name, contact_name, courier_info, arrival_date || null, due_date || null, notes,
            billing_country, billing_zip, billing_city, billing_street,
            shipping_country, shipping_zip, shipping_city, shipping_street,
            req.params.id
        ]);
        
        // Ha kész, visszadobjuk a csomag adatlapjára (Részletek)
        res.redirect(`/reszletek/${req.params.id}`);
    } catch (err) {
        console.error("Hiba a csomag frissítésekor:", err);
        res.status(500).send("Hiba a mentés során.");
    }
});

// =========================================================================
// 8. SZERVER INDÍTÁSA
// =========================================================================
app.listen(PORT, () => {
  console.log(`\n=========================================`);
  console.log(`🚀 A labor szerver sikeresen elindult!`);
  console.log(`🌐 Elérhető itt: http://localhost:${PORT}`);
  console.log(`=========================================\n`);
});