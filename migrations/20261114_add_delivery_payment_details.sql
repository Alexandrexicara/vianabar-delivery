BEGIN;
ALTER TABLE public.cardapio_orders ADD COLUMN IF NOT EXISTS delivery_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0);
ALTER TABLE public.cardapio_orders ADD COLUMN IF NOT EXISTS delivery_data JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMIT;
