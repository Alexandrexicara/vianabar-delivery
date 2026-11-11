require('dotenv').config();

const hostname = '0.0.0.0';
const httpPort = process.env.PORT || 3002;
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require('ws');
const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Middleware
const allowedOrigins = new Set((process.env.ALLOWED_APP_ORIGINS || 'https://delivery-day.netlify.app,https://vianabar-delivery.onrender.com,http://localhost:3002,http://127.0.0.1:3002').split(',').map(value => value.trim()).filter(Boolean));
app.use(cors({ origin(origin, callback) { if (!origin || allowedOrigins.has(origin)) return callback(null, true); return callback(new Error('Origem não autorizada.')); }, credentials: true }));

app.use(express.json({ limit: '15mb', verify: (req, _res, buffer) => { if (req.originalUrl && req.originalUrl.startsWith('/woovi/webhook')) req.rawBody = Buffer.from(buffer); } }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));
app.use('/api/notification-voice', require('./routes/notificationVoice'));

// 🔥 NOVAS ROTAS DE PAGAMENTO E DELIVERY
app.use("/pagamento", require("./routes/pagamento"));
app.use("/entrega", require("./routes/entrega"));
app.use("/vendedor", require("./routes/vendedor"));
app.use("/motoboy", require("./routes/motoboy"));
app.use("/google-pay", require("./routes/google-pay"));
app.use("/anti-chargeback", require("./routes/antiChargeback"));
app.use("/woovi", require("./routes/woovi"));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = './uploads/';
    if (!fs.existsSync(uploadDir)){
        fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// Upload endpoint for images
app.post('/upload/:type', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const imageUrl = `/uploads/${req.file.filename}`;
  console.log(`📁 Image uploaded: ${imageUrl}`);

  res.json({
    success: true,
    imageUrl: imageUrl,
    message: 'Image uploaded successfully'
  });
});

// Sessão segura do comerciante (cookie HttpOnly + PostgreSQL).
const merchantAuth = require('./routes/merchantAuth');
app.use('/api/merchant-auth', merchantAuth.router);

// Server-side authentication for creator dashboard.
const creatorAuth = require('./routes/creatorAuth');
app.use('/api/creator', creatorAuth.router);
app.use('/api/products', require('./routes/menuProducts')());
app.use('/api/cardapio/orders', require('./routes/cardapioOrders'));
app.use('/api/merchant-settings', require('./routes/merchantSettings'));
app.get('/creator-dashboard.html', creatorAuth.requireCreator, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.resolve('creator-dashboard.html'));
});
app.get('/creator-woovi.html', creatorAuth.requireCreator, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.resolve('creator-woovi.html'));
});

// Serve static files
app.use(express.static('.'));

// Function to determine establishment based on subdomain
function getEstablishmentIdFromSubdomain(req) {
  const host = req.get('Host');
  if (!host) return null;
  
  // Extract subdomain from host (assuming format: subdomain.cardapiodigital.com.br)
  const parts = host.split('.');
  if (parts.length >= 3 && parts[parts.length - 2] === 'cardapiodigital' && parts[parts.length - 1] === 'com.br') {
    // This is a subdomain request
    return parts[0];
  }
  
  return null; // Default domain, no specific establishment
}

// Middleware to set establishment context based on subdomain
app.use((req, res, next) => {
  const establishmentId = getEstablishmentIdFromSubdomain(req);
  if (establishmentId) {
    req.establishmentId = establishmentId;
    console.log(`[SERVER] Request for establishment: ${establishmentId}`);
  }
  next();
});

// Middleware to handle subdomain routing
app.get('*', (req, res, next) => {
  const establishmentId = req.establishmentId;
  if (establishmentId) {
    // This is a subdomain request, serve the user interface
    console.log(`[SERVER] Serving usuario for establishment: ${establishmentId}`);
    
    // For now, we'll serve usuario.html for subdomain requests
    // In a real implementation, you would validate that the establishment exists
    res.sendFile(path.resolve('usuario.html'));
    return;
  }
  
  // If no subdomain, continue to next middleware (which will serve index.html for root path)
  next();
});

// ✅ INJETAR MYGATEWAY AUTOMATICAMENTE EM PÁGINAS HTML
app.get('*.html', (req, res) => {
  const filePath = path.join(__dirname, req.path);
  
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      return res.sendFile(filePath);
    }
    
    let html = data;
    
    // Verificar se já tem o auto-loader
    if (!html.includes('mygateway-autoloader.js')) {
      // Inserir antes de </head>
      const autoLoaderScript = `
    <!-- MyGateway Auto Loader -->
    <script src="mygateway-autoloader.js"></script>`;
      
      if (html.includes('</head>')) {
        html = html.replace('</head>', autoLoaderScript + '\n  </head>');
        console.log(`[SERVER] ✅ MyGateway injetado em ${req.path}`);
      }
    }
    
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.send(html);
  });
});

