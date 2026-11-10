/* Avisos falados do Delivery Day: áudio ElevenLabs no servidor, sem chave no navegador. */
(() => {
  'use strict';
  if (window.__deliveryVoiceInstalled) return;
  window.__deliveryVoiceInstalled = true;

  const NativeWebSocket = window.WebSocket;
  const seen = new Set();
  const queue = [];
  let playing = false;
  let enabled = false;
  let unlockButton;

  function addUnlockControl() {
    if (document.getElementById('delivery-voice-enable')) return;
    const wrap = document.createElement('div');
    wrap.id = 'delivery-voice-enable';
    wrap.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:#17251d;color:#fff;padding:10px 12px;border-radius:12px;box-shadow:0 3px 16px #0004;font:13px Arial;display:flex;gap:8px;align-items:center;max-width:calc(100vw - 24px)';
    const label = document.createElement('span');
    label.textContent = 'Avisos por voz';
    unlockButton = document.createElement('button');
    unlockButton.type = 'button';
    unlockButton.id = 'delivery-voice-enable-button';
    unlockButton.textContent = 'Ativar áudio';
    unlockButton.style.cssText = 'border:0;border-radius:8px;padding:8px 11px;background:#b7f34a;color:#14210b;font-weight:700';
    unlockButton.addEventListener('click', async () => {
      enabled = true;
      try {
        const test = new Audio();
        test.muted = true;
        await test.play().catch(() => {});
        test.pause();
        wrap.querySelector('span').textContent = 'Voz ativada';
        unlockButton.textContent = 'Ativado';
        unlockButton.disabled = true;
        unlockButton.style.opacity = '.7';
        processQueue();
      } catch (_) {
        wrap.querySelector('span').textContent = 'Toque novamente para ativar';
      }
    });
    wrap.append(label, unlockButton);
    document.body.appendChild(wrap);
  }

  function orderLocation(order) {
    const table = order?.tableNumber || order?.table || order?.mesa;
    if (table) return 'da mesa ' + table;
    if (order?.deliveryType === 'delivery' || order?.type === 'delivery') return 'da entrega';
    return '';
  }

  function describe(data) {
    const id = data.orderId || data.order?.id || data.order?.orderNumber || '';
    const where = orderLocation(data.order);
    switch (data.type) {
      case 'newOrder':
        return 'Atenção. Chegou um novo pedido ' + (id ? 'número ' + id : '') + (where ? ', ' + where : '') + '.';
      case 'statusUpdate':
        if (data.status === 'ready') return 'Atenção. O pedido ' + id + (where ? ', ' + where : '') + ' está pronto. Garçom, favor retirar.';
        if (data.status === 'preparing') return 'O pedido ' + id + ' entrou em preparação.';
        if (data.status === 'delivered') return 'O pedido ' + id + ' foi entregue.';
        return '';
      case 'notifyWaiterForDelivery':
        return 'Atenção, garçom. O pedido ' + id + ' está pronto para entrega. Favor retirar.';
      case 'callWaiter':
        return 'Atenção. A mesa ' + (data.table || '') + ' está chamando o garçom.';
      case 'requestPayment':
        return 'Atenção. A mesa ' + (data.table || '') + ' solicitou o fechamento da conta.';
      case 'incomingMessage':
      case 'staffMessage':
        return data.message ? 'Nova mensagem. ' + data.message : '';
      default:
        return '';
    }
  }

  async function processQueue() {
    if (!enabled || playing || !queue.length) return;
    playing = true;
    const text = queue.shift();
    let objectUrl;
    try {
      const response = await fetch('/api/notification-voice/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!response.ok) throw new Error('TTS indisponível: ' + response.status);
      objectUrl = URL.createObjectURL(await response.blob());
      const audio = new Audio(objectUrl);
      audio.onended = () => { URL.revokeObjectURL(objectUrl); playing = false; processQueue(); };
      audio.onerror = () => { URL.revokeObjectURL(objectUrl); playing = false; processQueue(); };
      await audio.play();
    } catch (error) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      console.warn('[Delivery Day] Voz não reproduzida:', error.message);
      // Fallback local quando o serviço de voz estiver indisponível.
      if ('speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined') {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'pt-BR';
        utterance.rate = 0.94;
        utterance.onend = () => { playing = false; processQueue(); };
        utterance.onerror = () => { playing = false; processQueue(); };
        window.speechSynthesis.speak(utterance);
      } else {
        playing = false;
        processQueue();
      }
    }
  }

  function vibrateForNotification(type) {
    // Vibração nativa do Android quando o navegador oferece suporte.
    // O padrão curto diferencia os alertas sem manter o aparelho vibrando.
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      const pattern = (type === 'callWaiter' || type === 'requestPayment')
        ? [220, 90, 220, 90, 220]
        : [180, 80, 180];
      try { navigator.vibrate(pattern); } catch (error) {
        console.debug('[Delivery Day] Vibração indisponível:', error);
      }
    }
  }

  function handleMessage(event) {
    let data;
    try { data = JSON.parse(event.data); } catch (_) { return; }
    const message = describe(data);
    if (!message) return;
    const id = [data.type, data.orderId || data.order?.id || data.table || '', data.status || '', data.timestamp || ''].join(':');
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 300) seen.delete(seen.values().next().value);
    queue.push(message);
    processQueue();
  }

  // Registra um listener independente do onmessage já existente em cada página.
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      socket.addEventListener('message', handleMessage);
      return socket;
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addUnlockControl);
  else addUnlockControl();
})();
