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
const WOOVI_BASE_URL = String(process.env.WOOVI_BASE_URL || 'https://api.woovi.com').replace(/\/+$/, '');
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

async function ensureSubaccount(appId, name, pixKey) {
  const result = await wooviRequest(appId, '/api/v1/subaccount', {
    method: 'POST', body: JSON.stringify({ name, pixKey })
  });
  const account = result.subAccount || result.SubAccount || result.subaccount || {};
  if (account.withdrawBlocked === true) throw new Error('Subconta Pix bloqueada para saque: ' + name);
}

async function releaseSplitReservations(merchantId, allocations) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of allocations || []) {
      if (item.type === 'motoboy' && item.deliveryId) {
        await client.query('UPDATE motoboy_deliveries SET reserved_cents=GREATEST(0,reserved_cents-$1) WHERE id=$2 AND merchant_id=$3',
          [item.amountCents,item.deliveryId,merchantId]);
      }
      if (item.type === 'platform') {
        for (const debt of item.commissionAllocations || []) {
          await client.query('UPDATE merchant_commissions SET reserved_cents=GREATEST(0,reserved_cents-$1) WHERE id=$2 AND merchant_id=$3',
            [debt.amountCents,debt.commissionId,merchantId]);
        }
      }
    }
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function createMerchantCharge({ merchantId, orderReference, valueCents, description }) {
  if (!Number.isSafeInteger(valueCents) || valueCents < 100) throw new Error('O valor da cobrança deve ser de pelo menos R$ 1,00.');
  const merchantResult = await query(
    'SELECT id,pix_key,pix_key_encrypted,pix_key_type,pix_collection_consent_at,woovi_app_id_encrypted,woovi_credentials_verified_at,woovi_webhook_registered_at,commission_subaccount_ready_at,commission_percent,commission_credit_cents FROM merchants WHERE id=$1',
    [merchantId]
  );
  const merchant = merchantResult.rows[0];
  if (!merchant) throw new Error('Comerciante não encontrado.');
  if (!merchant.woovi_credentials_verified_at || !merchant.woovi_app_id_encrypted ||
      !merchant.woovi_webhook_registered_at || !merchant.commission_subaccount_ready_at) {
    throw new Error('Conecte a Woovi e habilite Split/Subconta antes de receber Pix pelo sistema.');
  }
  const appId = decryptSecret(merchant.woovi_app_id_encrypted);
  const originalPixKey = normalizePixKey(
    merchant.pix_key_encrypted ? decryptSecret(merchant.pix_key_encrypted) : merchant.pix_key,
    String(merchant.pix_key_type || '').toUpperCase()
  );
  if (!originalPixKey) throw new Error('Chave Pix original do comerciante não encontrada.');
  const originalKeyEncrypted = merchant.pix_key_encrypted || encryptPixKey(originalPixKey);
  if (!merchant.pix_key_encrypted) await query('UPDATE merchants SET pix_key_encrypted=$1,pix_key=NULL WHERE id=$2',[originalKeyEncrypted,merchantId]);

  const allocations = [];
  const debtClient = await pool.connect();
  let hadOverdue = false;
  try {
    await debtClient.query('BEGIN');
    await debtClient.query('SELECT pg_advisory_xact_lock($1::bigint)',[Number(merchantId)]);
    await debtClient.query('SELECT id FROM merchants WHERE id=$1 FOR UPDATE',[merchantId]);
    await applyCreditToOverdueCommissions(debtClient,merchantId);

    const courierSql =
      "SELECT d.id AS delivery_id,d.motoboy_id,d.amount_cents,d.paid_cents,d.reserved_cents," +
      " m.name,m.pix_key_encrypted,m.pix_key_type FROM motoboy_deliveries d " +
      "JOIN motoboys m ON m.id=d.motoboy_id " +
      "WHERE d.merchant_id=$1 AND d.due_at<=NOW() AND d.paid_cents+d.reserved_cents<d.amount_cents AND m.status='active' " +
      "ORDER BY d.due_at ASC,d.id ASC FOR UPDATE OF d";
    const couriers = await debtClient.query(courierSql,[merchantId]);
    const commissionSql =
      "SELECT id,commission_amount_cents,paid_cents,reserved_cents FROM merchant_commissions " +
      "WHERE merchant_id=$1 AND due_at<=NOW() AND paid_cents+reserved_cents<commission_amount_cents " +
      "ORDER BY due_at ASC,id ASC FOR UPDATE";
    const commissions = await debtClient.query(commissionSql,[merchantId]);

    const courierDebtTotal = couriers.rows.reduce((sum,row)=>sum+Number(row.amount_cents)-Number(row.paid_cents)-Number(row.reserved_cents||0),0);
    const commissionDebtTotal = commissions.rows.reduce((sum,row)=>sum+Number(row.commission_amount_cents)-Number(row.paid_cents)-Number(row.reserved_cents||0),0);
    hadOverdue = courierDebtTotal>0 || commissionDebtTotal>0;
    let remaining = valueCents;

    // Prioridade 1: motoboys vencidos, por ordem de vencimento e entrega.
    for (const row of couriers.rows) {
      if (remaining<=0) break;
      const available=Number(row.amount_cents)-Number(row.paid_cents)-Number(row.reserved_cents||0);
      const amount=Math.min(remaining,available);
      if(amount<=0)continue;
      if(!row.pix_key_encrypted)throw new Error('Motoboy sem chave Pix criptografada: '+row.motoboy_id);
      await debtClient.query('UPDATE motoboy_deliveries SET reserved_cents=reserved_cents+$1 WHERE id=$2',[amount,row.delivery_id]);
      allocations.push({type:'motoboy',motoboyId:Number(row.motoboy_id),deliveryId:Number(row.delivery_id),
        amountCents:amount,recipientPixKeyEncrypted:row.pix_key_encrypted,recipientName:row.name});
      remaining-=amount;
    }

    // Prioridade 2: comissão da plataforma vencida, mantendo o prazo original de sete dias.
    const commissionAllocations=[];
    for(const row of commissions.rows){
      if(remaining<=0)break;
      const available=Number(row.commission_amount_cents)-Number(row.paid_cents)-Number(row.reserved_cents||0);
      const amount=Math.min(remaining,available);
      if(amount<=0)continue;
      await debtClient.query('UPDATE merchant_commissions SET reserved_cents=reserved_cents+$1 WHERE id=$2',[amount,row.id]);
      commissionAllocations.push({commissionId:Number(row.id),amountCents:amount});
      remaining-=amount;
    }
    const platformAmount=commissionAllocations.reduce((sum,item)=>sum+item.amountCents,0);
    if(platformAmount>0){
      if(!merchant.pix_collection_consent_at)throw new Error('O comerciante ainda não autorizou a cobrança automática das comissões vencidas.');
      if(!PLATFORM_PIX_KEY)throw new Error('PLATFORM_PIX_KEY não configurada.');
      allocations.push({type:'platform',amountCents:platformAmount,
        recipientPixKeyEncrypted:encryptPixKey(PLATFORM_PIX_KEY),commissionAllocations});
    }

    // Quitadas as pendências vencidas, o restante segue para o comerciante.
    if(remaining>0)allocations.push({type:'merchant',amountCents:remaining,recipientPixKeyEncrypted:originalKeyEncrypted});
    if(!allocations.length)throw new Error('Não foi possível definir os destinatários do Pix.');

    // Garante uma subconta para cada recebedor antes de publicar a cobrança.
    const ensured=new Set();
    for(const item of allocations){
      const key=decryptSecret(item.recipientPixKeyEncrypted);
      if(ensured.has(key))continue;
      const label=item.type==='motoboy'?'Motoboy '+item.motoboyId:item.type==='platform'?'Comissão da plataforma':'Recebimento do comerciante';
      await ensureSubaccount(appId,'Vianas Bar - '+label,key);
      ensured.add(key);
    }
    await debtClient.query('UPDATE merchants SET payout_suspended=$1 WHERE id=$2',[hadOverdue,merchantId]);
    await debtClient.query('COMMIT');
  }catch(error){await debtClient.query('ROLLBACK');throw error;}
  finally{debtClient.release();}

  const payload={
    correlationID:crypto.randomUUID(),
    value:valueCents,
    comment:String(description||('Pedido '+orderReference)).slice(0,140),
    splits:allocations.map(item=>({value:item.amountCents,pixKey:decryptSecret(item.recipientPixKeyEncrypted),splitType:'SPLIT_SUB_ACCOUNT'}))
  };
  const arrearsSplit=allocations.filter(item=>item.type!=='merchant').reduce((sum,item)=>sum+item.amountCents,0);
  const recipientType=allocations.length===1?allocations[0].type:'mixed';
  const pending=await query(
    "INSERT INTO woovi_charges (merchant_id,order_reference,correlation_id,amount_cents,arrears_split_cents,recipient_type,split_allocations,status) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'creating') " +
    "RETURNING id,correlation_id,status,amount_cents,arrears_split_cents,split_allocations",
    [merchantId,String(orderReference),payload.correlationID,valueCents,arrearsSplit,recipientType,JSON.stringify(allocations)]
  );
  try{
    const response=await wooviRequest(appId,'/api/v1/charge',{method:'POST',body:JSON.stringify(payload)});
    const charge=response.charge||response;
    const updated=await query(
      "UPDATE woovi_charges SET woovi_charge_id=$1,status=CASE WHEN status='creating' THEN 'pending' ELSE status END,br_code=$2,payment_link_url=$3 " +
      "WHERE id=$4 RETURNING id,correlation_id,status,br_code,payment_link_url,amount_cents,arrears_split_cents",
      [charge.identifier||charge.transactionID||null,response.brCode||charge.brCode||null,charge.paymentLinkUrl||null,pending.rows[0].id]
    );
    return {success:true,charge:updated.rows[0],qrCode:response.brCode||charge.brCode||null,
      qrCodeImage:response.qrCodeImage||charge.qrCodeImage||null,paymentLinkUrl:charge.paymentLinkUrl||null};
  }catch(error){
    await query("UPDATE woovi_charges SET status='failed' WHERE id=$1 AND status='creating'",[pending.rows[0].id]).catch(()=>{});
    await releaseSplitReservations(merchantId,allocations).catch(releaseError=>console.error('[WOOVI RESERVATION RELEASE]',releaseError));
    throw error;
  }
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

async function applyCreditToOverdueCommissions(client, merchantId) {
  const merchant = await client.query('SELECT commission_credit_cents FROM merchants WHERE id=$1 FOR UPDATE', [merchantId]);
  let credit = Number(merchant.rows[0]?.commission_credit_cents || 0);
  if (credit <= 0) return 0;
  const due = await client.query(
    `SELECT id, commission_amount_cents, paid_cents
       FROM merchant_commissions
      WHERE merchant_id=$1 AND due_at <= NOW() AND paid_cents < commission_amount_cents
      ORDER BY due_at ASC, id ASC FOR UPDATE`,
    [merchantId]
  );
  for (const row of due.rows) {
    if (credit <= 0) break;
    const remaining = Number(row.commission_amount_cents) - Number(row.paid_cents);
    const applied = Math.min(credit, remaining);
    if (applied > 0) {
      await client.query('UPDATE merchant_commissions SET paid_cents=paid_cents+$1 WHERE id=$2', [applied, row.id]);
      credit -= applied;
    }
  }
  const used = Number(merchant.rows[0]?.commission_credit_cents || 0) - credit;
  if (used > 0) await client.query('UPDATE merchants SET commission_credit_cents=$1 WHERE id=$2', [credit, merchantId]);
  return credit;
}

async function applyArrearsPayment(client, merchantId, amountCents) {
  await applyCreditToOverdueCommissions(client, merchantId);
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

async function requestSubaccountWithdrawal(record) {
  const payoutType = record.recipient_type || (Number(record.arrears_split_cents) > 0 ? 'platform' : 'merchant');
  const lockClient = await pool.connect();
  const lockId = Number(record.merchant_id);
  let locked = false;
  let withdrawalCorrelationID = null;
  let pendingWebhookPayload = null;
  try {
    // Evita saques concorrentes da mesma conta Woovi.
    await lockClient.query('SELECT pg_advisory_lock($1::bigint)', [lockId]);
    locked = true;
    const previous = await lockClient.query(
      'SELECT correlation_id, status FROM woovi_payouts WHERE charge_id=$1 ORDER BY created_at DESC LIMIT 1',
      [record.id]
    );
    if (previous.rows[0] && previous.rows[0].status !== 'failed') {
      withdrawalCorrelationID = previous.rows[0].correlation_id;
    } else {
      const merchantResult = await lockClient.query(
        'SELECT woovi_app_id_encrypted, pix_key, pix_key_encrypted, pix_key_type FROM merchants WHERE id=$1',
        [record.merchant_id]
      );
      const merchant = merchantResult.rows[0];
      const appId = decryptSecret(merchant?.woovi_app_id_encrypted);
      const merchantPixKey = merchant?.pix_key_encrypted ? decryptSecret(merchant.pix_key_encrypted) : merchant?.pix_key;
      const recipientPixKey = payoutType === 'platform'
        ? PLATFORM_PIX_KEY
        : normalizePixKey(merchantPixKey, String(merchant?.pix_key_type || inferPixKeyType(merchantPixKey) || '').toUpperCase());
      if (!recipientPixKey) throw new Error('Chave Pix da subconta de recebimento não encontrada.');
      const path = '/api/v1/subaccount/' + encodeURIComponent(recipientPixKey) + '/withdraw';
      // Retira exatamente o valor desta venda, sem misturar saldo de cobranças diferentes.
      const response = await wooviRequest(appId, path, {
        method: 'POST',
        body: JSON.stringify({ value: Number(record.amount_cents) })
      });
      const transaction = response.transaction || {};
      withdrawalCorrelationID = transaction.correlationID;
      const amountCents = Number(transaction.value || record.amount_cents);
      if (!withdrawalCorrelationID || !Number.isSafeInteger(amountCents) || amountCents !== Number(record.amount_cents)) {
        throw new Error('A Woovi não confirmou a retirada pelo valor exato da cobrança.');
      }
      await lockClient.query(
        `INSERT INTO woovi_payouts (merchant_id, charge_id, correlation_id, amount_cents, status, payload, payout_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (correlation_id) DO NOTHING`,
        [record.merchant_id, record.id, withdrawalCorrelationID, amountCents, String(transaction.status || 'CREATED').toLowerCase(), response, payoutType]
      );
    }
    const earlyWebhook = await lockClient.query('SELECT payload FROM woovi_pending_movements WHERE correlation_id=$1 LIMIT 1', [withdrawalCorrelationID]);
    pendingWebhookPayload = earlyWebhook.rows[0]?.payload || null;
  } finally {
    if (locked) await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]).catch(() => {});
    lockClient.release();
  }
  if (pendingWebhookPayload) {
    await processMovementEvent(pendingWebhookPayload);
    await query('DELETE FROM woovi_pending_movements WHERE correlation_id=$1', [withdrawalCorrelationID]);
  }
}

