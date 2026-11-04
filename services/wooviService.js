const crypto = require('crypto');
const { query, pool } = require('../database');

function inferPixKeyType(value) {
  const key = String(value || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return 'EMAIL';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) return 'RANDOM';
  const digits = key.replace(/\D/g, '');
  if (digits.length === 11) return 'CPF';
  if (digits.length === 14) return 'CNPJ';
  if (key.startsWith('+')) return 'PHONE';
  return null;
}
function normalizePixKey(value, type) {
  const key = String(value || '').trim();
  if (type === 'CPF' || type === 'CNPJ') return key.replace(/\D/g, '');
  if (type === 'PHONE') { const digits = key.replace(/\D/g, ''); return '+' + (digits.startsWith('55') ? digits : '55' + digits); }
  return key;
}
const WOOVI_BASE_URL = process.env.WOOVI_BASE_URL || 'https://api.woovi.com';
const PLATFORM_PIX_KEY = normalizePixKey(process.env.PLATFORM_PIX_KEY || '', String(process.env.PLATFORM_PIX_KEY_TYPE || inferPixKeyType(process.env.PLATFORM_PIX_KEY || '') || '').toUpperCase());

function encryptPixKey(value) {
  const keyHex = process.env.MERCHANT_CREDENTIALS_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error('MERCHANT_CREDENTIALS_ENCRYPTION_KEY não configurada.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64')).join('.');
}

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
    'SELECT id, pix_key, pix_key_encrypted, pix_key_type, pix_collection_consent_at, woovi_app_id_encrypted, woovi_credentials_verified_at, woovi_webhook_registered_at, commission_subaccount_ready_at, commission_percent, commission_credit_cents FROM merchants WHERE id=$1',
    [merchantId]
  );
  const merchant = merchantResult.rows[0];
  if (!merchant) throw new Error('Comerciante não encontrado.');
  if (!merchant.woovi_credentials_verified_at || !merchant.woovi_app_id_encrypted ||
      !merchant.woovi_webhook_registered_at || !merchant.commission_subaccount_ready_at) {
    throw new Error('Conecte a Woovi e habilite Split/Subconta antes de receber Pix pelo sistema.');
  }
  const appId = decryptSecret(merchant.woovi_app_id_encrypted);
  let originalPixKey = merchant.pix_key_encrypted ? decryptSecret(merchant.pix_key_encrypted) : merchant.pix_key;
  if (!originalPixKey) throw new Error('Chave Pix original do comerciante não encontrada.');
  originalPixKey = normalizePixKey(originalPixKey, String(merchant.pix_key_type || inferPixKeyType(originalPixKey) || '').toUpperCase());
  if (!merchant.pix_key_encrypted) {
    const encrypted = encryptPixKey(originalPixKey);
    await query('UPDATE merchants SET pix_key_encrypted=$1, pix_key=NULL WHERE id=$2', [encrypted, merchantId]);
  }
  const debtResult = await query(
    `SELECT COALESCE(SUM(commission_amount_cents - paid_cents),0)::bigint AS debt
       FROM merchant_commissions
      WHERE merchant_id=$1 AND due_at <= NOW() AND paid_cents < commission_amount_cents`,
    [merchantId]
  );
  const grossDebt = Number(debtResult.rows[0]?.debt || 0);
  const credit = Number(merchant.commission_credit_cents || 0);
  const overdueDebt = Math.max(0, grossDebt - credit);
  let arrearsSplit = 0;
  const activePixRecipient = overdueDebt > 0 ? PLATFORM_PIX_KEY : originalPixKey;
  const activePixKeyType = overdueDebt > 0 ? String(process.env.PLATFORM_PIX_KEY_TYPE || inferPixKeyType(PLATFORM_PIX_KEY) || '').toUpperCase() : String(merchant.pix_key_type || inferPixKeyType(originalPixKey) || '').toUpperCase();
  if (!activePixKeyType) throw new Error('Tipo da chave Pix ativa não identificado.');
  const payload = {
    correlationID: crypto.randomUUID(),
    value: valueCents,
    comment: String(description || ('Pedido ' + orderReference)).slice(0, 140)
  };
  // A chave efetiva é decidida exclusivamente no servidor: a original fica preservada,
  // mas durante atraso a cobrança inteira vai para a subconta da plataforma.
  if (overdueDebt > 0) {
    if (!merchant.pix_collection_consent_at) throw new Error('O comerciante ainda não autorizou a cobrança automática de débitos.');
    if (!PLATFORM_PIX_KEY) throw new Error('PLATFORM_PIX_KEY não configurada.');
    arrearsSplit = valueCents;
    payload.splits = [{ value: valueCents, pixKey: activePixRecipient, pixKeyType: activePixKeyType, splitType: 'SPLIT_SUB_ACCOUNT' }];
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
  return {
    success: true,
    charge: inserted.rows[0],
    qrCode: response.brCode || charge.brCode || null,
    qrCodeImage: response.qrCodeImage || charge.qrCodeImage || null,
    paymentLinkUrl: charge.paymentLinkUrl || null
  };
}

