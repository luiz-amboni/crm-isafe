/**
 * ════════════════════════════════════════════════════
 * iSafe CRM · Bagy Integration
 * API REST da Bagy (plataforma BR de e-commerce)
 * Docs: https://developers.bagy.com.br
 * ════════════════════════════════════════════════════
 */

const axios  = require('axios');
const dayjs  = require('dayjs');
const { query, transaction } = require('../db');
const logger = require('./logger');
const { formatPhone, detectCategory, sleep } = require('../utils/helpers');

const BAGY_BASE = 'https://api.dooki.com.br/v2';

function bagyHttp() {
  const key     = process.env.BAGY_API_KEY;
  const storeId = process.env.BAGY_STORE_ID;
  if (!key || !storeId) throw new Error('BAGY_API_KEY e BAGY_STORE_ID não configurados no .env');
  return axios.create({
    baseURL: `${BAGY_BASE}/${storeId}`,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    timeout: 15000,
  });
}

// ── SINCRONIZAR PEDIDOS ───────────────────────────────────────

async function syncOrders(days = 365) {
  logger.info(`[Bagy] Sincronizando pedidos dos últimos ${days} dias...`);
  const http = bagyHttp();
  let total  = 0;
  let page   = 1;
  const dateFrom = dayjs().subtract(days, 'day').format('YYYY-MM-DD');

  while (true) {
    let data;
    try {
      const res = await http.get('/orders', {
        params: { page, limit: 50, status: 'paid,shipped,delivered', date_from: dateFrom }
      });
      data = res.data;
    } catch (err) {
      logger.error(`[Bagy] Erro ao buscar pedidos (pág ${page}): ${err.message}`);
      break;
    }

    const orders = data?.data || data?.orders || [];
    if (orders.length === 0) break;

    for (const order of orders) {
      await processBagyOrder(order);
      total++;
    }

    const lastPage = data?.meta?.last_page || data?.pagination?.totalPages || 1;
    if (page >= lastPage) break;
    page++;
    await sleep(400);
  }

  logger.info(`[Bagy] ✅ ${total} pedidos sincronizados`);
  return total;
}

// ── PROCESSAR PEDIDO ──────────────────────────────────────────

async function processBagyOrder(order) {
  return await transaction(async (client) => {
    const bagyOrderId = `bagy_${order.id || order.number}`;

    const existing = await client.query(
      `SELECT id FROM orders WHERE bling_order_id = $1`, [bagyOrderId]
    );
    if (existing.rows.length > 0) return null;

    // Cliente
    const buyer = order.buyer || order.customer || {};
    let clientId = null;
    const email = buyer.email || null;
    const phone = formatPhone(buyer.cellphone || buyer.phone || buyer.whatsapp);
    const name  = `${buyer.firstname || buyer.name || ''} ${buyer.lastname || ''}`.trim() || 'Cliente Bagy';

    if (email || phone) {
      const upserted = await client.query(
        `INSERT INTO clients (name, email, phone, city, state)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (email) DO UPDATE SET
           name  = EXCLUDED.name,
           phone = COALESCE(EXCLUDED.phone, clients.phone),
           updated_at = NOW()
         RETURNING id`,
        [
          name, email, phone,
          order.shipping?.city  || buyer.city  || null,
          order.shipping?.state || buyer.state || null,
        ]
      );
      clientId = upserted.rows[0].id;
    }

    // Produto principal
    const items   = order.items || order.products || [];
    const mainItem = items.reduce(
      (a, b) => (parseFloat(a.price) * (a.qty || 1)) >= (parseFloat(b.price) * (b.qty || 1)) ? a : b,
      items[0] || {}
    );
    const productName = mainItem.name || mainItem.title || 'Produto Bagy';

    const { rows: [ord] } = await client.query(
      `INSERT INTO orders
         (bling_order_id, client_id, order_number, product_name, product_category, amount, status, ordered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        bagyOrderId,
        clientId,
        String(order.number || order.id),
        productName,
        detectCategory(productName),
        parseFloat(order.total || order.amount || 0),
        'aprovado',
        new Date(order.created_at || order.date),
      ]
    );

    if (clientId) {
      await client.query(
        `INSERT INTO pipeline (order_id, client_id) VALUES ($1,$2) ON CONFLICT (order_id) DO NOTHING`,
        [ord.id, clientId]
      );
      logger.info(`[Bagy] 📦 Pedido #${order.number || order.id} → pipeline`);
    }

    return ord.id;
  });
}

// ── WEBHOOK BAGY ──────────────────────────────────────────────

async function handleWebhook(req, res) {
  res.status(200).json({ received: true });

  const event = req.headers['x-bagy-event'] || req.body?.event || '';
  const order = req.body?.data || req.body;

  if (!['order.paid', 'order.approved', 'pedido.aprovado'].some(e => event.includes(e.split('.')[0]))) return;
  if (!order?.id && !order?.number) return;

  try {
    logger.info(`[Bagy] Webhook: ${event} · pedido #${order.number || order.id}`);
    await processBagyOrder(order);
  } catch (err) {
    logger.error(`[Bagy] Erro no webhook: ${err.message}`);
  }
}

module.exports = { syncOrders, processBagyOrder, handleWebhook };
