const express = require('express');
const router = express.Router();

// A rota antiga aceitava valor e split enviados pelo navegador e chamava
// um serviço com consulta SQL e autenticação incorretas. Não permitir cobranças
// até a integração usar pedido persistido, valores calculados no servidor,
// correlationID idempotente e confirmação autenticada do webhook Woovi.
router.post('/charge/create', (_req, res) => {
  return res.status(501).json({
    success: false,
    error: 'Checkout Woovi ainda não foi ativado. A cobrança não foi criada.'
  });
});

module.exports = router;
