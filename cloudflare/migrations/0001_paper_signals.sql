CREATE TABLE IF NOT EXISTS paper_signals (
  ticker TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  entry_price REAL NOT NULL,
  model_probability REAL NOT NULL,
  estimated_fee REAL NOT NULL,
  model_name TEXT NOT NULL,
  seconds_to_close INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  result TEXT CHECK (result IS NULL OR result IN ('yes', 'no')),
  settled_at TEXT,
  correct INTEGER CHECK (correct IS NULL OR correct IN (0, 1)),
  net_profit REAL
);

CREATE INDEX IF NOT EXISTS paper_signals_created_at_idx
  ON paper_signals (created_at);

CREATE INDEX IF NOT EXISTS paper_signals_result_idx
  ON paper_signals (result);
