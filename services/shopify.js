/**
 * ════════════════════════════════════════════════════
 * iSafe CRM · Shopify Integration
 * Admin API + webhooks orders/paid
 * ════════════════════════════════════════════════════
 */

const axios  = require('axios');
const dayjs  = require('dayjs');
const { query, transaction } = require('../db');
const logger = require('./logger');
const { formatPhone, detectCategory, sleep } = require('../utils/helpers');

function shopifyHttp() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) throw new Error('SHOPIFY_STORE e SHOPIFY_ACCESS_TOKEN não configurados no .env');
  return axios.create({
    baseURL: `https://${store}/admin/api/2024-01`,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

// ── SYNC PEDIDOS ──────────────────────────────────────────────

async function syncOrders(days = 365) {
  logger.info(`[Shopify] Sincronizando pedidos dos últimos ${days} dias...`);
  const http = shopifyHttp();
  let total = 0;
  let pageInfo = null;

  const createdAtMin = dayjs().subtract(days, 'day').toISOString();

  while (true) {
    const params = { status: 'paid', limit: 50, created_at_min: createdAtMin };
    if (pageInfo) params.page_info = pageInfo;

    const { data, headers } = await http.get('/orders.json', { params });
    const orders = data.orders || [];
    if (orders.length === 0) break;

    for (const order of orders) {
      await processShopifyOrder(order);
      total++;
    }

    // Shopify usa Link header para paginação
    const linkHeader = headers['link'] || '';
    const nextMatch  = linkHeader.match(/<[^>]+page_info=([^&>]+)[^>]*>; rel="next"/);
    if (!nextMatch) break;
    pageInfo = nextMatch[1];

    await sleep(300);
  }

  logger.info(`[Shopify] ✅ ${total} pedidos sincronizados`);
  return total;
}

async function syncCustomers(days = 365) {
  logger.info(`[Shopify] Sincronizando clientes...`);
  const http = shopifyHttp();
  let total  = 0;
  const createdAtMin = dayjs().subtract(days, 'day').toISOString();

  const { data } = await http.get('/customers.json', {
    params: { limit: 250, created_at_min: createdAtMin }
  });

  for (const c of data.customers || []) {
    await upsertShopifyClient(c);
    total++;
  }

  logger.info(`[Shopify] ✅ ${total} clientes sincronizados`);
  return total;
}

// ── PROCESSAR PEDIDO (webhook ou sync) ───────────────────────

async function processShopifyOrder(order) {
  return await transaction(async (client) => {
    const shopifyOrderId = `shopify_${order.id}`;

    const existing = await client.query(
      `SELECT id FROM orders WHERE bling_order_id = $1`, [shopifyOrderId]
    );
    if (existing.rows.length > 0) return null;

    // Upsert cliente
    const customer = order.customer || {};
    let clientId = null;

    if (customer.email || customer.phone) {
      const upserted = await client.query(
        `INSERT INTO clients (name, email, phone, city, state)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (email) DO UPDATE SET
           name  = EXCLUDED.name,
           phone = COALESCE(EXCLUDED.phone, clients.phone),
           updated_at = NOW()
         RETURNING id`,
        [
          `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Cliente Shopify',
          customer.email || null,
          formatPhone(customer.phone || order.shipping_address?.phone),
          order.shipping_address?.city  || null,
          order.shipping_address?.province_code || null,
        ]
      );
      clientId = upserted.rows[0].id;
    }

    // Produto principal (maior valor)
    const mainItem = (order.line_items || []).reduce(
      (a, b) => parseFloat(a.price) >= parseFloat(b.price) ? a : b,
      order.line_items?.[0] || {}
    );

    const { rows: [ord] } = await client.query(
      `INSERT INTO orders
         (bling_order_id, client_id, order_number, product_name, product_category, amount, status, ordered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        shopifyOrderId,
        clientId,
        order.order_number || String(order.id),
        mainItem.title || 'Produto Shopify',
        detectCategory(mainItem.title),
        parseFloat(order.total_price || 0),
        'aprovado',
        new Date(order.created_at),
      ]
    );

    if (clientId) {
      await client.query(
        `INSERT INTO pipeline (order_id, client_id) VALUES ($1,$2) ON CONFLICT (order_id) DO NOTHING`,
        [ord.id, clientId]
      );
      logger.info(`[Shopify] 📦 Pedido #${order.order_number} → pipeline (cliente ${clientId})`);
    }

    return ord.id;
  });
}

// ── WEBHOOK SHOPIFY ───────────────────────────────────────────

async function handleWebhook(req, res) {
  res.status(200).json({ received: true });

  const topic = req.headers['x-shopify-topic'] || '';
  const order = req.body;

  if (!['orders/paid', 'orders/fulfilled'].includes(topic)) return;
  if (!order?.id) return;

  try {
    logger.info(`[Shopify] Webhook recebido: ${topic} · pedido #${order.order_number || order.id}`);
    await processShopifyOrder(order);
  } catch (err) {
    logger.error(`[Shopify] Erro no webhook: ${err.message}`);
  }
}

// ── HELPERS ───────────────────────────────────────────────────

async function upsertShopifyClient(c) {
  if (!c.email && !c.phone) return;
  await query(
    `INSERT INTO clients (name, email, phone, city, state)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE SET
       name = EXCLUDED.name,
       phone = COALESCE(EXCLUDED.phone, clients.phone),
       updated_at = NOW()`,
    [
      `${c.first_name||''} ${c.last_name||''}`.trim() || 'Cliente Shopify',
      c.email || null,
      formatPhone(c.phone),
      c.default_address?.city || null,
      c.default_address?.province_code || null,
    ]
  );
}

module.exports = { syncOrders, syncCustomers, processShopifyOrder, handleWebhook };
