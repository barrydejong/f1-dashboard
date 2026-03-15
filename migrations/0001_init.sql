CREATE TABLE IF NOT EXISTS race_reports (
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  race_name TEXT NOT NULL,
  race_date TEXT,
  race_time TEXT,
  race_datetime_utc TEXT,
  circuit_name TEXT,
  locality TEXT,
  country TEXT,
  winner_name TEXT,
  winner_team TEXT,
  podium_json TEXT NOT NULL,
  highlights_json TEXT NOT NULL,
  report_text TEXT NOT NULL,
  source_payload_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  report_model TEXT,
  report_source TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, round)
);

CREATE TABLE IF NOT EXISTS cache_entries (
  cache_key TEXT PRIMARY KEY,
  json_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
