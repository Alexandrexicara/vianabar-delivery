const fetch = require('node-fetch'); // Node.js >=18 has global fetch, otherwise install node-fetch
const crypto = require('crypto');

const WOOVI_BASE_URL = process.env.WOOVI_BASE_URL || 'https://api.woovi.com';
const WOOVI_APP_ID = process.env.WOOVI_APP_ID; // optional, may be per merchant
const WOOVI_API_KEY = process.env.WOOVI_API_KEY; // global key if needed

/**
 * Cria uma cobrança Pix na conta Woovi do comerciante informado.
 * @param {Object} param0 - { merchantId, pedidoId, valorTotalCents, descricao, splitDetails }
 * @returns {Promise<Object>} - { success: boolean, chargeId, error?: string }
 */
async function criarCharge({ merchantId, pedidoId, valorTotalCents, descricao, splitDetails }) {
  try {
    // Busca credenciais do comerciante
    const merchant = await getMerchantById(merchantId);
    if (!merchant) {
      return { success: false, error: 'Comerciante não encontrado' };
    }

    // Monta payload para a API Woovi
    const payload = {
      appId: merchant.woovi_app_id,
      amount: valorTotalCents,
      description: descricao,
      // splitDetails deve ser enviado conforme a modalidade escolhida
      ...(splitDetails && { split: splitDetails })
    };

    const response = await fetch(`${WOOVI_BASE_URL}/api/v1/charge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Authorization pode ser feito via header ou body, conforme a documentação
        // Aqui usamos header Authorization com a API key do comerciante (já descriptografada)
        'Authorization': `Bearer ${merchant.woovi_api_key}`
      },
      body: JSON.stringify(payload)
    });

    const responseData = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: `Woovi API error: ${JSON.stringify(responseData)}`
      };
    }

    return {
      success: true,
      chargeId: responseData.charge_id,
      chargeUrl: responseData.charge_url
    };
  } catch (err) {
    console.error('Erro ao criar cobrança Woovi:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Verifica webhook da Woovi e valida a cobrança.
 * @param {Object} param0 - { chargeId, signature, payload }
 * @returns {Promise<Object>} - { success: boolean, chargeId?, error?: string }
 */
async function validarWebhook({ chargeId, signature, payload }) {
  // Implementar verificação de assinatura conforme documentação Woovi
  // Exemplo simplificado:
  const hmac = crypto.createHmac('sha256', merchant.woovi_api_key);
  hmac.update(JSON.stringify(payload));
  const computedSignature = hmac.digest('hex');

  if (computedSignature !== signature) {
    return { success: false, error: 'Assinatura inválida' };
  }

  // Busca a cobrança no DB
  const charge = await getChargeById(chargeId);
  if (!charge) {
    return { success: false, error: 'Cobrança não encontrada' };
  }

  // Aqui você pode validar o status, valor, etc.
  return { success: true, chargeId: chargeId };
}

/**
 * Busca as credenciais de um comerciante pelo ID.
 * @param {number} merchantId
 * @returns {Promise<Object>} - merchant object or null
 */
async function getMerchantById(merchantId) {
  const result = await db.query(
    `SELECT * FROM merchants WHERE id = $1`,
    [merchantId]
  );
  return result.rows[0] || null;
}

/**
 * Obtém detalhes da cobrança Woovi.
 * @param {string} chargeId
 * @returns {Promise<Object>} - charge object
 */
async function getChargeById(chargeId) {
  const result = await db.query(
    `SELECT * FROM charges WHERE woovi_charge_id = $1`,
    [chargeId]
  );
  return result.rows[0];
}

/**
 * Atualiza o status da cobrança no DB.
 * @param {Object} param0 - { chargeId, status }
 * @returns {Promise<void>}
 */
async function atualizarStatusCobranca({ chargeId, status }) {
  await db.query(
    `UPDATE charges SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE woovi_charge_id = $2`,
    [status, chargeId]
  );
}

/**
 * Exporta as funções para uso nos serviços.
module.exports = {
  criarCharge,
  validarWebhook,
  getMerchantById,
  getChargeById,
  atualizarStatusCobranca
};