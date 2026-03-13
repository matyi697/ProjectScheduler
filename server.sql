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
--                      utemterv_beta
-- *********************************************************************


DROP TRIGGER IF EXISTS trigger_auto_main_job_num ON main_job;
DROP FUNCTION IF EXISTS set_main_job_number();

DROP TABLE IF EXISTS pipetta_munka CASCADE;
DROP TABLE IF EXISTS pipetta_torzs CASCADE;
DROP TABLE IF EXISTS sub_job CASCADE;
DROP TABLE IF EXISTS main_job CASCADE;

-- ==========================================
-- 1. CSOMAG TÁBLA
-- ==========================================
CREATE TABLE main_job (
    id SERIAL PRIMARY KEY,
    job_year INTEGER NOT NULL,
    job_number INTEGER, 
    
    company_name VARCHAR(255),
    contact_name VARCHAR(255),
    courier_info TEXT,
    arrival_date DATE,
    due_date DATE,
    notes TEXT,
    
    billing_country VARCHAR(100),
    billing_zip VARCHAR(20),
    billing_city VARCHAR(100),
    billing_street VARCHAR(255),
    shipping_country VARCHAR(100),
    shipping_zip VARCHAR(20),
    shipping_city VARCHAR(100),
    shipping_street VARCHAR(255),
    
    is_closed BOOLEAN DEFAULT FALSE,
    item_count INTEGER NOT NULL DEFAULT 1, 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (job_year, job_number)
);

-- ==========================================
-- 2. MUNKA TÁBLA
-- ==========================================
CREATE TABLE sub_job (
    id SERIAL PRIMARY KEY,
    main_job_id INTEGER REFERENCES main_job(id) ON DELETE CASCADE,
    sub_number INTEGER NOT NULL, 
    
    arajanlat VARCHAR(50),      
    meres VARCHAR(50),          
    arrival_date DATE,          
    due_date DATE,              
    notes TEXT,                 

    UNIQUE (main_job_id, sub_number)
);

-- ==========================================
-- 3. PIPETTA TÖRZSDATBÁZIS
-- ==========================================
CREATE TABLE pipetta_torzs (
    matrica_szam VARCHAR(50) PRIMARY KEY,
    gyarto VARCHAR(100),
    tipus VARCHAR(100),
    fajta VARCHAR(50),
    terfogat VARCHAR(50)
);

-- ==========================================
-- 4. PIPETTA MUNKÁK
-- ==========================================
CREATE TABLE pipetta_munka (
    id SERIAL PRIMARY KEY,
    sub_job_id INTEGER REFERENCES sub_job(id) ON DELETE CASCADE,
    matrica_szam VARCHAR(50) REFERENCES pipetta_torzs(matrica_szam),
    
    kalibracios_pontok INTEGER DEFAULT 1,
    ul_ertekek JSONB,
    inaccuracy_ertekek JSONB,
    imprecision_ertekek JSONB,
    
    -- ÚJ HELY: Pipettánkénti státuszok
    is_cleaned BOOLEAN DEFAULT FALSE,
    is_maintained BOOLEAN DEFAULT FALSE,
    is_serviced BOOLEAN DEFAULT FALSE,
    is_calibrated BOOLEAN DEFAULT FALSE,
    is_sent BOOLEAN DEFAULT FALSE,
    
    megjegzes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 5. SORSZÁMOZÓ TRIGGER
-- ==========================================
CREATE OR REPLACE FUNCTION set_main_job_number()
RETURNS TRIGGER AS $$
BEGIN
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

CREATE TRIGGER trigger_auto_main_job_num
BEFORE INSERT ON main_job
FOR EACH ROW
EXECUTE FUNCTION set_main_job_number();