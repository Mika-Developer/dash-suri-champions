/**
 * Proxy Salesbud → Dashboard Champions Suri
 * ------------------------------------------------------------
 * Por que um proxy? A API da Salesbud autentica com client_id + client_secret
 * (OAuth client credentials). Esse segredo não pode ficar no index.html, que é
 * público. Este script guarda o segredo no Google, pega o token, busca as notas
 * e devolve para o dashboard só o necessário (nome, área, nota, data, cliente).
 *
 * COMO CONFIGURAR
 * 1. https://script.google.com → Novo projeto → cole este arquivo inteiro.
 * 2. Engrenagem (Configurações do projeto) → Propriedades do script → adicione:
 *      SALESBUD_CLIENT_ID      = (client id da credencial)
 *      SALESBUD_CLIENT_SECRET  = (client secret — aparece uma única vez na Salesbud)
 *    A credencial deve ser de EMPRESA (lê as reuniões de todo mundo), com os
 *    escopos meetings.read e calls.read. Não configure allowlist de IP nela:
 *    o Apps Script roda em IPs variáveis do Google.
 * 3. Rode a função `testarSalesbud` uma vez no editor (autoriza o script e mostra
 *    no log as notas encontradas e os times de cada pessoa).
 * 4. Implantar → Nova implantação → App da Web
 *      Executar como: Eu | Quem tem acesso: Qualquer pessoa
 * 5. Copie a URL /exec e cole em SALESBUD_PROXY_URL no index.html.
 *
 * Docs da API: https://docs.salesbud.com.br/
 */

// ===================== CONFIGURAÇÃO =====================
const SALESBUD_API = 'https://api.salesbud.com.br';

// Janela de busca: notas dos últimos N dias (a média do top 3 usa as últimas 5 de cada pessoa).
const DIAS_JANELA = 14;

// Coleções lidas: 'meetings' (bot / upload) e 'calls' (VoIP). Remova uma se não usar.
const COLECOES = ['meetings', 'calls'];

// SÓ estes times da Salesbud são consultados (nome exato do time, sem diferenciar maiúsculas).
// A busca já é filtrada por time na própria API (team_id): notas de CS, Enablement ou
// qualquer outro time nem chegam a ser baixadas.
const TIMES = {
  'SDR':    'sdr',     // → coluna Pré-vendas
  'Closer': 'closer'   // → coluna Vendas
};

// Notas ignoradas por enquanto:
const NOTA_MINIMA = 1;                 // notas abaixo disso (ou seja, nota 0) não entram
const DURACAO_MINIMA_LIGACAO_SEG = 60; // ligações com menos de 1 minuto não entram

// Domínios da própria empresa: contas com esses domínios não são mostradas como "cliente".
const DOMINIOS_INTERNOS = ['suri.ai', 'chatbotmaker.io'];

// O dashboard mostra as 10 últimas notas de cada coluna e monta o pódio com a média
// das 5 últimas notas de cada pessoa. O proxy envia o suficiente para os dois.
const NOTAS_LISTA = 10;
const NOTAS_POR_PESSOA = 5;

// Cache da resposta (segundos). O dashboard consulta a cada 10s; isso evita gastar a cota da API.
const CACHE_RESPOSTA_SEG = 120;

// ===================== WEB APP =====================
function doGet() {
  let body;
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get('notas_resposta');
    if (cached) {
      body = cached;
    } else {
      body = JSON.stringify({ updated_at: new Date().toISOString(), notas: notasParaDashboard_(buscarNotas_()) });
      if (body.length < 95000) cache.put('notas_resposta', body, CACHE_RESPOSTA_SEG);
    }
  } catch (err) {
    body = JSON.stringify({ error: String(err && err.message || err) });
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

// Rode no editor para conferir a integração.
function testarSalesbud() {
  CacheService.getScriptCache().remove('notas_resposta');
  const notas = buscarNotas_();
  const times = {};
  notas.forEach(n => { times[n.name + ' — ' + n.team] = n.area; });
  const dash = notasParaDashboard_(notas);
  Logger.log('Notas encontradas: %s | enviadas ao dashboard: %s | tamanho: %s bytes',
    notas.length, dash.length, JSON.stringify(dash).length);
  Logger.log('Pessoa — time → área:\n%s', JSON.stringify(times, null, 2));
  Logger.log('Mais recentes no dashboard:\n%s', JSON.stringify(dash.slice(0, 10), null, 2));
}

// ===================== BUSCA =====================
function buscarNotas_() {
  const depois = new Date(Date.now() - DIAS_JANELA * 24 * 3600 * 1000).toISOString();
  const notas = [];
  timesAlvo_().forEach(time => {
    COLECOES.forEach(colecao => {
      // team_id → só reuniões/ligações de quem tem este time como padrão
      // score_min → só registros com avaliação concluída e nota >= NOTA_MINIMA (a API já filtra)
      const registros = listarTudo_('/v1/' + colecao, { team_id: time.id, meeting_after: depois, score_min: NOTA_MINIMA, limit: 100 });
      registros.forEach(r => {
        if (r.object === 'call' && Number(r.duration_seconds || 0) < DURACAO_MINIMA_LIGACAO_SEG) return;
        const score = notaDoRegistro_(colecao, r);
        if (score === null || score < NOTA_MINIMA) return;
        const owner = r.owner || {};
        notas.push({
          id: r.id,
          kind: r.object,                    // 'meeting' ou 'call'
          name: owner.name || owner.email || '—',
          email: owner.email || '',
          team: time.name,
          area: time.area,                   // 'sdr' (Pré-vendas) ou 'closer' (Vendas)
          score: score,                      // 0 a 10
          date: r.meeting_at,
          client: clienteDe_(r)
        });
      });
    });
  });
  notas.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return notas;
}

// Os times SDR e Closer da Salesbud, com seus ids (GET /v1/teams).
function timesAlvo_() {
  const alvo = {};
  Object.keys(TIMES).forEach(nome => { alvo[nome.trim().toLowerCase()] = TIMES[nome]; });
  const times = listarTudo_('/v1/teams', { limit: 100 })
    .filter(t => alvo[String(t.name || '').trim().toLowerCase()])
    .map(t => ({ id: t.id, name: t.name, area: alvo[String(t.name).trim().toLowerCase()] }));
  if (!times.length) throw new Error('Nenhum time ' + Object.keys(TIMES).join('/') + ' encontrado na Salesbud.');
  return times;
}

// O que vai para o dashboard: as últimas NOTAS_LISTA de cada área (lista)
// + as últimas NOTAS_POR_PESSOA de cada pessoa (média do pódio). `notas` já vem da mais recente.
function notasParaDashboard_(notas) {
  const porPessoa = {}, porArea = {};
  return notas.filter(n => {
    if (n.area !== 'sdr' && n.area !== 'closer') return false;
    const pessoa = n.area + '|' + (n.email || n.name).toLowerCase();
    porPessoa[pessoa] = (porPessoa[pessoa] || 0) + 1;
    porArea[n.area] = (porArea[n.area] || 0) + 1;
    return porArea[n.area] <= NOTAS_LISTA || porPessoa[pessoa] <= NOTAS_POR_PESSOA;
  }).map(n => ({ id: n.id, name: n.name, area: n.area, score: n.score, date: n.date, client: n.client, kind: n.kind }));
}

// Nome do cliente para exibir na TV — sem números de telefone e sem a própria Suri.
function clienteDe_(r) {
  const interno = d => DOMINIOS_INTERNOS.some(x => String(d || '').toLowerCase().endsWith(x));
  const candidatos = []
    .concat((r.accounts || []).filter(a => !interno(a.domain)).map(a => a.name || a.domain))
    .concat((r.participants || []).filter(p => !interno(p.email)).map(p => p.display_name));
  for (const c of candidatos) {
    const limpo = limpaTexto_(c);
    if (limpo) return limpo;
  }
  return r.object === 'call' ? 'Ligação' : 'Reunião';
}

function limpaTexto_(txt) {
  return String(txt || '')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '')   // remove telefones
    .replace(/\s{2,}/g, ' ').trim();
}

