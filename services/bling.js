/**
 * ════════════════════════════════════════════════════
 * iSafe CRM · Bling API v3
 * ════════════════════════════════════════════════════
 */

const axios  = require('axios');
const dayjs  = require('dayjs');
const { query, transaction } = require('../db');
const logger = require('./logger');
const { formatPhone, detectCategory, parseDate, sleep } = require('../utils/helpers');

const BLING_BASE = 'https://www.bling.com.br/Api/v3';

// ── CACHE DE VENDEDORES ────────────────────────────────────────────────────
// id (string) → nome. Populado por loadAllVendedores() antes de cada sync.
const _vendedorCache = new Map();

// ── MAPEAMENTO DE SITUAÇÃO POR ID ──────────────────────────────────────────
// Bling API v3 pode retornar situacao como objeto {id,nome} OU só o id inteiro.
// Mapeamos diretamente para os 3 status padrão da iSafe.
const SITUACAO_MAP = {
  0:  'Em aberto',   // Em Aberto
  1:  'Em aberto',   // Em Andamento
  2:  'Atendido',    // Atendido
  3:  'Cancelado',   // Cancelado
  4:  'Em aberto',   // Em Digitação
  5:  'Em aberto',   // Verificado
  6:  'Atendido',    // Atendido
  7:  'Em aberto',   // Retorno
  8:  'Atendido',    // Nota Fiscal Emitida
  9:  'Atendido',    // Faturado
  10: 'Em aberto',   // Venda Assistida
  11: 'Em aberto',   // Em Separação
  12: 'Em aberto',   // Em Conferência
  13: 'Em aberto',   // Pronto para Retirada
  14: 'Em aberto',   // Saiu para Entrega
  15: 'Cancelado',   // Cancelado pelo Cliente
  99: 'Cancelado',   // Cancelado
};

// Normaliza qualquer string de status para os 3 valores padrão da iSafe
function normalizeStatus(st) {
  if (!st) return 'Em aberto';
  const s = st.toLowerCase().trim();
  if (s.includes('cancelad')) return 'Cancelado';
  if (['atendido','faturado','aprovado','nota fiscal','entregue'].some(k => s.includes(k))) return 'Atendido';
  return 'Em aberto';
}

// ── OAUTH2 ─────────────────────────────────────────────────────────────────

async function getAccessToken() {
  const { rows } = await query(
    `SELECT * FROM bling_tokens ORDER BY created_at DESC LIMIT 1`
  );

  if (rows.length > 0) {
    const token = rows[0];
    const expiresAt = dayjs(token.expires_at);
    if (expiresAt.isAfter(dayjs().add(5, 'minute'))) {
      return token.access_token;
    }
    try {
      return await refreshToken(token.refresh_token);
    } catch (err) {
      logger.warn('Falha ao renovar token Bling, tentando variável de ambiente...');
    }
  }

  if (process.env.BLING_ACCESS_TOKEN) {
    await saveToken(
      process.env.BLING_ACCESS_TOKEN,
      process.env.BLING_REFRESH_TOKEN,
      dayjs().add(6, 'hour').toDate()
    );
    return process.env.BLING_ACCESS_TOKEN;
  }

  throw new Error('Nenhum token Bling disponível. Configure BLING_ACCESS_TOKEN no .env');
}

