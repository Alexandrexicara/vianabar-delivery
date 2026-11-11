const { vendedores, motoboys, pedidos } = require("../db");
const { v4: uuidv4 } = require("uuid");
const { log, logError, logSuccess } = require("../utils/logs");

function criarPedido({ vendedorId, motoboyId, valor, metodo, merchantId, clientId }) {
  const id = uuidv4();

  const valorNumerico = Number(valor);
  if (!Number.isFinite(valorNumerico) || valorNumerico <= 0) {
    throw new Error("Valor do pedido inválido.");
  }
  const valorTotalCents = Math.round(valorNumerico * 100);

  const pedido = {
    id,
    vendedorId,
    motoboyId,
    merchantId,
    clientId,
    valor: valorNumerico,
    valorTotalCents,
    comissao: null,
    valorMotoboy: null,
    valorVendedor: null,
    splitConfigured: false,
    splitStatus: "awaiting_fixed_amount_configuration",
    metodo,
    status: "criado",
    paymentStatus: "pending",
    createdAt: new Date().toISOString(),
    chargeId: null,
    chargeStatus: "pending"
  };

  pedidos[id] = pedido;
  
  log(`Pedido criado: ${id} - Valor: R$${valor} - Método: ${metodo}`);
  
  return pedido;
}

// Pagamentos só podem ser liquidados após confirmação autenticada do provedor.
function pagarPix(pedidoId) {
  const pedido = pedidos[pedidoId];
  if (!pedido) return { error: "Pedido não encontrado" };
  return {
    error: "Confirmação PIX direta desativada. Aguarde a confirmação autenticada do provedor.",
    paymentStatus: pedido.paymentStatus || "pending"
  };
}

function pagarCartao(pedidoId) {
  const pedido = pedidos[pedidoId];
  if (!pedido) return { error: "Pedido não encontrado" };
  return {
    error: "Confirmação de cartão direta desativada. O pagamento deve ser confirmado pelo provedor.",
    paymentStatus: pedido.paymentStatus || "pending"
  };
}

function verSaldoVendedor(vendedorId) {
  const vendedor = vendedores[vendedorId];
  if (!vendedor) {
    return { saldo: 0, saldoNegativo: 0, pedidos: [] };
  }
  return vendedor;
}

function verSaldoMotoboy(motoboyId) {
  const motoboy = motoboys[motoboyId];
  if (!motoboy) {
    return { saldo: 0, pedidos: [] };
  }
  return motoboy;
}

function getPedido(pedidoId) {
  return pedidos[pedidoId] || null;
}

function getPedidosPorVendedor(vendedorId) {
  return Object.values(pedidos).filter(p => p.vendedorId === vendedorId);
}

function getPedidosPorMotoboy(motoboyId) {
  return Object.values(pedidos).filter(p => p.motoboyId === motoboyId);
}

module.exports = { 
  criarPedido, 
  pagarPix, 
  pagarCartao,
  verSaldoVendedor,
  verSaldoMotoboy,
  getPedido,
  getPedidosPorVendedor,
  getPedidosPorMotoboy
};