async function createMerchantChargeBySlug({ storeSlug, orderReference, valueCents, description }) {
  const result = await query("SELECT id FROM merchants WHERE store_slug=$1 AND status='active' LIMIT 1", [storeSlug]);
  if (!result.rows[0]) throw new Error('Loja não encontrada ou ainda não ativada para receber Pix.');
  return createMerchantCharge({ merchantId: result.rows[0].id, orderReference, valueCents, description });
}

async function getPublicChargeStatus({ storeSlug, correlationID }) {
  const result = await query(
    `SELECT c.correlation_id, c.status, c.amount_cents, c.paid_at
       FROM woovi_charges c JOIN merchants m ON m.id=c.merchant_id
      WHERE m.store_slug=$1 AND c.correlation_id=$2 LIMIT 1`,
    [storeSlug, correlationID]
  );
  if (!result.rows[0]) throw new Error('Cobrança não encontrada.');
  return result.rows[0];
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
  if (remaining > 0) {
    await client.query('UPDATE merchants SET commission_credit_cents=commission_credit_cents+$1 WHERE id=$2', [remaining, merchantId]);
  }
}

async function applyCreditToCommission(client, merchantId, commissionId, commissionCents) {
  const result = await client.query('SELECT commission_credit_cents FROM merchants WHERE id=$1 FOR UPDATE', [merchantId]);
  const credit = Number(result.rows[0]?.commission_credit_cents || 0);
  const applied = Math.min(credit, commissionCents);
  if (applied > 0) {
    await client.query('UPDATE merchant_commissions SET paid_cents=paid_cents+$1 WHERE id=$2', [applied, commissionId]);
    await client.query('UPDATE merchants SET commission_credit_cents=commission_credit_cents-$1 WHERE id=$2', [applied, merchantId]);
  }
}

async function requestCommissionWithdrawal(record) {
  if (!Number(record.arrears_split_cents)) return;
  if (!PLATFORM_PIX_KEY) throw new Error('PLATFORM_PIX_KEY não configurada para retirar a subconta.');
  const merchantResult = await query('SELECT woovi_app_id_encrypted FROM merchants WHERE id=$1', [record.merchant_id]);
  const appId = decryptSecret(merchantResult.rows[0]?.woovi_app_id_encrypted);
  const path = '/api/v1/subaccount/' + encodeURIComponent(PLATFORM_PIX_KEY) + '/withdraw';
  const response = await wooviRequest(appId, path, { method: 'POST' });
  const transaction = response.transaction || {};
  const correlationID = transaction.correlationID;
  const amountCents = Number(transaction.value || record.arrears_split_cents);
  if (!correlationID || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error('A Woovi não retornou os dados da retirada da subconta.');
  }
  await query(
    `INSERT INTO woovi_payouts (merchant_id, charge_id, correlation_id, amount_cents, status, payload)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (correlation_id) DO NOTHING`,
    [record.merchant_id, record.id, correlationID, amountCents, String(transaction.status || 'CREATED').toLowerCase(), response]
  );
}

