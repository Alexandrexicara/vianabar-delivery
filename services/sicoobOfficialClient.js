const https = require('https');
const axios = require('axios');
const homologation = String(process.env.SICOOB_ENVIRONMENT || '').toLowerCase() === 'homologation';
const AUTH_URL = process.env.SICOOB_AUTH_URL || (homologation ? 'https://api-homol.sicoob.com.br/cooperado/pix/token' : 'https://apis.sisbr.com.br/cooperado/pix/token');
const API_URL = (process.env.SICOOB_API_BASE_URL || (homologation ? 'https://api-homol.sicoob.com.br/cooperado/pix/api/v2' : 'https://apis.sisbr.com.br/cooperado/pix/api/v2')).replace(/\/+$/, '');
let tokenValue = null;
let expiresAt = 0;
function agent() {
  const value = process.env.SICOOB_MTLS_PFX_BASE64;
  if (!value) throw new Error('Certificado mTLS do Sicoob não configurado.');
  return new https.Agent({ pfx: Buffer.from(value, 'base64'), passphrase: process.env.SICOOB_MTLS_PFX_PASSWORD || '', minVersion: 'TLSv1.2' });
}
function status() {
  return { configured: Boolean(process.env.SICOOB_CLIENT_ID && process.env.SICOOB_CLIENT_SECRET && process.env.SICOOB_MTLS_PFX_BASE64), clientIdConfigured: Boolean(process.env.SICOOB_CLIENT_ID), clientSecretConfigured: Boolean(process.env.SICOOB_CLIENT_SECRET), certificateConfigured: Boolean(process.env.SICOOB_MTLS_PFX_BASE64), apiBaseUrl: API_URL, environment: homologation ? 'homologation' : 'production' };
}
async function getToken() {
  if (tokenValue && expiresAt > Date.now() + 30000) return tokenValue;
  const clientId = process.env.SICOOB_CLIENT_ID || '';
  const clientSecret = process.env.SICOOB_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new Error('Credenciais Sicoob ainda não configuradas.');
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: process.env.SICOOB_SCOPES || 'cob.read' }).toString();
  const response = await axios.post(AUTH_URL, form, { httpsAgent: agent(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
  tokenValue = response.data?.access_token;
  if (!tokenValue) throw new Error('Sicoob não retornou access_token.');
  expiresAt = Date.now() + Math.max(60, Number(response.data.expires_in || 300)) * 1000;
  return tokenValue;
}
async function request(method, path, data) {
  const accessToken = await getToken();
  const response = await axios({ method, url: API_URL + path, data, httpsAgent: agent(), headers: { Authorization: 'Bearer ' + accessToken, client_id: process.env.SICOOB_CLIENT_ID, Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 25000 });
  return response.data;
}
module.exports = { status, request };
