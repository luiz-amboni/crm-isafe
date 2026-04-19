/**
 * ════════════════════════════════════════════════════
 * iSafe CRM · Campanhas de Marketing
 * WhatsApp Marketing + Email Marketing
 * ════════════════════════════════════════════════════
 */

const router    = require('express').Router();
const { query, transaction } = require('../db');
const wa        = require('../services/whatsapp');
const email     = require('../services/email');
const logger    = require('../services/logger');
const auth      = require('../middleware/auth');
const activityLog = require('../services/activityLog');

router.use(auth);

// ════════════════════════════════════════════════════
// LISTAR / CRIAR CAMPANHAS
// ════════════════════════════════════════════════════

// GET /api/campaigns?channel=whatsapp|email
router.get('/campaigns', async (req, res) => {
  try {
    const { channel } = req.query;
    let sql = `
      SELECT c.*,
        (SELECT COUNT(*) FROM campaign_clients cc WHERE cc.campaign_id = c.id)                            AS total_clients,
        (SELECT COUNT(*) FROM campaign_clients cc WHERE cc.campaign_id = c.id AND cc.status = 'sent')     AS sent_count,
        (SELECT COUNT(*) FROM campaign_clients cc WHERE cc.campaign_id = c.id AND cc.status = 'failed')   AS failed_count,
        (SELECT COUNT(*) FROM campaign_clients cc WHERE cc.campaign_id = c.id AND cc.status = 'pending')  AS pending_count
      FROM campaigns c
    `;
    const params = [];
    if (channel) { sql += ` WHERE c.channel = $1`; params.push(channel); }
    const CAMP_SORT = {
      created_desc: 'c.created_at DESC',
      created_asc:  'c.created_at ASC',
      name_asc:     'c.name ASC',
      name_desc:    'c.name DESC',
      sent_desc:    'sent_count DESC',
      status:       'c.status ASC, c.created_at DESC',
    };
    sql += ` ORDER BY ${CAMP_SORT[req.query.sort] || 'c.created_at DESC'}`;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns
router.post('/campaigns', async (req, res) => {
  try {
    const { name, channel, subject, message, scheduled_at, audience_filter } = req.body;
    if (!name || !channel) return res.status(400).json({ error: 'name e channel são obrigatórios' });
    const { rows } = await query(
      `INSERT INTO campaigns (name, channel, subject, message, scheduled_at, audience_filter)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, channel, subject || null, message || null,
       scheduled_at || null, audience_filter || 'manual']
    );
    // Se audience_filter não é manual, adiciona clientes automaticamente
    const camp = rows[0];
    if (audience_filter && audience_filter !== 'manual') {
      const filterMap = { all_phone:'has_phone', all_email:'has_email', pipeline:'pipeline', all:'all' };
      await autoAddClients(camp.id, filterMap[audience_filter] || audience_filter, channel);
    }
    res.status(201).json(camp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// CAMPANHA INDIVIDUAL
// ════════════════════════════════════════════════════

// GET /api/campaigns/:id
router.get('/campaigns/:id', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM campaign_clients cc WHERE cc.campaign_id = c.id)                            AS total_clients,
        (SELECT COUNT(*) FROM campaign_clients cc WHERE cc.campaign_id = c.id AND cc.status = 'sent')     AS sent_count,
        (SELECT COUNT(*) FROM campaign_clients cc WHERE cc.campaign_id = c.id AND cc.status = 'failed')   AS failed_count,
        (SELECT COUNT(*) FROM campaign_clients cc WHERE cc.campaign_id = c.id AND cc.status = 'pending')  AS pending_count
      FROM campaigns c WHERE c.id = $1
    `, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Campanha não encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/:id
router.patch('/campaigns/:id', async (req, res) => {
  try {
    const allowed = ['name','subject','message','scheduled_at','status','audience_filter'];
    const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
    if (fields.length === 0) return res.status(400).json({ error: 'Nenhum campo válido' });
    const sets   = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map(f => req.body[f]);
    const { rows } = await query(
      `UPDATE campaigns SET ${sets}, updated_at = NOW() WHERE id = $${fields.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Campanha não encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id
router.delete('/campaigns/:id', async (req, res) => {
  try {
    await query(`DELETE FROM campaigns WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// CLIENTES DA CAMPANHA
// ════════════════════════════════════════════════════

// GET /api/campaigns/:id/clients?page=1&limit=50
router.get('/campaigns/:id/clients', async (req, res) => {
  try {
    const page  = parseInt(req.query.page  || '1');
    const limit = parseInt(req.query.limit || '50');
    const offset = (page - 1) * limit;
    const { rows } = await query(`
      SELECT cc.id AS cc_id, cc.status AS send_status, cc.sent_at, cc.error_msg,
             c.id AS client_id, c.name, c.phone, c.email, c.city
      FROM campaign_clients cc
      JOIN clients c ON c.id = cc.client_id
      WHERE cc.campaign_id = $1
      ORDER BY cc.id DESC
      LIMIT $2 OFFSET $3
    `, [req.params.id, limit, offset]);
    const total = await query(
      `SELECT COUNT(*) FROM campaign_clients WHERE campaign_id = $1`, [req.params.id]
    );
    res.json({ data: rows, total: parseInt(total.rows[0].count), page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/clients — adicionar clientes
// body: { filter: 'all'|'has_phone'|'has_email'|'manual', client_ids: [1,2,...] }
router.post('/campaigns/:id/clients', async (req, res) => {
  try {
    const { filter, client_ids } = req.body;
    const campRow = await query(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    if (campRow.rows.length === 0) return res.status(404).json({ error: 'Campanha não encontrada' });

    let added = 0;
    if (filter && filter !== 'manual') {
      const filterMap = { all_phone:'has_phone', all_email:'has_email', pipeline:'pipeline', all:'all' };
      added = await autoAddClients(req.params.id, filterMap[filter] || filter, campRow.rows[0].channel);
    } else if (Array.isArray(client_ids) && client_ids.length > 0) {
      for (const cid of client_ids) {
        try {
          await query(
            `INSERT INTO campaign_clients (campaign_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [req.params.id, cid]
          );
          added++;
        } catch {}
      }
    }
    res.json({ added });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id/clients/:clientId
router.delete('/campaigns/:id/clients/:clientId', async (req, res) => {
  try {
    await query(
      `DELETE FROM campaign_clients WHERE campaign_id = $1 AND client_id = $2`,
      [req.params.id, req.params.clientId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// DISPARO
// ════════════════════════════════════════════════════

// POST /api/campaigns/:id/dispatch — dispara para todos os pendentes
router.post('/campaigns/:id/dispatch', async (req, res) => {
  try {
    const campRow = await query(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    if (campRow.rows.length === 0) return res.status(404).json({ error: 'Campanha não encontrada' });
    const camp = campRow.rows[0];

    if (camp.status === 'sending' || camp.status === 'completed') {
      return res.status(400).json({ error: `Campanha já está ${camp.status}` });
    }

    // Marca como sending
    await query(`UPDATE campaigns SET status = 'sending', updated_at = NOW() WHERE id = $1`, [camp.id]);

    // Busca clientes pendentes
    const { rows: pending } = await query(`
      SELECT cc.id AS cc_id, c.id AS client_id, c.name, c.phone, c.email
      FROM campaign_clients cc
      JOIN clients c ON c.id = cc.client_id
      WHERE cc.campaign_id = $1 AND cc.status = 'pending'
    `, [camp.id]);

    await activityLog.log(req.user?.id, req.user?.username, 'campaign_dispatch', { campaign_id: camp.id, name: camp.name, queued: pending.length }, req.ip);
    res.json({ ok: true, queued: pending.length, message: `Disparo iniciado para ${pending.length} clientes` });

    // Dispara em background
    dispatchCampaign(camp, pending).catch(err =>
      logger.error(`Erro no disparo da campanha ${camp.id}: ${err.message}`)
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════

async function autoAddClients(campaignId, filter, channel) {
  let sql;
  if (filter === 'pipeline') {
    // Apenas clientes com pedido ativo no pipeline
    sql = `SELECT DISTINCT c.id FROM clients c
           JOIN pipeline p ON p.client_id = c.id
           WHERE p.status = 'active'`;
    if (channel === 'whatsapp') sql += ` AND c.phone IS NOT NULL AND c.phone <> ''`;
    if (channel === 'email')    sql += ` AND c.email IS NOT NULL AND c.email <> ''`;
  } else {
    let where = [];
    if (filter === 'has_phone' || channel === 'whatsapp') where.push(`phone IS NOT NULL AND phone <> ''`);
    if (filter === 'has_email' || channel === 'email')    where.push(`email IS NOT NULL AND email <> ''`);
    sql = `SELECT id FROM clients` + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
  }
  const { rows } = await query(sql);
  let added = 0;
  for (const c of rows) {
    try {
      await query(
        `INSERT INTO campaign_clients (campaign_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [campaignId, c.id]
      );
      added++;
    } catch {}
  }
  return added;
}

async function dispatchCampaign(camp, pending) {
  let sent = 0, failed = 0;
  for (const c of pending) {
    try {
      const firstName = (c.name || '').split(' ')[0];
      const msg = (camp.message || '')
        .replace(/\{\{nome\}\}/gi, firstName)
        .replace(/\{\{name\}\}/gi, firstName);

      if (camp.channel === 'whatsapp') {
        if (!c.phone) throw new Error('Sem telefone');
        await wa.sendMessage(c.phone, msg);
      } else {
        if (!c.email) throw new Error('Sem e-mail');
        await email.send({
          to: c.email, toName: c.name,
          subject: camp.subject || 'iSafe Techstore',
          html: msg.replace(/\n/g, '<br>'),
        });
      }
      await query(
        `UPDATE campaign_clients SET status = 'sent', sent_at = NOW() WHERE campaign_id = $1 AND client_id = $2`,
        [camp.id, c.client_id]
      );
      sent++;
    } catch (err) {
      await query(
        `UPDATE campaign_clients SET status = 'failed', error_msg = $3 WHERE campaign_id = $1 AND client_id = $2`,
        [camp.id, c.client_id, err.message]
      );
      failed++;
    }
    // Respeita rate limit
    await new Promise(r => setTimeout(r, 350));
  }

  const newStatus = pending.length > 0 ? 'completed' : 'draft';
  await query(
    `UPDATE campaigns SET status = $1, sent_count = $2, failed_count = $3, updated_at = NOW() WHERE id = $4`,
    [newStatus, sent, failed, camp.id]
  );
  logger.info(`Campanha ${camp.id} finalizada: ${sent} enviadas, ${failed} falhas`);
}

module.exports = router;