// A listagem traz um resumo da avaliação; se a nota não vier nele, consulta a rota da avaliação
// (o resultado fica em cache por 6h — a nota de uma reunião avaliada não muda).
function notaDoRegistro_(colecao, r) {
  const resumo = r.overall_evaluation || {};
  if (typeof resumo.score === 'number') return resumo.score;
  if (resumo.status && resumo.status !== 'completed') return null;

  const cache = CacheService.getScriptCache();
  const chave = 'nota_' + r.id;
  const emCache = cache.get(chave);
  if (emCache !== null) return emCache === 'null' ? null : Number(emCache);

  const ev = api_('/v1/' + colecao + '/' + encodeURIComponent(r.id) + '/evaluations/overall', {});
  const score = ev && ev.status === 'completed' && typeof ev.score === 'number' ? ev.score : null;
  cache.put(chave, score === null ? 'null' : String(score), 6 * 3600);
  return score;
}

// Percorre todas as páginas. A doc pede para seguir `next_cursor`/`has_more`, nunca o tamanho de `data`.
function listarTudo_(path, params) {
  const todos = [];
  let cursor = null;
  let paginas = 0;
  do {
    const p = Object.assign({}, params);
    if (cursor) p.cursor = cursor;
    const page = api_(path, p);
    (page.data || []).forEach(x => todos.push(x));
    cursor = page.pagination && page.pagination.has_more ? page.pagination.next_cursor : null;
    paginas++;
  } while (cursor && paginas < 30);
  return todos;
}

// ===================== HTTP + TOKEN =====================
function api_(path, params, jaRenovou) {
  const qs = Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
  const resp = UrlFetchApp.fetch(SALESBUD_API + path + (qs ? '?' + qs : ''), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token_(false) },
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  if (code === 401 && !jaRenovou) {
    token_(true); // token revogado/expirado: pega outro e tenta de novo uma vez
    return api_(path, params, true);
  }
  if (code === 429) {
    const espera = Math.min(Number(resp.getHeaders()['Retry-After'] || 2), 10);
    Utilities.sleep(espera * 1000 + Math.floor(Math.random() * 500));
    return api_(path, params, jaRenovou);
  }
  if (code !== 200) throw new Error('Salesbud ' + code + ' em ' + path + ': ' + resp.getContentText().slice(0, 300));
  return JSON.parse(resp.getContentText());
}

function token_(forcarNovo) {
  const cache = CacheService.getScriptCache();
  if (!forcarNovo) {
    const t = cache.get('salesbud_token');
    if (t) return t;
  }
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('SALESBUD_CLIENT_ID');
  const clientSecret = props.getProperty('SALESBUD_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Configure SALESBUD_CLIENT_ID e SALESBUD_CLIENT_SECRET nas Propriedades do script.');

  const resp = UrlFetchApp.fetch(SALESBUD_API + '/oauth/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Falha ao obter token Salesbud (' + resp.getResponseCode() + '): ' + resp.getContentText().slice(0, 300));
  }
  const json = JSON.parse(resp.getContentText());
  // guarda um pouco antes de expirar (padrão 3600s)
  const ttl = Math.max(60, Math.min(21600, (json.expires_in || 3600) - 300));
  cache.put('salesbud_token', json.access_token, ttl);
  return json.access_token;
}
