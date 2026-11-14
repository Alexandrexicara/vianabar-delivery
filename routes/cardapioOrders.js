'use strict';

const express = require('express');
const crypto = require('crypto');
const woovi = require('../services/wooviService');
const orderEvents = require('../services/orderEvents');
const { requireMerchant } = require('./merchantAuth');

const router = express.Router();
const pool = woovi.pool;

function cleanStoreId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{1,120}$/.test(id) ? id : null;
}
function cleanText(value, max = 160) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}
function cents(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number * 100);
}
async function deliveryAvailability(pool, storeId) {
  const result = await pool.query("SELECT settings FROM merchant_settings WHERE store_id=$1", [storeId]);
  const settings = result.rows[0]?.settings || {};
  if (typeof settings.deliveryEnabled !== 'boolean' && !settings.deliveryOpeningTime && !settings.deliveryClosingTime) return {open:true};
  if (settings.deliveryEnabled === false) return {open:false,reason:'O Delivery está fechado manualmente pelo estabelecimento.'};
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const now = Number(parts.find(p=>p.type==='hour')?.value||0)*60 + Number(parts.find(p=>p.type==='minute')?.value||0);
  const minutes = value => { const [h,m]=String(value).split(':').map(Number); return h*60+m; };
  const start=minutes(settings.deliveryOpeningTime || '00:00'), end=minutes(settings.deliveryClosingTime || '23:59');
  const open = start <= end ? now >= start && now <= end : now >= start || now <= end;
  return open ? {open:true} : {open:false,reason:'Delivery fechado. Horário de atendimento: '+(settings.deliveryOpeningTime||'00:00')+' às '+(settings.deliveryClosingTime||'23:59')+'.'};
}

function sectorFor(value) {
  const sector = String(value || '').toLowerCase();
  return sector.includes('balc') || sector.includes('counter') ? 'counter' : 'kitchen';
}

