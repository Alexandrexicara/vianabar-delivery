'use strict';

// Adaptador temporariamente seguro.
// Credenciais e chamadas financeiras não podem ficar no navegador.
// O checkout real será realizado pelo backend após a integração e conciliação do provedor.
class MyGatewayIntegration {
  constructor() {
    this.merchantId = null;
    this.motoboyId = null;
    this.creatorId = null;
    this.enabled = false;
  }

  getRegistrationLink(profileType = 'merchant') {
    const links = {
      merchant: 'https://mygateway.com.br/cadastro',
      motoboy: 'https://mygateway.com.br/cadastro',
      platform: 'https://mygateway.com.br/cadastro'
    };
    const profile = String(profileType || 'merchant').toLowerCase();
    return links[profile] || links.merchant;
  }

  notConfigured() {
    throw new Error('Pagamento indisponível: a integração financeira antiga foi desativada por segurança. Aguarde a ativação do checkout no servidor.');
  }

  async criarContaComerciante() { return this.notConfigured(); }
  async criarContaMotoboy() { return this.notConfigured(); }
  async criarContaCriador() { return this.notConfigured(); }
  async processarPagamento() { return this.notConfigured(); }
  async gerarQRCode() { return this.notConfigured(); }
  async verificarPagamento() { return this.notConfigured(); }
  calcularSplit() { return this.notConfigured(); }
  getEstatisticasMotoboy() { return null; }
}

if (typeof window !== 'undefined') {
  window.MyGatewayIntegration = MyGatewayIntegration;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MyGatewayIntegration;
}
