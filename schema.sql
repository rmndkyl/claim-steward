-- Claim Steward schema (Cloudflare D1)
CREATE TABLE IF NOT EXISTS claims (
  campaign_id TEXT NOT NULL,
  wallet      TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  tier        TEXT NOT NULL,
  amount      TEXT NOT NULL,
  receipt_id  TEXT NOT NULL,
  settled_at  TEXT NOT NULL,
  PRIMARY KEY (campaign_id, wallet, scope)
);

CREATE TABLE IF NOT EXISTS ledger (
  seq         INTEGER PRIMARY KEY,
  receipt_id  TEXT NOT NULL UNIQUE,
  decision    TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  wallet      TEXT NOT NULL,
  hash        TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger (created_at DESC);
