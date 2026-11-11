'use strict';

const express = require('express');
const { requireCreator } = require('./creatorAuth');
const woovi = require('../services/wooviService');
const orderEvents = require('../services/orderEvents');
const router = express.Router();

router.get('/platform-key', requireCreator, async (_req, res) => {
  try {
    const config = await woovi.getPlatformPixConfig();
    res.set('Cache-Control','no-store');
    res.json({
      success:true, configured:Boolean(config),
      masked:config ? '••••' + config.key.slice(-4) : null,
      type:config?.type || null
    });
  } catch (error) {
    console.error('[WOOVI] Erro ao consultar chave da plataforma:', error.message);
    res.status(500).json({success:false,error:'Não foi possível consultar a chave Pix da plataforma.'});
  }
});

router.put('/platform-key', requireCreator, async (req, res) => {
  try {
    const result = await woovi.savePlatformPixKey({
      pixKey:req.body?.pixKey,
      pixKeyType:req.body?.pixKeyType
    });
    res.set('Cache-Control','no-store');
    res.json({success:true,...result});
  } catch (error) {
    res.status(400).json({success:false,error:error.message});
  }
});

router.get('/merchant/:storeId', requireCreator, async (req, res) => {
  try {
    const storeId = String(req.params.storeId || '');
    const account = await woovi.getMerchantAccount(storeId);
    res.set('Cache-Control','no-store');
    res.json({
      success: true,
      provider: 'woovi',
      configured: Boolean(account && account.status === 'active' && account.webhook_registered),
      status: account?.status || 'not_configured',
      webhookRegistered: Boolean(account?.webhook_registered)
    });
  } catch (error) {
    console.error('[WOOVI] Erro ao consultar conta:', error.message);
    res.status(500).json({ success:false, error:'Não foi possível consultar a configuração Ovi.' });
  }
});

router.put('/merchant/:storeId', requireCreator, async (req, res) => {
  try {
    const result = await woovi.registerMerchantAccount({
      storeId: req.params.storeId,
      appId: req.body?.appId
    });
    res.set('Cache-Control','no-store');
    res.json({ success:true, ...result });
  } catch (error) {
    console.error('[WOOVI] Erro ao conectar conta:', error.message);
    res.status(400).json({ success:false, error:error.message });
  }
});

router.post('/webhook', async (req, res) => {
  try {
    const result = await woovi.handleWebhook({
      payload: req.body || {},
      rawBody: req.rawBody,
      headers: req.headers
    });
    if ((result.paid || result.expired || result.needsReview) && result.orderId) {
      const order = await woovi.pool.query(
        `SELECT o.id,o.store_id,o.customer_name,o.customer_phone,o.table_number,o.observations,
                o.subtotal_cents,o.total_cents,o.order_type,o.status,o.payment_status,o.payment_method,o.created_at
         FROM cardapio_orders o WHERE o.id=$1`,
        [result.orderId]
      );
      if (order.rowCount) {
        const row = order.rows[0];
        const items = await woovi.pool.query(
          'SELECT product_id,product_name,quantity,unit_price_cents,sector FROM cardapio_order_items WHERE order_id=$1 ORDER BY id',
          [result.orderId]
        );
        const orderSnapshot = {
          id: row.id, storeId: row.store_id,
          customer: { name: row.customer_name, phone: row.customer_phone, tableNumber: row.table_number },
          table: row.order_type === 'totem' ? 'Totem' : row.order_type === 'counter' ? 'Balcão' : 'Mesa ' + row.table_number,
          orderType: row.order_type,
          observations: row.observations,
          subtotal: Number(row.subtotal_cents)/100,
          total: Number(row.total_cents)/100,
          status: row.status, paymentStatus: row.payment_status,
          paymentMethod: row.payment_method, timestamp: row.created_at,
          items: items.rows.map(item => ({
            id: item.product_id, name: item.product_name, quantity: item.quantity,
            price: Number(item.unit_price_cents)/100, sector: item.sector
          }))
        };
        if (result.paid) orderEvents.emit('order.paid', orderSnapshot);
        else if (result.expired) orderEvents.emit('order.expired', orderSnapshot);
        else if (result.needsReview) orderEvents.emit('order.paymentReview', orderSnapshot);
      }
    }
    res.status(200).json({ success:true, ...result });
  } catch (error) {
    console.error('[WOOVI-WEBHOOK] Evento rejeitado:', error.message);
    res.status(401).json({ success:false, error:'Webhook não validado.' });
  }
});

// A antiga rota pública não pode criar cobranças com valores enviados pelo navegador.
router.post('/charge/create', (_req, res) => res.status(410).json({
  success:false,
  error:'Use o fluxo autenticado de pedidos do cardápio. Esta rota antiga está desativada.'
}));

module.exports = router;