async function processChargeCompleted(body) {
  const charge = body?.charge || {};
  const correlationID = charge.correlationID || body?.correlationID;
  if (!correlationID) throw new Error('Webhook sem correlationID.');
  const client = await pool.connect();
  let record = null;
  let duplicateEvent = false;
  try {
    await client.query('BEGIN');
    const eventKey = String(body.event || 'OPENPIX:CHARGE_COMPLETED') + ':' + correlationID;
    const event = await client.query(
      'INSERT INTO woovi_webhook_events (event_key,event_type,correlation_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_key',
      [eventKey, body.event || 'OPENPIX:CHARGE_COMPLETED', correlationID, body]
    );
    duplicateEvent = !event.rowCount;
    const found = await client.query('SELECT * FROM woovi_charges WHERE correlation_id=$1 FOR UPDATE', [correlationID]);
    record = found.rows[0];
    if (!record) throw new Error('Cobrança não encontrada para este correlationID.');
    if (Number(charge.value ?? record.amount_cents) !== Number(record.amount_cents)) throw new Error('Valor confirmado difere do valor cobrado.');
    if (!duplicateEvent && record.status !== 'paid') {
      await client.query("UPDATE woovi_charges SET status='paid', paid_at=NOW() WHERE id=$1", [record.id]);
      const rateResult = await client.query('SELECT commission_percent FROM merchants WHERE id=$1', [record.merchant_id]);
      const rate = Number(rateResult.rows[0]?.commission_percent || 15);
      const commission = Math.round(Number(record.amount_cents) * rate / 100);
      const inserted = await client.query(
        `INSERT INTO merchant_commissions (merchant_id, charge_id, sale_amount_cents, commission_amount_cents, due_at)
         VALUES ($1,$2,$3,$4,NOW() + INTERVAL '7 days') RETURNING id`,
        [record.merchant_id, record.id, record.amount_cents, commission]
      );
      await applyCreditToOverdueCommissions(client, record.merchant_id);
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
  if (record) await requestSubaccountWithdrawal(record);
  return { processed: !duplicateEvent, duplicate: duplicateEvent, correlationID };
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
    if (!payout) {
      const destinationAlias = String(transaction.destinationAlias || body?.destination?.pixKey || '');
      let isKnownMerchantPixKey = false;
      if (destinationAlias) {
        const merchantKeys = await client.query('SELECT pix_key, pix_key_encrypted, pix_key_type FROM merchants');
        isKnownMerchantPixKey = merchantKeys.rows.some(item => {
          const key = item.pix_key_encrypted ? decryptSecret(item.pix_key_encrypted) : item.pix_key;
          return key && normalizePixKey(key, String(item.pix_key_type || inferPixKeyType(key) || '').toUpperCase()) === destinationAlias;
        });
      }
      if (!destinationAlias || destinationAlias === PLATFORM_PIX_KEY || isKnownMerchantPixKey) {
        await client.query(
          'INSERT INTO woovi_pending_movements (correlation_id,event_type,payload) VALUES ($1,$2,$3) ON CONFLICT (correlation_id) DO NOTHING',
          [correlationID, eventType, body]
        );
        await client.query('COMMIT');
        return { queued: true };
      }
      await client.query('COMMIT');
      return { ignored: true };
    }
    const eventKey = eventType + ':' + correlationID;
    const event = await client.query(
      'INSERT INTO woovi_webhook_events (event_key,event_type,correlation_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_key',
      [eventKey, eventType, correlationID, body]
    );
    if (!event.rowCount) { await client.query('COMMIT'); return { duplicate: true }; }
    if (eventType === 'OPENPIX:MOVEMENT_CONFIRMED' && payout.status !== 'confirmed') {
      const value = Number(transaction.value || payout.amount_cents);
      if ((payout.payout_type || 'platform') === 'platform') await applyArrearsPayment(client, payout.merchant_id, value);
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
