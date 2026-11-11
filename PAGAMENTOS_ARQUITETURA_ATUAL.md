# Arquitetura de pagamentos e entregas

## Regra principal

O sistema trabalha com valores fixos em reais, armazenados em centavos no banco. Não usar percentuais para calcular repasses, taxas ou entregas.

Os valores fixos de cada componente precisam vir da configuração comercial aprovada. Não criar valores padrão novos nem assumir que valores de demonstração sejam valores de produção.

## Fluxo A — pagamento do pedido com split automático

1. O servidor calcula e congela no pedido os valores: produtos, entrega, taxa fixa da plataforma e líquido do comerciante.
2. O servidor cria a cobrança no provedor usando o valor total em centavos.
3. Quando o provedor suportar split por valor fixo, o servidor envia os valores em centavos e confere que a soma dos repasses não ultrapassa o total.
4. O pedido só muda para pago depois de confirmação autenticada do provedor e conciliação de identificador, valor e moeda. As rotas antigas de confirmação simulada foram bloqueadas enquanto o checkout real não estiver ligado ao banco e ao provedor.
5. Webhooks repetidos não podem creditar saldos ou criar repasses duplicados.

### Provedores encontrados no repositório/documentação

- **Woovi:** a documentação oficial oferece cobrança PIX com correlationID e splits em valores fixos (centavos). O split para subcontas acumula saldo na subconta; o saque é uma operação separada. A conta precisa ter os recursos e permissões habilitados.
- **My Gateway:** a documentação pública consultada descreve criação de PIX, cartão com 3DS e consulta do pagamento. Ela orienta confirmar somente quando a situação chegar a Paid. A documentação pública consultada não descreve split entre recebedores. Portanto, não enviar campos de split inventados para essa API.

A seleção do provedor de cobrança e a disponibilidade de split devem ser confirmadas pelas credenciais/conta de produção. Não misturar contratos de APIs diferentes.

## Fluxo B — comerciante paga motoboys contratados por ele

Este fluxo é separado do split automático do pedido:

1. Cada entrega concluída gera uma obrigação de pagamento com valor fixo em centavos, vinculada ao comerciante, motoboy e pedido.
2. A obrigação vence 48 horas depois do momento em que foi gerada.
3. O painel do comerciante apresenta as obrigações vencidas e o total devido.
4. O comerciante autoriza um lote de pagamento; a autorização fica registrada com data e identificador do responsável.
5. O lote só pode ser marcado como pago após confirmação verificável do provedor de transferência.
6. Atraso deve bloquear novos saques/repasses ao comerciante apenas sobre valores que a plataforma ou o provedor efetivamente controla, conforme contrato e regras aplicáveis.

A migration migrations/20261111_create_merchant_motoboy_settlement.sql cria a estrutura persistente de obrigações, lotes, itens e eventos de auditoria. Ela não escolhe conta bancária, carteira ou instituição para custodiar/reservar os recursos. Essa decisão foi deixada deliberadamente em aberto.

## Segurança obrigatória

- Nunca aceitar do navegador o valor final do pedido ou o valor de split como autoridade. O servidor deve recalcular com dados persistidos.
- Nunca marcar PIX/cartão como pago por chamada direta do cliente.
- Não armazenar chaves de API em JavaScript público, HTML ou localStorage.
- Validar autenticação do webhook e conferir identificador, valor e estado na fonte do provedor.
- Usar transações SQL e idempotência para evitar duplicidade.
- Não afirmar que houve transferência bancária quando só foi criada uma obrigação ou autorização.

## Situação encontrada no código legado

As rotas antigas POST /pagamento/pix/:id e POST /pagamento/cartao/:id alteram o estado para pago sem confirmação de um provedor. O fluxo legado usa objetos em memória, que se perdem quando o processo reinicia. O módulo MyGateway antigo contém endpoint e campos de split incompatíveis com a documentação pública consultada.

Esses módulos não devem ser tratados como integração financeira pronta para produção. A substituição exige ligar o fluxo ao banco persistente, ao provedor efetivamente contratado e à autenticação dos painéis.

## Bloqueios de segurança já aplicados no código

- As rotas antigas de PIX/cartão não marcam mais pedidos como pagos.
- A rota antiga de criação de cobrança Woovi não aceita mais valores ou splits enviados pelo navegador.
- As rotas antigas de Google Pay e anti-chargeback não simulam captura nem estorno.
- Mensagens WebSocket do cliente não podem atualizar pagamento nem apagar histórico como se o pagamento tivesse sido confirmado.
- Pedidos recebidos por WebSocket são forçados para status de pagamento pendente.
- Saques instantâneos em memória do motoboy foram bloqueados até existir o fluxo persistente de 48 horas.
- O módulo antigo MyGateway no navegador foi substituído por adaptador desativado, sem chave de API e sem percentuais.
- Dados bancários/PIX não são mais solicitados no cadastro antigo de motoboy nem armazenados pelo módulo legado no navegador.
- Comissões de garçom nas telas administrativas passaram a usar valor fixo em reais, com padrão zero, em vez de percentual.

Esses bloqueios evitam confirmações financeiras falsas. Eles também significam que o checkout e a liquidação reais ainda precisam ser integrados antes de aceitar pagamentos em produção.


## Bloqueios identificados antes de ativar o fluxo real

- O banco Neon de produção consultado contém as tabelas de configuração/itens do cardápio, mas não possui tabelas persistentes de pedidos, comerciantes ou cobranças.
- A migration legada de cobranças referencia tabelas pedidos e merchants que não existem no schema de produção consultado.
- O fluxo de pedidos usado pelo WebSocket ainda mantém pedidos em memória; isso não serve como fonte financeira persistente.
- O projeto não tem, na branch main, uma sessão autenticada de comerciante pronta para autorizar lotes. Não expor as novas operações de autorização sem autenticação.
- Os valores fixos de entrega e taxa da plataforma não estão definidos em configuração de produção consultada. Os antigos R$ 1 e R$ 10 eram exemplos e foram removidos.
- O serviço de 48 horas ainda não foi ligado ao evento confiável de entrega concluída, porque o pedido atual não fornece valores fixos persistidos e autenticados.

Esses pontos precisam ser resolvidos para ativar o checkout e a autorização de pagamentos sem simulação. A escolha de onde manter os recursos continua separada e em aberto.
