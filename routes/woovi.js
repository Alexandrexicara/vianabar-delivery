const express = require('express');
const router = express.Router();
const { requireMerchant } = require('./merchant');
const { createMerchantCharge, processChargeCompleted } = require('../services/wooviService');

router.post('/charge/create', requireMerchant, async (req, res) => {
  try {
    const { pedidoId, valorTotalCents, descricao } = req.body || {};
    if (!pedidoId || !Number.isSafeInteger(Number(valorTotalCents)) || !descricao) {
      return res.status(400).json({ success: false, error: 'pedidoId, valorTotalCents e descricao são obrigatórios.' });
    }
    const result = await createMerchantCharge({ merchantId: req.merchant.id, orderReference: String(pedidoId), valueCents: Number(valorTotalCents), description: descricao });
    res.status(201).json(result);
  } catch (error) {
    console.error('[WOOVI CHARGE]', error);
    res.status(error.status || 400).json({ success: false, error: error.message });
  }
});
router.post('/webhook', async (req, res) => {
  try {
    const expectedToken = process.env.WOOVI_WEBHOOK_AUTH_TOKEN || '';
    if (!expectedToken || String(req.headers.authorization || '') !== expectedToken) {
      return res.status(401).json({ success: false, error: 'Webhook não autorizado.' });
    }
    const body = req.body || {};
    if (body.event === 'OPENPIX:CHARGE_COMPLETED') await processChargeCompleted(body);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[WOOVI WEBHOOK]', error);
    return res.status(500).json({ success: false, error: 'Falha ao processar webhook.' });
  }
});
module.exports = router;
