'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const API_BASE = String(process.env.WOOVI_API_BASE_URL || 'https://api.woovi.com').replace(/\/$/, '');
const WEBHOOK_URL = process.env.WOOVI_WEBHOOK_URL || 'https://vianabar-delivery.onrender.com/woovi/webhook';
const COMMISSION_PERCENT = 15;

function encryptionKey() {
  const raw = String(process.env.PAYMENT_CREDENTIALS_ENCRYPTION_KEY || '');
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('PAYMENT_CREDENTIALS_ENCRYPTION_KEY precisa conter uma chave de 32 bytes em hex ou base64.');
  return key;
}
function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}
function decryptSecret(row) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), row.app_id_iv);
  decipher.setAuthTag(row.app_id_tag);
  return Buffer.concat([decipher.update(row.app_id_ciphertext), decipher.final()]).toString('utf8');
}
function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
async function apiRequest(appId, method, path, data) {
  const response = await axios({
    method, url: API_BASE + path, data, timeout: 20000,
    headers: { Authorization: appId, 'Content-Type': 'application/json', Accept: 'application/json' }
  });
  return response.data;
}
function extractCharge(response) {
  const value = response?.data || response;
  return value.charge || value;
}
async function getMerchantAccount(storeId) {
  const result = await pool.query(
    'SELECT store_id, app_id_ciphertext, app_id_iv, app_id_tag, status, webhook_registered FROM merchant_woovi_accounts WHERE store_id=$1',
    [String(storeId)]
  );
  return result.rows[0] || null;
}
async function registerMerchantAccount({ storeId, appId }) {
  const id = String(storeId || '').trim();
  const key = String(appId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error('Identificador do estabelecimento inválido.');
  if (key.length < 12 || key.length > 500) throw new Error('AppID Woovi inválido.');
  if (!process.env.WOOVI_WEBHOOK_AUTH_TOKEN) throw new Error('Configure WOOVI_WEBHOOK_AUTH_TOKEN no backend antes de conectar a Ovi.');
  const encrypted = encryptSecret(key);
  await pool.query(
    `INSERT INTO merchant_woovi_accounts
       (store_id,app_id_ciphertext,app_id_iv,app_id_tag,webhook_token_hash,webhook_registered,status,last_error)
     VALUES ($1,$2,$3,$4,$5,FALSE,'pending_webhook',NULL)
     ON CONFLICT (store_id) DO UPDATE SET
       app_id_ciphertext=EXCLUDED.app_id_ciphertext, app_id_iv=EXCLUDED.app_id_iv,
       app_id_tag=EXCLUDED.app_id_tag, webhook_token_hash=EXCLUDED.webhook_token_hash,
       webhook_registered=FALSE, status='pending_webhook', last_error=NULL, updated_at=NOW()`,
    [id, encrypted.ciphertext, encrypted.iv, encrypted.tag,
      crypto.createHash('sha256').update(process.env.WOOVI_WEBHOOK_AUTH_TOKEN).digest('hex')]
  );
  const events = ['OPENPIX:CHARGE_COMPLETED','OPENPIX:CHARGE_EXPIRED','OPENPIX:MOVEMENT_CONFIRMED','OPENPIX:MOVEMENT_FAILED'];
  try {
    for (const event of events) {
      const list = await apiRequest(key, 'GET', '/api/v1/webhook?url=' + encodeURIComponent(WEBHOOK_URL));
      const webhooks = list.webhooks || list.data?.webhooks || [];
      const existing = webhooks.some(item => item.event === event && item.url === WEBHOOK_URL && item.isActive !== false);
      if (!existing) {
        await apiRequest(key, 'POST', '/api/v1/webhook', {
          webhook: { name: 'VianaBar - ' + event, event, url: WEBHOOK_URL,
            authorization: process.env.WOOVI_WEBHOOK_AUTH_TOKEN, isActive: true }
        });
      }
    }
    await pool.query(
      `UPDATE merchant_woovi_accounts SET webhook_registered=TRUE,status='active',last_error=NULL,updated_at=NOW() WHERE store_id=$1`,
      [id]
    );
    await pool.query(
      `INSERT INTO merchant_settings(store_id,settings) VALUES($1,jsonb_build_object('paymentProvider','woovi'))
       ON CONFLICT(store_id) DO UPDATE SET settings=merchant_settings.settings || EXCLUDED.settings,updated_at=NOW()`,
      [id]
    );
    return { storeId: id, provider: 'woovi', status: 'active', webhookRegistered: true };
  } catch (error) {
    const message = String(error.response?.data?.error || error.response?.data?.message || error.message || 'Falha ao registrar webhook').slice(0, 500);
    await pool.query(
      `UPDATE merchant_woovi_accounts SET webhook_registered=FALSE,status='error',last_error=$2,updated_at=NOW() WHERE store_id=$1`,
      [id, message]
    );
    throw new Error('A conta foi protegida no banco, mas o webhook Woovi não foi confirmado: ' + message);
  }
}
function pixKeyType(value) {
  const key = String(value || '').trim();
  const explicit = String(process.env.WOOVI_PLATFORM_PIX_KEY_TYPE || '').toUpperCase();
  if (['CPF','CNPJ','EMAIL','PHONE','RANDOM'].includes(explicit)) return explicit;
  if (/^\d{11}$/.test(key)) return 'CPF';
  if (/^\d{14}$/.test(key)) return 'CNPJ';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return 'EMAIL';
  if (/^\+?\d{10,15}$/.test(key)) return 'PHONE';
  return 'RANDOM';
}
async function createCharge({ storeId, orderId, amountCents, comment }) {
  const account = await getMerchantAccount(storeId);
  if (!account || account.status !== 'active' || !account.webhook_registered) {
    throw new Error('O recebimento pela Ovi ainda não está conectado para este estabelecimento.');
  }
  if (!process.env.WOOVI_PLATFORM_PIX_KEY) {
    throw new Error('A chave Pix da plataforma ainda não foi configurada para o repasse automático da comissão.');
  }
  if (!Number.isSafeInteger(Number(amountCents)) || Number(amountCents) <= 0) throw new Error('Valor da cobrança inválido.');
  const appId = decryptSecret(account);
  const response = await apiRequest(appId, 'POST', '/api/v1/charge?return_existing=true', {
    correlationID: String(orderId), value: Number(amountCents),
    comment: String(comment || ('Pedido ' + orderId)).slice(0, 140)
  });
  const charge = extractCharge(response);
  if (!charge.brCode || !charge.correlationID) throw new Error('A Ovi não retornou o código Pix esperado.');
  return {
    provider: 'woovi', correlationId: String(charge.correlationID),
    providerChargeId: charge.globalID || charge.identifier || charge.id || null,
    status: String(charge.status || 'ACTIVE').toLowerCase(), brCode: charge.brCode,
    qrCodeImage: charge.qrCodeImage || null, paymentLinkUrl: charge.paymentLinkUrl || null,
    expiresAt: charge.expiresDate || null, payload: response
  };
}
async function transferPlatformCommission({ orderId, storeId, amountCents }) {
  const correlationId = 'vianabar-comissao-' + String(orderId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  const existing = await pool.query('SELECT status FROM woovi_commission_transfers WHERE order_id=$1', [String(orderId)]);
  if (existing.rowCount) return existing.rows[0].status;
  if (!process.env.WOOVI_PLATFORM_PIX_KEY) {
    await pool.query(
      `INSERT INTO woovi_commission_transfers(order_id,correlation_id,amount_cents,status,failure_reason)
       VALUES($1,$2,$3,'needs_review','Chave Pix da plataforma não configurada')
       ON CONFLICT(order_id) DO UPDATE SET status='needs_review',failure_reason=EXCLUDED.failure_reason,updated_at=NOW()`,
      [String(orderId), correlationId, amountCents]
    );
    return 'needs_review';
  }
  const account = await getMerchantAccount(storeId);
  if (!account || account.status !== 'active') throw new Error('Conta Ovi do comerciante indisponível para Pix Out.');
  const appId = decryptSecret(account);
  await pool.query(
    `INSERT INTO woovi_commission_transfers(order_id,correlation_id,amount_cents,status)
     VALUES($1,$2,$3,'pending') ON CONFLICT(order_id) DO NOTHING`,
    [String(orderId), correlationId, amountCents]
  );
  try {
    const request = await apiRequest(appId, 'POST', '/api/v1/payment', {
      correlationID: correlationId, destinationAlias: process.env.WOOVI_PLATFORM_PIX_KEY,
      destinationAliasType: pixKeyType(process.env.WOOVI_PLATFORM_PIX_KEY), type: 'PIX_KEY',
      value: Number(amountCents), comment: 'Comissão VianaBar - pedido ' + orderId
    });
    await pool.query(
      `UPDATE woovi_commission_transfers SET status='processing',provider_reference=$2,updated_at=NOW() WHERE order_id=$1`,
      [String(orderId), String(request.id || request.payment?.id || request.correlationID || correlationId)]
    );
    await apiRequest(appId, 'POST', '/api/v1/payment/approve', { correlationID: correlationId });
    return 'processing';
  } catch (error) {
    const message = String(error.response?.data?.error || error.response?.data?.message || error.message || 'Pix Out não confirmado').slice(0, 500);
    await pool.query(
      `UPDATE woovi_commission_transfers SET status='needs_review',failure_reason=$2,updated_at=NOW() WHERE order_id=$1`,
      [String(orderId), message]
    );
    throw new Error('Pedido pago, mas a transferência da comissão exige revisão: ' + message);
  }
}
async function handleWebhook({ payload, rawBody, headers }) {
  const event = String(payload.event || payload.eventType || payload.type || '');
  const charge = payload.charge || payload.data?.charge || {};
  const payment = payload.payment || payload.data?.payment || {};
  const movement = payload.movement || payload.data?.movement || {};
  const correlationId = String(charge.correlationID || payment.correlationID || movement.correlationID || payload.correlationID || '');
  if (!correlationId) throw new Error('Webhook sem correlationID.');
  const authToken = process.env.WOOVI_WEBHOOK_AUTH_TOKEN || '';
  const receivedAuth = headers.authorization || headers['x-openpix-authorization'] || '';
  const normalizedAuth = String(receivedAuth).replace(/^Bearer\s+/i, '').trim();
  const signature = String(headers['x-webhook-signature'] || '');
  const hmacSecret = String(process.env.WOOVI_WEBHOOK_HMAC_SECRET || '');
  let authenticated = Boolean(authToken && constantTimeEqual(normalizedAuth, authToken));
  if (hmacSecret && signature) {
    const expected = crypto.createHmac('sha256', hmacSecret).update(rawBody || Buffer.from(JSON.stringify(payload))).digest('base64');
    authenticated = authenticated || constantTimeEqual(signature, expected);
  }
  if (!authenticated) throw new Error('Assinatura/autorização do webhook inválida.');

  if (event === 'OPENPIX:MOVEMENT_CONFIRMED' || event === 'OPENPIX:MOVEMENT_FAILED') {
    const transfer = await pool.query('SELECT order_id FROM woovi_commission_transfers WHERE correlation_id=$1', [correlationId]);
    if (!transfer.rowCount) return { accepted: true, ignored: true };
    const status = event === 'OPENPIX:MOVEMENT_CONFIRMED' ? 'paid' : 'needs_review';
    await pool.query(
      `UPDATE woovi_commission_transfers SET status=$2,paid_at=CASE WHEN $2='paid' THEN NOW() ELSE paid_at END,updated_at=NOW() WHERE correlation_id=$1`,
      [correlationId, status]
    );
    await pool.query('UPDATE cardapio_payment_transactions SET commission_status=$2,updated_at=NOW() WHERE order_id=$1',
      [transfer.rows[0].order_id, status]);
    return { accepted: true, commissionStatus: status };
  }

  const tx = await pool.query(
    'SELECT id,order_id,store_id,amount_cents,status FROM cardapio_payment_transactions WHERE correlation_id=$1',
    [correlationId]
  );
  if (!tx.rowCount) throw new Error('Cobrança não encontrada para o correlationID recebido.');
  const row = tx.rows[0];
  const eventKey = correlationId + ':' + event;
  const inserted = await pool.query(
    `INSERT INTO woovi_webhook_events(event_key,correlation_id,event_type,payload)
     VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(event_key) DO NOTHING RETURNING id`,
    [eventKey, correlationId, event || 'UNKNOWN', JSON.stringify(payload)]
  );
  if (!inserted.rowCount) return { accepted: true, duplicate: true };

  if (event === 'OPENPIX:CHARGE_COMPLETED') {
    const receivedValue = Number(charge.value ?? payload.value);
    if (!Number.isSafeInteger(receivedValue) || receivedValue !== Number(row.amount_cents)) {
      await pool.query("UPDATE cardapio_payment_transactions SET status='needs_review',updated_at=NOW() WHERE id=$1", [row.id]);
      await pool.query("UPDATE cardapio_orders SET payment_status='needs_review',updated_at=NOW() WHERE id=$1", [row.order_id]);
      return { accepted: true, needsReview: true, reason: 'Valor do webhook diferente do valor do pedido.' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE cardapio_payment_transactions SET status='paid',paid_at=NOW(),provider_payload=$2::jsonb,updated_at=NOW() WHERE id=$1 AND status<>'paid'`,
        [row.id, JSON.stringify(payload)]
      );
      await client.query("UPDATE cardapio_orders SET payment_status='paid',updated_at=NOW() WHERE id=$1", [row.order_id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const commissionCents = Math.round(Number(row.amount_cents) * COMMISSION_PERCENT / 100);
    await pool.query("UPDATE cardapio_payment_transactions SET commission_amount_cents=$2,commission_status='pending' WHERE id=$1",
      [row.id, commissionCents]);
    let commissionStatus = 'pending';
    if (commissionCents > 0) {
      try {
        commissionStatus = await transferPlatformCommission({ orderId: row.order_id, storeId: row.store_id, amountCents: commissionCents });
      } catch (error) {
        console.error('[WOOVI] Comissão requer revisão:', error.message);
        commissionStatus = 'needs_review';
      }
      await pool.query(
        `UPDATE cardapio_payment_transactions SET commission_status=$2,updated_at=NOW() WHERE order_id=$1`,
        [row.order_id, commissionStatus]
      );
    }
    return { accepted: true, paid: true, orderId: row.order_id, commissionStatus };
  }
  if (event === 'OPENPIX:CHARGE_EXPIRED') {
    await pool.query("UPDATE cardapio_payment_transactions SET status='expired',updated_at=NOW() WHERE id=$1 AND status<>'paid'", [row.id]);
    await pool.query("UPDATE cardapio_orders SET payment_status='expired',updated_at=NOW() WHERE id=$1 AND payment_status<>'paid'", [row.order_id]);
  }
  return { accepted: true, event };
}

module.exports = { getMerchantAccount, registerMerchantAccount, createCharge, handleWebhook, pool };
