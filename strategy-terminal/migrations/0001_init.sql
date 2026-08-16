CREATE TABLE IF NOT EXISTS strategy_snapshots (
  strategy TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_runs (
  trade_date TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  generated_at TEXT NOT NULL,
  stocks_screened INTEGER NOT NULL,
  rows_received INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  payload_hash TEXT,
  events_json TEXT NOT NULL DEFAULT '[]',
  trades_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_daily_runs_created ON daily_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO app_settings(key,value) VALUES ('last_reviewed_at','');
INSERT OR IGNORE INTO app_settings(key,value) VALUES ('bootstrapped','0');
