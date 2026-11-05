const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query } = require('../database');

const SECRET = process.env.ACCOUNT_AUTH_SECRET || process.env.MERCHANT_AUTH_SECRET || '';

async function authenticateMotoboy(req, res, next) {
  try {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const parts = token.split('.');
    if (!SECRET || parts.length !== 3) {
      return res.status(401).json({ success: false, error: 'Sessão inválida ou expirada.' });
    }
    const body = parts[0] + '.' + parts[1];
    const expected = crypto.createHmac('sha256', SECRET).update(body).digest();
    const supplied = Buffer.from(parts[2], 'base64url');
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      return res.status(401).json({ success: false, error: 'Sessão inválida ou expirada.' });
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.typ !== 'motoboy' || !payload.sub || !Number.isFinite(Number(payload.exp)) ||
        payload.exp < Math.floor(Date.now() / 1000)) {
      return res.status(401).json({ success: false, error: 'Sessão inválida ou expirada.' });
    }
    req.motoboyId = Number(payload.sub);
    const account = await query('SELECT status FROM motoboys WHERE id=$1 LIMIT 1', [req.motoboyId]);
    if (!account.rows[0] || account.rows[0].status !== 'active') {
      return res.status(403).json({ success: false, error: 'Conta de motoboy não está ativa.' });
    }
    next();
  } catch (_) {
    return res.status(401).json({ success: false, error: 'Sessão inválida ou expirada.' });
  }
}

function ownAccount(req, res, next) {
  if (!Number.isSafeInteger(Number(req.params.id)) || Number(req.params.id) !== req.motoboyId) {
    return res.status(403).json({ success: false, error: 'Acesso permitido somente à própria conta.' });
  }
  next();
}

router.use(authenticateMotoboy);

router.get('/:id', ownAccount, async (req, res) => {
  try {
    const result = await query(
      `SELECT m.id, m.name, m.status,
        COALESCE(SUM(d.amount_cents - d.paid_cents), 0)::bigint AS pending_cents,
        COALESCE(SUM(CASE WHEN d.due_at <= NOW() THEN d.amount_cents - d.paid_cents ELSE 0 END), 0)::bigint AS overdue_cents,
        MIN(d.due_at) FILTER (WHERE d.paid_cents < d.amount_cents) AS next_due_at
       FROM motoboys m LEFT JOIN motoboy_deliveries d ON d.motoboy_id = m.id
       WHERE m.id = $1 GROUP BY m.id`,
      [req.motoboyId]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'Motoboy não encontrado.' });
    if (result.rows[0].status !== 'active') return res.status(403).json({ success: false, error: 'Conta não está ativa.' });
    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('[MOTOBOY BALANCE]', error);
    return res.status(500).json({ success: false, error: 'Não foi possível consultar o saldo.' });
  }
});

router.get('/:id/historico', ownAccount, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, order_reference, amount_cents, paid_cents, due_at, status, created_at, paid_at
         FROM motoboy_deliveries WHERE motoboy_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.motoboyId]
    );
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('[MOTOBOY HISTORY]', error);
    return res.status(500).json({ success: false, error: 'Não foi possível consultar o histórico.' });
  }
});

router.get('/:id/resumo', ownAccount, async (req, res) => {
  try {
    const result = await query(
      `SELECT COUNT(*)::int AS total_entregas,
        COALESCE(SUM(amount_cents),0)::bigint AS total_gerado_cents,
        COALESCE(SUM(paid_cents),0)::bigint AS total_pago_cents,
        COALESCE(SUM(amount_cents-paid_cents),0)::bigint AS total_pendente_cents
       FROM motoboy_deliveries WHERE motoboy_id = $1`,
      [req.motoboyId]
    );
    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('[MOTOBOY SUMMARY]', error);
    return res.status(500).json({ success: false, error: 'Não foi possível consultar o resumo.' });
  }
});

// Os saques são feitos pelo fluxo financeiro Woovi, com confirmação via webhook.
// Não debitar saldo em memória nem aceitar saques informados pelo navegador.
router.post(['/sacar/:id', '/sacar-total/:id'], ownAccount, (req, res) => {
  return res.status(409).json({
    success: false,
    error: 'Saque manual indisponível. Os valores são pagos pelo fluxo Pix do comerciante e confirmados pelo banco.'
  });
});

router.get('/', (req, res) => {
  return res.status(403).json({ success: false, error: 'Consulta geral de motoboys exige acesso administrativo.' });
});

module.exports = router;
