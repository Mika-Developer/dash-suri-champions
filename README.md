# dash-suri-champions
Suri Champions

## Tela "Notas Salesbud"

Mostra, para **Pré-vendas** e **Vendas**, as últimas 5 notas da Salesbud e o top 3 pela média das últimas 5 notas de cada pessoa.

Os dados vêm da [API da Salesbud](https://docs.salesbud.com.br/) por um proxy no Google Apps Script, para que o `client_secret` não fique no HTML público:

1. Crie uma credencial **de empresa** na Salesbud, com os escopos `meetings.read` e `calls.read`.
2. Siga as instruções no topo de [`apps-script/salesbud-proxy.gs`](apps-script/salesbud-proxy.gs): crie o projeto, salve `SALESBUD_CLIENT_ID` e `SALESBUD_CLIENT_SECRET` nas *Propriedades do script*, rode `testarSalesbud` e implante como App da Web.
3. Cole a URL `/exec` em `SALESBUD_PROXY_URL` no `index.html`.

Para testar sem a API, abra a página com `?demo=1&view=notas`.
