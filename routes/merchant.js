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
    const inserted = await query(
      `INSERT INTO merchants
       (establishment_name, store_slug, owner_name, email, phone, document_type, document_number,
        password_hash, pix_key, pix_key_type, pix_collection_consent_at, status,
        split_mode, commission_percent)
       VALUES ($1,$2,$3,LOWER($4),$5,$6,$7,$8,$9,$10,NOW(),'pending','SPLIT_SUB_ACCOUNT',15)
       RETURNING id, establishment_name, store_slug, owner_name, email, document_type, status`,
      [establishmentName.trim(), makeStoreSlug(establishmentName), adminName.trim(), email.trim(), phone.trim(), type, doc,
       hashPassword(password), pixKey.trim(), keyType]
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
  const result = await query('SELECT id, establishment_name, store_slug, owner_name, email, phone, document_type, document_number, pix_key, pix_key_type, status, payout_suspended, woovi_credentials_verified_at FROM merchants WHERE id=$1', [req.merchant.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, error: 'Comerciante não encontrado.' });
  res.json({ success: true, merchant: result.rows[0] });
});

router.post('/me/woovi', requireMerchant, async (req, res) => {
  try {
    const appId = String(req.body?.appId || '').trim();
    if (!appId) return res.status(400).json({ success: false, error: 'Informe o AppID da Woovi.' });
    const encrypted = encryptSecret(appId);
    const verified = await fetch((process.env.WOOVI_BASE_URL || 'https://api.woovi.com') + '/api/v1/charge?skip=0&limit=1', {
      headers: { Authorization: appId, Accept: 'application/json' }
    });
    const data = await verified.json().catch(() => ({}));
    if (!verified.ok) return res.status(400).json({ success: false, error: data?.errors?.[0]?.message || 'A Woovi recusou o AppID informado.' });
    const publicApiUrl = String(process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
    const webhookToken = process.env.WOOVI_WEBHOOK_AUTH_TOKEN || '';
    const platformPixKey = process.env.PLATFORM_PIX_KEY || '';
    if (!publicApiUrl || !webhookToken || !platformPixKey) {
      return res.status(503).json({ success: false, error: 'Configure PUBLIC_API_URL, WOOVI_WEBHOOK_AUTH_TOKEN e PLATFORM_PIX_KEY no servidor.' });
    }

    // A chave Pix da plataforma é registrada como subconta na conta Woovi do comerciante.
    const subaccountResponse = await fetch((process.env.WOOVI_BASE_URL || 'https://api.woovi.com') + '/api/v1/subaccount', {
      method: 'POST',
      headers: { Authorization: appId, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name: 'Vianas Bar - Comissão da plataforma', pixKey: platformPixKey })
    });
    const subaccountData = await subaccountResponse.json().catch(() => ({}));
    if (!subaccountResponse.ok) {
      return res.status(400).json({ success: false, error: subaccountData?.errors?.[0]?.message || subaccountData?.message || 'A Woovi não habilitou a subconta Pix. Verifique as funcionalidades Split e Subconta.' });
    }

    const webhookUrl = publicApiUrl + '/woovi/webhook';
    for (const event of ['OPENPIX:CHARGE_COMPLETED', 'OPENPIX:MOVEMENT_CONFIRMED', 'OPENPIX:MOVEMENT_FAILED']) {
      const webhookResponse = await fetch((process.env.WOOVI_BASE_URL || 'https://api.woovi.com') + '/api/v1/webhook', {
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
    await query("UPDATE merchants SET woovi_app_id_encrypted=$1, woovi_credentials_verified_at=NOW(), woovi_webhook_registered_at=NOW(), commission_subaccount_ready_at=NOW(), status='active', updated_at=NOW() WHERE id=$2", [encrypted, req.merchant.id]);
    res.json({ success: true, message: 'AppID validado e webhook de confirmação Pix registrado.' });
  } catch (error) {
    console.error('[MERCHANT WOOVI CONFIG]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = { router, requireMerchant, encryptSecret, verifyToken };
