'use strict';
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const { requireMerchant } = require('./merchantAuth');

// Usa o mesmo sinal de sessão administrativa já adotado pela API de produtos.
const requireMerchantAdmin = requireMerchant;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.mimetype)) {
      return cb(new Error('Envie uma imagem PNG, JPG, WEBP ou GIF.'));
    }
    cb(null, true);
  }
});

let schemaReady;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = Promise.all([
      pool.query(`CREATE TABLE IF NOT EXISTS merchant_settings (
        store_id VARCHAR(120) PRIMARY KEY,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`),
      pool.query(`CREATE TABLE IF NOT EXISTS merchant_assets (
        store_id VARCHAR(120) NOT NULL,
        asset_type VARCHAR(20) NOT NULL CHECK (asset_type IN ('logo','background')),
        mime_type VARCHAR(100) NOT NULL,
        file_data BYTEA NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (store_id, asset_type)
      )`)
    ]).catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function validStoreId(value) {
  const storeId = String(value || '').trim();
  return storeId && storeId.length <= 120 && /^[a-zA-Z0-9_-]+$/.test(storeId) ? storeId : null;
}


router.get('/:storeId', async (req, res) => {
  try {
    const storeId = validStoreId(req.params.storeId);
    if (!storeId) return res.status(400).json({ success: false, error: 'Identificador de estabelecimento inválido.' });
    await ensureSchema();
    const result = await pool.query('SELECT settings, updated_at FROM merchant_settings WHERE store_id=$1', [storeId]);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, settings: result.rows[0]?.settings || {}, updatedAt: result.rows[0]?.updated_at || null });
  } catch (error) {
    console.error('[MERCHANT-SETTINGS] Erro ao carregar:', error);
    res.status(500).json({ success: false, error: 'Não foi possível carregar as configurações do estabelecimento.' });
  }
});

router.put('/:storeId', requireMerchantAdmin, async (req, res) => {
  try {
    const storeId = validStoreId(req.params.storeId);
    if (!storeId) return res.status(400).json({ success: false, error: 'Identificador de estabelecimento inválido.' });
    if (storeId !== req.merchant.storeId) return res.status(403).json({success:false,error:'Acesso restrito à própria loja.'});
    const settings = req.body?.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ success: false, error: 'Envie as configurações em formato válido.' });
    }
    const allowed = [
      'establishmentName','establishmentTagline','establishmentAddress','establishmentPhone',
      'establishmentHours','primaryColor','secondaryColor','facebook','instagram','whatsapp',
      'logo','background','establishmentLocation'
    ];
    const safeSettings = {};
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
      const value = settings[key];
      if (key === 'establishmentLocation' && value && typeof value === 'object') {
        const latitude = Number(value.latitude ?? value.lat);
        const longitude = Number(value.longitude ?? value.lng);
        if (Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
          safeSettings[key] = { latitude, longitude, accuracy:Number(value.accuracy)||null, updatedAt:value.updatedAt||new Date().toISOString() };
        }
      } else if (typeof value === 'string') {
        safeSettings[key] = value.slice(0, key === 'logo' || key === 'background' ? 300 : 2000);
      }
    }
    await ensureSchema();
    const result = await pool.query(
      `INSERT INTO merchant_settings (store_id, settings)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (store_id) DO UPDATE
       SET settings = merchant_settings.settings || EXCLUDED.settings, updated_at = NOW()
       RETURNING settings, updated_at`,
      [storeId, JSON.stringify(safeSettings)]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, settings: result.rows[0].settings, updatedAt: result.rows[0].updated_at });
  } catch (error) {
    console.error('[MERCHANT-SETTINGS] Erro ao salvar:', error);
    res.status(500).json({ success: false, error: 'Não foi possível salvar as configurações no banco de dados.' });
  }
});

router.post('/:storeId/assets/:type', requireMerchantAdmin, (req, res, next) => {
  upload.single('image')(req, res, error => error ? res.status(400).json({ success: false, error: error.message }) : next());
}, async (req, res) => {
  try {
    const storeId = validStoreId(req.params.storeId);
    const type = req.params.type;
    if (storeId !== req.merchant.storeId) return res.status(403).json({success:false,error:'Acesso restrito à própria loja.'});
    if (!storeId || !['logo','background'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Estabelecimento ou tipo de imagem inválido.' });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'Selecione uma imagem para enviar.' });
    await ensureSchema();
    await pool.query(
      `INSERT INTO merchant_assets (store_id, asset_type, mime_type, file_data)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (store_id, asset_type) DO UPDATE
       SET mime_type=EXCLUDED.mime_type, file_data=EXCLUDED.file_data, updated_at=NOW()`,
      [storeId, type, req.file.mimetype, req.file.buffer]
    );
    const imageUrl = `/api/merchant-settings/${encodeURIComponent(storeId)}/assets/${type}`;
    await pool.query(
      `INSERT INTO merchant_settings (store_id, settings)
       VALUES ($1, jsonb_build_object($2::text, $3::text))
       ON CONFLICT (store_id) DO UPDATE
       SET settings = merchant_settings.settings || EXCLUDED.settings, updated_at=NOW()`,
      [storeId, type, imageUrl]
    );
    res.json({ success: true, imageUrl });
  } catch (error) {
    console.error('[MERCHANT-ASSETS] Erro ao salvar imagem:', error);
    res.status(500).json({ success: false, error: 'Não foi possível salvar a imagem no banco de dados.' });
  }
});

router.get('/:storeId/assets/:type', async (req, res) => {
  try {
    const storeId = validStoreId(req.params.storeId);
    const type = req.params.type;
    if (!storeId || !['logo','background'].includes(type)) return res.status(400).end();
    await ensureSchema();
    const result = await pool.query(
      'SELECT mime_type, file_data FROM merchant_assets WHERE store_id=$1 AND asset_type=$2',
      [storeId, type]
    );
    if (!result.rowCount) return res.status(404).end();
    res.set('Content-Type', result.rows[0].mime_type);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(result.rows[0].file_data);
  } catch (error) {
    console.error('[MERCHANT-ASSETS] Erro ao carregar imagem:', error);
    res.status(500).end();
  }
});

module.exports = router;
