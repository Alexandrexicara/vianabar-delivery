const fs = require('fs');
const path = require('path');
const { pool } = require('../database');

// Executa apenas a cadeia de migrations validada para este projeto.
// A migration antiga de "charges" depende das tabelas pedidos/merchants legadas
// e não pode ser executada automaticamente sem validar esse schema.
const ORDERED_MIGRATIONS = [
  '20261015_create_merchants_table.sql',
  '20261104_cpf_pix_commissions.sql',
  '20261104_accounts_and_courier_payments.sql'
];

async function migrate() {
  const dir = path.join(__dirname, '..', 'migrations');
  await pool.query(\`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )\`);
  for (const filename of ORDERED_MIGRATIONS) {
    const file = path.join(dir, filename);
    if (!fs.existsSync(file)) throw new Error('Migration obrigatória não encontrada: ' + filename);
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename]);
    if (done.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(file, 'utf8'));
      await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]);
      await client.query('COMMIT');
      console.log('[MIGRATION] Aplicada:', filename);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error('Falha na migration ' + filename + ': ' + error.message);
    } finally { client.release(); }
  }
}
migrate().then(() => pool.end()).catch(async error => {
  console.error('[MIGRATION] Falha ao aplicar estrutura:', error);
  await pool.end(); process.exitCode = 1;
});
