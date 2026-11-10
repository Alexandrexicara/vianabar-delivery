// Compatibilidade: os anúncios são processados pelo módulo notification-voice.js.
// Nenhuma chave de API deve existir no navegador.
(function () {
  'use strict';
  window.announceNewOrder = function (order) {
    if (!order) return false;
    window.dispatchEvent(new CustomEvent('delivery-day-announce-order', { detail: order }));
    return true;
  };
})();
