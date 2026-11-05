require('dotenv').config();

const hostname = '0.0.0.0';
const httpPort = process.env.PORT || 3002;
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require('crypto');
const WebSocket = require('ws');
const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const { query: dbQuery } = require('./database');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());

app.use(express.json({ verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// 🔥 NOVAS ROTAS DE PAGAMENTO E DELIVERY
app.use("/pagamento", require("./routes/pagamento"));
app.use("/entrega", require("./routes/entrega"));
app.use("/vendedor", require("./routes/vendedor"));
app.use("/motoboy", require("./routes/motoboy"));
app.use("/google-pay", require("./routes/google-pay"));
app.use("/anti-chargeback", require("./routes/antiChargeback"));
app.use("/merchant", require("./routes/merchant").router);
app.use("/api/accounts", require("./routes/accounts"));
app.use("/merchant/woovi-baas", require("./routes/wooviBaas"));
app.use("/woovi", require("./routes/woovi"));
app.use("/sicoob", require("./routes/sicoob"));

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

// Autenticação real do painel do criador (cookie HttpOnly assinado no servidor).
const creatorAuth = require('./routes/creatorAuth');
app.use('/api/creator', creatorAuth.router);
app.get('/creator-dashboard.html', creatorAuth.requireCreator, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.resolve('creator-dashboard.html'));
});

// Arquivos operacionais nunca devem ser servidos como conteúdo público.
app.get(['/orders.json', '/merchants.json', '/charges.json'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.sendStatus(404);
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
wss.on('connection', (ws) => {
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
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received:', data);
      
      if (data.type === 'userLogin') {
        // Set client role to user
        ws.role = 'user';
        ws.send(JSON.stringify({ type: 'userLoginSuccess' }));
      } else if (data.type === 'adminLogin') {
        authenticateMerchantStaffSocket(ws, data, 'admin').catch(error => {
          console.error('[STAFF AUTH]', error);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'adminLoginError', message: 'Sessão administrativa inválida ou expirada.' }));
        });
      } else if (data.type === 'kitchenLogin') {
        authenticateMerchantStaffSocket(ws, data, 'kitchen').catch(error => {
          console.error('[STAFF AUTH]', error);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'kitchenLoginError', message: 'Sessão administrativa inválida ou expirada.' }));
        });
      } else if (data.type === 'counterLogin') {
        authenticateMerchantStaffSocket(ws, data, 'counter').catch(error => {
          console.error('[STAFF AUTH]', error);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'counterLoginError', message: 'Sessão administrativa inválida ou expirada.' }));
        });
      } else if (data.type === 'waiterLogin') {
        authenticateMerchantStaffSocket(ws, data, 'waiter').catch(error => {
          console.error('[STAFF AUTH]', error);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'waiterLoginError', message: 'Sessão administrativa inválida ou expirada.' }));
        });
      } else if (data.type === 'getExistingOrders') {
        console.log('Sending existing orders to client');
        const userOrders = orders.filter(order => order.clientId === ws.clientId);
        
        // Send different orders based on role
        let ordersToSend = [];
        if (ws.role === 'admin') {
          ordersToSend = orders;
        } else if (ws.role === 'kitchen') {
          // Kitchen staff only see orders with items for kitchen sector
          ordersToSend = orders.filter(order => {
            return order.items.some(item => item.sector === 'kitchen') &&
              (order.status === 'pending' || order.status === 'preparing');
          });
        } else if (ws.role === 'counter') {
          // Counter staff only see orders with items for counter sector
          ordersToSend = orders.filter(order => {
            return order.items.some(item => item.sector === 'counter') &&
              (order.status === 'pending' || order.status === 'preparing');
          });
        } else {
          // Regular users only see their own orders
          ordersToSend = userOrders;
        }
        
        ws.send(JSON.stringify({
          type: 'existingOrders',
          orders: ordersToSend
        }));
      } else if (data.type === 'submitOrder') {
        // Handle submitted order from customer
        if (data.order) {
          console.log('Processing submitted order:', data.order.id);
          // Add the new order to the orders array and associate with the client's WebSocket
          const orderData = { ...data.order, clientId: ws.clientId };
          orders.push(orderData);
          
          // Broadcast new order to all relevant clients
          const newOrderMessage = JSON.stringify({
            type: 'newOrder',
            order: data.order
          });
          
          // Send to admins
          clients.forEach((client, id) => {
            if (client.role === 'admin' && client.readyState === WebSocket.OPEN) {
              client.send(newOrderMessage);
            }
          });
          
          // Send to kitchen staff if order has items for kitchen sector
          const hasKitchenItems = data.order.items.some(item => item.sector === 'kitchen');
          if (hasKitchenItems) {
            clients.forEach((client, id) => {
              if (client.role === 'kitchen' && client.readyState === WebSocket.OPEN) {
                client.send(newOrderMessage);
              }
            });
          }
          
          // Send to counter staff if order has items for counter sector
          const hasCounterItems = data.order.items.some(item => item.sector === 'counter');
          if (hasCounterItems) {
            clients.forEach((client, id) => {
              if (client.role === 'counter' && client.readyState === WebSocket.OPEN) {
                client.send(newOrderMessage);
              }
            });
          }
          
          // Send to waiters
          clients.forEach((client, id) => {
            if (client.role === 'waiter' && client.readyState === WebSocket.OPEN) {
              client.send(newOrderMessage);
            }
          });
          
          // Send confirmation back to the customer
          console.log('Sending order confirmation to customer');
          ws.send(JSON.stringify({
            type: 'orderConfirmation',
            orderId: data.order.id
          }));
        }
      } else if (data.type === 'updateStatus') {
        if (!['admin', 'kitchen', 'counter', 'waiter'].includes(ws.role) ||
            !['pending', 'preparing', 'ready', 'delivered', 'cancelled'].includes(data.status)) {
          ws.send(JSON.stringify({ type: 'authorizationError', message: 'Você não tem autorização para alterar este pedido.' }));
          return;
        }
        // Update order status
        console.log('[DEBUG] Servidor: Recebida solicitação de atualização de status', data);
        const order = orders.find(o => o.id === data.orderId);
        if (order) {
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
      } else if (data.type === 'updatePaymentStatus') {
        if (ws.role !== 'admin' || !['pending', 'paid', 'failed', 'refunded'].includes(data.paymentStatus)) {
          ws.send(JSON.stringify({ type: 'authorizationError', message: 'Somente o administrador autenticado pode atualizar o status do pagamento.' }));
          return;
        }
        // Update payment status
        console.log('Updating payment status for order:', data.orderId, 'to', data.paymentStatus);
        const order = orders.find(o => o.id === data.orderId);
        if (order) {
          order.paymentStatus = data.paymentStatus;
          
          // Broadcast payment status update to all relevant clients
          const updateMessage = JSON.stringify({
            type: 'paymentStatusUpdate',
            orderId: data.orderId,
            paymentStatus: data.paymentStatus
          });
          
          // Send to admins
          clients.forEach((client, id) => {
            if (client.role === 'admin' && client.readyState === WebSocket.OPEN) {
              client.send(updateMessage);
            }
          });
          
          // Send to waiters
          clients.forEach((client, id) => {
            if (client.role === 'waiter' && client.readyState === WebSocket.OPEN) {
              client.send(updateMessage);
            }
          });
          
          // Send to the user who owns the order
          const orderOwnerClient = clients.get(order.clientId);
          if (orderOwnerClient && orderOwnerClient.readyState === WebSocket.OPEN) {
            orderOwnerClient.send(updateMessage);
          }
        } else {
          console.log('Order not found:', data.orderId);
        }
      } else if (data.type === 'paymentConfirmed') {
        if (ws.role !== 'admin') {
          ws.send(JSON.stringify({ type: 'authorizationError', message: 'Confirmação de pagamento não autorizada.' }));
          return;
        }
        console.log('Payment confirmed for order:', data.orderId);
        const orderIndex = orders.findIndex(o => o.id === data.orderId);
        if (orderIndex > -1) {
          const order = orders[orderIndex];
          const userClientId = order.clientId; // Store the client ID
          const userClient = clients.get(userClientId);

          if (userClient && userClient.readyState === WebSocket.OPEN) {
            console.log(`Sending clearHistory to client ${userClientId} for order ${order.id}`);
            userClient.send(JSON.stringify({ type: 'clearHistory' }));
          } else {
            console.log(`Client ${userClientId} not found or not connected.`);
          }

          // Remove ALL orders from the same client (not just one)
          const ordersToRemove = [];
          for (let i = orders.length - 1; i >= 0; i--) {
            if (orders[i].clientId === userClientId) {
              ordersToRemove.push(orders[i].id);
              orders.splice(i, 1);
            }
          }
          
          console.log(`Removed ${ordersToRemove.length} orders for client ${userClientId}`);
          
          // Notify all admins that the orders are completed and removed
          ordersToRemove.forEach(orderId => {
            const removalMessage = JSON.stringify({ type: 'orderRemoved', orderId: orderId });
            
            // Send to admins only
            clients.forEach((client, id) => {
              if (client.role === 'admin' && client.readyState === WebSocket.OPEN) {
                client.send(removalMessage);
              }
            });
          });

        } else {
          console.log('Order not found for payment confirmation:', data.orderId);
        }
      } else if (data.type === 'notifyWaiterForDelivery') {
        if (!['admin', 'kitchen', 'counter'].includes(ws.role)) {
          ws.send(JSON.stringify({ type: 'authorizationError', message: 'Apenas a equipe autorizada pode chamar o garçom.' }));
          return;
        }
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
          if ((client.role === 'admin' || client.role === 'waiter') && client.readyState === WebSocket.OPEN) {
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
          if ((client.role === 'admin' || client.role === 'waiter') && client.readyState === WebSocket.OPEN) {
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
        console.log('[DELIVERY] Validando sessão do motoboy:', data.motoboyInfo?.id);
        authenticateMotoboySocket(ws, data).catch(error => {
          console.error('[DELIVERY] Falha na autenticação do motoboy:', error);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'motoboyLoginError', message:'Não foi possível validar sua conta.' }));
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
            status: data.order.status || 'pending',
            paymentStatus: data.order.paymentStatus || 'pending'
          };
          deliveryOrders.push(order);
          persistDeliveryOrders();
          console.log('[DELIVERY] Novo pedido recebido:', order.id);

          broadcastToMotoboys({ type: 'newDeliveryOrder', order });
          broadcastToAdmins({ type: 'newDeliveryOrder', order });
        } else if (!order.clientId) {
          order.clientId = ws.clientId;
          persistDeliveryOrders();
        }

        ws.send(JSON.stringify({ type: 'deliveryOrderConfirmation', orderId: order.id }));
        
      } else if (data.type === 'acceptDeliveryOrder') {
        // Motoboy accepts delivery order
        console.log('[DELIVERY] Motoboy aceitou pedido:', data.orderId);
        
        const order = deliveryOrders.find(o => o.id === data.orderId);
        
        if (ws.role === 'motoboy' && ws.motoboyInfo?.id && order && order.status === 'pending') {
          order.status = 'accepted';
          order.motoboyId = ws.motoboyInfo.id;
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
        // Motoboy starts delivery
        console.log('[DELIVERY] Motoboy iniciou entrega:', data.orderId);
        
        const order = deliveryOrders.find(o => o.id === data.orderId);
        
        if (ws.role === 'motoboy' && ws.motoboyInfo?.id && order &&
            String(order.motoboyId) === String(ws.motoboyInfo.id) && order.status === 'accepted') {
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
        // Motoboy enviou atualização de localização
        console.log('[DELIVERY] Atualização de localização do motoboy:', data);
        
        const order = deliveryOrders.find(o => o.id === data.orderId);
        
        if (ws.role === 'motoboy' && ws.motoboyInfo?.id && order &&
            String(order.motoboyId) === String(ws.motoboyInfo.id) && order.status === 'delivering' &&
            Number.isFinite(Number(data.latitude)) && Number.isFinite(Number(data.longitude))) {
          // Salvar localização no localStorage
          order.motoboyLocation = {
            latitude: Number(data.latitude),
            longitude: Number(data.longitude),
            timestamp: new Date().toISOString()
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
        
        if (ws.role === 'motoboy' && ws.motoboyInfo?.id && order &&
            String(order.motoboyId) === String(ws.motoboyInfo.id) && order.status === 'delivering') {
          order.status = 'awaiting_customer_confirmation';
          order.completedAt = new Date().toISOString();
          persistDeliveryOrders();

          // O pagamento só é liberado após confirmação do cliente.
          broadcastToCustomer(data.orderId, {
            type: 'deliveryAwaitingCustomerConfirmation',
            orderId: data.orderId,
            message: 'O motoboy informou a entrega. Confirme o recebimento para concluir.'
          });
          broadcastToAdmins({
            type: 'deliveryAwaitingCustomerConfirmation',
            orderId: data.orderId
          });
        }
      } else if (data.type === 'confirmDeliveryOrder') {
        const order = deliveryOrders.find(o => o.id === data.orderId);
        if (!order || String(order.clientId) !== String(ws.clientId) ||
            order.status !== 'awaiting_customer_confirmation') {
          ws.send(JSON.stringify({ type: 'deliveryConfirmationError', message: 'Pedido não encontrado ou não pertence a esta sessão.' }));
          return;
        }
        order.status = 'completed';
        order.customerConfirmedAt = new Date().toISOString();
        persistDeliveryOrders();
        persistMotoboyDeliveryPayable(order).catch(error => {
          console.error('[COURIER PAYABLE] Falha ao registrar valor devido ao motoboy:', error);
        });
        ws.send(JSON.stringify({ type: 'deliveryConfirmed', orderId: order.id }));
        broadcastToAdmins({ type: 'deliveryConfirmed', orderId: order.id });
        clients.forEach(client => {
          if (client.role === 'motoboy' && String(client.motoboyInfo?.id) === String(order.motoboyId) &&
              client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'deliveryConfirmed', orderId: order.id }));
          }
        });
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



function verifyMerchantSocketToken(token) {
  const secret = process.env.MERCHANT_AUTH_SECRET || '';
  if (!secret || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
  const supplied = Buffer.from(parts[2], 'base64url');
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return Number(payload.sub);
  } catch (_) { return null; }
}
async function authenticateMerchantStaffSocket(ws, data, role) {
  const merchantId = verifyMerchantSocketToken(data.token);
  if (!merchantId) {
    ws.send(JSON.stringify({ type: role + 'LoginError', message: 'Entre com a conta do comerciante para acessar esta área.' }));
    return;
  }
  const result = await dbQuery("SELECT id,status FROM merchants WHERE id=$1 LIMIT 1", [merchantId]);
  if (!result.rows[0] || result.rows[0].status !== 'active') {
    ws.send(JSON.stringify({ type: role + 'LoginError', message: 'Conta do comerciante ainda não está ativa.' }));
    return;
  }
  ws.role = role;
  ws.merchantId = merchantId;
  ws.send(JSON.stringify({ type: role + 'LoginSuccess' }));
}

function verifyMotoboySocketToken(token) {
  const secret = process.env.ACCOUNT_AUTH_SECRET || process.env.MERCHANT_AUTH_SECRET || '';
  if (!secret || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
  const supplied = Buffer.from(parts[2], 'base64url');
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.typ !== 'motoboy' || !payload.sub || payload.exp < Math.floor(Date.now()/1000)) return null;
    return Number(payload.sub);
  } catch (_) { return null; }
}
async function authenticateMotoboySocket(ws, data) {
  const id = verifyMotoboySocketToken(data.token || data.motoboyInfo?.token);
  if (!id) {
    ws.send(JSON.stringify({ type:'motoboyLoginError', message:'Autenticação inválida. Entre novamente.' }));
    return;
  }
  const result = await dbQuery('SELECT id,name,phone,status FROM motoboys WHERE id=$1 LIMIT 1', [id]);
  const account = result.rows[0];
  if (!account || account.status !== 'active') {
    ws.send(JSON.stringify({ type:'motoboyLoginError', message:'Conta não autorizada para receber entregas.' }));
    return;
  }
  ws.role = 'motoboy';
  ws.motoboyInfo = { id:account.id, name:account.name, phone:account.phone };
  ws.send(JSON.stringify({
    type:'existingDeliveryOrders',
    orders:deliveryOrders.filter(o => ['pending','accepted','preparing','delivering'].includes(o.status))
  }));
  broadcastToAdmins({ type:'motoboyAvailable', motoboyInfo:ws.motoboyInfo });
}

async function persistMotoboyDeliveryPayable(order) {
  const motoboyId = Number(order?.motoboyId);
  const amountCents = Number.isSafeInteger(Number(order?.motoboyAmountCents))
    ? Number(order.motoboyAmountCents)
    : Math.round(Number(order?.total || 0) * 10); // regra atual do painel: 10% do pedido
  if (!Number.isSafeInteger(motoboyId) || motoboyId <= 0 || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    console.warn('[COURIER PAYABLE] Pedido sem motoboyId/valor válido; não foi criado título financeiro.', order?.id);
    return;
  }
  let merchantResult;
  if (order.merchantId) {
    merchantResult = await dbQuery('SELECT id FROM merchants WHERE id=$1 LIMIT 1', [Number(order.merchantId)]);
  } else if (order.storeSlug) {
    merchantResult = await dbQuery('SELECT id FROM merchants WHERE store_slug=$1 LIMIT 1', [String(order.storeSlug)]);
  } else if (order.establishmentId) {
    merchantResult = await dbQuery('SELECT id FROM merchants WHERE establishment_id=$1 LIMIT 1', [Number(order.establishmentId)]);
  } else {
    console.warn('[COURIER PAYABLE] Pedido sem merchantId/storeSlug/establishmentId; não é possível vincular a dívida.', order?.id);
    return;
  }
  const merchantId = merchantResult?.rows?.[0]?.id;
  if (!merchantId) {
    console.warn('[COURIER PAYABLE] Comerciante não encontrado para o pedido.', order?.id);
    return;
  }
  const motoboy = await dbQuery('SELECT id FROM motoboys WHERE id=$1 AND status=\'active\' LIMIT 1', [motoboyId]);
  if (!motoboy.rows[0]) {
    console.warn('[COURIER PAYABLE] Motoboy não encontrado/ativo no banco.', motoboyId);
    return;
  }
  await dbQuery(
    `INSERT INTO motoboy_deliveries (merchant_id,motoboy_id,order_reference,amount_cents,due_at)
     VALUES ($1,$2,$3,$4,NOW()+INTERVAL '48 hours')
     ON CONFLICT (merchant_id,order_reference,motoboy_id) DO NOTHING`,
    [merchantId,motoboyId,String(order.id),amountCents]
  );
  console.log('[COURIER PAYABLE] Entrega registrada com vencimento em 48 horas.', { merchantId,motoboyId,orderId:order.id,amountCents });
}

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
  // Find the customer who owns this order
  const order = deliveryOrders.find(o => o.id === orderId);
  
  if (order && order.clientId) {
    const customerClient = clients.get(order.clientId);
    if (customerClient && customerClient.readyState === WebSocket.OPEN) {
      customerClient.send(JSON.stringify(message));
    }
  }
}