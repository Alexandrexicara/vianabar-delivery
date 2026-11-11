# Dados bancários — situação e segurança

Este documento registra a situação do módulo bancário legado e substitui afirmações anteriores de integração concluída.

## Situação encontrada

O arquivo mygateway-bankdata.js e telas antigas salvam dados bancários no localStorage do navegador. Isso não equivale a cadastrar uma conta no provedor, validar titularidade, criar subconta, iniciar transferência ou confirmar recebimento.

Dados bancários e chaves PIX não devem ser tratados como credenciais verificadas apenas porque foram preenchidos no navegador. A integração de produção deve enviar os dados ao backend autenticado, armazená-los com controles adequados e seguir o processo de validação do provedor.

## Bancos e códigos

A tabela antiga de códigos bancários era apenas uma referência de preenchimento. A presença de um código na lista não significa que exista integração bancária ou autorização de transferência com aquele banco.

## Próximas etapas técnicas

1. Definir o provedor efetivo para o pagamento de motoboys.
2. Implementar cadastro e validação de recebedores no backend.
3. Registrar solicitações de pagamento com valores fixos em centavos.
4. Exigir autorização autenticada do comerciante.
5. Confirmar a transferência por resposta/webhook verificável do provedor.
6. Manter histórico e trilha de auditoria.

A decisão sobre onde os valores serão mantidos/reservados fica em aberto para definição conjunta. Não há nesta etapa escolha de conta bancária ou instituição custodiante.
