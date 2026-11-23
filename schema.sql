-- Felles tilbudsdatabase for Handletur (Cloudflare D1)
CREATE TABLE IF NOT EXISTS offers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chain       TEXT NOT NULL,
  name        TEXT NOT NULL,
  price       REAL NOT NULL,
  qty         TEXT DEFAULT '',  -- mengde, f.eks. '400 g' eller 'per kg'
  condition   TEXT DEFAULT '',
  member      TEXT DEFAULT '',
  valid_from  TEXT DEFAULT '',
  valid_to    TEXT DEFAULT '',
  lat         REAL NOT NULL,   -- avrundet til ~1 km, ikke nøyaktig posisjon
  lng         REAL NOT NULL,
  source      TEXT DEFAULT '',
  device      TEXT NOT NULL,   -- tilfeldig ID per telefon, ingen personopplysninger
  nick        TEXT DEFAULT '',
  confirms    INTEGER DEFAULT 0,
  reports     INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_geo ON offers(lat, lng);
CREATE INDEX IF NOT EXISTS idx_offers_device ON offers(device, created_at);

CREATE TABLE IF NOT EXISTS votes (
  offer_id INTEGER NOT NULL,
  device   TEXT NOT NULL,
  kind     TEXT NOT NULL,      -- 'confirm' eller 'report'
  PRIMARY KEY (offer_id, device)
);

-- Personlige profiler: handleliste, medlemskap, innstillinger m.m. Nøkkelen er en hash av profilkoden.
CREATE TABLE IF NOT EXISTS profiles (
  key        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