// Fallback route for SPA - Only for root path
app.get('/', (req, res) => {
  res.sendFile(path.resolve('index.html'));
});

// Store connected clients and associate them with orders
const clients = new Map(); // Using a Map to store ws connection with an ID
let clientIdCounter = 0; // Track client ID

// Start with an empty list of orders for production
let orders = [];
const cardapioDb = require('./services/wooviService').pool;
const orderEvents = require('./services/orderEvents');

const ordersReady = (async () => {
  try {
    const result = await cardapioDb.query(
      "SELECT id,store_id,customer_name,customer_phone,table_number,order_type,observations,subtotal_cents,total_cents,status,payment_method,payment_status,created_at FROM cardapio_orders WHERE status NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 500"
    );
    if (!result.rowCount) return;
    const ids = result.rows.map(row => row.id);
    const itemResult = await cardapioDb.query(
      "SELECT order_id,product_id,product_name,quantity,unit_price_cents,sector FROM cardapio_order_items WHERE order_id=ANY($1::text[]) ORDER BY id",
      [ids]
    );
    const grouped = new Map();
    for (const item of itemResult.rows) {
      if (!grouped.has(item.order_id)) grouped.set(item.order_id, []);
      grouped.get(item.order_id).push({
        id: item.product_id, name: item.product_name, quantity: item.quantity,
        price: Number(item.unit_price_cents) / 100, sector: item.sector
      });
    }
    const persistedOrders = result.rows.map(row => ({
      id: row.id, storeId: row.store_id,
      customer: { name: row.customer_name, phone: row.customer_phone, tableNumber: row.table_number },
      table: row.order_type === 'totem' ? 'Totem' : row.order_type === 'counter' ? 'Balcão' : 'Mesa ' + row.table_number,
      orderType: row.order_type || 'table', observations: row.observations,
      items: grouped.get(row.id) || [],
      subtotal: Number(row.subtotal_cents) / 100, total: Number(row.total_cents) / 100,
      status: row.status, paymentMethod: row.payment_method,
      paymentStatus: row.payment_status, timestamp: row.created_at
    }));
    for (const persistedOrder of persistedOrders) {
      if (!orders.some(existing => String(existing.id) === String(persistedOrder.id))) orders.push(persistedOrder);
    }
    console.log('[CARDAPIO] Pedidos ativos recuperados do Neon:', persistedOrders.length);
  } catch (error) {
    console.error('[CARDAPIO] Não foi possível recuperar pedidos persistidos:', error.message);
  }
})();

function sendCardapioMessage(client, storeId, message) {
  if (!client || client.readyState !== WebSocket.OPEN) return;
  if (client.storeId && storeId && client.storeId !== storeId) return;
  client.send(JSON.stringify(message));
}

orderEvents.on('order.created', ({ order, notifyKitchen }) => {
  if (!orders.some(existing => existing.id === order.id)) orders.unshift(order);
  const message = { type: 'newOrder', order };
  clients.forEach(client => {
    if (['admin','waiter'].includes(client.role)) sendCardapioMessage(client, order.storeId, message);
    if (notifyKitchen && client.role === 'kitchen' && order.items.some(item => item.sector === 'kitchen')) sendCardapioMessage(client, order.storeId, message);
    if (notifyKitchen && client.role === 'counter' && order.items.some(item => item.sector === 'counter')) sendCardapioMessage(client, order.storeId, message);
  });
});

orderEvents.on('order.paid', order => {
  const index = orders.findIndex(existing => existing.id === order.id);
  if (index >= 0) orders[index] = { ...orders[index], ...order };
  else orders.unshift(order);
  const statusMessage = { type: 'paymentStatusUpdate', orderId: order.id, paymentStatus: 'completed', storeId: order.storeId };
  clients.forEach(client => {
    if (['admin','waiter','kitchen','counter'].includes(client.role)) sendCardapioMessage(client, order.storeId, statusMessage);
    if (client.role === 'user' && client.trackingCardapioOrderId === String(order.id)) sendCardapioMessage(client, order.storeId, { type:'paymentStatusUpdate', orderId:order.id, paymentStatus:'completed', status:'paid' });
    if (client.role === 'kitchen' && order.items.some(item => item.sector === 'kitchen')) sendCardapioMessage(client, order.storeId, { type:'newOrder', order });
    if (client.role === 'counter' && order.items.some(item => item.sector === 'counter')) sendCardapioMessage(client, order.storeId, { type:'newOrder', order });
  });
});

