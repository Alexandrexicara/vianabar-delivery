const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query } = require('../database');

const TOKEN_SECRET = process.env.MERCHANT_AUTH_SECRET || '';
const CREDENTIAL_KEY = process.env.MERCHANT_CREDENTIALS_ENCRYPTION_KEY || '';

function b64(value) { return Buffer.from(value).toString('base64url'); }
function issueToken(merchantId) {
  if (!TOKEN_SECRET) throw new Error('MERCHANT_AUTH_SECRET não configurado no servidor');
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ sub: String(merchantId), iat: now, exp: now + 60 * 60 * 24 * 7 }));
  const body = header + '.' + payload;
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return body + '.' + signature;
}
function verifyToken(token) {
  if (!TOKEN_SECRET || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const body = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest();
  let supplied;
  try { supplied = Buffer.from(parts[2], 'base64url'); } catch (_) { return null; }
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { id: Number(payload.sub) };
  } catch (_) { return null; }
}
function requireMerchant(req, res, next) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ success: false, error: 'Sessão inválida ou expirada.' });
  req.merchant = user;
  next();
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function verifyPassword(password, stored) {
  try {
    const [kind, saltHex, hashHex] = String(stored).split('$');
    if (kind !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) { return false; }
}
function onlyDigits(value) { return String(value || '').replace(/\D/g, ''); }
function validCPF(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let d = (sum * 10) % 11; if (d === 10) d = 0;
  if (d !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  d = (sum * 10) % 11; if (d === 10) d = 0;
  return d === Number(cpf[10]);
}
function validCNPJ(value) {
  const c = onlyDigits(value);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const digit = (base) => {
    const weights = base.length === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const sum = base.split('').reduce((s,n,i) => s + Number(n) * weights[i], 0);
    const r = sum % 11; return r < 2 ? 0 : 11 - r;
  };
  return digit(c.slice(0,12)) === Number(c[12]) &&
    digit(c.slice(0,13)) === Number(c[13]);
}
function makeStoreSlug(name) {
  const base = String(name || 'loja').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 55) || 'loja';
  return base + '-' + crypto.randomBytes(3).toString('hex');
}
function decryptSecret(value) {
  if (!value) return null;
  if (!/^[a-f0-9]{64}$/i.test(CREDENTIAL_KEY)) throw new Error('Configure MERCHANT_CREDENTIALS_ENCRYPTION_KEY com 64 caracteres hexadecimais.');
  const [iv64, tag64, data64] = String(value).split('.');
  if (!iv64 || !tag64 || !data64) throw new Error('Chave Pix criptografada em formato inválido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(CREDENTIAL_KEY, 'hex'), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]).toString('utf8');
}
function maskPixKey(value) {
  const key = String(value || '');
  if (key.length <= 6) return '••••';
  return key.slice(0, 3) + '••••••' + key.slice(-3);
}
function normalizePixKey(value, type) {
  const key = String(value || '').trim();
  if (type === 'CPF' || type === 'CNPJ') return key.replace(/\D/g, '');
  if (type === 'PHONE') { const digits = key.replace(/\D/g, ''); return '+' + (digits.startsWith('55') ? digits : '55' + digits); }
  return key;
}
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
function validPixKey(value, type) {
  const key = String(value || '').trim();
  if (type === 'CPF') return validCPF(key);
  if (type === 'CNPJ') return validCNPJ(key);
  if (type === 'EMAIL') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key);
  if (type === 'PHONE') return /^\+55\d{10,11}$/.test(key);
  if (type === 'RANDOM') return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key);
  return false;
}
function encryptSecret(value) {
  if (!/^[a-f0-9]{64}$/i.test(CREDENTIAL_KEY)) throw new Error('Configure MERCHANT_CREDENTIALS_ENCRYPTION_KEY com 64 caracteres hexadecimais.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(CREDENTIAL_KEY, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64')).join('.');
}

