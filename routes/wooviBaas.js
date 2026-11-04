const express = require('express');
const router = express.Router();
const { requireMerchant } = require('./merchant');
const { startCpfOnboarding } = require('../services/wooviBaasService');

router.post('/onboarding', requireMerchant, async (req, res) => {
  try {
    const result = await startCpfOnboarding(req.merchant.id);
    res.status(201).json(result);
  } catch (error) {
    console.error('[WOOVI BAAS CPF ONBOARDING]', error);
    res.status(error.status || 400).json({ success: false, error: error.message });
  }
});

module.exports = router;
