# Arquitetura atual de pedidos e pagamentos — VianaBar

Última revisão: 11/11/2026.

## 1. Provedores por comerciante

Cada estabelecimento usa um único provedor de recebimento por vez. O pedido carrega o identificador da loja e o backend consulta a configuração daquela loja. Nunca misturar AppID, chave Pix, cobranças ou repasses de comerciantes diferentes.

- **Ovi/Woovi:** foco da implementação atual do checkout do cardápio. Cada comerciante conecta seu próprio AppID Woovi. A cobrança Pix é criada no backend com o AppID daquele estabelecimento.
- **Cicobi/Sicoob:** permanece como integração bancária separada. O checkout Ovi não pode ser usado quando a loja estiver marcada como Sicoob. A estrutura de conexões e pagamentos de motoboy existente não significa que o checkout de pedidos do cardápio Sicoob esteja concluído.

## 2. Checkout Ovi/Woovi

1. O cliente envia o carrinho e o storeId; o backend busca os produtos ativos no Neon e recalcula preço e total. Valores enviados pelo navegador nunca são autoridade.
2. O pedido e os itens são persistidos no PostgreSQL/Neon antes da chamada ao provedor.
3. O backend usa o AppID Woovi criptografado e vinculado ao storeId para criar a cobrança em centavos.
4. O pedido permanece pendente. A página mostra QR Code / Pix Copia e Cola devolvido pela Woovi.
5. O webhook autenticado e idempotente confirma o pagamento somente após conciliar correlationID e valor em centavos.
6. Após o pagamento, o evento libera o pedido para cozinha e atualiza comerciante, garçom e cliente.

### Comissão da plataforma na Ovi

A regra comercial aceita para a Ovi é **15% do valor de cada venda**, transferidos por Pix Out da conta Woovi do próprio comerciante para a chave Pix da plataforma. Não é um split enviado pelo navegador e não é uma tarifa por item.

- A cobrança entra na conta Woovi do comerciante.
- Após o webhook confirmar o pagamento, o backend cria e aprova um Pix Out de 15% usando a conta do comerciante.
- A transferência só aparece como concluída depois do evento de confirmação da Woovi.
- A conta do comerciante precisa ter Pix Out habilitado.
- Se a transferência tiver resultado incerto ou falhar, o sistema registra needs_review; nunca repete uma transferência às cegas.
- A chave Pix de destino da plataforma é configurada somente no backend.

## 3. Dinheiro e cartão na mesa

Dinheiro e cartão presencial não são cobranças Pix Woovi. O pedido é registrado com estado awaiting_in_person, aparece para o comerciante e chama o garçom. O sistema não pode marcar como pago apenas porque o cliente clicou no botão. A confirmação manual segura pelo comerciante/garçom deve ser registrada separadamente da confirmação automática da Woovi.

## 4. Persistência e isolamento

- Pedidos do cardápio, itens, transações, webhooks e repasses da comissão ficam no Neon.
- Todo pedido está vinculado a store_id.
- Os produtos são consultados por store_id; preço e setor são lidos do banco.
- WebSocket entrega pedidos e avisos somente às telas identificadas com o mesmo estabelecimento.
- Pedidos ativos são recuperados do Neon quando o backend reinicia.

## 5. Proteção de credenciais e webhooks

- AppID Woovi por comerciante e a chave Pix da plataforma são armazenados com AES-256-GCM no Neon; a chave de criptografia fica somente no ambiente do backend.
- Não enviar AppID, tokens ou chave Pix ao HTML, JavaScript público, localStorage ou logs.
- Webhooks validam a assinatura RSA-SHA256 oficial da Woovi sobre o corpo bruto, conferem também o token de autorização configurado e são deduplicados por correlationID + evento.
- Conferir valor recebido e o pedido antes de alterar estado financeiro.
- O navegador não pode marcar PIX/cartão como pago.
- As rotas legadas que simulavam confirmação permanecem desativadas.

## 6. Configuração necessária antes de receber dinheiro real

Variáveis do backend:
- PAYMENT_CREDENTIALS_ENCRYPTION_KEY: chave AES de 32 bytes, já provisionada no Render.
- WOOVI_WEBHOOK_AUTH_TOKEN: token de autorização dos webhooks, já provisionado no Render.
- WOOVI_API_BASE_URL: produção https://api.woovi.com.
- WOOVI_WEBHOOK_URL: endpoint público HTTPS do Render.

A chave Pix da plataforma é cadastrada na página restrita do criador (Configurar Ovi) e fica criptografada no Neon. Além disso, cada comerciante precisa conectar o AppID de produção da própria conta Woovi pela mesma página. A conta precisa permitir cobrança Pix e Pix Out. Sem esses dois cadastros ativos, o checkout Pix fica bloqueado — não usar chave fictícia ou ambiente sandbox como se fosse produção.

## 7. Estado do Cicobi/Sicoob

A integração Sicoob continua isolada do checkout Ovi. As tabelas de conexão e repasses de motoboy são uma base para esse fluxo, mas não há evidência de que o checkout de pedidos do cardápio esteja integrado e validado em produção. Não marcar Cicobi como concluído antes de conferir credenciais de produção, APIs liberadas, webhooks/consultas e teste real.

## 8. Motoboys

O pagamento do motoboy é outro fluxo: obrigação fixa por entrega, vinculada a comerciante, motoboy e pedido. Não calcular o valor do motoboy como percentual da venda. A transferência só pode ser marcada como paga após confirmação do provedor. Não misturar esse pagamento com a comissão Ovi da plataforma.