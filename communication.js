/**
 * Módulo de Comunicação Centralizado
 * Gerencia comunicação entre delivery, usuario e motoboy via WebSocket e localStorage
 */

const DeliveryCommunication = {
    ws: null,
    clientId: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    reconnectDelay: 3000,
    
    // Variáveis para controle de pedidos processados
    processedOrderIds: new Set(),
    lastProcessedTimestamp: null,
    
    // Inicializar conexão WebSocket
    init() {
        console.log('[COMMUNICATION] Iniciando módulo de comunicação...');
        this.connectWebSocket();
        this.setupLocalStorageListener();
        this.setupBroadcastChannel();
    },
    
    // Conectar ao servidor WebSocket
    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const hostname = (window.location.hostname || 'localhost').trim() || 'localhost';
        const portCandidates = [...new Set([
            window.location.port,
            '10000',
            '3002',
            '3001',
            '3000'
        ].filter(Boolean))];

        const buildUrl = (port) => `${protocol}://${hostname}:${port}`;

        const tryConnect = (index = 0) => {
            if (index >= portCandidates.length) {
                console.warn('[COMMUNICATION] Nenhuma porta WebSocket disponível. Usando fallback localStorage.');
                return;
            }

            const wsUrl = buildUrl(portCandidates[index]);
            console.log('[COMMUNICATION] Tentando conectar a:', wsUrl);

            try {
                this.ws = new WebSocket(wsUrl);

                this.ws.onopen = () => {
                    console.log('✅ [COMMUNICATION] WebSocket conectado!');
                    this.reconnectAttempts = 0;
                    this.sendHeartbeat();
                };

                this.ws.onmessage = (event) => {
                    try {
                        if (typeof event.data === 'string' && !event.data.startsWith('{')) {
                            console.log('[COMMUNICATION] Mensagem de texto recebida:', event.data);
                            return;
                        }

                        const message = JSON.parse(event.data);
                        console.log('[COMMUNICATION] Mensagem recebida:', message);
                        this.handleMessage(message);
                    } catch (error) {
                        console.warn('[COMMUNICATION] Erro ao processar mensagem (pode ser texto):', error.message);
                    }
                };

                this.ws.onclose = () => {
                    console.log('❌ [COMMUNICATION] WebSocket desconectado');
                    if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.attemptReconnect();
                    }
                };

                this.ws.onerror = (error) => {
                    console.error('[COMMUNICATION] Erro no WebSocket em', wsUrl, error);
                    if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
                        this.ws = null;
                        tryConnect(index + 1);
                    }
                };
            } catch (error) {
                console.error('[COMMUNICATION] Falha ao criar WebSocket em', wsUrl, error);
                tryConnect(index + 1);
            }
        };

        tryConnect();
    },
    
    // Tentar reconectar
    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`[COMMUNICATION] Tentativa de reconexão ${this.reconnectAttempts}/${this.maxReconnectAttempts} em ${this.reconnectDelay}ms`);
            setTimeout(() => this.connectWebSocket(), this.reconnectDelay);
        } else {
            console.warn('[COMMUNICATION] Máximo de tentativas atingido. Usando fallback localStorage.');
        }
    },
    
    // Enviar heartbeat para manter conexão
    sendHeartbeat() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.send({ type: 'heartbeat', timestamp: new Date().toISOString() });
            setTimeout(() => this.sendHeartbeat(), 30000); // A cada 30 segundos
        }
    },
    
    // Configurar listener para localStorage (fallback)
    setupLocalStorageListener() {
        window.addEventListener('storage', (event) => {
            if (event.key === 'deliveryOrders') {
                console.log('[COMMUNICATION] Mudança detectada no localStorage: deliveryOrders');
                const newOrders = JSON.parse(event.newValue || '[]');
                
                // Processar apenas novos pedidos verdadeiros
                newOrders.forEach(order => {
                    // Verificar se já processou este pedido
                    if (!this.processedOrderIds.has(order.id)) {
                        // Verificar se é um pedido recente (últimos 5 segundos)
                        const orderTime = new Date(order.orderTime || order.timestamp).getTime();
                        const now = Date.now();
                        const timeDiff = now - orderTime;
                        
                        if (timeDiff < 5000) { // Apenas pedidos dos últimos 5 segundos
                            console.log('[COMMUNICATION] Novo pedido detectado:', order);
                            this.broadcastToMotoboy(order);
                            
                            // Marcar como processado
                            this.processedOrderIds.add(order.id);
                            this.lastProcessedTimestamp = now;
                            
                            // Limpar Set após 1 minuto para evitar memory leak
                            setTimeout(() => {
                                this.processedOrderIds.delete(order.id);
                            }, 60000);
                        }
                    }
                });
            }
            
            if (event.key === 'motoboyNotifications') {
                console.log('[COMMUNICATION] Notificação do motoboy detectada');
                const notifications = JSON.parse(event.newValue || '[]');
                notifications.forEach(notification => {
                    this.handleMotoboyNotification(notification);
                });
            }
        });
    },
    
    // Configurar BroadcastChannel para comunicação entre abas
    setupBroadcastChannel() {
        if (typeof BroadcastChannel !== 'undefined') {
            this.channel = new BroadcastChannel('delivery_channel');
            
            this.channel.onmessage = (event) => {
                console.log('[COMMUNICATION] Mensagem via BroadcastChannel:', event.data);
                this.handleMessage(event.data);
            };
        }
    },
    
    // Enviar mensagem
    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
            return true;
        } else {
            console.warn('[COMMUNICATION] WebSocket não disponível, usando fallback');
            this.fallbackSend(message);
            return false;
        }
    },
    
    // Fallback usando localStorage quando WebSocket falhar
    fallbackSend(message) {
        if ((message.type === 'submitOrder' || message.type === 'submitDeliveryOrder') && message.order) {
            // Salvar pedido no localStorage
            const existingOrders = JSON.parse(localStorage.getItem('deliveryOrders') || '[]');
            const alreadyExists = existingOrders.some(item => item.id === message.order.id);
            if (!alreadyExists) {
                existingOrders.push(message.order);
                localStorage.setItem('deliveryOrders', JSON.stringify(existingOrders));
            }
            
            // Disparar evento personalizado
            window.dispatchEvent(new CustomEvent('newDeliveryOrder', { detail: message.order }));
            
            // Tentar comunicar com motoboy via postMessage se estiver em iframe
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({
                    type: 'NEW_DELIVERY_ORDER',
                    order: message.order
                }, '*');
            }
            
            console.log('[COMMUNICATION] Pedido salvo via fallback localStorage');
        }
    },
    
    // Lidar com mensagens recebidas
    handleMessage(message) {
        switch (message.type) {
            case 'existingDeliveryOrders':
                (message.orders || []).forEach(order => {
                    this.broadcastToMotoboy(order);
                });
                break;
            case 'deliveryOrderConfirmation':
                window.dispatchEvent(new CustomEvent('deliveryOrderConfirmed', { detail: message }));
                break;
            case 'deliveryOrderError':
                window.dispatchEvent(new CustomEvent('deliveryOrderError', { detail: message }));
                break;
            case 'submitDeliveryOrder':
            case 'submitOrder':
                console.log('[COMMUNICATION] Novo pedido de delivery recebido:', message.order?.id);
                if (message.order) {
                    this.broadcastToMotoboy(message.order);
                }
                break;
            case 'orderAccepted':
                console.log('[COMMUNICATION] Pedido aceito:', message.orderId);
                this.handleOrderAccepted(message);
                break;
            case 'orderDelivering':
                console.log('[COMMUNICATION] Pedido saindo para entrega:', message.orderId);
                this.handleOrderDelivering(message);
                break;
            case 'orderCompleted':
                console.log('[COMMUNICATION] Pedido entregue:', message.orderId);
                this.handleOrderCompleted(message);
                break;
            case 'motoboyAssigned':
                console.log('[COMMUNICATION] Motoboy designado:', message.motoboyName);
                this.handleMotoboyAssigned(message);
                break;
            case 'motoboyLocationUpdate':
                console.log('[COMMUNICATION] Localização do motoboy atualizada:', message.orderId);
                this.handleMotoboyLocationUpdate(message);
                break;
            case 'newDeliveryOrder':
            case 'NEW_DELIVERY_ORDER':
                console.log('[COMMUNICATION] Novo pedido de delivery:', message.order?.id);
                if (message.order) {
                    this.broadcastToMotoboy(message.order);
                }
                break;
        }
    },
    
    // Lidar com atualização de localização do motoboy
    handleMotoboyLocationUpdate(message) {
        const { orderId, latitude, longitude, motoboyName, motoboyPhone, status } = message;
        
        // Salvar localização no localStorage
        const locationData = {
            orderId,
            latitude,
            longitude,
            motoboyName,
            motoboyPhone,
            status,
            timestamp: new Date().toISOString()
        };
        localStorage.setItem(`motoboyLocation_${orderId}`, JSON.stringify(locationData));
        
        // Atualizar localização no pedido
        const deliveryOrders = JSON.parse(localStorage.getItem('deliveryOrders') || '[]');
        const order = deliveryOrders.find(o => o.id === orderId);
        if (order) {
            order.motoboyLocation = { latitude, longitude };
            order.motoboyName = motoboyName || order.motoboyName;
            order.motoboyPhone = motoboyPhone || order.motoboyPhone;
            localStorage.setItem('deliveryOrders', JSON.stringify(deliveryOrders));
        }
        
        // Disparar evento para atualizar mapa em tempo real
        window.dispatchEvent(new CustomEvent('motoboyLocationUpdated', { detail: locationData }));
        
        console.log(`[COMMUNICATION] Localização do motoboy ${motoboyName} atualizada: ${latitude}, ${longitude}`);
    },
    
    // Enviar novo pedido para todos os interessados
    broadcastNewOrder(order) {
        console.log('[COMMUNICATION] Broadcast de novo pedido:', order.id);
        
        const normalizedOrder = { ...order, status: order.status || 'pending' };

        // Via WebSocket
        const sent = this.send({
            type: 'submitDeliveryOrder',
            order: normalizedOrder
        });
        
        // Via localStorage (fallback)
        const existingOrders = JSON.parse(localStorage.getItem('deliveryOrders') || '[]');
        const alreadyExists = existingOrders.some(item => item.id === normalizedOrder.id);
        if (!alreadyExists) {
            existingOrders.push(normalizedOrder);
            localStorage.setItem('deliveryOrders', JSON.stringify(existingOrders));
        }
        
        // Via BroadcastChannel
        if (this.channel) {
            this.channel.postMessage({
                type: 'NEW_DELIVERY_ORDER',
                order: normalizedOrder
            });
        }
        
        // Disparar evento na janela
        window.dispatchEvent(new CustomEvent('newDeliveryOrder', { detail: normalizedOrder }));
        return sent;
    },
    
    // Enviar notificação para o motoboy
    broadcastToMotoboy(order) {
        console.log('[COMMUNICATION] Enviando pedido para motoboy:', order.id);
        
        // Salvar no localStorage específico para motoboy
        const motoboyOrders = JSON.parse(localStorage.getItem('motoboyOrders') || '[]');
        const alreadyExists = motoboyOrders.some(item => item.id === order.id);
        if (!alreadyExists) {
            motoboyOrders.push(order);
            localStorage.setItem('motoboyOrders', JSON.stringify(motoboyOrders));
        }
        
        // Disparar evento personalizado
        window.dispatchEvent(new CustomEvent('newOrderForMotoboy', { detail: order }));
        
        // Se estiver em iframe, comunicar com parent
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: 'NEW_DELIVERY_ORDER',
                order: order
            }, '*');
        }
    },
    
    // Lidar com pedido aceito
    handleOrderAccepted(message) {
        const notifications = JSON.parse(localStorage.getItem('customerNotifications') || '[]');
        notifications.push({
            orderId: message.orderId,
            type: 'ORDER_ACCEPTED',
            message: 'Seu pedido foi aceito pelo motoboy!',
            motoboyName: message.motoboyName,
            motoboyPhone: message.motoboyPhone,
            timestamp: new Date().toISOString()
        });
        localStorage.setItem('customerNotifications', JSON.stringify(notifications));
        
        // Atualizar status do pedido
        this.updateOrderStatus(message.orderId, 'accepted');
        
        // Disparar evento
        window.dispatchEvent(new CustomEvent('orderStatusChanged', { 
            detail: { 
                orderId: message.orderId, 
                status: 'accepted',
                motoboyName: message.motoboyName,
                motoboyPhone: message.motoboyPhone
            } 
        }));
    },
    
    // Lidar com pedido saindo para entrega
    handleOrderDelivering(message) {
        const notifications = JSON.parse(localStorage.getItem('customerNotifications') || '[]');
        notifications.push({
            orderId: message.orderId,
            type: 'DELIVERY_STARTED',
            message: 'Seu pedido saiu para entrega!',
            motoboyName: message.motoboyName,
            estimatedTime: message.estimatedTime,
            timestamp: new Date().toISOString()
        });
        localStorage.setItem('customerNotifications', JSON.stringify(notifications));
        
        // Atualizar status do pedido
        this.updateOrderStatus(message.orderId, 'delivering');
        
        // Disparar evento
        window.dispatchEvent(new CustomEvent('orderStatusChanged', { 
            detail: { 
                orderId: message.orderId, 
                status: 'delivering',
                estimatedTime: message.estimatedTime
            } 
        }));
    },
    
    // Lidar com pedido entregue
    handleOrderCompleted(message) {
        const notifications = JSON.parse(localStorage.getItem('customerNotifications') || '[]');
        notifications.push({
            orderId: message.orderId,
            type: 'ORDER_COMPLETED',
            message: 'Seu pedido foi entregue com sucesso!',
            timestamp: new Date().toISOString()
        });
        localStorage.setItem('customerNotifications', JSON.stringify(notifications));
        
        // Atualizar status do pedido
        this.updateOrderStatus(message.orderId, 'completed');
        
        // Disparar evento
        window.dispatchEvent(new CustomEvent('orderStatusChanged', { 
            detail: { 
                orderId: message.orderId, 
                status: 'completed'
            } 
        }));
    },
    
    // Lidar com motoboy designado
    handleMotoboyAssigned(message) {
        console.log('[COMMUNICATION] Motoboy designado:', message.motoboyName);
        
        // Salvar informações do motoboy
        const motoboyInfo = {
            orderId: message.orderId,
            motoboyName: message.motoboyName,
            motoboyPhone: message.motoboyPhone,
            motoboyVehicle: message.motoboyVehicle
        };
        
        localStorage.setItem(`motoboy_${message.orderId}`, JSON.stringify(motoboyInfo));
        
        // Disparar evento
        window.dispatchEvent(new CustomEvent('motoboyAssigned', { detail: motoboyInfo }));
    },
    
    // Lidar com notificação do motoboy
    handleMotoboyNotification(notification) {
        console.log('[COMMUNICATION] Processando notificação do motoboy:', notification);
        
        if (notification.action === 'accepted') {
            this.handleOrderAccepted({
                orderId: notification.orderId,
                motoboyName: notification.motoboyName,
                motoboyPhone: notification.motoboyPhone
            });
        } else if (notification.action === 'delivering') {
            this.handleOrderDelivering({
                orderId: notification.orderId,
                motoboyName: notification.motoboyName,
                estimatedTime: notification.estimatedTime
            });
        } else if (notification.action === 'completed') {
            this.handleOrderCompleted({
                orderId: notification.orderId
            });
        }
    },
    
    // Atualizar status do pedido
    updateOrderStatus(orderId, status) {
        const deliveryOrders = JSON.parse(localStorage.getItem('deliveryOrders') || '[]');
        const order = deliveryOrders.find(o => o.id === orderId);
        
        if (order) {
            order.status = status;
            localStorage.setItem('deliveryOrders', JSON.stringify(deliveryOrders));
            console.log(`[COMMUNICATION] Status do pedido ${orderId} atualizado para: ${status}`);
        }
    },
    
    // Obter status atual do pedido
    getOrderStatus(orderId) {
        const deliveryOrders = JSON.parse(localStorage.getItem('deliveryOrders') || '[]');
        const order = deliveryOrders.find(o => o.id === orderId);
        return order ? order.status : null;
    },
    
    // Registrar login do usuário
    registerUserLogin(userInfo) {
        this.send({
            type: 'userLogin',
            userInfo: userInfo
        });
    },
    
    // Registrar login do motoboy
    registerMotoboyLogin(motoboyInfo) {
        this.send({
            type: 'motoboyLogin',
            motoboyInfo: motoboyInfo
        });
    }
};

// Exportar para uso global
if (typeof window !== 'undefined') {
    window.DeliveryCommunication = DeliveryCommunication;
}