router.post('/', async (req, res) => {
  const storeId = cleanStoreId(req.body?.storeId);
  const customer = req.body?.customer || {};
  const rawItems = req.body?.items;
  const paymentMethod = String(req.body?.paymentMethod || '').toLowerCase();
  const orderType = ['table','totem','delivery','counter'].includes(String(req.body?.orderType || '').toLowerCase()) ? String(req.body.orderType).toLowerCase() : 'table';
  if (!storeId) return res.status(400).json({ success: false, error: 'Estabelecimento inválido.' });
  if (!['pix','cash','card'].includes(paymentMethod)) {
    return res.status(400).json({ success: false, error: 'Escolha PIX, dinheiro ou cartão.' });
  }
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 60) {
    return res.status(400).json({ success: false, error: 'O carrinho está vazio ou contém itens demais.' });
  }
  const customerName = cleanText(customer.fullName || customer.name, 160);
  const customerPhone = cleanText(customer.phone || customer.telephone, 40);
  const tableNumber = cleanText(customer.tableNumber || req.body?.tableNumber, 40);
  if (!customerName || !tableNumber) {
    return res.status(400).json({ success: false, error: 'Informe o nome do cliente e a mesa.' });
  }

  const quantities = new Map();
  for (const item of rawItems) {
    const productId = String(item?.id ?? item?.productId ?? '').trim();
    const quantity = Number(item?.quantity);
    if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      return res.status(400).json({ success: false, error: 'Há um produto ou quantidade inválida no carrinho.' });
    }
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }
  if (Array.from(quantities.values()).some(q => q > 99)) {
    return res.status(400).json({ success: false, error: 'Quantidade total de um produto excede o limite.' });
  }

  if (orderType === 'delivery') {
    try {
      const availability = await deliveryAvailability(pool, storeId);
      if (!availability.open) return res.status(409).json({success:false,code:'DELIVERY_CLOSED',error:availability.reason});
    } catch (error) {
      console.error('[CARDAPIO-ORDERS] Não foi possível validar horário do Delivery:',error.message);
      return res.status(503).json({success:false,error:'Não foi possível confirmar se o Delivery está aberto. Tente novamente.'});
    }
  }

  const client = await pool.connect();
  let order;
  try {
    const ids = Array.from(quantities.keys());
    const products = await client.query(
      `SELECT id,store_id,name,price,sector,is_active FROM menu_products
       WHERE store_id=$1 AND id=ANY($2::text[]) AND is_active=TRUE`,
      [storeId, ids]
    );
    if (products.rowCount !== ids.length) {
      return res.status(409).json({ success: false, error: 'Um ou mais produtos não estão mais disponíveis neste cardápio. Atualize a página.' });
    }
    const items = products.rows.map(product => {
      const quantity = quantities.get(String(product.id));
      const unitPriceCents = cents(product.price);
      return {
        id: String(product.id), name: String(product.name),
        price: unitPriceCents / 100, quantity,
        sector: sectorFor(product.sector),
        unitPriceCents, totalCents: unitPriceCents * quantity
      };
    });
    const subtotalCents = items.reduce((sum, item) => sum + item.totalCents, 0);
    if (subtotalCents <= 0) return res.status(400).json({ success: false, error: 'O total do pedido precisa ser maior que zero.' });
    const orderId = crypto.randomUUID();
    const paymentStatus = paymentMethod === 'pix' ? 'pending' : 'awaiting_in_person';
    order = {
      id: orderId, storeId, customer: { name: customerName, fullName: customerName, phone: customerPhone, tableNumber },
      items: items.map(({ id, name, price, quantity, sector }) => ({ id, name, price, quantity, sector })),
      observations: cleanText(req.body?.observations, 1000),
      subtotal: subtotalCents / 100, total: subtotalCents / 100,
      table: orderType === 'totem' ? 'Totem' : orderType === 'counter' ? 'Balcão' : 'Mesa ' + tableNumber,
      orderType, status: 'pending', paymentStatus,
      paymentMethod, timestamp: new Date().toISOString()
    };

    if (paymentMethod === 'pix') {
      const providerConfig = await client.query(
        "SELECT settings->>'paymentProvider' AS provider FROM merchant_settings WHERE store_id=$1",
        [storeId]
      );
      const selectedProvider = providerConfig.rows[0]?.provider || null;
      if (selectedProvider === 'sicoob') {
        return res.status(409).json({ success:false, code:'PAYMENT_PROVIDER_NOT_READY', provider:'sicoob', error:'Este estabelecimento selecionou Cicobi/Sicoob, mas ainda não concluiu a configuração das credenciais e a ativação do checkout Pix. Escolha outra forma de pagamento ou entre em contato com o comerciante.' });
      }
      if (selectedProvider && selectedProvider !== 'woovi') {
        return res.status(409).json({ success:false, code:'PAYMENT_PROVIDER_UNSUPPORTED', provider:selectedProvider, error:'O provedor de pagamento selecionado pelo estabelecimento ainda não está disponível para cobranças online. O pagamento não foi realizado.' });
      }
      const account = await woovi.getMerchantAccount(storeId);
      if (!account || account.status !== 'active' || !account.webhook_registered) {
        return res.status(409).json({ success:false, code:'MERCHANT_PAYMENT_NOT_CONFIGURED', provider:'woovi', error:'Este comerciante ainda não cadastrou e ativou as credenciais de pagamento da Ovi. Nenhuma cobrança foi criada e nenhum pagamento foi confirmado. Escolha outra forma de pagamento ou entre em contato com o estabelecimento.' });
      }
    }

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO cardapio_orders
       (id,store_id,customer_name,customer_phone,table_number,observations,subtotal_cents,total_cents,status,payment_method,payment_status,provider,order_type)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7,'pending',$8,$9,$10,$11)`,
      [orderId,storeId,customerName,customerPhone,tableNumber,order.observations,subtotalCents,paymentMethod,paymentStatus,paymentMethod==='pix'?'woovi':null,orderType]
    );
    for (const item of items) {
      await client.query(
        `INSERT INTO cardapio_order_items(order_id,product_id,product_name,quantity,unit_price_cents,total_cents,sector)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [orderId,item.id,item.name,item.quantity,item.unitPriceCents,item.totalCents,item.sector]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[CARDAPIO-ORDERS] Falha ao gravar pedido:', error.message);
    return res.status(500).json({ success: false, error: 'Não foi possível registrar o pedido. Nenhuma cobrança foi confirmada.' });
  } finally {
    client.release();
  }

  let payment = null;
  if (paymentMethod === 'pix') {
    const amountCents = Math.round(order.total * 100);
    try {
      await pool.query(
        `INSERT INTO cardapio_payment_transactions
         (order_id,store_id,provider,correlation_id,amount_cents,status)
         VALUES($1,$2,'woovi',$1,$3,'pending')`,
        [orderId,storeId,amountCents]
      );
      const charge = await woovi.createCharge({
        storeId, orderId, amountCents,
        comment: 'Pedido da mesa ' + tableNumber
      });
      await pool.query(
        `UPDATE cardapio_payment_transactions
         SET provider_charge_id=$2,status='active',br_code=$3,qr_code_image=$4,
             payment_link_url=$5,provider_payload=$6::jsonb,updated_at=NOW()
         WHERE order_id=$1`,
        [orderId,charge.providerChargeId,charge.brCode,charge.qrCodeImage,
          charge.paymentLinkUrl,JSON.stringify(charge.payload)]
      );
      payment = {
        provider: 'woovi', status: charge.status, brCode: charge.brCode,
        qrCodeImage: charge.qrCodeImage, paymentLinkUrl: charge.paymentLinkUrl,
        expiresAt: charge.expiresAt, amount: order.total
      };
    } catch (error) {
      await pool.query(
        `UPDATE cardapio_orders SET payment_status='failed',updated_at=NOW() WHERE id=$1`,
        [orderId]
      );
      await pool.query(
        `UPDATE cardapio_payment_transactions SET status='failed',updated_at=NOW() WHERE order_id=$1 AND status<>'paid'`,
        [orderId]
      ).catch(() => {});
      console.error('[CARDAPIO-ORDERS] Falha ao criar cobrança Ovi:', error.message);
      return res.status(502).json({ success: false, orderId, error: 'Pedido registrado, mas a Ovi não concluiu a cobrança. Não tente pagar por outra chave. Chame o garçom ou tente novamente com o estabelecimento.' });
    }
  }

  orderEvents.emit('order.created', { order, notifyKitchen: false });
  return res.status(201).json({ success: true, order, payment });
});

