-- Migration to create merchants table for Woovi integration
CREATE TABLE IF NOT EXISTS merchants (
    id SERIAL PRIMARY KEY,
    establishment_id INTEGER NOT NULL,
    woovi_app_id VARCHAR(255) NOT NULL,
    woovi_api_key BYTEA NOT NULL,  -- encrypted key
    split_mode VARCHAR(20) NOT NULL DEFAULT 'NONE',  -- NONE, SPLIT_SUB_ACCOUNT, SPLIT_PARTNER, SPLIT_INTERNAL_TRANSFER
    split_details JSONB,  -- JSON structure for split configuration
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);