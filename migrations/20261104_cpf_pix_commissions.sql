-- Viana Bar Delivery: cadastro PF/PJ, cobranças Pix Woovi e controle de comissões.
CREATE TABLE IF NOT EXISTS merchants (
  id SERIAL PRIMARY KEY,
  establishment_id INTEGER,
  woovi_app_id VARCHAR(255),
  woovi_api_key BYTEA,
  split_mode VARCHAR(30) NOT NULL DEFAULT 'SPLIT_INTERNAL_TRANSFER',
  split_details JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- CPF/CNPJ merchant accounts, secure Woovi credentials and commission collection.
ALTER TABLE merchants ALTER COLUMN establishment_id DROP NOT NULL;
ALTER TABLE merchants ALTER COLUMN woovi_app_id DROP NOT NULL;
ALTER TABLE merchants ALTER COLUMN woovi_api_key DROP NOT NULL;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS establishment_id INTEGER;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS woovi_app_id VARCHAR(255);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS woovi_api_key BYTEA;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS split_mode VARCHAR(30) NOT NULL DEFAULT 'SPLIT_SUB_ACCOUNT';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS establishment_name TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS store_slug VARCHAR(100);
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
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS woovi_webhook_registered_at TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS commission_subaccount_ready_at TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS pix_collection_consent_at TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5,2) NOT NULL DEFAULT 15;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS commission_credit_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS payout_suspended BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS merchants_store_slug_unique ON merchants (store_slug) WHERE store_slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS merchants_email_lower_unique ON merchants (LOWER(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS merchants_document_unique ON merchants (document_type, document_number) WHERE document_type IS NOT NULL AND document_number IS NOT NULL;
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
CREATE INDEX IF NOT EXISTS merchant_commissions_due_idx ON merchant_commissions (merchant_id, due_at) WHERE paid_cents < commission_amount_cents;
CREATE TABLE IF NOT EXISTS woovi_webhook_events (
  event_key VARCHAR(180) PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  correlation_id VARCHAR(100),
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS woovi_payouts (
  id BIGSERIAL PRIMARY KEY,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  charge_id BIGINT REFERENCES woovi_charges(id) ON DELETE SET NULL,
  correlation_id VARCHAR(100) NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'created',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  payload JSONB
);
