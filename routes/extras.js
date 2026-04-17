/**
 * ════════════════════════════════════════════════════
 * iSafe CRM · API Routes Extras
 * Win-back, Shopify sync, Bagy sync
 * Este arquivo é importado e montado no api.js principal
 * ════════════════════════════════════════════════════
 */

const router    = require('express').Router();
const winback   = require('../services/winback');
const shopify   = require('../services/shopify');
const bagy      = require('../services/bagy');
const logger    = require('../services/logger');
const { query } = require('../db');

// ── WIN-BACK ──────────────────────────────────────────────────

// GET /api/winback/summary — contagem por segmento
router.get('/winback/summary', async (req, res) => {
  try {
    const summary = await winback.getSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/winback/clients/:segment — listar clientes do segmento
router.get('/winback/clients/:segment', async (req, res) => {
  try {
    const seg = winback.SEGMENTS.find(s => s.key === req.params.segment);
    if (!seg) return res.status(404).json({ error: 'Segmento não encontrado' });
    const clients = await winback.getSegmentClients(seg);
    res.json({ segment: seg, clients, total: clients.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/winback/run — executar campanha
router.post('/winback/run', async (req, res) => {
  try {
    const { segment, template } = req.body;
    if (!segment) return res.status(400).json({ error: 'Campo "segment" obrigatório' });
    logger.info(`Win-back acionado via API: segmento "${segment}"`);
    const result = await winback.runCampaign(segment, template || null);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SHOPIFY ───────────────────────────────────────────────────

// POST /api/shopify/sync
router.post('/shopify/sync', async (req, res) => {
  try {
    const days = parseInt(req.body.days || '365');
    logger.info(`Sync Shopify manual: últimos ${days} dias`);
    const [orders, customers] = await Promise.all([
      shopify.syncOrders(days),
      shopify.syncCustomers(days),
    ]);
    res.json({ success: true, orders, customers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BAGY ──────────────────────────────────────────────────────

// POST /api/bagy/sync
router.post('/bagy/sync', async (req, res) => {
  try {
    const days = parseInt(req.body.days || '365');
    logger.info(`Sync Bagy manual: últimos ${days} dias`);
    const orders = await bagy.syncOrders(days);
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BUSCA GLOBAL ──────────────────────────────────────────────
// GET /api/search?q=termo

router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ clients: [], orders: [] });

  const term = `%${q}%`;
  try {
    const [clientsRes, ordersRes] = await Promise.all([
      query(
        `SELECT id, name, phone, email, city, state
         FROM clients
         WHERE name ILIKE $1 OR phone LIKE $1 OR email ILIKE $1
         ORDER BY name LIMIT 8`,
        [term]
      ),
      query(
        `SELECT o.id, o.order_number, o.bling_order_id, o.product_name, o.amount, o.status,
                o.ordered_at, c.name AS client_name
         FROM orders o
         LEFT JOIN clients c ON c.id = o.client_id
         WHERE o.order_number ILIKE $1
            OR o.product_name ILIKE $1
            OR c.name ILIKE $1
         ORDER BY o.ordered_at DESC LIMIT 8`,
        [term]
      ),
    ]);
    res.json({ clients: clientsRes.rows, orders: ordersRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
