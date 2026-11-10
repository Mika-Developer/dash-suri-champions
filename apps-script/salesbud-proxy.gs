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
 *    no log quem entrou em cada área e quem foi ignorado).
 * 4. Implantar → Nova implantação → App da Web
 *      Executar como: Eu | Quem tem acesso: Qualquer pessoa
 * 5. Copie a URL /exec e cole em SALESBUD_PROXY_URL no index.html.
 *
 * Docs da API: https://docs.salesbud.com.br/
 */

// ===================== CONFIGURAÇÃO =====================
const SALESBUD_API = 'https://api.salesbud.com.br';

// Janela de busca: notas dos últimos N dias (a tela usa a última nota de cada pessoa).
const DIAS_JANELA = 30;

// Coleções lidas: 'meetings' (bot / upload) e 'calls' (VoIP).
const COLECOES = ['meetings', 'calls'];

// ===== QUEM ENTRA E O QUE ENTRA =====
// Cada área puxa SÓ as reuniões/ligações com a classificação (tag) indicada,
// e SÓ das pessoas listadas. Qualquer outra pessoa (CS, Enablement...) fica de fora.
// Nomes: basta nome + sobrenome como aparecem na Salesbud (sem diferenciar acento/maiúscula;
// o sobrenome é comparado pelas 4 primeiras letras, ex.: "Ferrez" casa com "Ferraz").
const AREAS = {
  closer: {                                  // → coluna Vendas
    tag: 'Reunião Comercial',
    pessoas: [
      'André Queiroz', 'Alex Uchôa', 'Lucas Machado', 'Lizandra Rayssa', 'Hadson Souza',
      'Clailton Nascimento', 'Patrício Felix', 'Júnior Furtado', 'Jéssika Lima'
    ]
  },
  sdr: {                                     // → coluna Pré-vendas
    tag: 'Ligação de Qualificação',
    pessoas: [
      'Lívia Acácio', 'Daniele Carvalho', 'Maria Aparecida', 'Pedro Roncalli', 'Thiago Mendonça',
      'Sthefany Vasconcelos', 'Thais Giurizatto', 'Iara Jessica', 'Victória Ferraz'
    ]
  }
};

// Notas ignoradas por enquanto:
const NOTA_MINIMA = 1;                 // notas abaixo disso (ou seja, nota 0) não entram
const DURACAO_MINIMA_LIGACAO_SEG = 60; // ligações com menos de 1 minuto não entram

// Domínios da própria empresa: contas com esses domínios não são mostradas como "cliente".
const DOMINIOS_INTERNOS = ['suri.ai', 'chatbotmaker.io'];

// O dashboard usa a última nota de cada pessoa; o proxy envia as N mais recentes de cada uma
// (as extras ajudam a detectar notas novas para o popup de nota 8, 9 e 10).
const NOTAS_POR_PESSOA = 3;

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
  notas.forEach(n => { times[n.name] = n.area === 'sdr' ? 'Pré-vendas' : 'Vendas'; });
  const dash = notasParaDashboard_(notas);
  Logger.log('Notas encontradas: %s | enviadas ao dashboard: %s | tamanho: %s bytes',
    notas.length, dash.length, JSON.stringify(dash).length);
  Logger.log('Pessoas no dashboard → área:\n%s', JSON.stringify(times, null, 2));
  Logger.log('Ignorados (com a tag, mas fora das listas de pessoas):\n%s', JSON.stringify(IGNORADOS_, null, 2));
  Object.keys(AREAS).forEach(area => {
    const encontrados = new Set(notas.filter(n => n.area === area).map(n => n.pessoa));
    const semNota = AREAS[area].pessoas.filter(p => !encontrados.has(p));
    if (semNota.length) Logger.log('%s sem nota nos últimos %s dias: %s', area, DIAS_JANELA, semNota.join(', '));
  });
  Logger.log('Mais recentes no dashboard:\n%s', JSON.stringify(dash.slice(0, 10), null, 2));
}

// ===================== BUSCA =====================
const IGNORADOS_ = {};

function buscarNotas_() {
  const depois = new Date(Date.now() - DIAS_JANELA * 24 * 3600 * 1000).toISOString();
  const tags = tagsPorNome_();
  const notas = [];
  const vistos = new Set();

  Object.keys(AREAS).forEach(area => {
    const cfg = AREAS[area];
    const tag = tags[normaliza_(cfg.tag)];
    if (!tag) throw new Error('Classificação "' + cfg.tag + '" não encontrada na Salesbud. Classificações disponíveis: ' +
      Object.values(tags).map(t => t.name).join(', '));

    COLECOES.forEach(colecao => {
      // tag_id → só a classificação da área | score_min → só avaliações concluídas com nota >= NOTA_MINIMA
      const registros = listarTudo_('/v1/' + colecao, { tag_id: tag.id, meeting_after: depois, score_min: NOTA_MINIMA, limit: 100 });
      registros.forEach(r => {
        const owner = r.owner || {};
        const nome = owner.name || owner.email || '';
        const pessoa = pessoaDaLista_(nome, cfg.pessoas);
        if (!pessoa) { IGNORADOS_[nome + ' (' + cfg.tag + ')'] = true; return; }
        if (r.object === 'call' && Number(r.duration_seconds || 0) < DURACAO_MINIMA_LIGACAO_SEG) return;
        if (vistos.has(r.id)) return;
        const score = notaDoRegistro_(colecao, r);
        if (score === null || score < NOTA_MINIMA) return;
        vistos.add(r.id);
        notas.push({
          id: r.id,
          kind: r.object,                    // 'meeting' ou 'call'
          name: nome,
          pessoa: pessoa,                    // nome como está na lista acima
          email: owner.email || '',
          area: area,                        // 'sdr' (Pré-vendas) ou 'closer' (Vendas)
          score: score,                      // 0 a 10
          date: r.meeting_at,
          client: clienteDe_(r, nome)
        });
      });
    });
  });
  notas.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return notas;
}

