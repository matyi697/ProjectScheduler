-- *********************************************************************
--                      user_management
-- *********************************************************************

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL
);

INSERT INTO users (username, password) 
VALUES ('admin', '8C6976E5B5410415BDE908BD4DEE15DFB167A9C873FC4BB8A81F6F2AB448A918');




-- *********************************************************************
--                          utemterv_beta
-- *********************************************************************

-- 1. Fő munka (Csomag) tábla
CREATE TABLE main_job (
    id SERIAL PRIMARY KEY,
    job_year INTEGER NOT NULL,
    job_number INTEGER NOT NULL,
    
    -- UI-ról jövő adatok
    company_name VARCHAR(255),
    contact_name VARCHAR(255),
    courier_info TEXT,
    arrival_date DATE,
    due_date DATE,
    notes TEXT,
    
    -- A SZÁMLÁLÓ ÉRTÉKE
    item_count INTEGER NOT NULL DEFAULT 1, 
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (job_year, job_number)
);

-- 2. Munka tábla
CREATE TABLE sub_job (
    id SERIAL PRIMARY KEY,
    main_job_id INTEGER REFERENCES main_job(id) ON DELETE CASCADE,
    sub_number INTEGER NOT NULL, 
    
    -- A munkafolyamatok pipái minden egyes eszközhöz
    is_cleaned BOOLEAN DEFAULT FALSE,    -- Tisztítás
    is_serviced BOOLEAN DEFAULT FALSE,   -- Szerviz
    is_calibrated BOOLEAN DEFAULT FALSE, -- Kalibrálva
    is_sent BOOLEAN DEFAULT FALSE,       -- Kiküldve
    
    UNIQUE (main_job_id, sub_number)
);

-- A) Fő sorszám generáló 
CREATE OR REPLACE FUNCTION set_main_job_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.job_year IS NULL THEN
        NEW.job_year := EXTRACT(YEAR FROM CURRENT_DATE);
    END IF;

    SELECT COALESCE(MAX(job_number), 0) + 1
    INTO NEW.job_number
    FROM main_job
    WHERE job_year = NEW.job_year;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_auto_main_job_num
BEFORE INSERT ON main_job
FOR EACH ROW
EXECUTE FUNCTION set_main_job_number();


-- B) Munkákat generáló trigger a SZÁMLÁLÓ alapján
CREATE OR REPLACE FUNCTION create_sub_jobs_from_counter()
RETURNS TRIGGER AS $$
DECLARE
    i INTEGER;
BEGIN
    -- Ciklus indítása 1-től egészen a számláló értékéig (item_count)
    FOR i IN 1..NEW.item_count LOOP
        INSERT INTO sub_job (main_job_id, sub_number) 
        VALUES (NEW.id, i);
    END LOOP;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_auto_sub_jobs
AFTER INSERT ON main_job
FOR EACH ROW
EXECUTE FUNCTION create_sub_jobs_from_counter();

ALTER TABLE main_job
ADD COLUMN billing_country VARCHAR(100),
ADD COLUMN billing_zip VARCHAR(20),
ADD COLUMN billing_city VARCHAR(100),
ADD COLUMN billing_street VARCHAR(255),
ADD COLUMN shipping_country VARCHAR(100),
ADD COLUMN shipping_zip VARCHAR(20),
ADD COLUMN shipping_city VARCHAR(100),
ADD COLUMN shipping_street VARCHAR(255);

CREATE OR REPLACE FUNCTION set_main_job_number()
RETURNS TRIGGER AS $$
BEGIN
    -- Csak akkor generál automatikusan, ha NEM adtál meg sorszámot
    IF NEW.job_number IS NULL THEN
        IF NEW.job_year IS NULL THEN
            NEW.job_year := EXTRACT(YEAR FROM CURRENT_DATE);
        END IF;

        SELECT COALESCE(MAX(job_number), 0) + 1
        INTO NEW.job_number
        FROM main_job
        WHERE job_year = NEW.job_year;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;