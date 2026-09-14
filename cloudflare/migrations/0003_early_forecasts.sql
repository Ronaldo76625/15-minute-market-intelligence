CREATE TABLE IF NOT EXISTS early_forecasts (
  ticker TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  title TEXT NOT NULL,
  close_time TEXT NOT NULL,
  previous_result TEXT CHECK (
    previous_result IS NULL OR previous_result IN ('YES', 'NO')
  ),
  initial_payload TEXT,
  confirmation_payload TEXT,
  result TEXT CHECK (result IS NULL OR result IN ('yes', 'no')),
  settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS early_forecasts_close_time_idx
  ON early_forecasts (close_time DESC);
