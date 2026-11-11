'use strict';
const db = require('../database');
const pool = db.pool;
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

function id(value, label) {
  const result = String(value || '').trim();
  if (!result || result.length > 160) throw new Error(label + ' inválido.');
  return result;
}
function cents(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Valor deve ser positivo e informado em centavos inteiros.');
  return result;
}

async function registrarObrigacaoEntrega({ merchantId, motoboyId, orderId, amountCents }) {
  const merchant = id(merchantId, 'Comerciante');
  const motoboy = id(motoboyId, 'Motoboy');
  const order = id(orderId, 'Pedido');
  const amount = cents(amountCents);
  const earnedAt = new Date();
  const dueAt = new Date(earnedAt.getTime() + FORTY_EIGHT_HOURS_MS);
  const inserted = await pool.query(
    "INSERT INTO merchant_delivery_obligations (merchant_id,motoboy_id,order_id,amount_cents,earned_at,due_at,status) VALUES ($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT (merchant_id,order_id,motoboy_id) DO NOTHING RETURNING *",
    [merchant,motoboy,order,amount,earnedAt.toISOString(),dueAt.toISOString()]
  );
  if (inserted.rowCount) return inserted.rows[0];
  const existing = await pool.query(
    "SELECT * FROM merchant_delivery_obligations WHERE merchant_id=$1 AND order_id=$2 AND motoboy_id=$3",
    [merchant,order,motoboy]
  );
  if (!existing.rowCount) throw new Error('Não foi possível registrar a obrigação.');
  if (Number(existing.rows[0].amount_cents) !== amount) throw new Error('Já existe obrigação para este pedido e motoboy com outro valor; exige conciliação.');
  return existing.rows[0];
}

async function listarPendenciasComerciante(merchantId) {
  const merchant = id(merchantId, 'Comerciante');
  await pool.query(
    "UPDATE merchant_delivery_obligations SET status='due',updated_at=NOW() WHERE merchant_id=$1 AND status='pending' AND due_at<=NOW()",
    [merchant]
  );
  const [obligations, totals, batches] = await Promise.all([
    pool.query("SELECT id,motoboy_id,order_id,amount_cents,earned_at,due_at,status,payout_batch_id FROM merchant_delivery_obligations WHERE merchant_id=$1 AND status IN ('pending','due','in_batch') ORDER BY due_at", [merchant]),
    pool.query("SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status='due'),0)::bigint AS overdue_cents,COUNT(*) FILTER (WHERE status='due')::int AS overdue_count FROM merchant_delivery_obligations WHERE merchant_id=$1", [merchant]),
    pool.query("SELECT id,total_cents,status,requested_at,authorized_at FROM merchant_delivery_payout_batches WHERE merchant_id=$1 AND status IN ('pending_authorization','authorized','processing') ORDER BY requested_at DESC", [merchant])
  ]);
  return {
    obligations: obligations.rows,
    overdueCents: Number(totals.rows[0].overdue_cents),
    overdueCount: Number(totals.rows[0].overdue_count),
    activeBatches: batches.rows,
    blocked: Number(totals.rows[0].overdue_cents) > 0
  };
}

