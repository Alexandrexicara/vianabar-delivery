CREATE TABLE IF NOT EXISTS sicoob_pix_charges (
  id BIGSERIAL PRIMARY KEY,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  order_reference TEXT NOT NULL,
  txid VARCHAR(35) NOT NULL UNIQUE,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'created',
  end_to_end_id VARCHAR(40),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  UNIQUE (merchant_id, order_reference)
);
CREATE INDEX IF NOT EXISTS sicoob_pix_charges_merchant_idx ON sicoob_pix_charges(merchant_id, created_at DESC);
