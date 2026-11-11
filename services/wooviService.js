'use strict';

// Adaptador desativado até o backend persistir pedidos, recebedores e valores
// de split e validar webhooks com a configuração oficial da conta Woovi.
async function criarCharge() {
  return {
    success: false,
    error: 'Integração Woovi ainda não ativada: falta conciliar pedido persistido, recebedores e valores fixos no servidor.'
  };
}

async function validarWebhook() {
  return {
    success: false,
    error: 'Webhook Woovi não configurado. Nenhum evento pode liquidar pedido.'
  };
}

async function getMerchantById() {
  return null;
}

async function getChargeById() {
  return null;
}

async function atualizarStatusCobranca() {
  throw new Error('Atualização financeira desativada até a validação autenticada do provedor.');
}

module.exports = {
  criarCharge,
  validarWebhook,
  getMerchantById,
  getChargeById,
  atualizarStatusCobranca
};
