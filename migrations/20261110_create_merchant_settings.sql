-- Configurações e imagens permanentes de cada comerciante no Neon/PostgreSQL.
CREATE TABLE IF NOT EXISTS merchant_settings (
  store_id VARCHAR(120) PRIMARY KEY,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS merchant_assets (
  store_id VARCHAR(120) NOT NULL,
  asset_type VARCHAR(20) NOT NULL CHECK (asset_type IN ('logo','background')),
  mime_type VARCHAR(100) NOT NULL,
  file_data BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, asset_type)
);