// Catálogo de classificações (GET /v1/tags), indexado pelo nome normalizado.
function tagsPorNome_() {
  const mapa = {};
  listarTudo_('/v1/tags', { limit: 100 }).forEach(t => { mapa[normaliza_(t.name)] = t; });
  return mapa;
}

function normaliza_(txt) {
  return String(txt || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Devolve a entrada da lista que corresponde ao nome da Salesbud, ou null.
// Regra: mesmo primeiro nome e, se a lista tiver sobrenome, algum sobrenome do dono
// começando pelas mesmas 4 letras.
function pessoaDaLista_(nome, lista) {
  const t = normaliza_(nome).split(' ');
  for (const p of lista) {
    const q = normaliza_(p).split(' ');
    if (t[0] !== q[0]) continue;
    if (q.length === 1) return p;
    const sobrenome = q[q.length - 1].slice(0, 4);
    if (t.slice(1).some(x => x.slice(0, 4) === sobrenome)) return p;
  }
  return null;
}

// O que vai para o dashboard: as últimas NOTAS_POR_PESSOA de cada pessoa. `notas` já vem da mais recente.
function notasParaDashboard_(notas) {
  const porPessoa = {};
  return notas.filter(n => {
    if (n.area !== 'sdr' && n.area !== 'closer') return false;
    const pessoa = n.area + '|' + n.pessoa;
    porPessoa[pessoa] = (porPessoa[pessoa] || 0) + 1;
    return porPessoa[pessoa] <= NOTAS_POR_PESSOA;
  }).map(n => ({ id: n.id, name: n.name, area: n.area, score: n.score, date: n.date, client: n.client, kind: n.kind }));
}

// O que aparece como "cliente" na TV:
//  - Ligação: nome do contato (se houver) + telefone formatado. Ex.: "Maria · +55 (11) 94193-6890"
//  - Reunião: o título a partir da empresa. Ex.: "Reunião Suri [Br] -- Hadson + Adriano Belosofaclean"
//    vira "Adriano Belosofaclean" (pega o que vem depois do "--" e tira o nome do próprio dono);
//    "... -- Lizandra + Carla - Ótica Real" vira "Ótica Real" (contato - empresa → empresa).
function clienteDe_(r, nomeDono) {
  const interno = d => DOMINIOS_INTERNOS.some(x => String(d || '').toLowerCase().endsWith(x));
  const conta = (r.accounts || []).find(a => !interno(a.domain));
  const participantes = (r.participants || []).filter(p => !interno(p.email));

  if (r.object === 'call') {
    const p = participantes[0] || {};
    const fone = p.phone || extraiFone_(p.display_name) || extraiFone_(r.title);
    const nome = (conta && (conta.name || conta.domain)) || (ehFone_(p.display_name) ? '' : String(p.display_name || '').trim());
    return [nome, formataFone_(fone)].filter(Boolean).join(' · ') || 'Ligação';
  }

  const doTitulo = empresaDoTitulo_(r.title, nomeDono);
  if (doTitulo) return doTitulo;
  if (conta) return conta.name || conta.domain;
  const p = participantes.find(x => x.display_name && !ehFone_(x.display_name));
  if (p) return p.display_name.trim();
  const titulo = String(r.title || '').replace(/^\s*reuni[aã]o\s+suri\s*(\[[^\]]*\])?\s*/i, '').trim();
  return titulo || 'Reunião';
}

// "Reunião Suri [Br] -- Hadson + Adriano Belosofaclean" → "Adriano Belosofaclean"
function empresaDoTitulo_(titulo, nomeDono) {
  // corta no PRIMEIRO separador ("--", "—" ou, na falta deles, " - ") e fica com o resto
  const t = String(titulo || '');
  const m = t.match(/\s(?:--|—|–)\s/) || t.match(/\s-\s/);
  if (!m) return '';
  const trecho = t.slice(m.index + m[0].length).trim();
  if (!trecho) return '';
  const primeiroNomeDono = normaliza_(nomeDono).split(' ')[0];
  const pedacos = trecho.split('+').map(x => x.trim()).filter(Boolean)
    .filter(x => normaliza_(x).split(' ')[0] !== primeiroNomeDono && !/\bsuri\b/i.test(x));
  const resto = pedacos.join(' + ') || trecho;
  // "Carla - Ótica Real" → "Ótica Real": se sobrar "contato - empresa", fica com a empresa
  const ultimo = resto.split(/\s[-–—]\s/).pop().trim();
  return ultimo || resto;
}

function ehFone_(txt) { return /^\s*\+?[\d\s().-]{8,}\s*$/.test(String(txt || '')); }

function extraiFone_(txt) {
  const m = String(txt || '').match(/\+?\d[\d\s().-]{7,}\d/);
  return m ? m[0] : '';
}

// "+5511941936890" → "+55 (11) 94193-6890"
function formataFone_(fone) {
  let d = String(fone || '').replace(/\D/g, '');
  if (!d) return '';
  let ddi = '';
  if (d.length >= 12 && d.startsWith('55')) { ddi = '+55 '; d = d.slice(2); }
  if (d.length === 11) return ddi + '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  if (d.length === 10) return ddi + '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
  return String(fone).trim();
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