orderEvents.on('order.expired', order => {
  const index = orders.findIndex(existing => existing.id === order.id);
  if (index >= 0) orders[index] = { ...orders[index], ...order };
  const message = { type:'paymentStatusUpdate', orderId:order.id, paymentStatus:'expired', storeId:order.storeId };
  clients.forEach(client => {
    if (['admin','waiter'].includes(client.role)) sendCardapioMessage(client, order.storeId, message);
    if (client.role === 'user' && client.trackingCardapioOrderId === String(order.id)) sendCardapioMessage(client, order.storeId, message);
  });
});

orderEvents.on('order.paymentReview', order => {
  const index = orders.findIndex(existing => existing.id === order.id);
  if (index >= 0) orders[index] = { ...orders[index], ...order };
  const message = { type:'paymentStatusUpdate', orderId:order.id, paymentStatus:'needs_review', storeId:order.storeId };
  clients.forEach(client => {
    if (['admin','waiter'].includes(client.role)) sendCardapioMessage(client, order.storeId, message);
    if (client.role === 'user' && client.trackingCardapioOrderId === String(order.id)) sendCardapioMessage(client, order.storeId, message);
  });
});

const deliveryOrdersFile = path.join(__dirname, 'data', 'delivery-orders.json');
let deliveryOrders = [];

try {
  deliveryOrders = JSON.parse(fs.readFileSync(deliveryOrdersFile, 'utf8'));
  if (!Array.isArray(deliveryOrders)) deliveryOrders = [];
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error('[DELIVERY] Não foi possível carregar pedidos salvos:', error);
  }
}

function persistDeliveryOrders() {
  fs.mkdirSync(path.dirname(deliveryOrdersFile), { recursive: true });
  fs.writeFileSync(deliveryOrdersFile, JSON.stringify(deliveryOrders, null, 2));
}

// Add paymentStatus to any existing orders that might not have it
orders.forEach(order => {
  if (!order.paymentStatus) {
    order.paymentStatus = 'pending';
  }
});

// Create WebSocket server attached to the HTTP server
const wss = new WebSocket.Server({ server });

