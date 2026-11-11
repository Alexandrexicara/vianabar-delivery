# Integração Sicoob — Delivery Day

## Modelo definido
- O comerciante é o titular da conta Sicoob e autoriza as APIs Pix Recebimentos e Pix Pagamentos.
- A plataforma e os motoboys não precisam ser correntistas Sicoob. Cada um cadastra sua própria chave Pix como recebedor.
- Os pagamentos dos pedidos entram na conta do comerciante. Os valores da plataforma e dos motoboys saem dessa conta por transferências Pix separadas.
- A obrigação do motoboy vence 24 horas após a conclusão da entrega.
- O fechamento agrupa por comerciante + motoboy: um lote e uma transferência Pix por grupo.
- Não há aprovação manual do comerciante a cada lote; a autorização da integração bancária é feita uma vez.
- O painel administrativo terá reprocessamento controlado. Nunca repetir automaticamente uma transferência cujo resultado bancário seja desconhecido.

## Segurança
- Client secret, certificado, chave privada e chaves Pix devem ser cifrados no servidor.
- Nenhuma credencial pode ser enviada ao navegador ou gravada em logs.
- O estado processing exige referência retornada pelo Sicoob.
- O estado paid exige consulta ou webhook autenticado confirmando a liquidação.
- Falha com resultado ambíguo vai para needs_review, sem retry cego.
- Valores são armazenados em centavos. Não há percentuais nem tarifas inventadas.

## Dependências para dinheiro real
1. Credenciais de produção do comerciante e autorização das APIs.
2. Especificação técnica oficial da API Pix Pagamentos (endpoint, OAuth scopes, mTLS, idempotência e consulta de status).
3. Confirmação dos limites e da elegibilidade da cooperativa/conta.
4. Teste homologado de transferência para chave Pix externa.

A existência das APIs no catálogo do Sicoob não substitui a documentação técnica nem a aprovação de produção. Nenhum pagamento é simulado ou marcado como pago sem confirmação bancária.
