const express = require('express');
const router = express.Router();
const { requireMerchant } = require('./merchant');
const { createMerchantCharge, createMerchantChargeBySlug, getPublicChargeStatus, processChargeCompleted, processMovementEvent } = require('../services/wooviService');
const { processKycWebhook } = require('../services/wooviBaasService');

router.post('/public/charge/create', async (req, res) => {
  try {
    const { storeSlug, pedidoId, valorTotalCents, descricao } = req.body || {};
    if (!storeSlug || !pedidoId || !Number.isSafeInteger(Number(valorTotalCents)) || !descricao) {
      return res.status(400).json({ success: false, error: 'Loja, pedido, valor em centavos e descrição são obrigatórios.' });
    }
    const result = await createMerchantChargeBySlug({
      storeSlug: String(storeSlug), orderReference: String(pedidoId),
      valueCents: Number(valorTotalCents), description: descricao
    });
    res.status(201).json(result);
  } catch (error) {
    console.error('[WOOVI PUBLIC CHARGE]', error);
    res.status(error.status || 400).json({ success: false, error: error.message });
  }
});
router.get('/public/charge/:correlationId', async (req, res) => {
  try {
    const storeSlug = String(req.query.storeSlug || '');
    if (!storeSlug) return res.status(400).json({ success: false, error: 'storeSlug obrigatório.' });
    const charge = await getPublicChargeStatus({ storeSlug, correlationID: req.params.correlationId });
    res.json({ success: true, charge });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

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
router.post('/kyc-webhook', async (req, res) => {
  try {
    const expectedToken = process.env.WOOVI_MASTER_WEBHOOK_AUTH_TOKEN || '';
    if (!expectedToken || String(req.headers.authorization || '') !== expectedToken) {
      return res.status(401).json({ success: false, error: 'Webhook BaaS não autorizado.' });
    }
    // A Woovi envia um POST de validação ao cadastrar o webhook.
    if (!req.body?.event) return res.status(200).json({ success: true });
    await processKycWebhook(req.body);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[WOOVI KYC WEBHOOK]', error);
    return res.status(500).json({ success: false, error: 'Falha ao processar atualização do cadastro Woovi.' });
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
    if (body.event === 'OPENPIX:MOVEMENT_CONFIRMED' || body.event === 'OPENPIX:MOVEMENT_FAILED') await processMovementEvent(body);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[WOOVI WEBHOOK]', error);
    return res.status(500).json({ success: false, error: 'Falha ao processar webhook.' });
  }
});
module.exports = router;
