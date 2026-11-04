const fs = require('fs');
const path = require('path');
const { pool } = require('../database');

async function migrate() {
  const file = path.join(__dirname, '..', 'migrations', '20261104_cpf_pix_commissions.sql');
  const sql = fs.readFileSync(file, 'utf8');
  await pool.query(sql);
  console.log('[MIGRATION] Estrutura CPF/CNPJ, Pix Woovi e comissões aplicada.');
}
migrate().then(() => pool.end()).catch(async error => {
  console.error('[MIGRATION] Falha ao aplicar estrutura:', error);
  await pool.end();
  process.exitCode = 1;
});
