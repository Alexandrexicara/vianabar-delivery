-- Migration to create charges table for Woovi integration
CREATE TABLE IF NOT EXISTS charges (
    id SERIAL PRIMARY KEY,
    pedido_id INTEGER NOT NULL,
    merchant_id INTEGER NOT NULL,
    woovi_charge_id VARCHAR(255) NOT NULL,
    amount_total_cents INTEGER NOT NULL,
    split_details JSONB,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_charge_pedido FOREIGN KEY (pedido_id) REFERENCES pedidos (id) ON DELETE CASCADE,
    CONSTRAINT fk_charge_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
);