'use strict';
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const { requireCreator } = require('./creatorAuth');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000
});
const ASSET_KEYS = new Set(['logo','appIcon','splash','loginBackground','banner']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req,file,cb) => {
    if (!['image/png','image/jpeg','image/webp'].includes(file.mimetype)) return cb(new Error('Envie uma imagem PNG, JPG ou WEBP.'));
    cb(null,true);
  }
});
let schemaReady;
function ensureSchema() {
  if (!schemaReady) schemaReady = pool.query(`
    CREATE TABLE IF NOT EXISTS platform_brand_assets (
      asset_key VARCHAR(40) PRIMARY KEY,
      mime_type VARCHAR(100) NOT NULL,
      file_data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(error => { schemaReady = null; throw error; });
  return schemaReady;
}
router.get('/', async (_req,res) => {
  try {
    await ensureSchema();
    const result = await pool.query('SELECT asset_key, updated_at FROM platform_brand_assets');
    const images = {};
    for (const key of ASSET_KEYS) {
      const row = result.rows.find(item => item.asset_key === key);
      if (row) images[key] = '/api/platform-branding/assets/' + key;
    }
    res.set('Cache-Control','no-store');
    res.json({ success:true, images });
  } catch (error) {
    console.error('[PLATFORM-BRANDING] load:',error);
    res.status(500).json({success:false,error:'Não foi possível carregar a identidade visual.'});
  }
});
router.post('/:key', requireCreator, (req,res,next) => {
  upload.single('image')(req,res,error => error ? res.status(400).json({success:false,error:error.message}) : next());
}, async (req,res) => {
  try {
    const key = String(req.params.key || '');
    if (!ASSET_KEYS.has(key)) return res.status(400).json({success:false,error:'Tipo de imagem não permitido.'});
    if (!req.file) return res.status(400).json({success:false,error:'Selecione uma imagem.'});
    await ensureSchema();
    await pool.query(`
      INSERT INTO platform_brand_assets(asset_key,mime_type,file_data)
      VALUES($1,$2,$3)
      ON CONFLICT(asset_key) DO UPDATE SET mime_type=EXCLUDED.mime_type,file_data=EXCLUDED.file_data,updated_at=NOW()
    `,[key,req.file.mimetype,req.file.buffer]);
    res.set('Cache-Control','no-store');
    res.json({success:true,imageUrl:'/api/platform-branding/assets/'+key});
  } catch (error) {
    console.error('[PLATFORM-BRANDING] save:',error);
    res.status(500).json({success:false,error:'Não foi possível salvar a imagem no PostgreSQL.'});
  }
});
router.get('/assets/:key', async (req,res) => {
  try {
    const key = String(req.params.key || '');
    if (!ASSET_KEYS.has(key)) return res.status(404).end();
    await ensureSchema();
    const result = await pool.query('SELECT mime_type,file_data FROM platform_brand_assets WHERE asset_key=$1',[key]);
    if (!result.rowCount) {
      if (key === 'appIcon' || key === 'logo') return res.redirect(302,'/icons/delivery-day.svg');
      return res.status(404).end();
    }
    res.set('Content-Type',result.rows[0].mime_type);
    res.set('Cache-Control','public, max-age=300');
    res.send(result.rows[0].file_data);
  } catch (error) {
    console.error('[PLATFORM-BRANDING] asset:',error);
    res.status(500).end();
  }
});
module.exports = router;