router.post('/register', async (req, res) => {
  try {
    if (!TOKEN_SECRET) return res.status(503).json({ success: false, error: 'MERCHANT_AUTH_SECRET não configurado no servidor.' });
    const { establishmentName, adminName, email, phone, documentType, documentNumber, password, pixKey, pixKeyType, acceptsCommissionCollection } = req.body || {};
    const type = String(documentType || '').toUpperCase();
    const doc = onlyDigits(documentNumber);
    if (!establishmentName || !adminName || !email || !phone || !password || !pixKey) {
      return res.status(400).json({ success: false, error: 'Preencha estabelecimento, responsável, e-mail, telefone, documento, senha e chave Pix.' });
    }
    if (password.length < 8) return res.status(400).json({ success: false, error: 'A senha precisa ter pelo menos 8 caracteres.' });
    if (!['CPF','CNPJ'].includes(type) || !(type === 'CPF' ? validCPF(doc) : validCNPJ(doc))) {
      return res.status(400).json({ success: false, error: 'CPF ou CNPJ inválido.' });
    }
    if (acceptsCommissionCollection !== true) return res.status(400).json({ success: false, error: 'É necessário autorizar expressamente a cobrança das comissões vencidas via Pix.' });
    const allowedPixTypes = ['CPF','CNPJ','EMAIL','PHONE','RANDOM'];
    const keyType = String(pixKeyType || '').toUpperCase();
    if (!allowedPixTypes.includes(keyType)) return res.status(400).json({ success: false, error: 'Tipo de chave Pix inválido.' });
    const normalizedPixKey = normalizePixKey(pixKey, keyType);
    if (!validPixKey(normalizedPixKey, keyType)) return res.status(400).json({ success: false, error: 'A chave Pix não corresponde ao tipo informado.' });
    const encryptedPixKey = encryptSecret(normalizedPixKey);
    const inserted = await query(
      `INSERT INTO merchants
       (establishment_name, store_slug, owner_name, email, phone, document_type, document_number,
        password_hash, pix_key_encrypted, pix_key_type, pix_collection_consent_at, status,
        split_mode, commission_percent)
       VALUES ($1,$2,$3,LOWER($4),$5,$6,$7,$8,$9,$10,NOW(),'pending','SPLIT_SUB_ACCOUNT',15)
       RETURNING id, establishment_name, store_slug, owner_name, email, document_type, status`,
      [establishmentName.trim(), makeStoreSlug(establishmentName), adminName.trim(), email.trim(), phone.trim(), type, doc,
       hashPassword(password), encryptedPixKey, keyType]
    );
    const merchant = inserted.rows[0];
    const token = issueToken(merchant.id);
    return res.status(201).json({ success: true, token, merchant });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'Já existe cadastro com este e-mail ou documento.' });
    console.error('[MERCHANT REGISTER]', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const result = await query('SELECT id, password_hash, establishment_name, owner_name, email, document_type, status FROM merchants WHERE LOWER(email)=$1 LIMIT 1', [email]);
    const merchant = result.rows[0];
    if (!merchant || !verifyPassword(password, merchant.password_hash)) return res.status(401).json({ success: false, error: 'E-mail ou senha incorretos.' });
    return res.json({ success: true, token: issueToken(merchant.id), merchant: { id: merchant.id, establishment_name: merchant.establishment_name, owner_name: merchant.owner_name, email: merchant.email, document_type: merchant.document_type, status: merchant.status } });
  } catch (error) {
    console.error('[MERCHANT LOGIN]', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/me', requireMerchant, async (req, res) => {
  const result = await query('SELECT id, establishment_name, store_slug, owner_name, email, phone, document_type, document_number, pix_key, pix_key_encrypted, pix_key_type, status, payout_suspended, woovi_credentials_verified_at, woovi_kyc_status, woovi_onboarding_url, woovi_account_id FROM merchants WHERE id=$1', [req.merchant.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, error: 'Comerciante não encontrado.' });
  const merchant = result.rows[0];
  let originalPixKey = merchant.pix_key_encrypted ? decryptSecret(merchant.pix_key_encrypted) : merchant.pix_key;
  if (originalPixKey && !merchant.pix_key_encrypted) {
    const encrypted = encryptSecret(originalPixKey);
    await query('UPDATE merchants SET pix_key_encrypted=$1, pix_key=NULL WHERE id=$2', [encrypted, merchant.id]);
  }
  const commissions = await query(
    `SELECT GREATEST(0, COALESCE(SUM(c.commission_amount_cents-c.paid_cents),0)-m.commission_credit_cents)::bigint AS overdue_cents
       FROM merchants m LEFT JOIN merchant_commissions c ON c.merchant_id=m.id AND c.due_at<=NOW()
      WHERE m.id=$1 GROUP BY m.id`, [merchant.id]
  );
  const overdue = Number(commissions.rows[0]?.overdue_cents || 0);
  res.json({ success: true, merchant: {
    ...merchant, pix_key: originalPixKey || null, pix_key_masked: maskPixKey(originalPixKey),
    pix_key_encrypted: undefined, overdue_cents: overdue,
    pix_receiving_key_status: overdue > 0 ? 'temporarily_replaced_by_platform' : 'merchant_key_active',
    active_pix_recipient: overdue > 0 ? 'platform' : 'merchant'
  }});
});

router.get('/me/commissions', requireMerchant, async (req, res) => {
  try {
    const summary = await query(
      `SELECT (GREATEST(0, COALESCE(SUM(CASE WHEN c.due_at <= NOW() THEN c.commission_amount_cents-c.paid_cents ELSE 0 END),0)-m.commission_credit_cents)>0) AS payout_suspended,
        m.commission_credit_cents,
        GREATEST(0, COALESCE(SUM(CASE WHEN c.due_at <= NOW() THEN c.commission_amount_cents-c.paid_cents ELSE 0 END),0)-m.commission_credit_cents)::bigint AS overdue_cents,
        COALESCE(SUM(c.commission_amount_cents-c.paid_cents),0)::bigint AS total_open_cents
       FROM merchants m LEFT JOIN merchant_commissions c ON c.merchant_id=m.id
       WHERE m.id=$1 GROUP BY m.id`,
      [req.merchant.id]
    );
    const rows = await query(
      `SELECT sale_amount_cents, commission_amount_cents, paid_cents, due_at, created_at
         FROM merchant_commissions WHERE merchant_id=$1
        ORDER BY due_at DESC LIMIT 30`,
      [req.merchant.id]
    );
    res.json({ success: true, summary: summary.rows[0] || {}, commissions: rows.rows });
  } catch (error) {
    console.error('[MERCHANT COMMISSIONS]', error);
    res.status(500).json({ success: false, error: 'Não foi possível consultar as comissões.' });
  }
});

router.post('/me/woovi', requireMerchant, async (req, res) => {
  try {
    let appId = String(req.body?.appId || '').trim();
    if (!appId) {
      const saved = await query('SELECT woovi_app_id_encrypted FROM merchants WHERE id=$1', [req.merchant.id]);
      if (saved.rows[0]?.woovi_app_id_encrypted) appId = decryptSecret(saved.rows[0].woovi_app_id_encrypted);
    }
    if (!appId) return res.status(400).json({ success: false, error: 'Informe o AppID da Woovi ou conclua o cadastro PF pela opção BaaS.' });
    const merchantResult = await query('SELECT pix_key, pix_key_encrypted, pix_key_type, establishment_name FROM merchants WHERE id=$1', [req.merchant.id]);
    const merchantRow = merchantResult.rows[0];
    if (!merchantRow) return res.status(404).json({ success: false, error: 'Comerciante não encontrado.' });
    let merchantPixKey = merchantRow.pix_key_encrypted ? decryptSecret(merchantRow.pix_key_encrypted) : merchantRow.pix_key;
    if (!merchantPixKey) return res.status(400).json({ success: false, error: 'Cadastre uma chave Pix válida antes de conectar a Woovi.' });
    const merchantPixType = String(merchantRow.pix_key_type || inferPixKeyType(merchantPixKey) || '').toUpperCase();
    const platformPixKey = normalizePixKey(process.env.PLATFORM_PIX_KEY || '', String(process.env.PLATFORM_PIX_KEY_TYPE || inferPixKeyType(process.env.PLATFORM_PIX_KEY || '') || '').toUpperCase());
    const platformPixType = String(process.env.PLATFORM_PIX_KEY_TYPE || inferPixKeyType(platformPixKey) || '').toUpperCase();
    const validPixTypes = ['CPF','CNPJ','EMAIL','PHONE','RANDOM'];
    if (!validPixTypes.includes(String(merchantPixType).toUpperCase()) || !validPixTypes.includes(platformPixType)) return res.status(400).json({ success: false, error: 'Informe tipos válidos para a chave Pix do comerciante e da plataforma (CPF, CNPJ, EMAIL, PHONE ou RANDOM).'});
    merchantPixKey = normalizePixKey(merchantPixKey, String(merchantPixType).toUpperCase());
    if (!validPixKey(merchantPixKey, String(merchantPixType).toUpperCase())) return res.status(400).json({ success: false, error: 'A chave Pix cadastrada não corresponde ao tipo informado.' });
    if (!validPixKey(platformPixKey, platformPixType)) return res.status(503).json({ success: false, error: 'PLATFORM_PIX_KEY e PLATFORM_PIX_KEY_TYPE não formam uma chave Pix válida.' });
    const encrypted = encryptSecret(appId);
    const publicApiUrl = String(process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
    const webhookToken = process.env.WOOVI_WEBHOOK_AUTH_TOKEN || '';
    if (!publicApiUrl || !webhookToken || !platformPixKey) {
      return res.status(503).json({ success: false, error: 'Configure PUBLIC_API_URL, WOOVI_WEBHOOK_AUTH_TOKEN e PLATFORM_PIX_KEY no servidor.' });
    }

    // Define a chave original do comerciante como destino normal dos saques da conta.
    // Durante atraso, a cobrança é desviada para a subconta da plataforma; a chave normal não é apagada.
    const baseUrl = process.env.WOOVI_BASE_URL || 'https://api.woovi.com';
    const withdrawUrl = baseUrl + '/api/v1/pix-keys/withdraw';
    let withdrawResponse = await fetch(withdrawUrl, {
      method: 'POST',
      headers: { Authorization: appId, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ pixKey: merchantPixKey, pixKeyType: merchantPixType })
    });
    let withdrawData = await withdrawResponse.json().catch(() => ({}));
    if (!withdrawResponse.ok) {
      const withdrawError = String(withdrawData?.error || withdrawData?.message || withdrawData?.errors?.[0]?.message || '');
      if (withdrawResponse.status === 400 && /já existente|already exists|already registered/i.test(withdrawError)) {
        withdrawResponse = await fetch(withdrawUrl, {
          method: 'PUT',
          headers: { Authorization: appId, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ pixKey: merchantPixKey, pixKeyType: merchantPixType })
        });
        withdrawData = await withdrawResponse.json().catch(() => ({}));
      }
      if (!withdrawResponse.ok) {
        return res.status(400).json({
          success: false,
          error: withdrawData?.error || withdrawData?.message || withdrawData?.errors?.[0]?.message ||
            'A Woovi não permitiu configurar a chave Pix original como destino normal de saque. Habilite a API de chave Pix de saque e os escopos PIX_KEY_WITHDRAW_POST/PUT.'
        });
      }
    }
    // A API devolve subAccounts como objeto { subaccount: {...} } e pagina os resultados.
    const subaccounts = [];
    let skip = 0;
    let hasNextPage = true;
    while (hasNextPage && skip < 1000) {
      const listUrl = baseUrl + '/api/v1/subaccount?skip=' + skip + '&limit=100';
      const subaccountListResponse = await fetch(listUrl, {
        headers: { Authorization: appId, Accept: 'application/json' }
      });
      const subaccountList = await subaccountListResponse.json().catch(() => ({}));
      if (!subaccountListResponse.ok) {
        return res.status(400).json({ success: false, error: subaccountList?.errors?.[0]?.message || 'A conta não possui acesso à funcionalidade Subconta da Woovi.' });
      }
      const raw = subaccountList.subAccounts || subaccountList.subaccounts || subaccountList.accounts || [];
      const pageItems = Array.isArray(raw) ? raw : raw?.subaccount ? (Array.isArray(raw.subaccount) ? raw.subaccount : [raw.subaccount]) : Object.values(raw || {}).filter(item => item && typeof item === 'object');
      subaccounts.push(...pageItems);
      const pageInfo = subaccountList.pageInfo || {};
      hasNextPage = pageInfo.hasNextPage === true;
      skip += Number(pageInfo.limit || 100);
    }
    const hasPlatformSubaccount = subaccounts.some(item => (item.pixKey || item.pix_key) === platformPixKey);
    if (!hasPlatformSubaccount) {
      const subaccountResponse = await fetch(baseUrl + '/api/v1/subaccount', {
        method: 'POST',
        headers: { Authorization: appId, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: 'Vianas Bar - Comissão da plataforma', pixKey: platformPixKey, pixKeyType: platformPixType })
      });
      const subaccountData = await subaccountResponse.json().catch(() => ({}));
      if (!subaccountResponse.ok) {
        return res.status(400).json({ success: false, error: subaccountData?.errors?.[0]?.message || subaccountData?.message || 'Não foi possível criar a subconta Pix da plataforma.' });
      }
    }

    const webhookUrl = publicApiUrl + '/woovi/webhook';
    const existingHooksResponse = await fetch(baseUrl + '/api/v1/webhook?url=' + encodeURIComponent(webhookUrl), {
      headers: { Authorization: appId, Accept: 'application/json' }
    });
    const existingHooksData = await existingHooksResponse.json().catch(() => ({}));
    if (!existingHooksResponse.ok) {
      return res.status(400).json({ success: false, error: existingHooksData?.errors?.[0]?.message || 'Não foi possível consultar os webhooks da Woovi.' });
    }
    const existingHooks = existingHooksData.webhooks || [];
    for (const event of ['OPENPIX:CHARGE_COMPLETED', 'OPENPIX:MOVEMENT_CONFIRMED', 'OPENPIX:MOVEMENT_FAILED']) {
      const exists = existingHooks.some(hook => hook.event === event && hook.url === webhookUrl && hook.isActive !== false);
      if (exists) continue;
      const webhookResponse = await fetch(baseUrl + '/api/v1/webhook', {
        method: 'POST',
        headers: { Authorization: appId, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ webhook: {
          name: 'Vianas Bar Delivery - ' + event,
          event,
          url: webhookUrl,
          authorization: webhookToken,
          isActive: true
        } })
      });
      const webhookData = await webhookResponse.json().catch(() => ({}));
      if (!webhookResponse.ok) {
        return res.status(400).json({ success: false, error: webhookData?.errors?.[0]?.message || webhookData?.message || 'Não foi possível registrar o webhook ' + event + '.' });
      }
    }
    await query("UPDATE merchants SET woovi_app_id_encrypted=$1, pix_key_encrypted=COALESCE(pix_key_encrypted,$2), pix_key=NULL, woovi_credentials_verified_at=NOW(), woovi_webhook_registered_at=NOW(), commission_subaccount_ready_at=NOW(), status='active', updated_at=NOW() WHERE id=$3", [encrypted, encryptSecret(merchantPixKey), req.merchant.id]);
    res.json({ success: true, message: 'AppID validado e webhook de confirmação Pix registrado.' });
  } catch (error) {
    console.error('[MERCHANT WOOVI CONFIG]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = { router, requireMerchant, encryptSecret, verifyToken };
