const { motoboys, pedidos, entregas } = require("../db");
const { log, logError, logSuccess } = require("../utils/logs");

function verSaldo(motoboyId) {
  const motoboy = motoboys[motoboyId];
  if (!motoboy) {
    return { saldo: 0, pedidos: [] };
  }
  
  log(`Consulta saldo - Motoboy: ${motoboyId} - Saldo: R$${motoboy.saldo}`);
  
  return motoboy;
}

function sacar(motoboyId, valor) {
  return {
    error: "Saque direto desativado. Os pagamentos de motoboys precisam seguir o ciclo de 48 horas, autorização do comerciante e confirmação do provedor."
  };
}

function sacarTotal(motoboyId) {
  return {
    error: "Saque total direto desativado. Os pagamentos de motoboys precisam seguir o ciclo de 48 horas, autorização do comerciante e confirmação do provedor."
  };
}

function getHistoricoPedidos(motoboyId) {
  const pedidosMotoboy = Object.values(pedidos).filter(p => p.motoboyId === motoboyId);
  const entregasMotoboy = Object.values(entregas).filter(e => e.motoboyId === motoboyId);
  
  return {
    pedidos: pedidosMotoboy,
    entregas: entregasMotoboy,
    totalPedidos: pedidosMotoboy.length,
    totalEntregas: entregasMotoboy.length
  };
}

function getResumoGanho(motoboyId) {
  const pedidosMotoboy = Object.values(pedidos).filter(p => p.motoboyId === motoboyId && p.status === "pago");
  
  const totalGanho = pedidosMotoboy.reduce((total, pedido) => total + Number(pedido.valorMotoboy || 0), 0);
  const totalPedidos = pedidosMotoboy.length;
  
  return {
    motoboyId,
    totalGanho,
    totalPedidos,
    mediaPorPedido: totalPedidos > 0 ? totalGanho / totalPedidos : 0
  };
}

function getAllMotoboys() {
  return Object.keys(motoboys).map(id => ({
    id,
    ...motoboys[id],
    resumo: getResumoGanho(id)
  }));
}

module.exports = { 
  verSaldo, 
  sacar, 
  sacarTotal,
  getHistoricoPedidos,
  getResumoGanho,
  getAllMotoboys
};
