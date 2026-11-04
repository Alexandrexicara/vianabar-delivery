-- CPF/CNPJ merchant accounts, secure Woovi credentials and commission collection.
ALTER TABLE merchants ALTER COLUMN establishment_id DROP NOT NULL;
ALTER TABLE merchants ALTER COLUMN woovi_app_id DROP NOT NULL;
ALTER TABLE merchants ALTER COLUMN woovi_api_key DROP NOT NULL;

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS establishment_name TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS document_type VARCHAR(4);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS document_number VARCHAR(14);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS pix_key TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS pix_key_type VARCHAR(12);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS woovi_app_id_encrypted TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS woovi_credentials_verified_at TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS pix_collection_consent_at TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS payout_suspended BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS merchants_email_lower_unique
  ON merchants (LOWER(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS merchants_document_unique
  ON merchants (document_type, document_number)
  WHERE document_type IS NOT NULL AND document_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS woovi_charges (
  id BIGSERIAL PRIMARY KEY,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  order_reference TEXT NOT NULL,
  correlation_id VARCHAR(100) NOT NULL UNIQUE,
  woovi_charge_id VARCHAR(120),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  arrears_split_cents INTEGER NOT NULL DEFAULT 0 CHECK (arrears_split_cents >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  br_code TEXT,
  payment_link_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS merchant_commissions (
  id BIGSERIAL PRIMARY KEY,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  charge_id BIGINT REFERENCES woovi_charges(id) ON DELETE SET NULL,
  sale_amount_cents INTEGER NOT NULL CHECK (sale_amount_cents >= 0),
  commission_amount_cents INTEGER NOT NULL CHECK (commission_amount_cents >= 0),
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  due_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (paid_cents <= commission_amount_cents)
);
CREATE INDEX IF NOT EXISTS merchant_commissions_due_idx
  ON merchant_commissions (merchant_id, due_at) WHERE paid_cents < commission_amount_cents;

CREATE TABLE IF NOT EXISTS woovi_webhook_events (
  event_key VARCHAR(180) PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  correlation_id VARCHAR(100),
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
