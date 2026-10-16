const express = require('express');
const router = express.Router();
const { criarCharge } = require('../services/wooviService');

router.post('/charge/create', async (req, res) => {
  try {
    const { merchantId, pedidoId, valorTotalCents, descricao, splitDetails } = req.body;

    if (!merchantId || !pedidoId || !valorTotalCents || !descricao) {
      return res.status(400).json({ success: false, error: 'merchantId, pedidoId, valorTotalCents e descrição são obrigatórios' });
    }

    const result = await criarCharge({ merchantId, pedidoId, valorTotalCents, descricao, splitDetails });
    res.json(result);
  } catch (error) {
    console.error('Erro ao criar charge:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;