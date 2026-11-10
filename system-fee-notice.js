(function () {
  // O criador poderá definir o valor aqui quando a taxa for aprovada.
  // Enquanto estiver null, o aviso informa a existência da taxa sem exibir um valor.
  window.SYSTEM_ORDER_FEE_AMOUNT = window.SYSTEM_ORDER_FEE_AMOUNT ?? null;

  function addSystemFeeNotice() {
    if (document.getElementById('system-order-fee-notice')) return;
    const footer = document.createElement('footer');
    footer.id = 'system-order-fee-notice';
    footer.setAttribute('role', 'note');
    footer.style.cssText = 'width:100%;box-sizing:border-box;padding:10px 14px;margin-top:24px;text-align:center;font:12px/1.5 Arial,sans-serif;color:#59636e;background:#f5f7f8;border-top:1px solid #e2e7ea;';
    const amount = window.SYSTEM_ORDER_FEE_AMOUNT;
    const amountText = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
      ? ' Valor atual: R$ ' + amount.toFixed(2).replace('.', ',') + ' por pedido.'
      : ' O valor será informado antes da confirmação do pedido.';
    footer.textContent = 'Transparência: qualquer valor adicional identificado como taxa do sistema corresponde à taxa de utilização da plataforma por pedido.' + amountText;
    document.body.appendChild(footer);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addSystemFeeNotice);
  else addSystemFeeNotice();
})();
