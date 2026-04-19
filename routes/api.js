/**
 * ════════════════════════════════════════════════════
 * iSafe CRM · API REST para o Dashboard
 * Autenticada via header: x-api-key
 * ════════════════════════════════════════════════════
 */

const router    = require('express').Router();
const dayjs     = require('dayjs');
const { query } = require('../db');
const bling     = require('../services/bling');
const scheduler = require('../services/scheduler');
const email     = require('../services/email');
const wa        = require('../services/whatsapp');
const logger    = require('../services/logger');
const auth      = require('../middleware/auth');
const ai        = require('../services/ai');
const activityLog = require('../services/activityLog');
const { buildContext, renderWhatsApp } = require('../templates/messages');

router.use(auth);

// ════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════

// GET /api/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const [kpis, pipeline, activity, recentOrders] = await Promise.all([
      getDashboardKPIs(),
      getPipelineStages(),
      getRecentActivity(12),
      getRecentOrders(12),
    ]);
    res.json({ kpis, pipeline, activity, recentOrders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getDashboardKPIs() {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*) FROM clients)                                                   AS total_clients,
      (SELECT COUNT(DISTINCT client_id) FROM pipeline WHERE status = 'active')         AS active_pipeline,
      (SELECT COUNT(*) FROM message_log WHERE status = 'sent')                        AS messages_sent,
      (SELECT COUNT(*) FROM message_log WHERE sent_at > NOW() - INTERVAL '30 days')   AS sent_30d,
      (SELECT COUNT(*) FROM message_log WHERE status = 'sent' AND channel LIKE '%whatsapp%'
         AND sent_at > NOW() - INTERVAL '30 days')                                    AS wa_sent_30d,
      (SELECT COUNT(*) FROM orders WHERE ordered_at > NOW() - INTERVAL '30 days')     AS orders_30d,
      -- Clientes cujo PRIMEIRO pedido foi nos últimos 30 dias (exclui re-compradores)
      (SELECT COUNT(*) FROM (
        SELECT client_id
        FROM orders
        WHERE client_id IS NOT NULL
        GROUP BY client_id
        HAVING MIN(ordered_at) > NOW() - INTERVAL '30 days'
      ) t)                                                                             AS new_clients_30d
  `);
  return rows[0];
}

async function getPipelineStages() {
  const { rows } = await query(`
    SELECT
      CASE
        WHEN days_since BETWEEN 0  AND 6   THEN 'd3'
        WHEN days_since BETWEEN 7  AND 20  THEN 'd14'
        WHEN days_since BETWEEN 21 AND 45  THEN 'd30'
        WHEN days_since BETWEEN 46 AND 75  THEN 'd60'
        WHEN days_since BETWEEN 76 AND 130 THEN 'd90'
        ELSE 'plus'
      END AS stage,
      COUNT(*) AS count
    FROM (
      SELECT DATE_PART('day', NOW() - o.ordered_at) AS days_since
      FROM pipeline p
      JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'active'
    ) t
    GROUP BY stage
  `);
  return rows;
}

async function getRecentActivity(limit = 12) {
  const { rows } = await query(`
    SELECT
      ml.id, ml.day_offset, ml.channel, ml.status, ml.sent_at,
      c.name  AS client_name,
      o.product_name
    FROM message_log ml
    JOIN clients c ON c.id = ml.client_id
    JOIN orders  o ON o.id = ml.order_id
    WHERE ml.status = 'sent'
    ORDER BY ml.sent_at DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

async function getRecentOrders(limit = 12) {
  const { rows } = await query(`
    SELECT
      o.id, o.order_number, o.bling_order_id, o.product_name, o.product_category,
      o.amount, o.status, o.ordered_at, o.vendedor,
      c.name AS client_name, c.city
    FROM orders o
    LEFT JOIN clients c ON c.id = o.client_id
    ORDER BY o.ordered_at DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

// ════════════════════════════════════════════════════
// CLIENTES
// ════════════════════════════════════════════════════

// GET /api/clients?page=1&limit=20&stage=d3&search=&has_phone=true&contacted=yes&vendedor=Nome&sort=ordered_at_desc
router.get('/clients', async (req, res) => {
  try {
    const page   = parseInt(req.query.page  || '1');
    const limit  = parseInt(req.query.limit || '50');
    const offset = (page - 1) * limit;
    const search      = req.query.search    ? `%${req.query.search}%` : null;
    const stage       = req.query.stage;
    const hasPhone    = req.query.has_phone;
    const contacted   = req.query.contacted;
    const vendedor    = req.query.vendedor;

    const SORT_MAP = {
      ordered_at_desc:  'ordered_at DESC',
      ordered_at_asc:   'ordered_at ASC',
      name_asc:         'name ASC',
      name_desc:        'name DESC',
      amount_desc:      'amount DESC NULLS LAST',
      amount_asc:       'amount ASC NULLS LAST',
      messages_desc:    'messages_sent DESC',
      days_asc:         'days_since ASC',
    };
    const sortExpr = SORT_MAP[req.query.sort] || 'ordered_at DESC';

    // Base: apenas pedidos Atendidos (única fonte de dados após simplificação do sync)
    let whereClause = `WHERE o.client_id IS NOT NULL AND o.status = 'Atendido'`;
    const params = [];
    let pi = 1;

    if (search) {
      whereClause += ` AND (c.name ILIKE $${pi} OR o.product_name ILIKE $${pi} OR c.phone LIKE $${pi} OR o.vendedor ILIKE $${pi})`;
      params.push(search); pi++;
    }

    if (stage && stage !== 'all') {
      const ranges = {
        d3:   [0, 6], d14: [7, 20], d30: [21, 45],
        d60:  [46, 75], d90: [76, 130], d160: [131, 200],
      };
      if (ranges[stage]) {
        whereClause += ` AND DATE_PART('day', NOW() - o.ordered_at) BETWEEN $${pi} AND $${pi+1}`;
        params.push(...ranges[stage]); pi += 2;
      }
    }

    if (hasPhone === 'true') {
      whereClause += ` AND c.phone IS NOT NULL AND c.phone != ''`;
    } else if (hasPhone === 'false') {
      whereClause += ` AND (c.phone IS NULL OR c.phone = '')`;
    }

    // "Contactado" = tem pelo menos 1 mensagem enviada com sucesso no pipeline deste pedido
    if (contacted === 'yes') {
      whereClause += ` AND p.id IS NOT NULL AND (SELECT COUNT(*) FROM message_log ml WHERE ml.pipeline_id = p.id AND ml.status = 'sent') > 0`;
    } else if (contacted === 'no') {
      whereClause += ` AND (p.id IS NULL OR (SELECT COUNT(*) FROM message_log ml WHERE ml.pipeline_id = p.id AND ml.status = 'sent') = 0)`;
    }

    if (vendedor && vendedor !== 'all') {
      whereClause += ` AND o.vendedor = $${pi}`;
      params.push(vendedor); pi++;
    }

    const { rows } = await query(`
      SELECT * FROM (
        SELECT DISTINCT ON (c.id)
          p.id            AS pipeline_id,
          c.id            AS client_id,
          c.name, c.phone, c.email, c.city,
          o.id            AS order_id,
          o.bling_order_id,
          o.order_number,
          o.product_name,
          o.item_count,
          o.product_sku, o.product_category, o.amount,
          o.status        AS order_status,
          o.vendedor,
          o.ordered_at,
          DATE_PART('day', NOW() - o.ordered_at)::int AS days_since,
          (
            SELECT s.day_offset
            FROM automation_steps s
            WHERE s.day_offset > DATE_PART('day', NOW() - o.ordered_at)
              AND s.is_active = true
            ORDER BY s.day_offset LIMIT 1
          ) AS next_step_day,
          COALESCE((
            SELECT COUNT(*) FROM message_log ml
            WHERE ml.pipeline_id = p.id AND ml.status = 'sent'
          ), 0)::int AS messages_sent
        FROM clients c
        JOIN orders  o ON o.client_id = c.id
        LEFT JOIN pipeline p ON p.order_id = o.id
        ${whereClause}
        ORDER BY c.id, o.ordered_at DESC
      ) sub
      ORDER BY ${sortExpr}
      LIMIT $${pi} OFFSET $${pi+1}
    `, [...params, limit, offset]);

    const totalRow = await query(`
      SELECT COUNT(DISTINCT c.id)
      FROM clients c
      JOIN orders  o ON o.client_id = c.id
      LEFT JOIN pipeline p ON p.order_id = o.id
      ${whereClause}
    `, params);

    res.json({
      data:  rows,
      total: parseInt(totalRow.rows[0].count),
      page, limit,
      pages: Math.ceil(totalRow.rows[0].count / limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vendedores — lista de vendedores distintos (para filtros)
router.get('/vendedores', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT DISTINCT vendedor
      FROM orders
      WHERE vendedor IS NOT NULL AND vendedor != ''
      ORDER BY vendedor
    `);
    res.json(rows.map(r => r.vendedor));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id — Perfil completo do cliente
router.get('/clients/:id', async (req, res) => {
  try {
    const clientRes = await query(`SELECT * FROM clients WHERE id = $1`, [req.params.id]);
    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado' });
    const client = clientRes.rows[0];

    // Todos os pedidos do cliente com status do pipeline
    const ordersRes = await query(`
      SELECT
        o.id, o.order_number, o.bling_order_id,
        o.product_name, o.product_sku, o.product_category,
        o.amount, o.status AS order_status, o.ordered_at,
        p.id   AS pipeline_id,
        p.status AS pipeline_status,
        (SELECT COUNT(*) FROM message_log ml
         WHERE ml.pipeline_id = p.id AND ml.status = 'sent')::int AS messages_sent
      FROM orders o
      LEFT JOIN pipeline p ON p.order_id = o.id
      WHERE o.client_id = $1
      ORDER BY o.ordered_at DESC
    `, [req.params.id]);

    // Histórico de mensagens
    const logsRes = await query(`
      SELECT ml.id, ml.day_offset, ml.channel, ml.status,
             ml.sent_at, ml.wa_message, ml.email_subject, ml.error_message,
             s.label AS step_label,
             o.product_name, o.order_number, o.bling_order_id
      FROM message_log ml
      LEFT JOIN automation_steps s ON s.id = ml.step_id
      LEFT JOIN orders o ON o.id = ml.order_id
      WHERE ml.client_id = $1
      ORDER BY ml.created_at DESC
      LIMIT 30
    `, [req.params.id]);

    // Totais
    const totalsRes = await query(`
      SELECT
        COUNT(DISTINCT o.id)::int AS total_orders,
        SUM(o.amount)::numeric(10,2) AS total_spent,
        MAX(o.ordered_at) AS last_order
      FROM orders o WHERE o.client_id = $1
    `, [req.params.id]);

    res.json({
      client,
      orders:   ordersRes.rows,
      messages: logsRes.rows,
      totals:   totalsRes.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// WIN-BACK — CLIENTES INATIVOS
// ════════════════════════════════════════════════════

// GET /api/winback/segments
router.get('/winback/segments', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (
          WHERE last_order < NOW() - INTERVAL '90 days'
            AND last_order >= NOW() - INTERVAL '180 days'
        )::int AS seg90,
        COUNT(*) FILTER (
          WHERE last_order < NOW() - INTERVAL '180 days'
            AND last_order >= NOW() - INTERVAL '365 days'
        )::int AS seg180,
        COUNT(*) FILTER (
          WHERE last_order < NOW() - INTERVAL '365 days'
        )::int AS seg365
      FROM (
        SELECT c.id, MAX(o.ordered_at) AS last_order
        FROM clients c JOIN orders o ON o.client_id = c.id
        GROUP BY c.id
      ) t
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/winback/contacted?days=90&max_days=180 — clientes já contactados neste segmento
router.get('/winback/contacted', async (req, res) => {
  try {
    const days    = parseInt(req.query.days    || '90');
    const maxDays = parseInt(req.query.max_days || '9999');

    const { rows } = await query(`
      SELECT
        c.id, c.name, c.phone, c.email, c.city,
        MAX(ml.sent_at)                                                    AS contacted_at,
        (SELECT ml2.wa_message FROM message_log ml2
         WHERE ml2.client_id = c.id AND ml2.channel = 'winback'
         ORDER BY ml2.sent_at DESC LIMIT 1)                                AS last_message,
        (SELECT o2.product_name FROM orders o2
         WHERE o2.client_id = c.id ORDER BY o2.ordered_at DESC LIMIT 1)   AS last_product,
        DATE_PART('day', NOW() - MAX(o.ordered_at))::int                   AS days_inactive,
        COUNT(DISTINCT o.id)::int                                          AS total_orders,
        SUM(o.amount)::numeric(10,2)                                       AS total_spent
      FROM clients c
      JOIN orders o ON o.client_id = c.id
      JOIN message_log ml ON ml.client_id = c.id
        AND ml.channel = 'winback' AND ml.status = 'sent'
      GROUP BY c.id
      HAVING DATE_PART('day', NOW() - MAX(o.ordered_at)) BETWEEN $1 AND $2
      ORDER BY MAX(ml.sent_at) DESC
      LIMIT 300
    `, [days, maxDays]);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/winback/clients?days=90&max_days=180&limit=50&vendedor=Nome
router.get('/winback/clients', async (req, res) => {
  try {
    const days     = parseInt(req.query.days    || '90');
    const maxDays  = parseInt(req.query.max_days || String(days + 90));
    const limit    = parseInt(req.query.limit   || '100');
    const vendedor = req.query.vendedor;

    const params = [days, maxDays, limit];
    let vendedorClause = '';
    if (vendedor && vendedor !== 'all') {
      params.push(vendedor);
      vendedorClause = `AND EXISTS (
        SELECT 1 FROM orders ox
        WHERE ox.client_id = c.id AND ox.vendedor = $${params.length}
      )`;
    }

    const { rows } = await query(`
      SELECT
        c.id, c.name, c.phone, c.email, c.city,
        MAX(o.ordered_at)::date AS last_order,
        DATE_PART('day', NOW() - MAX(o.ordered_at))::int AS days_inactive,
        COUNT(DISTINCT o.id)::int AS total_orders,
        SUM(o.amount)::numeric(10,2) AS total_spent,
        (SELECT o2.product_name FROM orders o2
         WHERE o2.client_id = c.id ORDER BY o2.ordered_at DESC LIMIT 1) AS last_product,
        (SELECT o2b.bling_order_id FROM orders o2b
         WHERE o2b.client_id = c.id ORDER BY o2b.ordered_at DESC LIMIT 1) AS bling_order_id,
        (SELECT o3.vendedor FROM orders o3
         WHERE o3.client_id = c.id ORDER BY o3.ordered_at DESC LIMIT 1) AS vendedor
      FROM clients c
      JOIN orders o ON o.client_id = c.id
      ${vendedorClause ? 'WHERE 1=1 ' + vendedorClause : ''}
      GROUP BY c.id
      HAVING MAX(o.ordered_at) < NOW() - MAKE_INTERVAL(days => $1)
         AND MAX(o.ordered_at) >= NOW() - MAKE_INTERVAL(days => $2)
      ORDER BY MAX(o.ordered_at) DESC
      LIMIT $3
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/winback/preview-message — Gera mensagem personalizada para cliente win-back
// clientId=null → gera template genérico de reativação
router.post('/winback/preview-message', async (req, res) => {
  try {
    const { clientId, template, productName } = req.body;

    let cl = { name: 'Cliente', product_name: 'produto Apple', product_category: 'Apple', days_inactive: 120 };
    if (clientId) {
      const { rows } = await query(`
        SELECT c.name, o.product_name, o.product_category,
               DATE_PART('day', NOW() - MAX(o.ordered_at))::int AS days_inactive
        FROM clients c
        JOIN orders o ON o.client_id = c.id
        WHERE c.id = $1
        GROUP BY c.name, o.product_name, o.product_category
        ORDER BY MAX(o.ordered_at) DESC
        LIMIT 1
      `, [clientId]);
      if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });
      cl = rows[0];
      // Usa o produto selecionado no frontend quando informado (ex: picker de pedidos)
      if (productName) cl.product_name = productName;
    }

    // Nunca passa placeholder genérico para a IA
    const cleanName = /^produto\s+isafe$/i.test((cl.product_name||'').trim());
    if (cleanName) cl.product_name = null;

    const message = await ai.generateMessage({
      clientName:      cl.name,
      productName:     cl.product_name || null,
      productCategory: cl.product_category,
      dayOffset:       cl.days_inactive,
      stepLabel:       'Reativação Win-Back',
      focus:           `Reativar cliente inativo há ${cl.days_inactive} dias`,
      waTemplate:      template || '',
    });

    res.json({ message: message || template || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/winback/mark-contacted — Registra contato de reativação
router.post('/winback/mark-contacted', async (req, res) => {
  try {
    const { clientId, message, channel } = req.body;
    if (!clientId) return res.status(400).json({ error: 'clientId obrigatório' });

    const { rows: orderRows } = await query(
      `SELECT id FROM orders WHERE client_id = $1 ORDER BY ordered_at DESC LIMIT 1`,
      [clientId]
    );
    const orderId = orderRows[0]?.id || null;

    await query(`
      INSERT INTO message_log
        (client_id, order_id, step_id, pipeline_id, day_offset, channel, status, sent_at, wa_message, triggered_by)
      VALUES ($1, $2, NULL, NULL, -1, $3, 'sent', NOW(), $4, $5)
    `, [clientId, orderId, channel || 'winback', message || null, req.user?.username || 'manual']);

    await activityLog.log(req.user?.id, req.user?.username, 'winback_contacted', { clientId, channel }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bulk/email — Disparo em massa por e-mail
router.post('/bulk/email', async (req, res) => {
  try {
    const { clientIds, subject, message, stepId } = req.body;
    if (!Array.isArray(clientIds) || !clientIds.length) return res.status(400).json({ error: 'clientIds obrigatório' });
    if (!subject || !message) return res.status(400).json({ error: 'subject e message obrigatórios' });

    const { sleep } = require('../utils/helpers');
    let sent = 0, skipped = 0;
    const errors = [];

    for (const clientId of clientIds) {
      try {
        const { rows } = await query(`SELECT name, email FROM clients WHERE id = $1`, [clientId]);
        const c = rows[0];
        if (!c?.email) { skipped++; continue; }

        const firstName = (c.name || '').split(' ')[0] || c.name;
        const html = message
          .replace(/\{\{nome\}\}/g, firstName)
          .replace(/\{\{produto\}\}/g, '')
          .replace(/\n/g, '<br>');

        await email.sendEmail({
          to: c.email, name: c.name,
          subject: subject.replace(/\{\{nome\}\}/g, firstName),
          htmlContent: html,
        });

        const { rows: oRows } = await query(
          `SELECT id FROM orders WHERE client_id = $1 ORDER BY ordered_at DESC LIMIT 1`, [clientId]
        );
        await query(`
          INSERT INTO message_log
            (client_id, order_id, step_id, pipeline_id, day_offset, channel, status, sent_at, email_subject)
          VALUES ($1,$2,$3,NULL,$4,'email','sent',NOW(),$5)
        `, [clientId, oRows[0]?.id || null, stepId || null, stepId ? 0 : -1, subject]);

        sent++;
        await sleep(150);
      } catch (e) {
        logger.warn(`bulk/email client ${clientId}: ${e.message}`);
        errors.push({ clientId, error: e.message });
        skipped++;
      }
    }

    res.json({ success: true, sent, skipped, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// EMAIL — ESTATÍSTICAS E CLIENTES ALVO
// ════════════════════════════════════════════════════

// GET /api/email/stats
router.get('/email/stats', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE channel IN ('email','both') AND status = 'sent')::int AS email_sent,
        COUNT(*) FILTER (WHERE channel IN ('email','both') AND status = 'sent'
          AND sent_at > NOW() - INTERVAL '30 days')::int AS email_30d,
        COUNT(*) FILTER (WHERE status = 'sent')::int AS total_sent
      FROM message_log
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email/upcoming-clients — Clientes com e-mail e próxima etapa de e-mail
router.get('/email/upcoming-clients', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100');
    const { rows } = await query(`
      SELECT
        c.id, c.name, c.email,
        o.product_name,
        DATE_PART('day', NOW() - o.ordered_at)::int AS days_since,
        s.label      AS next_step_label,
        s.day_offset AS next_step_day,
        s.channel    AS next_step_channel
      FROM pipeline p
      JOIN orders  o ON o.id = p.order_id
      JOIN clients c ON c.id = p.client_id
      JOIN LATERAL (
        SELECT * FROM automation_steps
        WHERE day_offset > DATE_PART('day', NOW() - o.ordered_at)
          AND is_active = true
          AND channel IN ('email','both')
        ORDER BY day_offset LIMIT 1
      ) s ON true
      WHERE p.status = 'active'
        AND c.email IS NOT NULL AND c.email != ''
      ORDER BY s.day_offset, o.ordered_at DESC
      LIMIT $1
    `, [limit]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:id/pipeline — Atualizar status do pipeline
router.patch('/clients/:id/pipeline', async (req, res) => {
  try {
    const { status, notes } = req.body;
    await query(
      `UPDATE pipeline SET status = $1, notes = $2 WHERE client_id = $3`,
      [status, notes, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// AUTOMAÇÕES / STEPS
// ════════════════════════════════════════════════════

// GET /api/steps — Lista todas as etapas
router.get('/steps', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM automation_steps ORDER BY day_offset`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/steps/:id — Atualizar etapa (qualquer campo)
router.patch('/steps/:id', async (req, res) => {
  try {
    const allowed = ['day_offset','label','focus','channel','wa_template','email_subject','email_template','is_active'];
    const updates = [];
    const values  = [];
    let pi = 1;
    for (const f of allowed) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${pi}`);
        values.push(req.body[f]);
        pi++;
      }
    }
    if (updates.length === 0) return res.json({ success: true });
    updates.push(`updated_at = NOW()`);
    values.push(req.params.id);
    await query(
      `UPDATE automation_steps SET ${updates.join(', ')} WHERE id = $${pi}`,
      values
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Já existe uma automação neste dia` });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/steps — Criar nova etapa
router.post('/steps', async (req, res) => {
  try {
    const { day_offset, label, focus, channel, wa_template, email_subject, email_template } = req.body;
    if (!day_offset || !label || !channel) {
      return res.status(400).json({ error: 'day_offset, label e channel são obrigatórios' });
    }
    const { rows } = await query(
      `INSERT INTO automation_steps (day_offset, label, focus, channel, wa_template, email_subject, email_template)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [day_offset, label, focus || null, channel, wa_template || null, email_subject || null, email_template || null]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Já existe uma automação no D+${req.body.day_offset}` });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/steps/:id — Remover etapa
router.delete('/steps/:id', async (req, res) => {
  try {
    await query(`DELETE FROM automation_steps WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/steps/:id/clients — Clientes pendentes e já enviados nesta etapa
// Returns: { step, pending: [], sent: [], vendedores: [], counts: {} }
router.get('/steps/:id/clients', async (req, res) => {
  try {
    const { rows: stepRows } = await query(`SELECT * FROM automation_steps WHERE id = $1`, [req.params.id]);
    if (stepRows.length === 0) return res.status(404).json({ error: 'Etapa não encontrada' });
    const step      = stepRows[0];
    const tolerance = parseInt(process.env.SCHEDULER_TOLERANCE_DAYS || '3');
    const { vendedor } = req.query;

    // ── PENDENTES: na janela de ±tolerance dias, sem envio nesta etapa ─────
    const pendingParams = [step.id, step.day_offset, tolerance];
    let pendingExtra = '';
    if (vendedor && vendedor !== 'all') {
      pendingParams.push(vendedor);
      pendingExtra = ` AND o.vendedor = $${pendingParams.length}`;
    }

    const { rows: pending } = await query(`
      SELECT
        p.id          AS pipeline_id,
        c.id          AS client_id,
        c.name, c.phone, c.email,
        o.product_name, o.product_category, o.amount,
        o.order_number, o.bling_order_id, o.vendedor,
        DATE_PART('day', NOW() - o.ordered_at)::int AS days_since
      FROM pipeline p
      JOIN orders o ON o.id = p.order_id
      JOIN clients c ON c.id = p.client_id
      WHERE p.status = 'active'
        AND ABS(DATE_PART('day', NOW() - o.ordered_at) - $2) <= $3
        AND NOT EXISTS (
          SELECT 1 FROM message_log ml
          WHERE ml.pipeline_id = p.id AND ml.step_id = $1
            AND ml.status IN ('sent','skipped')
        )
        ${pendingExtra}
      ORDER BY o.ordered_at ASC
      LIMIT 500
    `, pendingParams);

    // ── JÁ ENVIADOS: todos que receberam esta etapa ────────────────────────
    const sentParams = [step.id];
    let sentExtra = '';
    if (vendedor && vendedor !== 'all') {
      sentParams.push(vendedor);
      sentExtra = ` AND o.vendedor = $${sentParams.length}`;
    }

    const { rows: sent } = await query(`
      SELECT
        p.id          AS pipeline_id,
        c.id          AS client_id,
        c.name, c.phone,
        o.product_name, o.product_category, o.order_number, o.vendedor,
        ml.sent_at, ml.channel, ml.wa_message, ml.status AS send_status
      FROM message_log ml
      JOIN pipeline p ON p.id = ml.pipeline_id
      JOIN orders o ON o.id = p.order_id
      JOIN clients c ON c.id = p.client_id
      WHERE ml.step_id = $1
        AND ml.status IN ('sent','skipped')
        ${sentExtra}
      ORDER BY ml.sent_at DESC
      LIMIT 500
    `, sentParams);

    // ── Vendedores distintos na janela (para filtro) ────────────────────────
    const { rows: metaRows } = await query(`
      SELECT DISTINCT o.vendedor
      FROM pipeline p
      JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'active'
        AND ABS(DATE_PART('day', NOW() - o.ordered_at) - $1) <= $2
    `, [step.day_offset, tolerance]);

    const vendedores = [...new Set(metaRows.map(r => r.vendedor).filter(Boolean))].sort();

    res.json({
      step,
      pending,
      sent,
      vendedores,
      counts: { pending: pending.length, sent: sent.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pipeline/:id/preview-message — Gera mensagem personalizada (IA ou template)
router.post('/pipeline/:id/preview-message', async (req, res) => {
  try {
    const { stepId } = req.body;
    const { rows: plRows } = await query(`
      SELECT p.id AS pipeline_id, c.name AS client_name,
             o.product_name, o.product_category, o.amount, o.order_number
      FROM pipeline p
      JOIN orders o ON o.id = p.order_id
      JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1
    `, [req.params.id]);
    if (plRows.length === 0) return res.status(404).json({ error: 'Pipeline não encontrado' });

    const { rows: stepRows } = await query(`SELECT * FROM automation_steps WHERE id = $1`, [stepId]);
    if (stepRows.length === 0) return res.status(404).json({ error: 'Etapa não encontrada' });

    const pl   = plRows[0];
    const step = stepRows[0];

    const message = await ai.generateMessage({
      clientName:      pl.client_name,
      productName:     pl.product_name,
      productCategory: pl.product_category,
      dayOffset:       step.day_offset,
      stepLabel:       step.label,
      focus:           step.focus,
      waTemplate:      step.wa_template,
    });

    res.json({ message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/mark-sent — Registra mensagem como enviada (envio manual via WA direto)
router.post('/messages/mark-sent', async (req, res) => {
  try {
    const { pipelineId, stepId, message, channel } = req.body;
    if (!pipelineId || !stepId) return res.status(400).json({ error: 'pipelineId e stepId obrigatórios' });

    // Busca dados para o log
    const { rows: plRows } = await query(`
      SELECT p.client_id, p.order_id FROM pipeline p WHERE p.id = $1
    `, [pipelineId]);
    if (plRows.length === 0) return res.status(404).json({ error: 'Pipeline não encontrado' });

    const { rows: stepRows } = await query(`SELECT day_offset FROM automation_steps WHERE id = $1`, [stepId]);
    if (stepRows.length === 0) return res.status(404).json({ error: 'Etapa não encontrada' });

    const { client_id, order_id } = plRows[0];
    const { day_offset } = stepRows[0];

    // Upsert: se já existe log para este pipeline+step, atualiza; senão insere
    await query(`
      INSERT INTO message_log
        (pipeline_id, client_id, order_id, step_id, day_offset, channel,
         status, scheduled_for, sent_at, wa_message)
      VALUES ($1,$2,$3,$4,$5,$6,'sent', CURRENT_DATE, NOW(), $7)
      ON CONFLICT DO NOTHING
    `, [pipelineId, client_id, order_id, stepId, day_offset, channel || 'whatsapp', message || null]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/steps/:id/detail — Visão completa de uma automação
router.get('/steps/:id/detail', async (req, res) => {
  try {
    const { rows: stepRows } = await query(`SELECT * FROM automation_steps WHERE id = $1`, [req.params.id]);
    if (stepRows.length === 0) return res.status(404).json({ error: 'Automação não encontrada' });
    const step = stepRows[0];
    const tolerance = parseInt(process.env.SCHEDULER_TOLERANCE_DAYS || '1');

    const [statsRes, activityRes, windowRes] = await Promise.all([
      // Stats globais desta etapa
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'sent')    AS total_sent,
          COUNT(*) FILTER (WHERE status = 'failed')  AS total_failed,
          COUNT(*) FILTER (WHERE status = 'skipped') AS total_skipped,
          COUNT(*) FILTER (WHERE status = 'pending') AS total_pending
        FROM message_log WHERE step_id = $1
      `, [step.id]),

      // Atividade recente (últimas 40 mensagens desta etapa)
      query(`
        SELECT ml.id, ml.channel, ml.status, ml.sent_at, ml.error_message, ml.day_offset,
               ml.wa_message, ml.email_subject,
               c.id AS client_id, c.name AS client_name, c.phone, c.email,
               o.product_name, o.product_category, o.amount, o.order_number, o.vendedor
        FROM message_log ml
        LEFT JOIN clients c ON c.id = ml.client_id
        LEFT JOIN orders o  ON o.id  = ml.order_id
        WHERE ml.step_id = $1
        ORDER BY ml.created_at DESC
        LIMIT 40
      `, [step.id]),

      // Clientes na janela hoje (ainda não receberam esta etapa)
      query(`
        SELECT
          p.id AS pipeline_id,
          c.id AS client_id, c.name, c.phone, c.email,
          o.product_name, o.product_category, o.amount, o.order_number, o.vendedor,
          DATE_PART('day', NOW() - o.ordered_at)::int AS days_since,
          o.ordered_at
        FROM pipeline p
        JOIN orders o  ON o.id  = p.order_id
        JOIN clients c ON c.id = p.client_id
        WHERE p.status = 'active'
          AND ABS(DATE_PART('day', NOW() - o.ordered_at) - $1) <= $2
          AND NOT EXISTS (
            SELECT 1 FROM message_log ml
            WHERE ml.pipeline_id = p.id AND ml.step_id = $3
              AND ml.status IN ('sent','skipped')
          )
        ORDER BY o.ordered_at DESC
        LIMIT 100
      `, [step.day_offset, tolerance, step.id]),
    ]);

    res.json({
      step,
      stats:    statsRes.rows[0],
      activity: activityRes.rows,
      pending:  windowRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/account/history — Histórico completo de mensagens enviadas
router.get('/account/history', async (req, res) => {
  try {
    const page      = Math.max(1, parseInt(req.query.page  || '1'));
    const limit     = Math.min(100, parseInt(req.query.limit || '50'));
    const offset    = (page - 1) * limit;
    const status    = req.query.status      || null;
    const channel   = req.query.channel     || null;
    const triggered = req.query.triggered_by || null;

    const where = [];
    const params = [];
    if (status)    { params.push(status);    where.push(`ml.status = $${params.length}`); }
    if (channel)   { params.push(channel);   where.push(`ml.channel = $${params.length}`); }
    if (triggered) { params.push(triggered); where.push(`ml.triggered_by = $${params.length}`); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const dataParams  = [...params, limit, offset];
    const countParams = [...params];

    const [dataRes, countRes, usersRes] = await Promise.all([
      query(`
        SELECT ml.id, ml.channel, ml.status, ml.sent_at, ml.day_offset,
               ml.email_subject, ml.error_message, ml.triggered_by,
               c.id AS client_id, c.name AS client_name, c.phone,
               o.product_name, o.product_category, o.amount, o.order_number, o.bling_order_id,
               s.label AS step_label
        FROM message_log ml
        LEFT JOIN clients c ON c.id = ml.client_id
        LEFT JOIN orders o  ON o.id  = ml.order_id
        LEFT JOIN automation_steps s ON s.id = ml.step_id
        ${whereClause}
        ORDER BY ${({ date_asc:'ml.created_at ASC', status:'ml.status ASC, ml.created_at DESC', channel:'ml.channel ASC, ml.created_at DESC' })[req.query.sort] || 'ml.created_at DESC'}
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}
      `, dataParams),
      query(`SELECT COUNT(*) AS total FROM message_log ml ${whereClause}`, countParams),
      query(`SELECT username FROM users WHERE is_active = true ORDER BY username`),
    ]);

    const senders = ['scheduler', ...usersRes.rows.map(r => r.username)];

    res.json({
      rows:     dataRes.rows,
      total:    parseInt(countRes.rows[0].total),
      senders,
      page,
      limit,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// AÇÕES MANUAIS
// ════════════════════════════════════════════════════

// POST /api/scheduler/run — Rodar scheduler manualmente
router.post('/scheduler/run', async (req, res) => {
  try {
    logger.info('Scheduler acionado manualmente via API');
    const result = await scheduler.runScheduler();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/resend — Reenviar mensagem específica
router.post('/messages/resend', async (req, res) => {
  try {
    const { pipelineId, dayOffset } = req.body;
    const result = await scheduler.resendManual(pipelineId, dayOffset);
    // Retorna o resultado REAL do envio (não sempre true)
    res.json({
      success: result.success,
      failed:  result.failed,
      skipped: result.skipped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// SINCRONIZAÇÃO BLING
// ════════════════════════════════════════════════════

// POST /api/bling/sync — Sync manual (sequencial para respeitar rate limit Bling ~3 req/s)
router.post('/bling/sync', async (req, res) => {
  try {
    const days = parseInt(req.body.days || '365');
    logger.info(`Sync Bling manual iniciado (${days} dias)`);
    const contacts = await bling.syncContacts();
    await new Promise(r => setTimeout(r, 2000));
    const orders   = await bling.syncOrders(days);
    await activityLog.log(req.user?.id, req.user?.username, 'bling_sync', { days, contacts, orders }, req.ip);
    res.json({ success: true, contacts, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bling/sync-products — Corrige nomes "Produto iSafe" em lote
// Passa ?all=true para rodar até zerar
router.post('/bling/sync-products', async (req, res) => {
  try {
    const batch = parseInt(req.body.batch || '50');
    const runAll = req.body.all === true;
    logger.info(`Re-sync de nomes de produtos iniciado (lote: ${batch}, all: ${runAll})`);
    let totalFixed = 0;
    let remaining  = Infinity;
    do {
      const result = await bling.syncProductNames(batch);
      totalFixed += result.fixed;
      remaining   = result.remaining;
    } while (runAll && remaining > 0);
    res.json({ success: true, fixed: totalFixed, remaining });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bling/sync-vendedores — Backfill vendedores + status nos pedidos existentes
router.post('/bling/sync-vendedores', async (req, res) => {
  try {
    const days = parseInt(req.body.days || '730');
    logger.info(`Sync de vendedores iniciado (${days} dias)`);
    const updated = await bling.syncVendedores(days);
    res.json({ success: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bling/fix-orders — Corrige vendedor + status em lote nos pedidos com dados incorretos
// Body: { batch: 100 }   (default 100 pedidos por execução)
router.post('/bling/fix-orders', async (req, res) => {
  try {
    const batch = parseInt(req.body.batch || '100');
    logger.info(`Fix de pedidos iniciado (lote: ${batch})`);
    const result = await bling.fixAllOrders(batch);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bling/raw-order/:id — Retorna a resposta RAW da Bling API para um pedido
// Útil para diagnóstico: ver exatamente o que a API retorna
router.get('/bling/raw-order/:id', async (req, res) => {
  try {
    const raw = await bling.rawOrder(req.params.id);
    // Log the vendedor and situacao fields specifically for debugging
    const d = raw?.data || raw;
    logger.info(
      `RAW ORDER ${req.params.id}: ` +
      `vendedor=${JSON.stringify(d?.vendedor)} ` +
      `situacao=${JSON.stringify(d?.situacao)}`
    );
    res.json(raw);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bling/setup-webhook
router.post('/bling/setup-webhook', async (req, res) => {
  try {
    await bling.setupWebhook();
    res.json({ success: true, webhookUrl: `${process.env.APP_URL}/webhook/bling` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// IA — GERAÇÃO DE TEMPLATES
// ════════════════════════════════════════════════════

// POST /api/ai/generate-template — gera template WhatsApp com IA para uma etapa
router.post('/ai/generate-template', async (req, res) => {
  try {
    const { stepId } = req.body;
    if (!stepId) return res.status(400).json({ error: 'stepId obrigatório' });

    const { rows } = await query(`SELECT * FROM automation_steps WHERE id = $1`, [stepId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Etapa não encontrada' });
    const step = rows[0];

    const message = await ai.generateTemplate({
      dayOffset:  step.day_offset,
      stepLabel:  step.label,
      focus:      step.focus,
      waTemplate: step.wa_template,
    });

    if (!message) {
      return res.status(422).json({
        error: 'Configure uma API Key de IA nas Configurações (Groq — gratuita) para usar este recurso.',
      });
    }
    res.json({ message });
  } catch (err) {
    logger.error(`AI generate-template: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// STATUS DO SISTEMA
// ════════════════════════════════════════════════════

// GET /api/status — Health check completo
router.get('/status', async (req, res) => {
  const [dbOk, waStatus, dnsStatus] = await Promise.all([
    query('SELECT 1').then(() => true).catch(() => false),
    wa.getInstanceStatus(),
    email.checkDNSStatus(process.env.EMAIL_FROM?.split('@')[1] || 'lojaisafe.com.br'),
  ]);

  res.json({
    status:   dbOk && waStatus.connected ? 'ok' : 'degraded',
    database: dbOk,
    whatsapp: waStatus,
    email:    dnsStatus,
    version:  '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// GET /api/logs?page=1 — Últimas mensagens enviadas
router.get('/logs', async (req, res) => {
  try {
    const page  = parseInt(req.query.page || '1');
    const limit = 50;
    const offset = (page - 1) * limit;
    const { rows } = await query(`
      SELECT ml.*, c.name AS client_name, c.phone, c.email,
             o.product_name, s.label AS step_label
      FROM message_log ml
      JOIN clients c ON c.id = ml.client_id
      JOIN orders  o ON o.id = ml.order_id
      LEFT JOIN automation_steps s ON s.id = ml.step_id
      ORDER BY ml.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/metrics/monthly — Métricas mensais
router.get('/metrics/monthly', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        TO_CHAR(sent_at, 'YYYY-MM') AS month,
        channel,
        COUNT(*) AS count,
        COUNT(*) FILTER (WHERE status = 'sent')   AS sent,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
      FROM message_log
      WHERE sent_at > NOW() - INTERVAL '12 months'
      GROUP BY month, channel
      ORDER BY month
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// DESCADASTRO EMAIL
// ════════════════════════════════════════════════════

router.get('/email/unsubscribe', async (req, res) => {
  const { email: emailAddr } = req.query;
  if (!emailAddr) return res.status(400).send('E-mail não fornecido');
  try {
    await email.unsubscribe(emailAddr, 'one-click');
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✅ Descadastro realizado</h2>
        <p>${emailAddr} não receberá mais e-mails da iSafe CRM.</p>
        <p><a href="https://lojaisafe.com.br">Voltar para lojaisafe.com.br</a></p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('Erro ao processar descadastro');
  }
});

module.exports = router;
