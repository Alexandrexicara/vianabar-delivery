# Sicoob Pix integration

The integration must use OAuth 2.0 Client Credentials with mutual TLS (mTLS), a valid client certificate, the application Client ID, and only the scopes enabled for the account.

Before production, configure credentials as Render environment secrets; never commit certificates, passwords, client secrets, or tokens.

Pix Recebimentos is for collecting Pix. It does not by itself implement outbound Pix transfers or split payouts to motoboys. Those require the Sicoob Pix Pagamentos product, its own authorization scopes, and an approved account.

The exact API base URL, OAuth scopes, certificate requirements, webhook registration, and payload schema must be confirmed against the OpenAPI files enabled for this specific application in the Sicoob Developers portal. Do not activate real payments until sandbox/homologation tests pass.