async function criarLotePagamento({ merchantId, idempotencyKey }) {
  const merchant = id(merchantId, 'Comerciante');
  const key = idempotencyKey, client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [merchant]);
    if (key) {
      const old = await client.query("SELECT * FROM merchant_delivery_payout_batches WHERE idempotency_key=$1", [key]);
      if (old.rowCount) {
        if (old.rows[0].merchant_id !== merchant) throw new Error('Chave de idempotência já utilizada.');
        await client.query('COMMIT');
        return old.rows[0];
      }
    }
    await client.query("UPDATE merchant_delivery_obligations SET status='due',updated_at=NOW() WHERE merchant_id=$1 AND status='pending' AND due_at<=NOW()", [merchant]);
    const active = await client.query("SELECT id FROM merchant_delivery_payout_batches WHERE merchant_id=$1 AND status IN ('pending_authorization','authorized','processing') LIMIT 1 FOR UPDATE", [merchant]);
    if (active.rowCount) throw new Error('Já existe lote de pagamento em aberto.');
    const due = await client.query("SELECT id,amount_cents,earned_at,due_at FROM merchant_delivery_obligations WHERE merchant_id=$1 AND status='due' ORDER BY due_at FOR UPDATE", [merchant]);
    if (!due.rowCount) throw new Error('Não há entregas vencidas para pagar.');
    const total = due.rows.reduce((sum,row) => sum + Number(row.amount_cents), 0);
    if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Total do lote inválido.');
    const start = due.rows.reduce((v,row) => row.earned_at < v ? row.earned_at : v, due.rows[0].earned_at);
    const end = due.rows.reduce((v,row) => row.due_at > v ? row.due_at : v, due.rows[0].due_at);
    const batch = await client.query("INSERT INTO merchant_delivery_payout_batches (merchant_id,total_cents,period_start,period_end,idempotency_key,status) VALUES ($1,$2,$3,$4,$5,'pending_authorization') RETURNING *", [merchant,total,start,end,key || null]);
    for (const row of due.rows) {
      await client.query("INSERT INTO merchant_delivery_payout_items (batch_id,obligation_id,amount_cents) VALUES ($1,$2,$3)", [batch.rows[0].id,row.id,row.amount_cents]);
    }
    await client.query("UPDATE merchant_delivery_obligations SET status='in_batch',payout_batch_id=$2,updated_at=NOW() WHERE merchant_id=$1 AND id=ANY($3::bigint[])", [merchant,batch.rows[0].id,due.rows.map(row => row.id)]);
    await client.query("INSERT INTO merchant_delivery_payout_events (batch_id,event_type,details) VALUES ($1,'batch_created',$2::jsonb)", [batch.rows[0].id,JSON.stringify({obligationCount:due.rowCount,totalCents:total})]);
    await client.query('COMMIT');
    return batch.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function autorizarLoteComerciante({ merchantId, batchId, authorizedBy }) {
  const merchant = id(merchantId,'Comerciante'), actor = id(authorizedBy,'Responsável');
  const batchIdNumber = Number(batchId);
  if (!Number.isSafeInteger(batchIdNumber) || batchIdNumber <= 0) throw new Error('Lote inválido.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [merchant]);
    const batch = await client.query("SELECT * FROM merchant_delivery_payout_batches WHERE id=$1 AND merchant_id=$2 FOR UPDATE", [batchIdNumber,merchant]);
    if (!batch.rowCount || batch.rows[0].status !== 'pending_authorization') throw new Error('Lote não encontrado ou não aguarda autorização.');
    await client.query("UPDATE merchant_delivery_obligations SET status='due',updated_at=NOW() WHERE merchant_id=$1 AND status='pending' AND due_at<=NOW()", [merchant]);
    const uncovered = await client.query("SELECT COUNT(*)::int AS count FROM merchant_delivery_obligations WHERE merchant_id=$1 AND status='due'", [merchant]);
    if (Number(uncovered.rows[0].count)) throw new Error('Existem outras entregas vencidas fora deste lote. Atualize o lote antes de autorizar.');
    const result = await client.query("UPDATE merchant_delivery_payout_batches SET status='authorized',authorized_at=NOW(),authorized_by=$3,updated_at=NOW() WHERE id=$1 AND merchant_id=$2 AND status='pending_authorization' RETURNING *", [batchIdNumber,merchant,actor]);
    await client.query("INSERT INTO merchant_delivery_payout_events (batch_id,event_type,actor_id) VALUES ($1,'merchant_authorized',$2)", [batchIdNumber,actor]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

// Chamadas internas: só a integração autenticada do provedor pode marcar processamento/liquidação.

async function marcarLoteEmProcessamento({ batchId, provider }) {
  const batch = Number(batchId);
  if (!Number.isSafeInteger(batch) || batch <= 0) throw new Error('Lote inválido.');
  const providerName = id(provider, 'Provedor');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      "UPDATE merchant_delivery_payout_batches SET status='processing',provider=$2,updated_at=NOW() WHERE id=$1 AND status='authorized' RETURNING *",
      [batch, providerName]
    );
    if (!updated.rowCount) throw new Error('Lote não está autorizado ou não existe.');
    await client.query(
      "INSERT INTO merchant_delivery_payout_events (batch_id,event_type,details) VALUES ($1,'provider_processing',$2::jsonb)",
      [batch, JSON.stringify({ provider: providerName })]
    );
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function confirmarLotePago({ batchId, provider, providerReference }) {
  const batch = Number(batchId);
  if (!Number.isSafeInteger(batch) || batch <= 0) throw new Error('Lote inválido.');
  const providerName = id(provider,'Provedor'), reference = id(providerReference,'Referência');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query("UPDATE merchant_delivery_payout_batches SET status='paid',provider=$2,provider_reference=$3,processed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('authorized','processing') RETURNING *", [batch,providerName,reference]);
    if (!updated.rowCount) {
      const previous = await client.query("SELECT * FROM merchant_delivery_payout_batches WHERE id=$1 AND status='paid' AND provider_reference=$2", [batch,reference]);
      if (previous.rowCount) { await client.query('COMMIT'); return previous.rows[0]; }
      throw new Error('Lote não está apto para confirmação.');
    }
    await client.query("UPDATE merchant_delivery_obligations SET status='paid',updated_at=NOW() WHERE payout_batch_id=$1 AND status='in_batch'", [batch]);
    await client.query("INSERT INTO merchant_delivery_payout_events (batch_id,event_type,details) VALUES ($1,'provider_confirmed_paid',$2::jsonb)", [batch,JSON.stringify({provider:providerName,providerReference:reference})]);
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function registrarFalhaLote({ batchId, provider, reason }) {
  const batch = Number(batchId);
  if (!Number.isSafeInteger(batch) || batch <= 0) throw new Error('Lote inválido.');
  const providerName = id(provider,'Provedor'), detail = String(reason || 'Falha informada pelo provedor').slice(0,1000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query("UPDATE merchant_delivery_payout_batches SET status='failed',provider=$2,failure_reason=$3,updated_at=NOW() WHERE id=$1 AND status IN ('authorized','processing') RETURNING *", [batch,providerName,detail]);
    if (!updated.rowCount) throw new Error('Lote não está apto para registrar falha.');
    await client.query("UPDATE merchant_delivery_obligations SET status='due',payout_batch_id=NULL,updated_at=NOW() WHERE payout_batch_id=$1 AND status='in_batch'", [batch]);
    await client.query("INSERT INTO merchant_delivery_payout_events (batch_id,event_type,details) VALUES ($1,'provider_failed',$2::jsonb)", [batch,JSON.stringify({provider:providerName,reason:detail})]);
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { registrarObrigacaoEntrega, listarPendenciasComerciante, criarLotePagamento, autorizarLoteComerciante, marcarLoteEmProcessamento, confirmarLotePago, registrarFalhaLote };