async function refreshToken(refreshToken) {
  logger.info('Renovando access token Bling via refresh token...');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  });

  const { data } = await axios.post(
    'https://www.bling.com.br/Api/v3/oauth/token',
    params,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(
          `${process.env.BLING_CLIENT_ID}:${process.env.BLING_CLIENT_SECRET}`
        ).toString('base64')}`,
      },
    }
  );

  const expiresAt = dayjs().add(data.expires_in, 'second').toDate();
  await saveToken(data.access_token, data.refresh_token, expiresAt);
  logger.info('Token Bling renovado com sucesso');
  return data.access_token;
}

async function saveToken(accessToken, refreshToken, expiresAt) {
  // Mantém apenas o token mais recente — evita acúmulo infinito na tabela
  await query(`DELETE FROM bling_tokens`);
  await query(
    `INSERT INTO bling_tokens (access_token, refresh_token, expires_at)
     VALUES ($1, $2, $3)`,
    [accessToken, refreshToken, expiresAt]
  );
}

// ── HTTP CLIENT ────────────────────────────────────────────────────────────

async function blingRequest(method, endpoint, data = null, params = {}, _retry = 0) {
  const token = await getAccessToken();
  try {
    const response = await axios({
      method,
      url:     `${BLING_BASE}${endpoint}`,
      headers: { Authorization: `Bearer ${token}` },
      params,
      data,
      timeout: 20000,
    });
    return response.data;
  } catch (err) {
    if (err.response?.status === 401) {
      await query(`DELETE FROM bling_tokens`);
      throw new Error('Token Bling expirado ou inválido. Renove as credenciais.');
    }
    const status = err.response?.status;
    // Rate limit (429) ou erro de servidor (5xx) → retry com backoff
    const isRetryable = status === 429 || (status >= 500 && status < 600);
    if (isRetryable && _retry < 3) {
      const wait = (_retry + 1) * 2000; // 2s, 4s, 6s
      logger.warn(`Bling ${status} em [${method} ${endpoint}] — aguardando ${wait}ms (tentativa ${_retry + 1}/3)`);
      await sleep(wait);
      return blingRequest(method, endpoint, data, params, _retry + 1);
    }
    logger.error(`Erro Bling API [${method} ${endpoint}] ${status || ''}: ${err.message}`);
    throw err;
  }
}

// ── DIAGNÓSTICO: retorna resposta RAW do Bling para um pedido ──────────────
// Usado para entender a estrutura real da API. Chamado via GET /api/bling/raw-order/:id

async function rawOrder(blingOrderId) {
  const resp = await blingRequest('GET', `/pedidos/vendas/${blingOrderId}`);
  return resp;
}

// ── CARREGAR TODOS OS VENDEDORES (uma chamada, popula cache) ───────────────
// A Bling API v3 tem GET /vendedores que retorna a lista completa.
// Isso evita N chamadas individuais durante o sync de pedidos.

async function loadAllVendedores() {
  logger.info('Carregando lista de vendedores do Bling...');
  let pagina = 1;
  let total  = 0;

  while (true) {
    let data;
    try {
      data = await blingRequest('GET', '/vendedores', null, { pagina, limite: 100 });
    } catch (err) {
      logger.warn(`Erro ao buscar vendedores (pág ${pagina}): ${err.message}`);
      break;
    }

    const items = data?.data ?? [];
    if (items.length === 0) break;

    for (const v of items) {
      const nome = v.contato?.nome || v.contato?.nomeFantasia || v.nome || v.nomeVendedor || null;
      if (v.id && nome) {
        _vendedorCache.set(String(v.id), nome);
        total++;
      }
    }

    if (items.length < 100) break;
    pagina++;
    await sleep(200);
  }

  logger.info(`✅ ${total} vendedores carregados no cache`);
  return total;
}

// ── RESOLVER NOME DO VENDEDOR ──────────────────────────────────────────────
// Estratégia (em ordem):
// 1. Se o objeto de pedido já tiver .vendedor.nome → usa direto
// 2. Se tiver .vendedor.id → busca no cache (loadAllVendedores deve ter rodado)
// 3. Se não estiver no cache → tenta chamada individual a /vendedores/{id}
// 4. Fallback final: null

async function resolveVendedor(orderData) {
  const v = orderData?.vendedor;
  if (!v) return null;

  // Caso 1: nome já presente no objeto (Bling v3 às vezes inclui contato inline)
  if (v.contato?.nome)        return v.contato.nome;
  if (v.contato?.nomeFantasia) return v.contato.nomeFantasia;
  if (v.nome)                 return v.nome;
  if (v.name)                 return v.name;
  if (v.nomeVendedor)         return v.nomeVendedor;
  if (v.nomeContato)          return v.nomeContato;

  // Caso 2: temos ID, busca no cache
  if (v.id) {
    const id = String(v.id);
    if (_vendedorCache.has(id)) return _vendedorCache.get(id);

    // Caso 3: não está no cache — chamada individual como fallback
    try {
      const resp = await blingRequest('GET', `/vendedores/${id}`);
      const d    = resp?.data;
      // Bling v3: nome do vendedor fica em contato.nome (não na raiz)
      const nome = d?.contato?.nome
                || d?.contato?.nomeFantasia
                || d?.nome
                || d?.nomeVendedor
                || d?.nomeContato
                || null;
      if (nome) {
        _vendedorCache.set(id, nome);
        logger.debug(`Vendedor ${id} → "${nome}" via lookup individual`);
        return nome;
      }
      logger.warn(`Vendedor ${id}: API retornou mas sem campo nome. Campos: ${Object.keys(d || {}).join(',')} | contato: ${JSON.stringify(d?.contato)}`);
    } catch (err) {
      logger.warn(`Vendedor ${id} não encontrado em /vendedores/${id}: ${err.message}`);
    }
  }

  return null;
}

// ── EXTRAIR NOME DA SITUAÇÃO ───────────────────────────────────────────────
// A Bling API v3 pode retornar situacao de várias formas:
//   { id: 6, nome: "Atendido" }   → forma ideal
//   { id: 6 }                     → só o ID
//   6                             → número direto
//   "Atendido"                    → string direto (raro)

function extractSituacaoNome(orderData) {
  const s = orderData?.situacao;
  if (s == null) return null;

  if (typeof s === 'string') return s;                          // string direto
  if (typeof s === 'number') return SITUACAO_MAP[s] || null;   // número direto

  if (typeof s === 'object') {
    if (s.nome)  return s.nome;                                 // objeto com nome
    if (s.id !== undefined) return SITUACAO_MAP[parseInt(s.id)] || `Status ${s.id}`;
  }

  return null;
}

// ── SINCRONIZAR CONTATOS ───────────────────────────────────────────────────

async function syncContacts(pagina = 1) {
  logger.info(`Sincronizando contatos Bling (página ${pagina})...`);
  let total = 0;

  while (true) {
    let data;
    try {
      data = await blingRequest('GET', '/contatos', null, {
        pagina,
        limite: 100,
        situacao: 'A',
      });
    } catch (err) {
      logger.error(`Erro ao buscar contatos (pág. ${pagina}): ${err.message}`);
      break;
    }

    const contacts = data?.data ?? [];
    if (contacts.length === 0) break;

    for (const c of contacts) {
      await upsertClient({
        blingContactId: String(c.id),
        name:  c.nome,
        email: c.email || null,
        phone: formatPhone(c.telefone || c.celular || ''),
        cpf:   c.cpfCnpj || null,
        city:  c.endereco?.municipio || null,
        state: c.endereco?.uf || null,
      });
      total++;
    }

    if (contacts.length < 100) break;
    pagina++;
    await sleep(300);
  }

  logger.info(`✅ Sincronização de contatos concluída: ${total} contatos processados`);
  return total;
}

// ── SINCRONIZAR PEDIDOS ────────────────────────────────────────────────────

async function syncOrders(days = 365) {
  logger.info(`Sincronizando pedidos dos últimos ${days} dias...`);

  // Pré-carrega todos os vendedores para evitar N chamadas individuais
  await loadAllVendedores();

  let total   = 0;
  let pagina  = 1;
  const dataInicio = dayjs().subtract(days, 'day').format('YYYY-MM-DD');

  while (true) {
    let data;
    try {
      data = await blingRequest('GET', '/pedidos/vendas', null, {
        pagina,
        limite: 100,
        dataInicio,
        // Sem filtro de situação — traz todos os status para refletir o real do Bling
      });
    } catch (err) {
      logger.error(`Erro ao buscar pedidos (pág. ${pagina}): ${err.message}`);
      break;
    }

    const orders = data?.data ?? [];
    if (orders.length === 0) break;

    for (const order of orders) {
      const blingId      = String(order.id || order.numero);
      const situacaoNome = normalizeStatus(extractSituacaoNome(order));

      // Só processa pedidos Atendidos — Em aberto e Cancelado são ignorados
      if (situacaoNome !== 'Atendido') {
        total++; continue;
      }

      const existing = await query(
        `SELECT id FROM orders WHERE bling_order_id = $1`, [blingId]
      );

      if (existing.rows.length > 0) {
        // Pedido já existe e está Atendido — garante status e pipeline
        await query(
          `UPDATE orders SET status = 'Atendido' WHERE bling_order_id = $1`,
          [blingId]
        );
        total++; continue;
      }

      // Novo pedido Atendido — busca detalhes para ter itens/produto completo
      try {
        const detail = await blingRequest('GET', `/pedidos/vendas/${order.id}`);
        await processOrder(detail.data || order);
        await sleep(300);
      } catch (err) {
        logger.warn(`Detalhes do pedido ${order.id} indisponíveis: ${err.message}`);
        await processOrder(order);
      }
      total++;
    }

    if (orders.length < 100) break;
    pagina++;
    await sleep(500);
  }

  logger.info(`✅ Sincronização de pedidos concluída: ${total} pedidos processados`);
  return total;
}

// ── PROCESSAR UM PEDIDO ────────────────────────────────────────────────────
// Importante: resolveVendedor é chamado ANTES da transação para evitar
// HTTP calls dentro de transações de banco de dados.

async function processOrder(orderData) {
  // Resolve vendedor e situacao ANTES de abrir a transação
  const vendedor     = await resolveVendedor(orderData);
  const statusNome   = normalizeStatus(extractSituacaoNome(orderData));
  // Pipeline: todos os pedidos "Atendido" entram na jornada de automação
  const addToPipeline = statusNome === 'Atendido';

  return await transaction(async (client) => {
    const blingOrderId   = String(orderData.id || orderData.numero);
    const blingContactId = String(orderData.contato?.id || '');
    const product        = extractMainProduct(orderData.itens);
    const productName    = product.name;
    const itemCount      = product.count;
    const amount         = parseFloat(orderData.totalVenda || orderData.total || 0);
    const orderedAt      = parseDate(orderData.data);

    const existing = await client.query(
      `SELECT id, client_id FROM orders WHERE bling_order_id = $1`,
      [blingOrderId]
    );

    // Pedido já existe → atualiza status normalizado e garante pipeline se Atendido
    if (existing.rows.length > 0) {
      const existingOrderId  = existing.rows[0].id;
      const existingClientId = existing.rows[0].client_id;
      await client.query(
        `UPDATE orders SET status = $1, vendedor = COALESCE($2, vendedor) WHERE id = $3`,
        [statusNome, vendedor || null, existingOrderId]
      );
      if (existingClientId && addToPipeline) {
        await client.query(
          `INSERT INTO pipeline (order_id, client_id) VALUES ($1,$2)
           ON CONFLICT (order_id) DO NOTHING`,
          [existingOrderId, existingClientId]
        );
      }
      return existingOrderId;
    }

    // Busca ou cria o cliente
    let clientId = null;
    if (blingContactId) {
      const clientRow = await client.query(
        `SELECT id FROM clients WHERE bling_contact_id = $1`,
        [blingContactId]
      );
      if (clientRow.rows.length > 0) {
        clientId = clientRow.rows[0].id;
      } else {
        try {
          const contactData = await blingRequest('GET', `/contatos/${blingContactId}`);
          const c = contactData.data;
          const inserted = await client.query(
            `INSERT INTO clients (bling_contact_id, name, email, phone, cpf)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [
              blingContactId,
              c.nome,
              c.email || null,
              formatPhone(c.telefone || c.celular || ''),
              c.cpfCnpj || null,
            ]
          );
          clientId = inserted.rows[0].id;
        } catch (err) {
          logger.warn(`Não foi possível buscar contato ${blingContactId}: ${err.message}`);
        }
      }
    }

    // Insere pedido com todos os campos
    const orderInsert = await client.query(
      `INSERT INTO orders
         (bling_order_id, client_id, order_number, product_name, product_category,
          amount, status, vendedor, item_count, ordered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        blingOrderId,
        clientId,
        orderData.numero || blingOrderId,
        productName,
        detectCategory(productName),
        amount,
        statusNome,
        vendedor,
        itemCount,
        orderedAt,
      ]
    );
    const orderId = orderInsert.rows[0].id;

    // Pipeline de automação apenas para pedidos concluídos
    if (clientId && addToPipeline) {
      await client.query(
        `INSERT INTO pipeline (order_id, client_id) VALUES ($1,$2)
         ON CONFLICT (order_id) DO NOTHING`,
        [orderId, clientId]
      );
      logger.info(`📦 Pipeline: ${productName} — ${statusNome} — vendedor: ${vendedor || '—'} — cliente ${clientId}`);
    } else if (clientId) {
      logger.info(`📋 Pedido registrado (${statusNome}, fora do pipeline): ${productName} — vendedor: ${vendedor || '—'}`);
    }

    return orderId;
  });
}

// ── FIX ALL: corrige vendedor + status em TODOS os pedidos existentes ──────
// Usado pelo endpoint POST /api/bling/fix-orders
// Busca pedidos com status='aprovado' OU vendedor nulo e corrige via detalhe da API

async function fixAllOrders(batchSize = 50) {
  logger.info('Iniciando correção completa de vendedor + status em todos os pedidos...');

  // Pré-carrega todos os vendedores uma vez
  await loadAllVendedores();

  // Pedidos que precisam de correção: status legado 'aprovado' OU vendedor nulo
  const { rows } = await query(
    `SELECT id, bling_order_id, status, vendedor
     FROM orders
     WHERE status = 'aprovado'
        OR (vendedor IS NULL OR vendedor = '')
     ORDER BY ordered_at DESC
     LIMIT $1`,
    [batchSize]
  );

  if (rows.length === 0) {
    logger.info('Nenhum pedido precisa de correção.');
    return { fixed: 0, remaining: 0 };
  }

  logger.info(`${rows.length} pedidos para corrigir...`);
  let fixed = 0;

  for (const row of rows) {
    try {
      const resp         = await blingRequest('GET', `/pedidos/vendas/${row.bling_order_id}`);
      const d            = resp?.data || resp;
      const vendedor     = await resolveVendedor(d);
      const situacaoNome = extractSituacaoNome(d);
      const product      = extractMainProduct(d.itens);

      const updateParts = [];
      const vals        = [];

      // Sempre atualiza status com o valor real do Bling
      if (situacaoNome) {
        vals.push(situacaoNome);
        updateParts.push(`status = $${vals.length}`);
      }
      // Atualiza vendedor apenas se estiver vazio
      if (vendedor && (!row.vendedor || row.vendedor === '')) {
        vals.push(vendedor);
        updateParts.push(`vendedor = $${vals.length}`);
      }
      // Atualiza nome do produto se for genérico
      if (product.name && product.name !== 'Produto iSafe') {
        vals.push(product.name);
        updateParts.push(`product_name = $${vals.length}`);
        vals.push(detectCategory(product.name));
        updateParts.push(`product_category = $${vals.length}`);
      }

      if (updateParts.length > 0) {
        vals.push(row.bling_order_id);
        await query(
          `UPDATE orders SET ${updateParts.join(', ')} WHERE bling_order_id = $${vals.length}`,
          vals
        );
        fixed++;
        logger.debug(`Pedido ${row.bling_order_id}: status="${situacaoNome}" vendedor="${vendedor}"`);
      }

      await sleep(300);
    } catch (err) {
      logger.warn(`Fix pedido ${row.bling_order_id}: ${err.message}`);
    }
  }

  // Quantos ainda precisam de correção
  const { rows: rem } = await query(
    `SELECT COUNT(*) FROM orders WHERE status = 'aprovado' OR (vendedor IS NULL OR vendedor = '')`
  );
  const remaining = parseInt(rem[0].count);

  logger.info(`✅ Correção concluída: ${fixed} pedidos corrigidos, ${remaining} restantes`);
  return { fixed, remaining };
}

// ── CONFIGURAR WEBHOOK NO BLING ────────────────────────────────────────────

async function setupWebhook() {
  const webhookUrl = `${process.env.APP_URL}/webhook/bling`;
  logger.info(`Configurando webhook Bling → ${webhookUrl}`);
  try {
    await blingRequest('POST', '/hooks', {
      url:    webhookUrl,
      tipo:   1,
      situacao: 1,
    });
    logger.info('✅ Webhook Bling configurado com sucesso');
  } catch (err) {
    logger.warn(`Webhook Bling: ${err.response?.data?.error?.description || err.message}`);
  }
}

// ── SINCRONIZAR VENDEDORES (backfill dos pedidos sem vendedor) ─────────────

async function syncVendedores(days = 730) {
  logger.info(`Sincronizando vendedores + status dos últimos ${days} dias...`);

  // Pré-carrega todos os vendedores uma vez
  await loadAllVendedores();
  logger.info(`Cache: ${_vendedorCache.size} vendedores disponíveis`);

  // Busca pedidos sem vendedor OU com status legado 'aprovado'
  const { rows } = await query(
    `SELECT bling_order_id, vendedor, status FROM orders
     WHERE (vendedor IS NULL OR vendedor = '' OR status = 'aprovado')
       AND ordered_at > NOW() - MAKE_INTERVAL(days => $1)
     ORDER BY ordered_at DESC`,
    [days]
  );

  if (rows.length === 0) {
    logger.info('Todos os pedidos já têm vendedor e status corretos.');
    return 0;
  }

  logger.info(`${rows.length} pedidos para corrigir (vendedor/status)...`);
  let updated = 0;

  for (const row of rows) {
    try {
      const resp         = await blingRequest('GET', `/pedidos/vendas/${row.bling_order_id}`);
      const d            = resp?.data || resp;
      const vendedor     = await resolveVendedor(d);
      const situacaoNome = extractSituacaoNome(d);

      // Log diagnóstico: mostra estrutura real retornada pelo Bling
      logger.info(
        `Pedido ${row.bling_order_id} ← Bling: ` +
        `vendedor=${JSON.stringify(d?.vendedor)} ` +
        `situacao=${JSON.stringify(d?.situacao)} ` +
        `→ resolved: vendedor="${vendedor}" status="${situacaoNome}"`
      );

      const res = await query(
        `UPDATE orders SET
           vendedor = CASE WHEN (vendedor IS NULL OR vendedor = '') AND $1::text IS NOT NULL THEN $1 ELSE vendedor END,
           status   = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE status END
         WHERE bling_order_id = $3`,
        [vendedor, situacaoNome, row.bling_order_id]
      );
      if (res.rowCount > 0) updated++;

      await sleep(300);
    } catch (err) {
      logger.warn(`Sync pedido ${row.bling_order_id}: ${err.message}`);
    }
  }

  logger.info(`✅ Sync concluído: ${updated} pedidos atualizados`);
  return updated;
}

// ── RE-SYNC NOMES DE PRODUTOS ──────────────────────────────────────────────

async function syncProductNames(batchSize = 30) {
  const { rows } = await query(
    `SELECT o.id, o.bling_order_id FROM orders o
     WHERE o.product_name = 'Produto iSafe'
     LIMIT $1`,
    [batchSize]
  );
  if (rows.length === 0) return { fixed: 0, remaining: 0 };

  let fixed = 0;
  for (const row of rows) {
    try {
      const detail = await blingRequest('GET', `/pedidos/vendas/${row.bling_order_id}`);
      const d = detail.data || detail;
      const product = extractMainProduct(d.itens || []);
      if (product.name && product.name !== 'Produto iSafe') {
        await query(
          `UPDATE orders SET product_name = $1, product_category = $2 WHERE id = $3`,
          [product.name, detectCategory(product.name), row.id]
        );
        // Tenta atualizar item_count se a coluna existir
        try {
          await query(`UPDATE orders SET item_count = $1 WHERE id = $2`, [product.count, row.id]);
        } catch (_) {}
        fixed++;
      }
      await sleep(300);
    } catch (err) {
      logger.warn(`Re-sync produto pedido ${row.bling_order_id}: ${err.message}`);
    }
  }

  const { rows: remaining } = await query(
    `SELECT COUNT(*) FROM orders WHERE product_name = 'Produto iSafe'`
  );
  return { fixed, remaining: parseInt(remaining[0].count) };
}

// ── HELPERS ────────────────────────────────────────────────────────────────
// formatPhone / detectCategory / parseDate / sleep → utils/helpers.js

async function upsertClient({ blingContactId, name, email, phone, cpf, city, state }) {
  await query(
    `INSERT INTO clients (bling_contact_id, name, email, phone, cpf, city, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (bling_contact_id) DO UPDATE SET
       name  = EXCLUDED.name,
       email = COALESCE(EXCLUDED.email, clients.email),
       phone = COALESCE(EXCLUDED.phone, clients.phone),
       updated_at = NOW()`,
    [blingContactId, name, email, phone, cpf, city, state]
  );
}

function extractMainProduct(itens) {
  if (!itens || itens.length === 0) return { name: 'Produto iSafe', count: 1 };
  const main = itens.reduce((a, b) =>
    (parseFloat(a.valorUnidade || 0) * (a.quantidade || 1)) >=
    (parseFloat(b.valorUnidade || 0) * (b.quantidade || 1)) ? a : b
  );
  return { name: main.descricao || 'Produto iSafe', count: itens.length };
}

module.exports = {
  getAccessToken,
  rawOrder,
  loadAllVendedores,
  syncContacts,
  syncOrders,
  syncProductNames,
  syncVendedores,
  fixAllOrders,
  processOrder,
  setupWebhook,
  formatPhone,
  detectCategory,
  extractSituacaoNome,
};
