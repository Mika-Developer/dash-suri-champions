# dash-suri-champions
Suri Champions

## Tela "Craques da Call" (notas Salesbud)

Mostra, para **Pré-vendas** (time SDR) e **Vendas** (time Closer), um ranking com a **última nota de cada pessoa**, da maior para a menor; o pódio são os 3 primeiros. Quando sai uma nota nova, ela substitui a anterior da pessoa. Notas 9 ou 10 novas geram um popup.

Os dados vêm da [API da Salesbud](https://docs.salesbud.com.br/) por um proxy no Google Apps Script, para que o `client_secret` não fique no HTML público:

1. Crie uma credencial **de empresa** na Salesbud, com os escopos `meetings.read` e `calls.read`.
2. Siga as instruções no topo de [`apps-script/salesbud-proxy.gs`](apps-script/salesbud-proxy.gs): crie o projeto, salve `SALESBUD_CLIENT_ID` e `SALESBUD_CLIENT_SECRET` nas *Propriedades do script*, rode `testarSalesbud` e implante como App da Web.
3. Cole a URL `/exec` em `SALESBUD_PROXY_URL` no `index.html`.

Para testar sem a API, abra a página com `?demo=1&view=notas`.
