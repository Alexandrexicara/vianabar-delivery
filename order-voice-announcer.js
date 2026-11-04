// Anúncio de novos pedidos usando a síntese de voz nativa do navegador.
// Não expõe chaves de API no navegador e não depende de serviço externo.
(function () {
  'use strict';
  const announcedOrders = new Set();
  let enabled = true;

  function orderText(order) {
    const id = String(order.id || order.orderNumber || 'sem número');
    const items = Array.isArray(order.items) ? order.items.map(item => {
      const quantity = Number(item.quantity) || 1;
      const name = item.name || item.productName || 'item';
      return quantity + ' ' + name;
    }).join(', ') : '';
    const customer = order.customerName || order.customer?.name || order.nome || '';
    const place = order.tableNumber || order.table || order.mesa ||
      (order.deliveryType === 'delivery' ? 'entrega' : '');
    return 'Novo pedido ' + id + '.' +
      (customer ? ' Cliente: ' + customer + '.' : '') +
      (items ? ' Itens: ' + items + '.' : '') +
      (place ? ' Local: ' + place + '.' : '');
  }

  window.setOrderVoiceEnabled = function (value) {
    enabled = Boolean(value);
    if (!enabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    return enabled;
  };

  window.announceNewOrder = function (order) {
    if (!enabled || !order || !('speechSynthesis' in window) ||
        typeof window.SpeechSynthesisUtterance === 'undefined') return false;
    const id = String(order.id || order.orderNumber || '');
    if (!id || announcedOrders.has(id)) return false;
    announcedOrders.add(id);
    if (announcedOrders.size > 200) announcedOrders.delete(announcedOrders.values().next().value);
    const utterance = new SpeechSynthesisUtterance(orderText(order));
    utterance.lang = 'pt-BR';
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    const voices = window.speechSynthesis.getVoices();
    const portuguese = voices.find(voice => /^pt(-|_)?br$/i.test(voice.lang)) ||
      voices.find(voice => /^pt/i.test(voice.lang));
    if (portuguese) utterance.voice = portuguese;
    window.speechSynthesis.speak(utterance);
    return true;
  };
})();
