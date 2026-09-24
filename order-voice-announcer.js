// Anúncio falado de novos pedidos usando a síntese de voz do navegador.
(function () {
    'use strict';

    const announcedOrders = new Set();

    function getOrderItems(order) {
        const items = Array.isArray(order?.items) ? order.items : [];
        return items.map(item => {
            const quantity = Number(item.quantity) || 1;
            const name = item.name || item.productName || 'item';
            return `${quantity} ${name}`;
        }).join(', ');
    }

    function getOrderLocation(order) {
        return order?.tableNumber || order?.table || order?.mesa || order?.deliveryType === 'delivery'
            ? ` na ${order.tableNumber || order.table || order.mesa || 'entrega'}`
            : '';
    }

    window.announceNewOrder = function (order) {
        if (!order || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
            return false;
        }

        const orderId = String(order.id || order.orderNumber || Date.now());
        if (announcedOrders.has(orderId)) {
            return false;
        }
        announcedOrders.add(orderId);
        if (announcedOrders.size > 100) {
            announcedOrders.delete(announcedOrders.values().next().value);
        }

        const items = getOrderItems(order);
        const location = getOrderLocation(order);
        const customer = order.customerName || order.customer?.name || order.nome;
        const customerText = customer ? ` Cliente: ${customer}.` : '';
        const itemsText = items ? ` Itens: ${items}.` : '';
        const message = `Novo pedido número ${orderId}.${customerText}${itemsText}${location}.`;

        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(message);
        utterance.lang = 'pt-BR';
        utterance.rate = 0.95;
        utterance.pitch = 1;
        utterance.volume = 1;
        window.speechSynthesis.speak(utterance);
        console.log('[VOICE] Anunciando pedido:', message);
        return true;
    };
})();