router.post('/:orderId/confirm-in-person', requireMerchant, async (req, res) => {
  const orderId = String(req.params.orderId || '').trim();
  const storeId = req.merchant.storeId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE cardapio_orders
       SET payment_status='paid', updated_at=NOW()
       WHERE id=$1 AND store_id=$2 AND payment_status='awaiting_in_person'
         AND payment_method IN ('cash','card')
       RETURNING id,store_id,order_type,customer_name,customer_phone,table_number,observations,
                 subtotal_cents,total_cents,status,payment_method,payment_status,created_at`,
      [orderId, storeId]
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({success:false,error:'Pedido não encontrado nesta loja ou o pagamento já foi tratado.'});
    }
    const row = updated.rows[0];
    const itemRows = await client.query(
      'SELECT product_id,product_name,quantity,unit_price_cents,sector FROM cardapio_order_items WHERE order_id=$1',
      [orderId]
    );
    await client.query('COMMIT');
    const order = {
      id: row.id, storeId: row.store_id, orderType: row.order_type,
      customer: {name:row.customer_name,fullName:row.customer_name,phone:row.customer_phone,tableNumber:row.table_number},
      table: row.order_type === 'totem' ? 'Totem' : row.order_type === 'counter' ? 'Balcão' : 'Mesa ' + row.table_number,
      observations: row.observations || '',
      items: itemRows.rows.map(item => ({
        id:String(item.product_id),name:item.product_name,quantity:Number(item.quantity),
        price:Number(item.unit_price_cents)/100,sector:item.sector
      })),
      subtotal:Number(row.subtotal_cents)/100,total:Number(row.total_cents)/100,
      status:row.status,paymentStatus:'paid',paymentMethod:row.payment_method,
      timestamp:row.created_at
    };
    orderEvents.emit('order.paid', order);
    return res.json({success:true,order});
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('[CARDAPIO-ORDERS] Confirmação presencial:', error.message);
    return res.status(500).json({success:false,error:'Não foi possível confirmar o recebimento. Tente novamente.'});
  } finally {
    client.release();
  }
});

router.get('/:orderId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id,o.store_id,o.order_type,o.status,o.payment_status,o.payment_method,o.total_cents,o.created_at,
              p.status AS provider_status,p.br_code,p.qr_code_image,p.payment_link_url,p.commission_status
       FROM cardapio_orders o LEFT JOIN cardapio_payment_transactions p ON p.order_id=o.id
       WHERE o.id=$1`,
      [String(req.params.orderId)]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, error: 'Pedido não encontrado.' });
    const row = result.rows[0];
    res.set('Cache-Control','no-store');
    res.json({ success: true, order: {
      id: row.id, storeId: row.store_id, orderType: row.order_type, status: row.status,
      paymentStatus: row.payment_status, paymentMethod: row.payment_method,
      total: Number(row.total_cents)/100, createdAt: row.created_at,
      payment: row.provider_status ? {
        status: row.provider_status, brCode: row.br_code, qrCodeImage: row.qr_code_image,
        paymentLinkUrl: row.payment_link_url, commissionStatus: row.commission_status
      } : null
    }});
  } catch (error) {
    console.error('[CARDAPIO-ORDERS] Erro ao consultar pedido:', error.message);
    res.status(500).json({ success: false, error: 'Não foi possível consultar o pedido.' });
  }
});

module.exports = router;
