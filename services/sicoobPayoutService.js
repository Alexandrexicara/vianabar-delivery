'use strict';

const { pool } = require('../database');

function requiredId(value, label) {
  const result = String(value || '').trim();
  if (!result || result.length > 160) throw new Error(label + ' inválido.');
  return result;
}
function positiveCents(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Valor deve ser positivo em centavos inteiros.');
  return result;
}

// Chamar somente após confirmação confiável de entrega concluída,
// usando IDs e valor obtidos do pedido persistido no servidor.
async function registrarObrigacaoEntrega({ merchantId, motoboyId, orderId, amountCents, earnedAt = new Date() }) {
  const merchant = requiredId(merchantId, 'Comerciante');
  const motoboy = requiredId(motoboyId, 'Motoboy');
  const order = requiredId(orderId, 'Pedido');
  const amount = positiveCents(amountCents);
  const earned = new Date(earnedAt);
  if (Number.isNaN(earned.getTime())) throw new Error('Data de conclusão inválida.');
  const due = new Date(earned.getTime() + 24 * 60 * 60 * 1000);
  const inserted = await pool.query(
    'INSERT INTO sicoob_delivery_obligations (merchant_id,motoboy_id,order_id,amount_cents,earned_at,due_at,status) VALUES ($1,$2,$3,$4,$5,$6,\'pending\') ON CONFLICT (merchant_id,order_id,motoboy_id) DO NOTHING RETURNING *',
    [merchant,motoboy,order,amount,earned.toISOString(),due.toISOString()]
  );
  if (inserted.rowCount) return inserted.rows[0];
  const existing = await pool.query('SELECT * FROM sicoob_delivery_obligations WHERE merchant_id=$1 AND order_id=$2 AND motoboy_id=$3', [merchant,order,motoboy]);
  if (!existing.rowCount || Number(existing.rows[0].amount_cents) !== amount) throw new Error('Entrega já registrada com dados divergentes; exige conciliação.');
  return existing.rows[0];
}

// Um lote por comerciante + motoboy. Um lote representa uma transferência Pix.
async function criarLotesDiariosVencidos({ merchantId = null } = {}) {
  const merchantFilter = merchantId ? requiredId(merchantId, 'Comerciante') : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE sicoob_delivery_obligations SET status=\'due\',updated_at=NOW() WHERE status=\'pending\' AND due_at<=NOW() AND ($1::varchar IS NULL OR merchant_id=$1)', [merchantFilter]);
    const groups = await client.query(
      'SELECT merchant_id,motoboy_id,MIN(earned_at) AS period_start,MAX(due_at) AS period_end,SUM(amount_cents)::bigint AS total_cents,ARRAY_AGG(id ORDER BY earned_at,id) AS obligation_ids FROM sicoob_delivery_obligations WHERE status=\'due\' AND ($1::varchar IS NULL OR merchant_id=$1) GROUP BY merchant_id,motoboy_id ORDER BY merchant_id,motoboy_id',
      [merchantFilter]
    );
    const created = [];
    for (const group of groups.rows) {
      const total = Number(group.total_cents);
      if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Total diário inválido.');
      const dayKey = new Date(group.period_end).toISOString().slice(0,10);
      const key = 'sicoob:' + group.merchant_id + ':' + group.motoboy_id + ':' + dayKey;
      const batch = await client.query(
        'INSERT INTO sicoob_daily_payout_batches (merchant_id,motoboy_id,total_cents,period_start,period_end,idempotency_key,status) VALUES ($1,$2,$3,$4,$5,$6,\'pending\') ON CONFLICT (idempotency_key) DO NOTHING RETURNING *',
        [group.merchant_id,group.motoboy_id,total,group.period_start,group.period_end,key]
      );
      if (!batch.rowCount) continue;
      const row = batch.rows[0];
      for (const obligationId of group.obligation_ids) {
        await client.query('INSERT INTO sicoob_daily_payout_items(batch_id,obligation_id,amount_cents) SELECT $1,id,amount_cents FROM sicoob_delivery_obligations WHERE id=$2', [row.id,obligationId]);
      }
      await client.query('UPDATE sicoob_delivery_obligations SET status=\'in_batch\',payout_batch_id=$2,updated_at=NOW() WHERE id=ANY($1::bigint[]) AND status=\'due\'', [group.obligation_ids,row.id]);
      await client.query('INSERT INTO sicoob_payout_events(batch_id,event_type,details) VALUES ($1,$2,$3::jsonb)', [row.id,'daily_batch_created',JSON.stringify({obligationCount:group.obligation_ids.length,totalCents:total})]);
      created.push(row);
    }
    await client.query('COMMIT');
    return created;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

