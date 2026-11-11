CREATE TABLE IF NOT EXISTS merchant_users (
  id BIGSERIAL PRIMARY KEY,
  store_id VARCHAR(120) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, email)
);
CREATE INDEX IF NOT EXISTS merchant_users_email_idx ON merchant_users (LOWER(email));
