const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireMerchant } = require('./merchant');
const { query } = require('../database');
const sicoob = require('../services/sicoobOfficialClient');

router.get('/status', requireMerchant, (req, res) => {
  res.json({ success: true, provider: 'sicoob', ...sicoob.status() });
});

router.post('/pix/cob', requireMerchant, async (req, res) => {
  try {
    if (process.env.SICOOB_ENABLE_CHARGES !== 'true') return res.status(503).json({ success: false, error: 'Cobranças Sicoob desativadas até a validação do pedido no banco e a homologação.' });
    const { orderReference, valueCents, description } = req.body || {};
    const cents = Number(valueCents);
    if (!orderReference || !Number.isSafeInteger(cents) || cents < 1) {
      return res.status(400).json({ success: false, error: 'Pedido e valor em centavos são obrigatórios.' });
    }
    if (!sicoob.status().configured) {
      return res.status(503).json({ success: false, error: 'Integração Sicoob aguarda Client ID, Client Secret e certificado mTLS.' });
    }
    const txid = crypto.randomBytes(16).toString('hex').toUpperCase();
    const charge = await sicoob.request('put', '/cob/' + txid, {
      calendario: { expiracao: Number(process.env.SICOOB_PIX_EXPIRATION_SECONDS || 3600) },
      valor: { original: (cents / 100).toFixed(2) },
      solicitacaoPagador: String(description || 'Pedido ' + orderReference).slice(0, 140)
    });
    await query(
      `INSERT INTO sicoob_pix_charges (merchant_id, order_reference, txid, amount_cents, status, payload)
       VALUES ($1,$2,$3,$4,'created',$5::jsonb)
       ON CONFLICT (txid) DO NOTHING`,
      [req.merchant.id, String(orderReference), txid, cents, JSON.stringify(charge)]
    );
    res.status(201).json({ success: true, txid, charge });
  } catch (error) {
    console.error('[SICOOB PIX]', error.response?.data || error.message);
    res.status(error.response?.status || 400).json({ success: false, error: error.response?.data?.message || error.message });
  }
});

router.get('/pix/cob/:txid', requireMerchant, async (req, res) => {
  try {
    const owned = await query('SELECT txid FROM sicoob_pix_charges WHERE txid=$1 AND merchant_id=$2 LIMIT 1', [req.params.txid, req.merchant.id]);
    if (!owned.rows[0]) return res.status(404).json({ success: false, error: 'Cobrança não encontrada.' });
    const charge = await sicoob.request('get', '/cob/' + encodeURIComponent(req.params.txid));
    res.json({ success: true, charge });
  } catch (error) {
    res.status(error.response?.status || 400).json({ success: false, error: error.response?.data?.message || error.message });
  }
});

router.post('/webhook', async (req, res) => {
  const expected = Buffer.from(process.env.SICOOB_WEBHOOK_TOKEN || '');
  const supplied = Buffer.from(String(req.headers['x-sicoob-webhook-token'] || ''));
  if (!expected.length || expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return res.status(401).json({ success: false, error: 'Webhook não autorizado.' });
  }
  try {
    const pixItems = Array.isArray(req.body?.pix) ? req.body.pix : [];
    for (const pix of pixItems) {
      if (!pix.txid || !pix.endToEndId) continue;
      await query(
        `UPDATE sicoob_pix_charges
            SET status='paid', end_to_end_id=$1, paid_at=COALESCE(paid_at,NOW()), payload=payload || $2::jsonb
          WHERE txid=$3 AND amount_cents=ROUND(($4::numeric)*100)::bigint`,
        [String(pix.endToEndId), JSON.stringify({ webhook: pix }), String(pix.txid), String(pix.valor || '0')]
      );
    }
    res.status(200).json({ success: true, received: pixItems.length });
  } catch (error) {
    console.error('[SICOOB WEBHOOK]', error);
    res.status(500).json({ success: false, error: 'Falha ao processar webhook.' });
  }
});

module.exports = router;
