'use strict';
const express = require('express');
const { Pool } = require('pg');
const { requireMerchant } = require('./merchantAuth');

const router = express.Router();
const requireAdmin = requireMerchant;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = [
      row.name, row.category, row.sector,
      Number(row.price || 0).toFixed(2), row.description, row.image
    ].map(value => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')).join('\u001f');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const toProduct = (row) => ({
  id: /^\d+$/.test(String(row.id)) ? Number(row.id) : row.id,
  storeId: row.store_id,
  storeName: row.store_name,
  name: row.name,
  category: row.category || '',
  sector: row.sector || 'Cozinha',
  price: Number(row.price || 0).toFixed(2),
  description: row.description || '',
  image: row.image || null,
  active: row.is_active !== false
});

router.get('/showcase', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, store_id, store_name, name, category, sector, price, description, image, is_active, showcase_order
       FROM (
         SELECT mp.*,
                ROW_NUMBER() OVER (PARTITION BY store_id ORDER BY showcase_order ASC, created_at ASC) AS showcase_rank
         FROM menu_products mp
         WHERE is_active = TRUE AND showcase_order IS NOT NULL
       ) featured
       WHERE showcase_rank <= 8
       ORDER BY store_id, showcase_order ASC`
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, products: dedupeRows(result.rows).map(toProduct) });
  } catch (error) {
    console.error('[PRODUCTS] Erro ao carregar vitrine pública:', error);
    res.status(500).json({ success: false, error: 'Não foi possível carregar a vitrine.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const storeId = String(req.query.storeId || 'main').slice(0, 120);
    const result = await pool.query(
      'SELECT id, store_id, store_name, name, category, sector, price, description, image, is_active, showcase_order FROM menu_products WHERE store_id = $1 AND is_active = TRUE ORDER BY created_at ASC',
      [storeId]
    );
    const uniqueRows = dedupeRows(result.rows);
    const products = uniqueRows.map(toProduct);
    const showcase = uniqueRows
      .filter(row => row.showcase_order !== null)
      .sort((a, b) => a.showcase_order - b.showcase_order)
      .map(toProduct);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, products, showcase });
  } catch (error) {
    console.error('[PRODUCTS] Erro ao carregar:', error);
    res.status(500).json({ success: false, error: 'Não foi possível carregar os produtos.' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const item = req.body || {};
    const id = String(item.id || Date.now());
    const name = String(item.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Informe o nome do produto.' });
    const storeId = req.merchant.storeId;
    const storeName = String(item.storeName || 'Cardápio Principal').slice(0, 160);
    const result = await pool.query(
      `INSERT INTO menu_products (id, store_id, store_name, name, category, sector, price, description, image)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET store_name=EXCLUDED.store_name,
       name=EXCLUDED.name, category=EXCLUDED.category, sector=EXCLUDED.sector, price=EXCLUDED.price,
       description=EXCLUDED.description, image=EXCLUDED.image, is_active=TRUE, updated_at=NOW()
       WHERE menu_products.store_id = EXCLUDED.store_id
       RETURNING id, store_id, store_name, name, category, sector, price, description, image, is_active`,
      [id, storeId, storeName, name, item.category || '', item.sector || 'Cozinha', Math.max(0, Number(item.price) || 0), item.description || '', item.image || null]
    );
    if (!result.rowCount) return res.status(409).json({success:false,error:'Identificador de produto já pertence a outra loja.'});
    res.status(201).json({ success: true, product: toProduct(result.rows[0]) });
  } catch (error) {
    console.error('[PRODUCTS] Erro ao salvar:', error);
    res.status(500).json({ success: false, error: 'Não foi possível salvar o produto.' });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const item = req.body || {};
    const name = String(item.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Informe o nome do produto.' });
    const result = await pool.query(
      `UPDATE menu_products SET name=$2, category=$3, sector=$4, price=$5, description=$6,
       image=COALESCE($7,image), updated_at=NOW() WHERE id=$1 AND store_id=$8
       RETURNING id, store_id, store_name, name, category, sector, price, description, image, is_active`,
      [String(req.params.id), name, item.category || '', item.sector || 'Cozinha', Math.max(0, Number(item.price) || 0), item.description || '', item.image || null, req.merchant.storeId]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, error: 'Produto não encontrado.' });
    res.json({ success: true, product: toProduct(result.rows[0]) });
  } catch (error) {
    console.error('[PRODUCTS] Erro ao atualizar:', error);
    res.status(500).json({ success: false, error: 'Não foi possível atualizar o produto.' });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM menu_products WHERE id=$1 AND store_id=$2 RETURNING id', [String(req.params.id), req.merchant.storeId]);
    if (!result.rowCount) return res.status(404).json({ success: false, error: 'Produto não encontrado.' });
    res.json({ success: true });
  } catch (error) {
    console.error('[PRODUCTS] Erro ao apagar:', error);
    res.status(500).json({ success: false, error: 'Não foi possível apagar o produto.' });
  }
});

router.patch('/:id/showcase', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const storeId = req.merchant.storeId;
    const enabled = req.body?.showcase === true;
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [storeId]);
    const product = await client.query('SELECT id FROM menu_products WHERE id=$1 AND store_id=$2 AND is_active=TRUE', [String(req.params.id), storeId]);
    if (!product.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Produto não encontrado.' });
    }
    if (enabled) {
      const count = await client.query('SELECT COUNT(*)::int AS total FROM menu_products WHERE store_id=$1 AND showcase_order IS NOT NULL', [storeId]);
      if (count.rows[0].total >= 8) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'A vitrine já possui 8 produtos.' });
      }
      await client.query(
        'UPDATE menu_products SET showcase_order=(SELECT COALESCE(MAX(showcase_order),0)+1 FROM menu_products WHERE store_id=$1), updated_at=NOW() WHERE id=$2 AND store_id=$1',
        [storeId, String(req.params.id)]
      );
    } else {
      await client.query('UPDATE menu_products SET showcase_order=NULL, updated_at=NOW() WHERE id=$1 AND store_id=$2', [String(req.params.id), storeId]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[PRODUCTS] Erro ao atualizar vitrine:', error);
    res.status(500).json({ success: false, error: 'Não foi possível atualizar a vitrine.' });
  } finally {
    client.release();
  }
});

module.exports = () => router;