// Só após o Sicoob aceitar a ordem e devolver referência bancária.
async function marcarLoteProcessando({ batchId, providerReference }) {
  const id = Number(batchId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Lote inválido.');
  const ref = requiredId(providerReference, 'Referência do Sicoob');
  const result = await pool.query('UPDATE sicoob_daily_payout_batches SET status=\'processing\',provider_reference=$2,attempted_at=NOW(),updated_at=NOW() WHERE id=$1 AND status=\'pending\' RETURNING *', [id,ref]);
  if (!result.rowCount) throw new Error('Lote não está pendente ou já foi processado.');
  await pool.query('INSERT INTO sicoob_payout_events(batch_id,event_type,details) VALUES ($1,$2,$3::jsonb)', [id,'provider_accepted',JSON.stringify({providerReference:ref})]);
  return result.rows[0];
}

// Apenas após consulta/webhook autenticado do Sicoob confirmar a liquidação.
async function confirmarLotePago({ batchId, providerReference }) {
  const id = Number(batchId);
  const ref = requiredId(providerReference, 'Referência do Sicoob');
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Lote inválido.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query('UPDATE sicoob_daily_payout_batches SET status=\'paid\',processed_at=NOW(),updated_at=NOW() WHERE id=$1 AND provider_reference=$2 AND status=\'processing\' RETURNING *', [id,ref]);
    if (!updated.rowCount) {
      const existing = await client.query('SELECT * FROM sicoob_daily_payout_batches WHERE id=$1 AND provider_reference=$2 AND status=\'paid\'', [id,ref]);
      if (existing.rowCount) { await client.query('COMMIT'); return existing.rows[0]; }
      throw new Error('Confirmação não corresponde a um lote em processamento.');
    }
    await client.query('UPDATE sicoob_delivery_obligations SET status=\'paid\',updated_at=NOW() WHERE payout_batch_id=$1 AND status=\'in_batch\'', [id]);
    await client.query('INSERT INTO sicoob_payout_events(batch_id,event_type,details) VALUES ($1,$2,$3::jsonb)', [id,'provider_confirmed_paid',JSON.stringify({providerReference:ref})]);
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function registrarFalhaLote({ batchId, reason, retrySafe = false }) {
  const id = Number(batchId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Lote inválido.');
  const detail = String(reason || 'Falha informada pelo Sicoob').slice(0,1000);
  const status = retrySafe ? 'failed' : 'needs_review';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('UPDATE sicoob_daily_payout_batches SET status=$2,failure_reason=$3,updated_at=NOW() WHERE id=$1 AND status IN (\'pending\',\'processing\') RETURNING *', [id,status,detail]);
    if (!result.rowCount) throw new Error('Lote não está apto para registrar falha.');
    if (retrySafe) await client.query('UPDATE sicoob_delivery_obligations SET status=\'due\',payout_batch_id=NULL,updated_at=NOW() WHERE payout_batch_id=$1 AND status=\'in_batch\'', [id]);
    await client.query('INSERT INTO sicoob_payout_events(batch_id,event_type,details) VALUES ($1,$2,$3::jsonb)', [id,'provider_failed',JSON.stringify({reason:detail,retrySafe})]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { registrarObrigacaoEntrega, criarLotesDiariosVencidos, marcarLoteProcessando, confirmarLotePago, registrarFalhaLote };
