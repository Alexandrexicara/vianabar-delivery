const https = require('https');
const axios = require('axios');

const AUTH_URL = process.env.SICOOB_AUTH_URL || 'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token';
const API_URL = (process.env.SICOOB_API_BASE_URL || 'https://api.sicoob.com.br/pix/api/v2').replace(/\/+$/, '');
let cachedToken = null;
let tokenExpiresAt = 0;

function certificateAgent() {
  const pfx64 = process.env.SICOOB_MTLS_PFX_BASE64;
  if (!pfx64) throw new Error('SICOOB_MTLS_PFX_BASE64 não configurado.');
  return new https.Agent({
    pfx: Buffer.from(pfx64, 'base64'),
    passphrase: process.env.SICOOB_MTLS_PFX_PASSWORD || '',
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true
  });
}

function status() {
  return {
    configured: Boolean(process.env.SICOOB_CLIENT_ID && process.env.SICOOB_CLIENT_SECRET && process.env.SICOOB_MTLS_PFX_BASE64),
    clientIdConfigured: Boolean(process.env.SICOOB_CLIENT_ID),
    clientSecretConfigured: Boolean(process.env.SICOOB_CLIENT_SECRET),
    certificateConfigured: Boolean(process.env.SICOOB_MTLS_PFX_BASE64),
    apiBaseUrl: API_URL
  };
}

async function token() {
  if (cachedToken && tokenExpiresAt > Date.now() + 30000) return cachedToken;
  const clientId = process.env.SICOOB_CLIENT_ID;
  const clientSecret = process.env.SICOOB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Credenciais Sicoob ainda não configuradas.');
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: process.env.SICOOB_SCOPES || 'cob.read cob.write pix.read'
  }).toString();
  const response = await axios.post(AUTH_URL, form, {
    httpsAgent: certificateAgent(),
    auth: { username: clientId, password: clientSecret },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000
  });
  if (!response.data.access_token) throw new Error('Token OAuth do Sicoob não retornado.');
  cachedToken = response.data.access_token;
  tokenExpiresAt = Date.now() + Math.max(60, Number(response.data.expires_in || 300)) * 1000;
  return cachedToken;
}

async function api(method, path, data) {
  const accessToken = await token();
  const response = await axios({
    method,
    url: API_URL + path,
    data,
    httpsAgent: certificateAgent(),
    headers: {
      Authorization: 'Bearer ' + accessToken,
      client_id: process.env.SICOOB_CLIENT_ID,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    timeout: 25000
  });
  return response.data;
}

module.exports = { status, api };
