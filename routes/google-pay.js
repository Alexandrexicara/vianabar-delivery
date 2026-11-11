'use strict';
const express = require("express");
const router = express.Router();

// Google Pay entrega um token de pagamento, mas isso por si só não comprova
// autorização/captura. A liquidação precisa ocorrer no gateway contratado.
router.post("/", async (_req, res) => {
  return res.status(501).json({
    success: false,
    error: "Google Pay ainda não está conectado a um processador de pagamentos no servidor. Nenhum pagamento foi confirmado."
  });
});

// O estado financeiro não pode ser lido da memória do processo como fonte oficial.
router.get("/status/:pedidoId", (_req, res) => {
  return res.status(501).json({
    success: false,
    error: "Consulta de pagamento indisponível até a integração persistente com o provedor."
  });
});

// Um estorno só pode ser confirmado após solicitação e resposta do provedor.
router.post("/estornar/:pedidoId", (_req, res) => {
  return res.status(501).json({
    success: false,
    error: "Estorno não habilitado: é necessária integração autenticada com o provedor."
  });
});

router.get("/config", (_req, res) => {
  res.json({
    success: true,
    data: {
      environment: process.env.GOOGLE_PAY_ENV || "TEST",
      merchantId: process.env.GOOGLE_PAY_MERCHANT_ID || null,
      gatewayMerchantId: process.env.GATEWAY_MERCHANT_ID || null,
      gateway: process.env.PAYMENT_GATEWAY || null,
      allowedCardNetworks: ["VISA", "MASTERCARD", "ELO", "HIPERCARD"],
      currencyCode: "BRL",
      countryCode: "BR",
      paymentProcessingEnabled: false
    }
  });
});

module.exports = router;
