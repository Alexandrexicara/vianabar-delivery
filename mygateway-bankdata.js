'use strict';

// Dados bancários são informações sensíveis e não devem ser gravados no
// localStorage/sessionStorage. Este módulo mantém apenas formatação/validação
// visual; o cadastro seguro depende do backend e do provedor que será escolhido.
const BankDataModule = {
  detectProfileType() {
    const url = String(window.location.href || '').toLowerCase();
    if (url.includes('motoboy')) return 'MOTOBOY';
    if (url.includes('admin')) return 'ADMIN';
    if (url.includes('creator')) return 'CREATOR';
    return 'UNKNOWN';
  },

  applyBankFieldsAutomatically() {
    console.warn('[BANK DATA] Cadastro automático de dados bancários desativado.');
    return false;
  },

  validateBankCode(code) {
    return /^\d{3}$/.test(String(code || ''));
  },
  validateAgency(agency) {
    const value = String(agency || '').replace(/\D/g, '');
    return value.length >= 4 && value.length <= 5;
  },
  validateAccount(account) {
    const value = String(account || '').replace(/\D/g, '');
    return value.length >= 6 && value.length <= 13;
  },
  formatBankCode(input) {
    input.value = String(input.value || '').replace(/\D/g, '').slice(0, 3);
  },
  formatAgency(input) {
    const value = String(input.value || '').replace(/\D/g, '').slice(0, 5);
    input.value = value.length > 4 ? value.slice(0, 4) + '-' + value.slice(4) : value;
  },
  formatAccount(input) {
    const value = String(input.value || '').replace(/\D/g, '').slice(0, 13);
    input.value = value.length > 1 ? value.slice(0, -1) + '-' + value.slice(-1) : value;
  },
  getBankName(code) {
    const banks = {
      '001': 'Banco do Brasil',
      '033': 'Santander',
      '104': 'Caixa Econômica Federal',
      '237': 'Bradesco',
      '341': 'Itaú Unibanco',
      '756': 'Sicoob',
      '748': 'Sicredi',
      '260': 'Nu Pagamentos (Nubank)',
      '336': 'C6 Bank',
      '290': 'PagSeguro',
      '380': 'PicPay'
    };
    return banks[String(code || '')] || 'Banco Desconhecido';
  },
  saveBankData() {
    console.warn('[BANK DATA] Dados bancários não foram salvos. Aguarde integração segura no servidor.');
    return false;
  },
  loadBankData() {
    return null;
  },
  isComplete() {
    return false;
  },
  checkAndAlert() {
    return false;
  }
};

if (typeof window !== 'undefined') window.BankDataModule = BankDataModule;
if (typeof module !== 'undefined' && module.exports) module.exports = BankDataModule;