// Handle WebSocket connections
wss.on('connection', async (ws, req) => {
  ws.merchantSession = merchantAuth.sessionFromCookieHeader(req.headers.cookie);
  await ordersReady;
  const clientId = ++clientIdCounter;
  clients.set(clientId, ws);
  ws.clientId = clientId; // Attach clientId to the ws object for later reference
  console.log(`New client connected with ID: ${clientId}`);
  
  // Send existing orders to new client based on role
  ws.send(JSON.stringify({
    type: 'existingOrders',
    orders: ws.role === 'admin' ? orders : orders.filter(order => order.clientId === ws.clientId)
  }));
  
  // Handle messages from client
  ws.on('message', async (message) => {
    await ordersReady;
    try {
      const data = JSON.parse(message);
      console.log('Received:', data);
      
      if (data.type === 'userLogin') {
        ws.role = 'user';
        ws.storeId = String(data.storeId || data.userInfo?.storeId || 'main');
        ws.userInfo = data.userInfo || null;
        ws.send(JSON.stringify({ type: 'userLoginSuccess', clientId: ws.clientId, storeId: ws.storeId }));
      } else if (data.type === 'trackCardapioOrder') {
        const tracked = orders.find(order => String(order.id) === String(data.orderId));
        if (ws.role !== 'user' || !tracked || (tracked.storeId && tracked.storeId !== ws.storeId)) {
          ws.send(JSON.stringify({ type:'cardapioTrackingError', orderId:data.orderId, message:'Pedido não encontrado para esta loja.' }));
          return;
        }
        ws.trackingCardapioOrderId = String(tracked.id);
        ws.send(JSON.stringify({ type:'cardapioOrderSnapshot', order:tracked }));
      } else if (data.type === 'trackDeliveryOrder') {
        const trackedOrder = deliveryOrders.find(o => String(o.id) === String(data.orderId));
        if (!trackedOrder) {
          ws.send(JSON.stringify({type:'deliveryOrderError',orderId:data.orderId,message:'Pedido não encontrado para acompanhamento.'}));
          return;
        }
        ws.role = 'deliveryCustomer';
        ws.trackingOrderId = String(trackedOrder.id);
        ws.send(JSON.stringify({type:'deliveryOrderSnapshot',order:trackedOrder}));
      } else if (data.type === 'updateCustomerLocation') {
        const trackedOrder = deliveryOrders.find(o => String(o.id) === String(data.orderId));
        const lat = Number(data.latitude), lng = Number(data.longitude);
        const ownsOrder = trackedOrder && (String(ws.trackingOrderId||'') === String(data.orderId) || Number(trackedOrder.clientId) === Number(ws.clientId));
        if (!ownsOrder || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180) {
          ws.send(JSON.stringify({type:'locationUpdateError',orderId:data.orderId,message:'Localização não vinculada ao pedido.'}));
          return;
        }
        trackedOrder.customerLocation = {latitude:lat,longitude:lng,accuracy:Number(data.accuracy)||null,updatedAt:data.timestamp||new Date().toISOString()};
        persistDeliveryOrders();
        const locationUpdate = {type:'deliveryCustomerLocation',orderId:trackedOrder.id,customerLocation:trackedOrder.customerLocation};
        broadcastToAdmins(locationUpdate);
        broadcastToMotoboys(locationUpdate);
      } else if (data.type === 'adminLogin') {
        if (!ws.merchantSession || ws.merchantSession.role !== 'admin') { ws.send(JSON.stringify({ type: 'authRequired', message: 'Entre com o acesso seguro do comerciante.' })); ws.close(4401, 'Authentication required'); return; }
        ws.role = 'admin';
        ws.storeId = ws.merchantSession.storeId;
        ws.send(JSON.stringify({ type: 'adminLoginSuccess' }));
        ws.send(JSON.stringify({
          type: 'existingDeliveryOrders',
          orders: deliveryOrders.filter(o => o.storeId === ws.storeId && ['pending', 'accepted', 'preparing', 'delivering', 'onroute'].includes(String(o.status || '').toLowerCase()))
        }));
      } else if (data.type === 'kitchenLogin') {
        if (!ws.merchantSession) { ws.send(JSON.stringify({type:'authRequired'})); ws.close(4401, 'Authentication required'); return; }
        ws.role = 'kitchen';
        ws.storeId = ws.merchantSession.storeId;
        ws.send(JSON.stringify({ type: 'kitchenLoginSuccess' }));
      } else if (data.type === 'counterLogin') {
        if (!ws.merchantSession) { ws.send(JSON.stringify({type:'authRequired'})); ws.close(4401, 'Authentication required'); return; }
        ws.role = 'counter';
        ws.storeId = ws.merchantSession.storeId;
        ws.send(JSON.stringify({ type: 'counterLoginSuccess' }));
      } else if (data.type === 'waiterLogin') {
        if (!ws.merchantSession) { ws.send(JSON.stringify({type:'authRequired'})); ws.close(4401, 'Authentication required'); return; }
        ws.role = 'waiter';
        ws.storeId = ws.merchantSession.storeId;
        ws.send(JSON.stringify({ type: 'waiterLoginSuccess' }));
      } else if (data.type === 'getExistingDeliveryOrders') {
        if (ws.role === 'admin') {
          const activeOrders = deliveryOrders.filter(o => o.storeId === ws.storeId && ['accepted', 'preparing', 'delivering', 'onroute'].includes(String(o.status || '').toLowerCase()));
          ws.send(JSON.stringify({
            type: 'existingDeliveryOrders',
            requestId: data.requestId || null,
            orders: activeOrders
          }));
        } else {
          ws.send(JSON.stringify({ type:'messageError', message:'Acesso não autorizado à consulta de entregas.' }));
        }
      } else if (data.type === 'getExistingOrders') {
        console.log('Sending existing orders to client');
        const userOrders = orders.filter(order => order.clientId === ws.clientId);
        
        // Send different orders based on role
        let ordersToSend = [];
        if (ws.role === 'admin') {
          ordersToSend = orders.filter(order => order.storeId === ws.storeId);
        } else if (ws.role === 'kitchen') {
          // Kitchen staff only see orders with items for kitchen sector
          ordersToSend = orders.filter(order => order.storeId === ws.storeId && ['paid','completed'].includes(String(order.paymentStatus || '').toLowerCase()) && order.items.some(item => item.sector === 'kitchen') &&
              (order.status === 'pending' || order.status === 'preparing'));
        } else if (ws.role === 'counter') {
          // Counter staff only see orders with items for counter sector
          ordersToSend = orders.filter(order => order.storeId === ws.storeId && ['paid','completed'].includes(String(order.paymentStatus || '').toLowerCase()) && order.items.some(item => item.sector === 'counter') &&
              (order.status === 'pending' || order.status === 'preparing'));
        } else {
          // Regular users only see their own orders
          ordersToSend = userOrders;
        }
        
        ws.send(JSON.stringify({
          type: 'existingOrders',
          orders: ordersToSend
        }));
      } else if (data.type === 'submitOrder') {
        // Pedidos de mesa agora precisam passar pela API que valida os produtos,
        // persiste no Neon e cria a cobrança Ovi quando o método for Pix.
        ws.send(JSON.stringify({
          type: 'orderRejected',
          message: 'Atualize o cardápio e confirme o pedido pela tela de pagamento.'
        }));
      } else if (data.type === 'updateStatus') {
        // Update order status
        console.log('[DEBUG] Servidor: Recebida solicitação de atualização de status', data);
        const order = orders.find(o => o.id === data.orderId);
        if (ws.merchantSession && ['admin','kitchen','counter','waiter'].includes(ws.role) && order && order.storeId === ws.storeId) {
          if (order.storeId) cardapioDb.query('UPDATE cardapio_orders SET status=$2,updated_at=NOW() WHERE id=$1 AND store_id=$3', [String(order.id), String(data.status), order.storeId]).catch(error => console.error('[CARDAPIO] Falha ao persistir status:', error.message));
          console.log('[DEBUG] Servidor: Pedido encontrado, atualizando status de', order.status, 'para', data.status);
          order.status = data.status;
          
          // Broadcast status update to all relevant clients
          const updateMessage = JSON.stringify({
            type: 'statusUpdate',
            orderId: data.orderId,
            status: data.status
          });
          console.log('[DEBUG] Servidor: Mensagem de atualização criada', updateMessage);
          
          // Send to admins
          console.log('[DEBUG] Servidor: Enviando atualização para admins');
          let adminCount = 0;
          clients.forEach((client, id) => {
            if (client.role === 'admin' && client.readyState === WebSocket.OPEN) {
              console.log('[DEBUG] Servidor: Enviando para admin', id);
              client.send(updateMessage);
              adminCount++;
            }
          });
          console.log('[DEBUG] Servidor: Total de admins notificados:', adminCount);
          
          // Send to kitchen staff for all status updates
          // Kitchen should see the entire order lifecycle
          console.log('[DEBUG] Servidor: Enviando atualização para cozinha');
          let kitchenCount = 0;
          clients.forEach((client, id) => {
            if (client.role === 'kitchen' && client.readyState === WebSocket.OPEN) {
              console.log('[DEBUG] Servidor: Enviando para cozinha', id);
              client.send(updateMessage);
              kitchenCount++;
            }
          });
          console.log('[DEBUG] Servidor: Total de cozinheiros notificados:', kitchenCount);
          
          // Send to counter staff for all status updates
          // Counter should see the entire order lifecycle
          console.log('[DEBUG] Servidor: Enviando atualização para balcão');
          let counterCount = 0;
          clients.forEach((client, id) => {
            if (client.role === 'counter' && client.readyState === WebSocket.OPEN) {
              console.log('[DEBUG] Servidor: Enviando para balcão', id);
              client.send(updateMessage);
              counterCount++;
            }
          });
          console.log('[DEBUG] Servidor: Total de balcões notificados:', counterCount);
          
          // Send to waiters for all status updates
          console.log('[DEBUG] Servidor: Enviando atualização para garçons');
          let waiterCount = 0;
          clients.forEach((client, id) => {
            if (client.role === 'waiter' && client.readyState === WebSocket.OPEN) {
              console.log('[DEBUG] Servidor: Enviando para garçom', id);
              client.send(updateMessage);
              waiterCount++;
            }
          });
          console.log('[DEBUG] Servidor: Total de garçons notificados:', waiterCount);
          
          // Send to the user who owns the order
          const orderOwnerClient = clients.get(order.clientId);
          if (orderOwnerClient && orderOwnerClient.readyState === WebSocket.OPEN) {
            console.log('[DEBUG] Servidor: Enviando atualização para o cliente dono do pedido');
            orderOwnerClient.send(updateMessage);
            
            // Send additional notification messages based on status
            let notificationMessage = '';
            switch (data.status) {
              case 'preparing':
                notificationMessage = 'Seu pedido está sendo preparado. Aguarde um momento.';
                break;
              case 'ready':
                notificationMessage = 'Seu pedido está pronto e a caminho!';
                break;
              case 'delivered':
                notificationMessage = 'Seu pedido foi entregue. Bom apetite!';
                break;
            }
            
            if (notificationMessage) {
              const notificationMsg = JSON.stringify({
                type: 'orderNotification',
                message: notificationMessage,
                status: data.status
              });
              console.log('[DEBUG] Servidor: Enviando notificação especial para cliente', notificationMsg);
              orderOwnerClient.send(notificationMsg);
            }
          } else {
            console.log('[DEBUG] Servidor: Cliente dono do pedido não encontrado ou não conectado');
          }
        } else {
          console.log('[DEBUG] Servidor: Pedido não encontrado:', data.orderId);
        }
      } else if (data.type === 'updatePaymentStatus' || data.type === 'paymentConfirmed') {
        // Segurança: o navegador nunca pode declarar um pagamento como confirmado.
        // Somente o webhook/consulta autenticada do provedor poderá alterar o estado financeiro.
        ws.send(JSON.stringify({
          type: 'paymentRejected',
          orderId: data.orderId || null,
          message: 'A confirmação do pagamento precisa ser validada pelo servidor.'
        }));
        return;
      } else if (data.type === 'notifyWaiterForDelivery') {
        // Handle notify waiter for delivery request from kitchen/counter
        console.log('[DEBUG] Servidor: Notificação de entrega recebida para pedido:', data.orderId);
        
        // Broadcast notification to all waiter clients and admins
        const notifyWaiterMessage = JSON.stringify({
          type: 'notifyWaiterForDelivery',
          orderId: data.orderId,
          message: `Pedido ${data.orderId} está pronto para entrega. Favor buscar na cozinha/balcão.`
        });
        
        let waiterCount = 0;
        clients.forEach((client, id) => {
          if (client.role === 'waiter' && client.readyState === WebSocket.OPEN) {
            console.log('[DEBUG] Servidor: Enviando notificação para garçom', id);
            client.send(notifyWaiterMessage);
            waiterCount++;
          }
        });
        
        // Also notify admins
        clients.forEach((client, id) => {
          if (client.role === 'admin' && client.readyState === WebSocket.OPEN) {
            client.send(notifyWaiterMessage);
          }
        });
        
        console.log('[DEBUG] Servidor: Total de garçons notificados:', waiterCount);
      } else if (data.type === 'requestPayment') {
        // Handle request payment/account closing from customer
        console.log('Payment request received for table:', data.table, 'payment method:', data.paymentMethod);

        const paymentRequestMessage = JSON.stringify({
          type: 'requestPayment',
          table: data.table,
          paymentMethod: data.paymentMethod,
          orderId: data.orderId,
          message: data.message || 'Cliente solicitando fechamento de conta/pagamento.'
        });

        clients.forEach((client, id) => {
          if ((client.role === 'admin' || client.role === 'waiter') && client.readyState === WebSocket.OPEN && (!ws.storeId || !client.storeId || client.storeId === ws.storeId)) {
            client.send(paymentRequestMessage);
          }
        });

        ws.send(JSON.stringify({
          type: 'callWaiterConfirmation',
          message: 'Garçom foi notificado para atendimento de pagamento.'
        }));
      } else if (data.type === 'callWaiter') {
        // Handle call waiter request from customer
        console.log('Call waiter request received for table:', data.table, 'payment method:', data.paymentMethod);
        
        // Broadcast call waiter request to all admin clients and waiters
        const callWaiterMessage = JSON.stringify({
          type: 'callWaiter',
          table: data.table,
          paymentMethod: data.paymentMethod,
          orderId: data.orderId
        });
        
        clients.forEach((client, id) => {
          if ((client.role === 'admin' || client.role === 'waiter') && client.readyState === WebSocket.OPEN && (!ws.storeId || !client.storeId || client.storeId === ws.storeId)) {
            client.send(callWaiterMessage);
          }
        });
        
        // Send confirmation back to the customer
        ws.send(JSON.stringify({
          type: 'callWaiterConfirmation',
          message: 'Garçom foi notificado e virá até sua mesa.'
        }));
      } else if (data.type === 'sendMessageToClient') {
        // Handle send message to client request from admin
        console.log('Send message to client request received for order:', data.orderId, 'message:', data.message);
        
        // Find the order and the client who owns it
        const order = orders.find(o => o.id === data.orderId);
        if (order) {
          const clientOwner = clients.get(order.clientId);
          if (clientOwner && clientOwner.readyState === WebSocket.OPEN) {
            // Send message to the client
            clientOwner.send(JSON.stringify({
              type: 'adminMessage',
              message: data.message
            }));
            
            // Send confirmation back to the admin
            ws.send(JSON.stringify({
              type: 'messageSent',
              message: 'Mensagem enviada com sucesso para o cliente.'
            }));
          } else {
            // Send error back to the admin
            ws.send(JSON.stringify({
              type: 'messageError',
              message: 'Cliente não está conectado no momento.'
            }));
          }
        } else {
          // Send error back to the admin
          ws.send(JSON.stringify({
              type: 'messageError',
              message: 'Pedido não encontrado.'
          }));
        }
      } else if (data.type === 'motoboyLogin') {
        // Handle motoboy login
        console.log('[DELIVERY] Motoboy logged in:', data.motoboyInfo);
        ws.role = 'motoboy';
        ws.motoboyInfo = data.motoboyInfo;
        
        // Send existing delivery orders to motoboy
        ws.send(JSON.stringify({
          type: 'existingDeliveryOrders',
          orders: deliveryOrders.filter(o => ['pending', 'accepted', 'preparing', 'delivering'].includes(o.status))
        }));
        
        // Broadcast to admins that a motoboy is available
        broadcastToAdmins({
          type: 'motoboyAvailable',
          motoboyInfo: data.motoboyInfo
        });
        
      } else if (data.type === 'submitDeliveryOrder') {
        // Handle new delivery order
        if (!data.order || !data.order.id || !Array.isArray(data.order.items)) {
          ws.send(JSON.stringify({ type: 'deliveryOrderError', message: 'Dados do pedido inválidos.' }));
          return;
        }

        let order = deliveryOrders.find(item => item.id === data.order.id);
        if (!order) {
          order = {
            ...data.order,
            clientId: ws.clientId,
            merchantId: data.order.merchantId || 'main',
            status: data.order.status || 'pending',
            paymentStatus: data.order.paymentStatus || 'pending'
          };
          ws.role = 'deliveryCustomer';
          ws.trackingOrderId = String(order.id);
          deliveryOrders.push(order);
          persistDeliveryOrders();
          console.log('[DELIVERY] Novo pedido recebido:', order.id);

          broadcastToMotoboys({ type: 'newDeliveryOrder', order });
          broadcastToAdmins({ type: 'newDeliveryOrder', order });
        } else if (!order.clientId) {
          order.clientId = ws.clientId;
          ws.role = 'deliveryCustomer';
          ws.trackingOrderId = String(order.id);
          persistDeliveryOrders();
        } else {
          ws.role = 'deliveryCustomer';
          ws.trackingOrderId = String(order.id);
        }

        ws.send(JSON.stringify({ type: 'deliveryOrderConfirmation', orderId: order.id }));
        ws.send(JSON.stringify({ type:'deliveryOrderSnapshot', order }));
        
      } else if (data.type === 'acceptDeliveryOrder') {
        // Motoboy accepts delivery order
        console.log('[DELIVERY] Motoboy aceitou pedido:', data.orderId);
        
        const order = deliveryOrders.find(o => o.id === data.orderId);
        
        if (order && ['pending', 'accepted'].includes(order.status)) {
          order.status = 'accepted';
          order.motoboyId = ws.motoboyInfo?.id || data.motoboyId || null;
          order.motoboyName = data.motoboyName || ws.motoboyInfo?.name || '';
          order.motoboyPhone = data.motoboyPhone || ws.motoboyInfo?.phone || '';
          order.acceptedAt = new Date().toISOString();
          persistDeliveryOrders();
          
          // Notify customer
          broadcastToCustomer(data.orderId, {
            type: 'orderAccepted',
            orderId: data.orderId,
            motoboyName: order.motoboyName,
            motoboyPhone: order.motoboyPhone
          });
          
          // Notify admins
          broadcastToAdmins({
            type: 'orderAccepted',
            orderId: data.orderId,
            motoboyName: order.motoboyName
          });
        }
        
      } else if (data.type === 'startDeliveryOrder') {
        // Motoboy starts delivery only after accepting/being assigned to the order.
        console.log('[DELIVERY] Motoboy iniciou entrega:', data.orderId);
        const order = deliveryOrders.find(o => String(o.id) === String(data.orderId));
        const senderId = String(ws.motoboyInfo?.id || ws.motoboyInfo?.phone || '');
        if (ws.role !== 'motoboy' || !order || !order.motoboyId || !senderId || String(order.motoboyId) !== senderId) {
          ws.send(JSON.stringify({ type:'deliveryOrderError', orderId:data.orderId, message:'Motoboy não está vinculado a este pedido.' }));
          return;
        }
        
        if (order) {
          order.status = 'delivering';
          order.deliveringAt = new Date().toISOString();
          persistDeliveryOrders();
          
          // Notify customer
          broadcastToCustomer(data.orderId, {
            type: 'orderDelivering',
            orderId: data.orderId,
            motoboyName: order.motoboyName,
            estimatedTime: order.estimatedTime
          });
          
          // Notify admins
          broadcastToAdmins({
            type: 'orderDelivering',
            orderId: data.orderId
          });
        }
        
      } else if (data.type === 'updateMotoboyLocation') {
        // Somente uma conexão identificada como motoboy pode publicar posição GPS.
        if (ws.role !== 'motoboy') {
          ws.send(JSON.stringify({ type:'locationUpdateError', orderId:data.orderId, message:'Conexão não identificada como motoboy.' }));
          return;
        }
        console.log('[DELIVERY] Atualização GPS recebida:', data.orderId);
        const order = deliveryOrders.find(o => String(o.id) === String(data.orderId));
        const senderId = String(ws.motoboyInfo?.id || ws.motoboyInfo?.phone || '');
        if (!order || !order.motoboyId || !senderId || String(order.motoboyId) !== senderId) {
          ws.send(JSON.stringify({ type:'locationUpdateError', orderId:data.orderId, message:'Este motoboy não está associado ao pedido.' }));
          return;
        }
        
        if (order && Number.isFinite(Number(data.latitude)) && Number.isFinite(Number(data.longitude)) &&
            Math.abs(Number(data.latitude)) <= 90 && Math.abs(Number(data.longitude)) <= 180) {
          // Salvar localização no localStorage
          order.motoboyLocation = {
            latitude: Number(data.latitude),
            longitude: Number(data.longitude),
            timestamp: data.timestamp || new Date().toISOString(),
            accuracy: Number.isFinite(Number(data.accuracy)) ? Number(data.accuracy) : null
          };
          order.motoboyName = data.motoboyName || order.motoboyName;
          order.motoboyPhone = data.motoboyPhone || order.motoboyPhone;
          persistDeliveryOrders();
          
          // Enviar para o cliente
          broadcastToCustomer(data.orderId, {
            type: 'motoboyLocationUpdate',
            orderId: data.orderId,
            latitude: order.motoboyLocation.latitude,
            longitude: order.motoboyLocation.longitude,
            motoboyName: order.motoboyName,
            motoboyPhone: order.motoboyPhone,
            status: order.status
          });
          // Atualizar também os painéis administrativos conectados.
          broadcastToAdmins({
            type: 'deliveryMotoboyLocation',
            orderId: data.orderId,
            latitude: order.motoboyLocation.latitude,
            longitude: order.motoboyLocation.longitude,
            motoboyName: order.motoboyName,
            status: order.status,
            timestamp: order.motoboyLocation.timestamp
          });
        }
        
      } else if (data.type === 'requestMotoboyLocation') {
        // Cliente solicitou localização do motoboy
        console.log('[DELIVERY] Cliente solicitou localização do motoboy:', data.orderId);
        
        const order = deliveryOrders.find(o => o.id === data.orderId);
        
        if (order && order.motoboyLocation) {
          // Enviar última localização conhecida
          ws.send(JSON.stringify({
            type: 'motoboyLocationUpdate',
            orderId: data.orderId,
            latitude: order.motoboyLocation.latitude,
            longitude: order.motoboyLocation.longitude,
            motoboyName: order.motoboyName,
            motoboyPhone: order.motoboyPhone,
            status: order.status
          }));
        }
        
      } else if (data.type === 'completeDeliveryOrder') {
        // Motoboy completes delivery
        console.log('[DELIVERY] Motoboy completou entrega:', data.orderId);
        
        const order = deliveryOrders.find(o => o.id === data.orderId);
        
        if (order) {
          order.status = 'completed';
          order.completedAt = new Date().toISOString();
          persistDeliveryOrders();
          
          // Notify customer
          broadcastToCustomer(data.orderId, {
            type: 'orderCompleted',
            orderId: data.orderId
          });
          
          // Notify admins
          broadcastToAdmins({
            type: 'orderCompleted',
            orderId: data.orderId
          });
        }
      } else if (data.type === 'heartbeat') {
        // Respond to heartbeat to keep connection alive
        ws.send(JSON.stringify({
          type: 'heartbeat',
          timestamp: new Date().toISOString()
        }));
      } else {
        console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  // Handle client disconnect
  ws.on('close', () => {
    console.log(`Client ${ws.clientId} disconnected`);
    clients.delete(ws.clientId);
  });
});

// Start HTTP server
server.listen(httpPort, hostname, () => {
  console.log(`Server running on port ${httpPort}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(` HTTP server running on: http://${hostname}:${httpPort}/`);
  console.log(` Project directory: ${path.resolve(".")}`);
  console.log(`📂 Project directory: ${path.resolve(".")}`);
  console.log('WebSocket server attached to HTTP server on the same port');
});

// The order simulation has been removed for production use.

// Helper functions for delivery communication
function broadcastToMotoboys(message) {
  const messageStr = JSON.stringify(message);
  clients.forEach((client, id) => {
    if (client.role === 'motoboy' && client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

function broadcastToAdmins(message) {
  const messageStr = JSON.stringify(message);
  clients.forEach((client, id) => {
    if (client.role === 'admin' && client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

function broadcastToCustomer(orderId, message) {
  const id = String(orderId);
  const messageStr = JSON.stringify(message);
  let sent = false;
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && String(client.trackingOrderId || '') === id) {
      client.send(messageStr);
      sent = true;
    }
  });
  if (!sent) {
    const order = deliveryOrders.find(o => String(o.id) === id);
    const originalClient = order?.clientId ? clients.get(order.clientId) : null;
    if (originalClient && originalClient.readyState === WebSocket.OPEN) originalClient.send(messageStr);
  }
}