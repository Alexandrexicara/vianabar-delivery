-- Cadastro persistente de clientes e motoboys e razão de valores de entrega.
CREATE TABLE IF NOT EXISTS customers (
 id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, cpf_hash CHAR(64) NOT NULL UNIQUE,
 cpf_encrypted TEXT NOT NULL, phone TEXT NOT NULL, last_table TEXT,
 visit_count INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS motoboys (
 id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
 cpf_hash CHAR(64) NOT NULL, cpf_encrypted TEXT NOT NULL, password_hash TEXT NOT NULL,
 vehicle_data JSONB NOT NULL DEFAULT '{}'::jsonb, cnh_data JSONB NOT NULL DEFAULT '{}'::jsonb,
 pix_key_encrypted TEXT NOT NULL, pix_key_type VARCHAR(12) NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS motoboys_email_lower_unique ON motoboys(LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS motoboys_cpf_hash_unique ON motoboys(cpf_hash);
CREATE TABLE IF NOT EXISTS motoboy_deliveries (
 id BIGSERIAL PRIMARY KEY, merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
 motoboy_id BIGINT NOT NULL REFERENCES motoboys(id) ON DELETE RESTRICT, order_reference TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0), paid_cents INTEGER NOT NULL DEFAULT 0
 CHECK(paid_cents>=0 AND paid_cents<=amount_cents),
 due_at TIMESTAMPTZ NOT NULL DEFAULT(NOW()+INTERVAL '48 hours'),
 status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 paid_at TIMESTAMPTZ, UNIQUE(merchant_id,order_reference,motoboy_id)
);
CREATE INDEX IF NOT EXISTS motoboy_deliveries_due_idx ON motoboy_deliveries(merchant_id,due_at,id)
 WHERE paid_cents<amount_cents;
CREATE INDEX IF NOT EXISTS motoboy_deliveries_motoboy_idx ON motoboy_deliveries(motoboy_id,due_at);
CREATE TABLE IF NOT EXISTS motoboy_payouts (
 id BIGSERIAL PRIMARY KEY, merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
 motoboy_id BIGINT NOT NULL REFERENCES motoboys(id) ON DELETE RESTRICT,
 delivery_id BIGINT NOT NULL REFERENCES motoboy_deliveries(id) ON DELETE RESTRICT,
 correlation_id VARCHAR(120) UNIQUE, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 status VARCHAR(20) NOT NULL DEFAULT 'queued', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 confirmed_at TIMESTAMPTZ, payload JSONB
);
CREATE INDEX IF NOT EXISTS motoboy_payouts_queue_idx ON motoboy_payouts(merchant_id,status,created_at);

ALTER TABLE motoboy_deliveries ADD COLUMN IF NOT EXISTS reserved_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merchant_commissions ADD COLUMN IF NOT EXISTS reserved_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE woovi_charges ADD COLUMN IF NOT EXISTS split_allocations JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE woovi_payouts ADD COLUMN IF NOT EXISTS allocation_key TEXT;
ALTER TABLE woovi_payouts ADD COLUMN IF NOT EXISTS motoboy_id BIGINT REFERENCES motoboys(id) ON DELETE RESTRICT;
ALTER TABLE woovi_payouts ADD COLUMN IF NOT EXISTS delivery_id BIGINT REFERENCES motoboy_deliveries(id) ON DELETE RESTRICT;
ALTER TABLE woovi_payouts ADD COLUMN IF NOT EXISTS recipient_pix_key_encrypted TEXT;
ALTER TABLE woovi_payouts ADD COLUMN IF NOT EXISTS allocation_details JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS woovi_payouts_charge_allocation_unique
  ON woovi_payouts(charge_id,allocation_key) WHERE allocation_key IS NOT NULL;

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS delivery_collection_consent_at TIMESTAMPTZ;

-- Novos cadastros precisam de aprovação explícita antes de acessar o painel.
ALTER TABLE motoboys ALTER COLUMN status SET DEFAULT 'pending';
