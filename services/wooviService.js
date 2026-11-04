const crypto = require('crypto');
const { query, pool } = require('../database');
const WOOVI_BASE_URL = process.env.WOOVI_BASE_URL || 'https://api.woovi.com';
const PLATFORM_PIX_KEY = process.env.PLATFORM_PIX_KEY || '';

function decryptSecret(value) {
  if (!value) throw new Error('AppID Woovi não configurado para este comerciante.');
  const keyHex = process.env.MERCHANT_CREDENTIALS_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error('MERCHANT_CREDENTIALS_ENCRYPTION_KEY não configurada.');
  const [iv64, tag64, data64] = value.split('.');
  if (!iv64 || !tag64 || !data64) throw new Error('Credencial Woovi armazenada em formato inválido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]).toString('utf8');
}
async function wooviRequest(appId, path, options = {}) {
  const response = await fetch(WOOVI_BASE_URL + path, {
    ...options,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: appId, ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.errors?.[0]?.message || data?.message || 'Erro retornado pela Woovi.');
    error.status = response.status;
    throw error;
  }
  return data;
}
async function createMerchantCharge({ merchantId, orderReference, valueCents, description }) {
  if (!Number.isSafeInteger(valueCents) || valueCents < 100) throw new Error('O valor da cobrança deve ser de pelo menos R$ 1,00.');
  const merchantResult = await query(
    'SELECT id, pix_key, pix_collection_consent_at, woovi_app_id_encrypted, woovi_credentials_verified_at FROM merchants WHERE id=$1',
    [merchantId]
  );
  const merchant = merchantResult.rows[0];
  if (!merchant) throw new Error('Comerciante não encontrado.');
  if (!merchant.woovi_credentials_verified_at || !merchant.woovi_app_id_encrypted) throw new Error('Conecte e valide o AppID da Woovi antes de cobrar.');
  const appId = decryptSecret(merchant.woovi_app_id_encrypted);
  const debtResult = await query(
    `SELECT COALESCE(SUM(commission_amount_cents - paid_cents),0)::bigint AS debt
       FROM merchant_commissions
      WHERE merchant_id=$1 AND due_at <= NOW() AND paid_cents < commission_amount_cents`,
    [merchantId]
  );
  const overdueDebt = Number(debtResult.rows[0]?.debt || 0);
  let arrearsSplit = 0;
  const payload = { correlationID: crypto.randomUUID(), value: valueCents, comment: String(description || ('Pedido ' + orderReference)).slice(0, 140) };
  if (merchant.pix_key) payload.pixKey = merchant.pix_key;
  if (overdueDebt > 0) {
    if (!merchant.pix_collection_consent_at) throw new Error('O comerciante ainda não autorizou a cobrança automática de débitos.');
    if (!PLATFORM_PIX_KEY) throw new Error('PLATFORM_PIX_KEY não configurada; cobrança suspensa para evitar desvio incorreto.');
    arrearsSplit = Math.min(valueCents, overdueDebt);
    payload.splits = [{ value: arrearsSplit, pixKey: PLATFORM_PIX_KEY, splitType: 'SPLIT_INTERNAL_TRANSFER' }];
  }
  const response = await wooviRequest(appId, '/api/v1/charge', { method: 'POST', body: JSON.stringify(payload) });
  const charge = response.charge || response;
  const inserted = await query(
    `INSERT INTO woovi_charges
      (merchant_id, order_reference, correlation_id, woovi_charge_id, amount_cents, arrears_split_cents, status, br_code, payment_link_url)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)
     RETURNING id, correlation_id, status, br_code, payment_link_url, amount_cents, arrears_split_cents`,
    [merchantId, String(orderReference), payload.correlationID, charge.identifier || charge.transactionID || null,
     valueCents, arrearsSplit, response.brCode || charge.brCode || null, charge.paymentLinkUrl || null]
  );
  if (overdueDebt > 0) await query('UPDATE merchants SET payout_suspended=TRUE WHERE id=$1', [merchantId]);
  return { success: true, charge: inserted.rows[0], qrCode: response.brCode || charge.brCode || null, paymentLinkUrl: charge.paymentLinkUrl || null };
}
async function applyArrearsPayment(client, merchantId, amountCents) {
  let remaining = amountCents;
  const due = await client.query(
    `SELECT id, commission_amount_cents, paid_cents FROM merchant_commissions
      WHERE merchant_id=$1 AND due_at <= NOW() AND paid_cents < commission_amount_cents
      ORDER BY due_at ASC, id ASC FOR UPDATE`, [merchantId]
  );
  for (const row of due.rows) {
    if (remaining <= 0) break;
    const applied = Math.min(Number(row.commission_amount_cents) - Number(row.paid_cents), remaining);
    await client.query('UPDATE merchant_commissions SET paid_cents=paid_cents+$1 WHERE id=$2', [applied, row.id]);
    remaining -= applied;
  }
}
async function processChargeCompleted(body) {
  const charge = body?.charge || {};
  const correlationID = charge.correlationID || body?.correlationID;
  if (!correlationID) throw new Error('Webhook sem correlationID.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const eventKey = String(body.event || 'OPENPIX:CHARGE_COMPLETED') + ':' + correlationID;
    const event = await client.query(
      'INSERT INTO woovi_webhook_events (event_key,event_type,correlation_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_key',
      [eventKey, body.event || 'OPENPIX:CHARGE_COMPLETED', correlationID, body]
    );
    if (!event.rowCount) { await client.query('COMMIT'); return { duplicate: true }; }
    const found = await client.query('SELECT * FROM woovi_charges WHERE correlation_id=$1 FOR UPDATE', [correlationID]);
    const record = found.rows[0];
    if (!record) throw new Error('Cobrança não encontrada para este correlationID.');
    if (Number(charge.value ?? record.amount_cents) !== Number(record.amount_cents)) throw new Error('Valor confirmado difere do valor cobrado.');
    if (record.status !== 'paid') {
      await client.query("UPDATE woovi_charges SET status='paid', paid_at=NOW() WHERE id=$1", [record.id]);
      if (Number(record.arrears_split_cents) > 0) await applyArrearsPayment(client, record.merchant_id, Number(record.arrears_split_cents));
      const commission = Math.round(Number(record.amount_cents) * 0.15);
      await client.query(
        `INSERT INTO merchant_commissions (merchant_id, charge_id, sale_amount_cents, commission_amount_cents, due_at)
         VALUES ($1,$2,$3,$4,NOW() + INTERVAL '7 days')`,
        [record.merchant_id, record.id, record.amount_cents, commission]
      );
      const balance = await client.query(
        `SELECT COALESCE(SUM(commission_amount_cents-paid_cents),0)::bigint AS debt
           FROM merchant_commissions WHERE merchant_id=$1 AND due_at <= NOW()`, [record.merchant_id]
      );
      await client.query('UPDATE merchants SET payout_suspended=$1 WHERE id=$2', [Number(balance.rows[0].debt || 0) > 0, record.merchant_id]);
    }
    await client.query('COMMIT');
    return { processed: true, correlationID };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
module.exports = { createMerchantCharge, processChargeCompleted, decryptSecret, wooviRequest };
