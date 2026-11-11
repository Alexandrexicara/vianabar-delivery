# Regras de repasse — versão corrigida

> Este documento substitui a regra antiga baseada em percentuais. Não use os exemplos antigos deste arquivo ou de versões anteriores.

## Regra comercial

Todos os componentes são valores fixos em reais, guardados como centavos no sistema:

- valor dos produtos;
- valor fixo da entrega;
- taxa fixa da plataforma;
- valor líquido do comerciante.

Não calcular parte de nenhum participante por percentual do total do pedido. Não presumir que o motoboy recebe uma porcentagem do pedido.

## Dois fluxos diferentes

### A — Split automático do pedido

O provedor recebe o valor da cobrança e divide os valores fixos configurados para cada participante, desde que o contrato do provedor e a conta estejam habilitados para esse recurso. O servidor calcula e valida todos os valores antes de criar a cobrança.

### B — Motoboy contratado pelo comerciante

A entrega gera uma obrigação fixa do comerciante para o motoboy. O sistema acumula as obrigações e, após 48 horas, apresenta os valores vencidos para autorização do comerciante. A confirmação de pagamento deve vir do provedor de transferência.

## Provedor

O código legado de MyGateway não é uma implementação válida de split: contém percentuais, endpoint não correspondente à documentação pública e chamadas feitas pelo navegador. Não usar esse código como integração financeira de produção.

A documentação oficial da Woovi descreve split PIX por valores em centavos, com subcontas e saque separado. A implementação deve seguir o contrato oficial e usar credenciais somente no servidor.

## Valores

Os valores comerciais devem ser definidos nas configurações administrativas e aprovados antes de habilitar pagamentos reais. Não há valores padrão de produção definidos neste documento.
