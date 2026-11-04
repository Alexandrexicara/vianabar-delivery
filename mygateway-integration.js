// Compatibilidade com as páginas antigas do Vianas Bar.
// O checkout Pix real é criado no backend usando o AppID Woovi do comerciante.
class MyGatewayIntegration {
  constructor() {
    this.baseURL = '/woovi';
    this.merchantId = null;
    this.motoboyId = null;
    this.creatorId = null;
    this.plataformaPercent = 15;
    this.motoboyPercent = 25;
  }

  getRegistrationLink(profileType = 'merchant') {
    const profile = String(profileType || 'merchant').toLowerCase();
    if (profile === 'motoboy') return '/motoboy-login.html';
    if (profile === 'platform' || profile === 'creator' || profile === 'admin') return '/creator-login.html';
    return '/landing-page.html';
  }

  // Mantém a interface antiga para páginas que ainda chamem estes métodos.
  // O cadastro real de comerciante agora é feito pelo endpoint próprio do Vianas Bar.
  async criarContaComerciante() {
    throw new Error('Use o cadastro de comerciante do Vianas Bar. A criação de conta MyGateway foi desativada porque o provedor não está integrado.');
  }

  async criarContaMotoboy() {
    throw new Error('O cadastro de motoboy continua no módulo de entregas do Vianas Bar; não existe integração MyGateway ativa.');
  }

  async criarContaCriador() {
    throw new Error('O cadastro de administrador/criador continua no painel do Vianas Bar; não existe integração MyGateway ativa.');
  }

  getStoreSlug() {
    const host = String(window.location.hostname || '').toLowerCase();
    if (host.endsWith('.cardapiodigital.com.br')) return host.split('.')[0];
    try {
      const saved = JSON.parse(localStorage.getItem('establishmentData') || '{}');
      if (saved.uniqueId) return saved.uniqueId;
      const profile = JSON.parse(localStorage.getItem('merchantProfile') || '{}');
      if (profile.store_slug) return profile.store_slug;
    } catch (_) {}
    return '';
  }

  async gerarQRCode(pedido) {
    const storeSlug = this.getStoreSlug();
    if (!storeSlug) throw new Error('Não foi possível identificar a loja. Acesse pelo endereço exclusivo do estabelecimento.');
    const total = Number(pedido && pedido.total);
    if (!Number.isFinite(total) || total <= 0) throw new Error('Valor do pedido inválido.');
    const response = await fetch(this.baseURL + '/public/charge/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeSlug,
        pedidoId: String(pedido.numero || pedido.id || ('pedido-' + Date.now())),
        valorTotalCents: Math.round(total * 100),
        descricao: 'Pedido ' + String(pedido.numero || pedido.id || '')
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || 'Não foi possível gerar a cobrança Pix.');
    const charge = data.charge || {};
    const code = data.qrCode || charge.br_code;
    if (!code) throw new Error('A Woovi não retornou o código Pix desta cobrança.');
    let qrCodeImage = data.qrCodeImage || null;
    if (!qrCodeImage && window.QRCode && typeof window.QRCode.toDataURL === 'function') {
      try { qrCodeImage = await window.QRCode.toDataURL(code, { width: 280, margin: 2 }); } catch (_) {}
    }
    return {
      success: true,
      transactionId: charge.correlation_id,
      qrCode: code,
      qrCodeImage,
      paymentLinkUrl: data.paymentLinkUrl || charge.payment_link_url || null,
      status: 'pending'
    };
  }

  async verificarPagamento(transactionId) {
    const storeSlug = this.getStoreSlug();
    if (!storeSlug) throw new Error('Loja não identificada para consultar o pagamento.');
    const response = await fetch(this.baseURL + '/public/charge/' + encodeURIComponent(transactionId) + '?storeSlug=' + encodeURIComponent(storeSlug));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || 'Não foi possível consultar o pagamento.');
    const charge = data.charge;
    return {
      status: charge.status === 'paid' ? 'approved' : 'pending',
      amount: Number(charge.amount_cents || 0) / 100,
      processedAt: charge.paid_at || null,
      transactionId: charge.correlation_id
    };
  }

  async processarPagamento(pedido) {
    return {
      success: false,
      error: 'O pagamento com cartão ainda não está conectado a um processador real neste projeto. Use Pix para confirmação automática.'
    };
  }

  calcularSplit(valorTotal, metodoPagamento) {
    const total = Number(valorTotal) || 0;
    const taxaPlataforma = total * this.plataformaPercent / 100;
    const valorMotoboy = total * this.motoboyPercent / 100;
    return {
      valorTotal: total,
      splits: {
        plataforma: { percent: this.plataformaPercent, valor: taxaPlataforma },
        motoboy: { percent: this.motoboyPercent, valor: valorMotoboy },
        comerciante: { percent: 100 - this.plataformaPercent - this.motoboyPercent, valor: total - taxaPlataforma - valorMotoboy }
      }
    };
  }
}
window.MyGatewayIntegration = MyGatewayIntegration;
