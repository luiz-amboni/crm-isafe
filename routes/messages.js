/**
 * ════════════════════════════════════════════════════
 * iSafe CRM · Biblioteca de Mensagens
 * Templates reutilizáveis em campanhas e win-back
 * ════════════════════════════════════════════════════
 */

const router    = require('express').Router();
const { query } = require('../db');
const auth      = require('../middleware/auth');

router.use(auth);

// GET /api/templates?channel=whatsapp|email|both
router.get('/templates', async (req, res) => {
  try {
    const { channel, category } = req.query;
    let sql = `SELECT * FROM message_templates`;
    const params = [], where = [];
    if (channel)  { where.push(`channel = $${params.length+1}`);  params.push(channel); }
    if (category) { where.push(`category = $${params.length+1}`); params.push(category); }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ` ORDER BY created_at DESC`;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/templates
router.post('/templates', async (req, res) => {
  try {
    const { name, channel, category, content, subject } = req.body;
    if (!name || !channel) return res.status(400).json({ error: 'name e channel são obrigatórios' });
    const { rows } = await query(
      `INSERT INTO message_templates (name, channel, category, content, subject)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, channel, category||null, content||null, subject||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/templates/:id
router.patch('/templates/:id', async (req, res) => {
  try {
    const allowed = ['name','channel','category','content','subject'];
    const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo válido' });
    const sets   = fields.map((f, i) => `${f} = $${i+1}`).join(', ');
    const values = fields.map(f => req.body[f]);
    const { rows } = await query(
      `UPDATE message_templates SET ${sets}, updated_at = NOW() WHERE id = $${fields.length+1} RETURNING *`,
      [...values, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Template não encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/templates/:id
router.delete('/templates/:id', async (req, res) => {
  try {
    await query(`DELETE FROM message_templates WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
