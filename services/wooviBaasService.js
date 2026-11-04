const crypto = require('crypto');
const { query } = require('../database');

const WOOVI_BASE_URL = process.env.WOOVI_BASE_URL || 'https://api.woovi.com';

function encryptAppId(value) {
  const keyHex = process.env.MERCHANT_CREDENTIALS_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error('MERCHANT_CREDENTIALS_ENCRYPTION_KEY não configurada.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64')).join('.');
}

async function masterRequest(path, options = {}) {
  const masterAppId = process.env.WOOVI_MASTER_APP_ID || '';
  if (!masterAppId) {
    const error = new Error('Configure WOOVI_MASTER_APP_ID (API Master BaaS) no Render.');
    error.status = 503;
    throw error;
  }
  const response = await fetch(WOOVI_BASE_URL + path, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: masterAppId,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || data?.errors?.[0]?.message || data?.message || 'A Woovi recusou a operação BaaS.');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function ensureMasterKycWebhooks() {
  const publicApiUrl = String(process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  const webhookToken = process.env.WOOVI_MASTER_WEBHOOK_AUTH_TOKEN || '';
  if (!publicApiUrl || !webhookToken) {
    const error = new Error('Configure PUBLIC_API_URL e WOOVI_MASTER_WEBHOOK_AUTH_TOKEN no Render.');
    error.status = 503;
    throw error;
  }
  const webhookUrl = publicApiUrl + '/woovi/kyc-webhook';
  const existingResponse = await masterRequest('/api/v1/webhook?url=' + encodeURIComponent(webhookUrl));
  const existing = Array.isArray(existingResponse.webhooks) ? existingResponse.webhooks : [];
  const events = [
    'ACCOUNT_REGISTER_STEP_UPDATED',
    'ACCOUNT_REGISTER_IN_REVIEW',
    'ACCOUNT_REGISTER_DOCUMENTS_REQUESTED',
    'ACCOUNT_REGISTER_RFI_RESOLVED',
    'ACCOUNT_REGISTER_PENDING',
    'ACCOUNT_REGISTER_APPROVED',
    'ACCOUNT_REGISTER_REJECTED'
  ];
  for (const event of events) {
    if (existing.some(item => item.event === event && item.url === webhookUrl && item.isActive !== false)) continue;
    await masterRequest('/api/v1/webhook', {
      method: 'POST',
      body: JSON.stringify({
        webhook: {
          name: 'Vianas Bar - ' + event,
          event,
          url: webhookUrl,
          authorization: webhookToken,
          isActive: true
        }
      })
    });
  }
  return webhookUrl;
}

async function startCpfOnboarding(merchantId) {
  const result = await query(
    'SELECT id, owner_name, document_type, document_number, woovi_kyc_correlation_id, woovi_onboarding_url, woovi_kyc_status, woovi_app_id_encrypted FROM merchants WHERE id=$1',
    [merchantId]
  );
  const merchant = result.rows[0];
  if (!merchant) {
    const error = new Error('Comerciante não encontrado.');
    error.status = 404;
    throw error;
  }
  if (merchant.document_type !== 'CPF') {
    const error = new Error('O onboarding BaaS por CPF só deve ser usado em cadastros de pessoa física.');
    error.status = 400;
    throw error;
  }
  if (merchant.woovi_app_id_encrypted) {
    return { success: true, alreadyApproved: true, status: merchant.woovi_kyc_status || 'APPROVED', message: 'A conta Woovi PF já foi aprovada. Conclua a ativação da integração.' };
  }

  const webhookUrl = await ensureMasterKycWebhooks();
  const correlationID = merchant.woovi_kyc_correlation_id || ('vianas-merchant-' + merchant.id);
  const response = await masterRequest('/api/v1/kyc/onboarding', {
    method: 'POST',
    body: JSON.stringify({
      taxID: String(merchant.document_number).replace(/\D/g, ''),
      taxIDType: 'BR:CPF',
      officialName: merchant.owner_name,
      correlationID
    })
  });
  const onboardingUrl = response.linkOnboarding || response.accountRegister?.linkOnboarding;
  if (!onboardingUrl) {
    const error = new Error('A Woovi não retornou o link de cadastro PF.');
    error.status = 502;
    throw error;
  }
  await query(
    `UPDATE merchants
        SET woovi_kyc_correlation_id=$1, woovi_onboarding_url=$2,
            woovi_kyc_status=$3, woovi_onboarding_created_at=COALESCE(woovi_onboarding_created_at,NOW()),
            woovi_master_webhook_registered_at=NOW(), updated_at=NOW()
      WHERE id=$4`,
    [correlationID, onboardingUrl, response.accountRegister?.status || 'PENDING', merchantId]
  );
  return { success: true, onboardingUrl, status: response.accountRegister?.status || 'PENDING', webhookUrl };
}

async function processKycWebhook(body) {
  const event = String(body?.event || '');
  const correlationID = body?.accountRegister?.correlationID || body?.correlationID;
  if (!correlationID) throw new Error('Webhook KYC sem correlationID.');
  const result = await query(
    'SELECT id, woovi_app_id_encrypted FROM merchants WHERE woovi_kyc_correlation_id=$1 LIMIT 1',
    [correlationID]
  );
  const merchant = result.rows[0];
  if (!merchant) return { ignored: true, correlationID };

  if (event === 'ACCOUNT_REGISTER_APPROVED') {
    const accountId = body?.account?.accountId;
    if (!accountId) throw new Error('Conta aprovada sem account.accountId.');
    let encryptedAppId = merchant.woovi_app_id_encrypted;
    if (!encryptedAppId) {
      const scopes = String(process.env.WOOVI_ACCOUNT_APP_SCOPES || '').split(',').map(value => value.trim()).filter(Boolean);
      const application = await masterRequest('/api/v1/application', {
        method: 'POST',
        body: JSON.stringify({
          accountId,
          application: {
            name: 'Vianas Bar Delivery - Comerciante ' + merchant.id,
            type: 'API',
            ...(scopes.length ? { scopes } : {})
          }
        })
      });
      const appId = application?.application?.appID || application?.application?.appId || application?.appID;
      if (!appId) throw new Error('A Woovi aprovou a conta, mas não retornou o AppID da conta PF.');
      encryptedAppId = encryptAppId(appId);
    }
    await query(
      `UPDATE merchants SET woovi_account_id=$1, woovi_app_id_encrypted=$2,
        woovi_kyc_status='APPROVED', status='pending_woovi_setup', updated_at=NOW()
       WHERE id=$3`,
      [accountId, encryptedAppId, merchant.id]
    );
    return { approved: true, merchantId: merchant.id, accountId };
  }

  const statusByEvent = {
    'ACCOUNT_REGISTER_STEP_UPDATED': body?.accountRegister?.status || 'PENDING',
    'ACCOUNT_REGISTER_IN_REVIEW': 'IN_REVIEW',
    'ACCOUNT_REGISTER_DOCUMENTS_REQUESTED': 'DOCUMENTS_REQUESTED',
    'ACCOUNT_REGISTER_RFI_RESOLVED': 'PENDING',
    'ACCOUNT_REGISTER_PENDING': 'PENDING',
    'ACCOUNT_REGISTER_REJECTED': 'REJECTED'
  };
  const status = statusByEvent[event];
  if (status) {
    await query('UPDATE merchants SET woovi_kyc_status=$1, updated_at=NOW() WHERE id=$2', [status, merchant.id]);
  }
  return { processed: true, merchantId: merchant.id, status: status || 'UNCHANGED' };
}

module.exports = { startCpfOnboarding, processKycWebhook };
