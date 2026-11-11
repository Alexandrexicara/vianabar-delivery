# Split automático — regras atuais

Este documento substitui todas as instruções antigas deste arquivo que descreviam percentuais.

O split automático pertence exclusivamente ao **Fluxo A — pagamento do pedido**. Os valores são fixos, em reais/centavos, nunca percentuais.

O servidor deve montar a divisão a partir dos valores comerciais aprovados e persistidos no pedido. A soma dos repasses não pode ultrapassar o valor efetivamente cobrado. A cobrança só fica paga após confirmação autenticada do provedor, com conciliação do identificador e do valor.

A documentação oficial da Woovi descreve cobrança PIX com split em valores fixos (centavos) para subcontas. O saldo de uma subconta é acumulado e o saque é uma operação separada. A disponibilidade depende da habilitação da conta e das permissões do contrato.

A documentação pública da My Gateway consultada descreve criação de PIX, cartão com 3DS e consulta de situação; não descreve split entre recebedores. Não enviar campos de split não documentados.

O **Fluxo B** não é split automático: é a obrigação do comerciante de pagar o motoboy contratado, com vencimento após 48 horas e autorização do comerciante.

Nenhum valor comercial deve ser inventado. Os valores fixos devem ser definidos nas configurações aprovadas antes de ativar o fluxo financeiro em produção.