async function processChargeCompleted(body) {
  const charge = body?.charge || {};
  const correlationID = charge.correlationID || body?.correlationID;
  if (!correlationID) throw new Error('Webhook sem correlationID.');
  const client = await pool.connect();
  let record = null;
  try {
    await client.query('BEGIN');
    const eventKey = String(body.event || 'OPENPIX:CHARGE_COMPLETED') + ':' + correlationID;
    const event = await client.query(
      'INSERT INTO woovi_webhook_events (event_key,event_type,correlation_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_key',
      [eventKey, body.event || 'OPENPIX:CHARGE_COMPLETED', correlationID, body]
    );
    if (!event.rowCount) { await client.query('COMMIT'); return { duplicate: true }; }
    const found = await client.query('SELECT * FROM woovi_charges WHERE correlation_id=$1 FOR UPDATE', [correlationID]);
    record = found.rows[0];
    if (!record) throw new Error('Cobrança não encontrada para este correlationID.');
    if (Number(charge.value ?? record.amount_cents) !== Number(record.amount_cents)) throw new Error('Valor confirmado difere do valor cobrado.');
    if (record.status !== 'paid') {
      await client.query("UPDATE woovi_charges SET status='paid', paid_at=NOW() WHERE id=$1", [record.id]);
      const rateResult = await client.query('SELECT commission_percent FROM merchants WHERE id=$1', [record.merchant_id]);
      const rate = Number(rateResult.rows[0]?.commission_percent || 15);
      const commission = Math.round(Number(record.amount_cents) * rate / 100);
      const inserted = await client.query(
        `INSERT INTO merchant_commissions (merchant_id, charge_id, sale_amount_cents, commission_amount_cents, due_at)
         VALUES ($1,$2,$3,$4,NOW() + INTERVAL '7 days') RETURNING id`,
        [record.merchant_id, record.id, record.amount_cents, commission]
      );
      await applyCreditToCommission(client, record.merchant_id, inserted.rows[0].id, commission);
      const balance = await client.query(
        `SELECT GREATEST(0, COALESCE(SUM(commission_amount_cents-paid_cents),0)-m.commission_credit_cents)::bigint AS debt
           FROM merchant_commissions c JOIN merchants m ON m.id=c.merchant_id
          WHERE c.merchant_id=$1 AND c.due_at <= NOW() GROUP BY m.commission_credit_cents`,
        [record.merchant_id]
      );
      await client.query('UPDATE merchants SET payout_suspended=$1 WHERE id=$2', [Number(balance.rows[0]?.debt || 0) > 0, record.merchant_id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  // O saldo da subconta só é transferido após a confirmação da cobrança.
  // A quitação da dívida só é registrada no webhook MOVEMENT_CONFIRMED.
  if (record && Number(record.arrears_split_cents) > 0) {
    try { await requestCommissionWithdrawal(record); }
    catch (error) { console.error('[WOOVI SUBACCOUNT WITHDRAW]', error.message); }
  }
  return { processed: true, correlationID };
}

async function processMovementEvent(body) {
  // A Woovi pode enviar o PixOut no objeto payment (payload documentado) ou transaction/movement.
  const transaction = body?.payment || body?.transaction || body?.movement || {};
  const correlationID = transaction.correlationID || body?.correlationID;
  if (!correlationID) throw new Error('Webhook de movimentação sem correlationID.');
  const eventType = String(body.event || '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM woovi_payouts WHERE correlation_id=$1 FOR UPDATE', [correlationID]);
    const payout = found.rows[0];
    if (!payout) { await client.query('COMMIT'); return { ignored: true }; }
    const eventKey = eventType + ':' + correlationID;
    const event = await client.query(
      'INSERT INTO woovi_webhook_events (event_key,event_type,correlation_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_key',
      [eventKey, eventType, correlationID, body]
    );
    if (!event.rowCount) { await client.query('COMMIT'); return { duplicate: true }; }
    if (eventType === 'OPENPIX:MOVEMENT_CONFIRMED' && payout.status !== 'confirmed') {
      const value = Number(transaction.value || payout.amount_cents);
      await applyArrearsPayment(client, payout.merchant_id, value);
      await client.query("UPDATE woovi_payouts SET status='confirmed', confirmed_at=NOW(), payload=$1 WHERE id=$2", [body, payout.id]);
      const balance = await client.query(
        `SELECT GREATEST(0, COALESCE(SUM(c.commission_amount_cents-c.paid_cents),0)-m.commission_credit_cents)::bigint AS debt
           FROM merchant_commissions c JOIN merchants m ON m.id=c.merchant_id
          WHERE c.merchant_id=$1 AND c.due_at <= NOW() GROUP BY m.commission_credit_cents`,
        [payout.merchant_id]
      );
      await client.query('UPDATE merchants SET payout_suspended=$1 WHERE id=$2', [Number(balance.rows[0]?.debt || 0) > 0, payout.merchant_id]);
    } else if (eventType === 'OPENPIX:MOVEMENT_FAILED') {
      await client.query("UPDATE woovi_payouts SET status='failed', payload=$1 WHERE id=$2", [body, payout.id]);
    }
    await client.query('COMMIT');
    return { processed: true, correlationID };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

module.exports = {
  createMerchantCharge,
  createMerchantChargeBySlug,
  getPublicChargeStatus,
  processChargeCompleted,
  processMovementEvent,
  decryptSecret,
  wooviRequest
};
