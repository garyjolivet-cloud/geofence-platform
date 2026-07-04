-- Weather cache: rolling 48-hour hourly readings (real-time Groq context)
CREATE TABLE IF NOT EXISTS weather_cache (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at       TEXT    NOT NULL,
  reading_date     TEXT    NOT NULL,
  reading_time     INTEGER NOT NULL,
  ww_temp_c        REAL,
  ww_wind_spd_kph  REAL,
  ww_wind_dir_deg  INTEGER,
  ww_wind_gust_kph REAL,
  hour_precip_mm   REAL,
  precip_24hr_mm   REAL
);

-- Snow history: daily 8 AM MST snapshots, 14-day rolling window
CREATE TABLE IF NOT EXISTS snow_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date    TEXT    NOT NULL UNIQUE,   -- YYYY-MM-DD (local date)
  taken_at         TEXT    NOT NULL,          -- ISO-8601 UTC
  ww_temp_c        REAL,
  ww_wind_spd_kph  REAL,
  ww_wind_dir_deg  INTEGER,
  ww_wind_gust_kph REAL,
  hour_precip_mm   REAL,
  precip_24hr_mm   REAL,
  hn24_cm          REAL,                      -- Dogtooth new snow last 24h (cm)
  hst_cm           REAL,                      -- Dogtooth storm snow total (cm)
  hs_cm            REAL                       -- Dogtooth total snow stake (cm)
);
