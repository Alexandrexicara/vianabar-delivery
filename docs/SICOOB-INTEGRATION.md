# Sicoob Pix integration

The integration must use OAuth 2.0 Client Credentials with mutual TLS (mTLS), a valid client certificate, the application Client ID, and only the scopes enabled for the account.

Before production, configure credentials as Render environment secrets; never commit certificates, passwords, client secrets, or tokens.

Pix Recebimentos is for collecting Pix. It does not by itself implement outbound Pix transfers or split payouts to motoboys. Those require the Sicoob Pix Pagamentos product, its own authorization scopes, and an approved account.

The exact API base URL, OAuth scopes, certificate requirements, webhook registration, and payload schema must be confirmed against the OpenAPI files enabled for this specific application in the Sicoob Developers portal. Do not activate real payments until sandbox/homologation tests pass.

## Configuração no Render

Defina estas variáveis como secrets do serviço (não no Git):

```env
SICOOB_ENVIRONMENT=production
SICOOB_CLIENT_ID=
SICOOB_CLIENT_SECRET=
SICOOB_MTLS_PFX_BASE64=
SICOOB_MTLS_PFX_PASSWORD=
SICOOB_SCOPES=cob.read
SICOOB_PIX_EXPIRATION_SECONDS=3600
SICOOB_WEBHOOK_TOKEN=
```

O cliente usa os endpoints documentados no manual oficial do Sicoob:
- Produção: `https://apis.sisbr.com.br/cooperado/pix/token` e `https://apis.sisbr.com.br/cooperado/pix/api/v2`
- Homologação: `https://api-homol.sicoob.com.br/cooperado/pix/token` e `https://api-homol.sicoob.com.br/cooperado/pix/api/v2`

O manual informa OAuth Client Credentials com certificado mTLS, `client_id` e `client_secret` no formulário, e header `client_id` nas chamadas de API. Os escopos precisam corresponder exatamente aos concedidos para o aplicativo. A versão do manual disponível é 2.2.1, datada de 23/03/2021; confirmar no portal os detalhes atuais da aplicação antes de ativar.
