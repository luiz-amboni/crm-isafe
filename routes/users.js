/**
 * iSafe CRM · Gestão de Usuários e Log de Atividades
 * Todas as rotas requerem auth + admin (exceto GET /me que fica em auth.js)
 */

const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const auth     = require('../middleware/auth');
const { requireAdmin } = require('../middleware/auth');
const { query }  = require('../db');
const activityLog = require('../services/activityLog');
const logger   = require('../services/logger');

// ── LISTAR USUÁRIOS ────────────────────────────────────────────────────────

router.get('/users', auth, requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT id, username, full_name, role, is_active, created_at, last_login
     FROM users ORDER BY created_at ASC`
  );
  res.json(rows);
});

// ── CRIAR USUÁRIO ──────────────────────────────────────────────────────────

router.post('/users', auth, requireAdmin, async (req, res) => {
  const { username, password, full_name, role } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username e senha são obrigatórios' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter mínimo 6 caracteres' });
  }
  const validRole = ['admin', 'user'].includes(role) ? role : 'user';
  const cleanUser = username.trim().toLowerCase();

  const { rows: existing } = await query('SELECT id FROM users WHERE username = $1', [cleanUser]);
  if (existing.length > 0) {
    return res.status(409).json({ error: 'Nome de usuário já existe' });
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id, username, full_name, role, is_active, created_at`,
    [cleanUser, hash, full_name || null, validRole]
  );

  await activityLog.log(req.user.id, req.user.username, 'create_user', { new_user: cleanUser, role: validRole }, req.ip);
  logger.info(`Usuário criado: ${cleanUser} (${validRole}) por ${req.user.username}`);
  res.status(201).json(rows[0]);
});

// ── ATUALIZAR USUÁRIO ──────────────────────────────────────────────────────

router.put('/users/:id', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { full_name, role, is_active } = req.body || {};

  // Impede desativar o próprio usuário admin
  if (String(req.user.id) === String(id) && is_active === false) {
    return res.status(400).json({ error: 'Você não pode desativar sua própria conta' });
  }

  const sets = [];
  const vals = [];

  if (full_name !== undefined) { sets.push(`full_name = $${vals.length+1}`); vals.push(full_name); }
  if (role      !== undefined && ['admin','user'].includes(role)) {
    sets.push(`role = $${vals.length+1}`); vals.push(role);
  }
  if (is_active !== undefined) { sets.push(`is_active = $${vals.length+1}`); vals.push(is_active); }

  if (sets.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  vals.push(id);
  const { rows } = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}
     RETURNING id, username, full_name, role, is_active`,
    vals
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });

  await activityLog.log(req.user.id, req.user.username, 'update_user', { user_id: id, changes: req.body }, req.ip);
  res.json(rows[0]);
});

// ── RESETAR SENHA (admin) ──────────────────────────────────────────────────

router.post('/users/:id/reset-password', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { new_password } = req.body || {};

  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter mínimo 6 caracteres' });
  }

  const { rows } = await query('SELECT username FROM users WHERE id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });

  const hash = await bcrypt.hash(new_password, 10);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);

  await activityLog.log(req.user.id, req.user.username, 'reset_password', { user_id: id, target: rows[0].username }, req.ip);
  logger.info(`Senha resetada para: ${rows[0].username} por ${req.user.username}`);
  res.json({ ok: true });
});

// ── LOG DE ATIVIDADES ──────────────────────────────────────────────────────

router.get('/activity-log', auth, requireAdmin, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '100'), 500);
  const offset = parseInt(req.query.offset || '0');
  const userId = req.query.user_id || null;

  let sql = `
    SELECT al.id, al.username, al.action, al.details, al.ip, al.created_at,
           u.full_name
    FROM activity_log al
    LEFT JOIN users u ON u.id = al.user_id
  `;
  const params = [];

  if (userId) {
    params.push(userId);
    sql += ` WHERE al.user_id = $${params.length}`;
  }

  sql += ` ORDER BY al.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
  params.push(limit, offset);

  const { rows } = await query(sql, params);

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM activity_log${userId ? ' WHERE user_id = $1' : ''}`,
    userId ? [userId] : []
  );

  res.json({ rows, total: countRows[0].total });
});

// ── LIMPAR LOGS ANTIGOS (>90 dias) ─────────────────────────────────────────

router.delete('/activity-log/cleanup', auth, requireAdmin, async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM activity_log WHERE created_at < NOW() - INTERVAL '90 days'`
  );
  await activityLog.log(req.user.id, req.user.username, 'cleanup_logs', { deleted: rowCount }, req.ip);
  res.json({ deleted: rowCount });
});

module.exports = router;
