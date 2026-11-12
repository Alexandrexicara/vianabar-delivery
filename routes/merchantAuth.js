'use strict';

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || process.env.RENDER ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
const COOKIE = 'merchant_session';
const SESSION_SECONDS = 8 *  60 * 60;
const attempts = new Map();
let schemaPromise;

function ensureSchema() {
  if (!schemaPromise) schemaPromise = pool.query(`
    CREATE TABLE IF NOT EXISTS merchant_users (
      id BIGSERIAL PRIMARY KEY,
      store_id VARCHAR(120) NOT NULL,
      email VARCHAR(254) NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(store_id,email)
    );
    CREATE INDEX IF NOT EXISTS merchant_users_email_idx ON merchant_users(LOWER(email));
  `).catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
function cleanStoreId(value) {
  const s = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{1,120}$/.test(s) ? s : null;
}
function cleanEmail(value) {
  const s = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : null;
}
function parseCookies(header) {
  return String(header || '').split(';').reduce((out, part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    return out;
  }, {});
}
function sign(body) {
  const secret = String(process.env.MERCHANT_AUTH_SECRET || '');
  if (secret.length < 32) throw new Error('MERCHANT_AUTH_SECRET precisa ter pelo menos 32 caracteres.');
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}
function sessionFromCookieHeader(header) {
  const token = parseCookies(header)[COOKIE] || '';
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const expected = Buffer.from(sign(parts[0]), 'base64url');
    const supplied = Buffer.from(parts[1], 'base64url');
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (payload.role !== 'admin' || !payload.storeId || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) { return null; }
}
function requireMerchant(req, res, next) {
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    const origin = String(req.get('Origin') || '');
    const allowed = new Set((process.env.ALLOWED_APP_ORIGINS || 'https://delivery-day.netlify.app,https://vianabar-delivery.onrender.com,http://localhost:3002,http://127.0.0.1:3002').split(',').map(value => value.trim()).filter(Boolean));
    if (!allowed.has(origin)) return res.status(403).json({ success:false, error:'Origem não autorizada.' });
  }
  const session = sessionFromCookieHeader(req.headers.cookie);
  if (!session) return res.status(401).json({ success: false, error: 'Sessão do comerciante expirada. Entre novamente.' });
  req.merchant = session;
  next();
}
function setSession(res, user) {
  const body = Buffer.from(JSON.stringify({
    sub: String(user.id), email: user.email, storeId: user.store_id,
    role: user.role, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  })).toString('base64url');
  res.cookie(COOKIE, body + '.' + sign(body), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER),
    sameSite: 'none', path: '/', maxAge: SESSION_SECONDS * 1000
  });
}
function verifyPassword(password, saltHex, hashHex) {
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function rateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, until: now + 15 * 60 * 1000 };
  if (entry.until <= now) { entry.count = 0; entry.until = now + 15 * 60 * 1000; }
  if (entry.count >= 8) { attempts.set(ip, entry); return true; }
  entry.count++;
  attempts.set(ip, entry);
  return false;
}

router.post('/register', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  if (rateLimited(ip)) return res.status(429).json({ success: false, error: 'Muitas tentativas. Aguarde 15 minutos.' });
  const storeId = cleanStoreId(req.body?.storeId);
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!storeId || !email || password.length < 12 || password.length > 200) {
    return res.status(400).json({ success: false, error: 'Informe loja válida, e-mail e senha com pelo menos 12 caracteres.' });
  }
  try {
    await ensureSchema();
    // Cada comerciante pode abrir sua própria loja usando um identificador exclusivo.
    // O cadastro público não exige código secreto nem pré-cadastro manual.
    await pool.query(
      'INSERT INTO merchant_settings(store_id,settings) VALUES($1,$2::jsonb) ON CONFLICT(store_id) DO NOTHING',
      [storeId, JSON.stringify({ establishmentName: storeId })]
    );
    const existing = await pool.query('SELECT id FROM merchant_users WHERE store_id=$1 LIMIT 1', [storeId]);
    if (existing.rowCount) return res.status(409).json({ success:false, error:'Esta loja já possui administrador. Entre com seu e-mail e senha.' });
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    const result = await pool.query(
      `INSERT INTO merchant_users(store_id,email,password_salt,password_hash)
       VALUES($1,$2,$3,$4) RETURNING id,store_id,email,role`,
      [storeId, email, salt.toString('hex'), hash.toString('hex')]
    );
    attempts.delete(ip);
    setSession(res, result.rows[0]);
    res.status(201).json({ success:true, merchant:{ email, storeId } });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success:false, error:'Já existe um administrador cadastrado para esta loja.' });
    console.error('[MERCHANT-AUTH] register:', error.message);
    res.status(500).json({ success:false, error:'Não foi possível concluir o cadastro do comerciante.' });
  }
});

router.post('/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  if (rateLimited(ip)) return res.status(429).json({ success: false, error: 'Muitas tentativas. Aguarde 15 minutos.' });
  const storeId = cleanStoreId(req.body?.storeId);
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!storeId || !email || !password) return res.status(400).json({ success: false, error: 'Informe loja, e-mail e senha.' });
  try {
    await ensureSchema();
    const result = await pool.query(
      'SELECT id,store_id,email,password_salt,password_hash,role FROM merchant_users WHERE store_id=$1 AND email=$2 AND is_active=TRUE LIMIT 1',
      [storeId, email]
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      return res.status(401).json({ success: false, error: 'Loja, e-mail ou senha incorretos.' });
    }
    attempts.delete(ip);
    setSession(res, user);
    res.json({ success: true, merchant: { email: user.email, storeId: user.store_id } });
  } catch (error) {
    console.error('[MERCHANT-AUTH] login:', error.message);
    res.status(500).json({ success: false, error: 'Não foi possível validar o acesso.' });
  }
});
router.get('/session', requireMerchant, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, merchant: { email: req.merchant.email, storeId: req.merchant.storeId, role: req.merchant.role } });
});
router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER), sameSite: 'none', path: '/' });
  res.json({ success: true });
});

module.exports = { router, requireMerchant, sessionFromCookieHeader, pool, ensureSchema };
