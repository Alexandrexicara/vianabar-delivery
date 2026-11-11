ALTER TABLE public.cardapio_orders
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) NOT NULL DEFAULT 'table';

ALTER TABLE public.cardapio_orders
  DROP CONSTRAINT IF EXISTS cardapio_orders_order_type_check;

ALTER TABLE public.cardapio_orders
  ADD CONSTRAINT cardapio_orders_order_type_check
  CHECK (order_type IN ('table','totem','delivery','counter'));

CREATE INDEX IF NOT EXISTS idx_cardapio_orders_store_type_created
  ON public.cardapio_orders(store_id, order_type, created_at DESC);
