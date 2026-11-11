CREATE TABLE IF NOT EXISTS platform_payment_settings (
  setting_id VARCHAR(40) PRIMARY KEY,
  pix_key_ciphertext BYTEA NOT NULL,
  pix_key_iv BYTEA NOT NULL,
  pix_key_tag BYTEA NOT NULL,
  pix_key_type VARCHAR(20) NOT NULL CHECK (pix_key_type IN ('CPF','CNPJ','EMAIL','PHONE','RANDOM')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
