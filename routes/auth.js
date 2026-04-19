/**
 * iSafe CRM · Autenticação multi-usuário
 */

const router  = require('express').Router();
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const logger  = require('../services/logger');
const cfg     = require('../services/config');
const auth    = require('../middleware/auth');
const { query } = require('../db');
const activityLog = require('../services/activityLog');

const TOKEN_EXPIRY = process.env.JWT_EXPIRY || '8h';

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s === 'troque-por-uma-string-aleatoria-longa') {
    if (process.env.NODE_ENV === 'production') {
      logger.error('Tentativa de iniciar sistema em produção sem JWT_SECRET válido.');
      throw new Error('JWT_SECRET inválido ou não configurado.');
    }
    return 'isafe-crm-dev-secret-inseguro';
  }
  return s;
}

// ── SEED DO ADMIN INICIAL ─────────────────────────────────────────────────
// Chamado pelo server.js após migrations — cria usuário admin se não existir

async function seedAdmin() {
  const { rows } = await query('SELECT id FROM users LIMIT 1');
  if (rows.length > 0) return; // já existem usuários

  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = await cfg.get('ADMIN_PASSWORD') || process.env.ADMIN_PASSWORD;

  if (!adminPass) {
    logger.warn('ADMIN_PASSWORD não configurado — admin seed pulado. Sistema em modo livre.');
    return;
  }

  const hash = await bcrypt.hash(adminPass, 10);
  await query(
    `INSERT INTO users (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (username) DO NOTHING`,
    [adminUser, hash, 'Administrador']
  );
  logger.info(`Usuário admin "${adminUser}" criado na tabela users`);
}

// ── LOGIN ──────────────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  // Verifica se existe algum usuário no banco
  const { rows: allUsers } = await query('SELECT id FROM users WHERE is_active = true LIMIT 1');

  // Modo livre: sem nenhum usuário cadastrado e sem ADMIN_PASSWORD
  if (allUsers.length === 0) {
    const adminPass = await cfg.get('ADMIN_PASSWORD');
    if (!adminPass) {
      const token = jwt.sign(
        { id: 0, username: 'admin', role: 'admin' },
        getSecret(),
        { expiresIn: TOKEN_EXPIRY }
      );
      return res.json({ token, username: 'admin', role: 'admin', warning: 'ADMIN_PASSWORD não configurado — acesso livre' });
    }
  }

  if (!username || !password) {
    return res.status(400).json({ error: 'Informe usuário e senha' });
  }

  // Busca usuário no banco
  const { rows } = await query(
    'SELECT id, username, password_hash, role, full_name, is_active FROM users WHERE username = $1',
    [username.trim().toLowerCase()]
  );

  if (rows.length === 0) {
    logger.warn(`Login: usuário não encontrado "${username}" (IP: ${req.ip})`);
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }

  const user = rows[0];

  if (!user.is_active) {
    logger.warn(`Login: usuário inativo "${username}" (IP: ${req.ip})`);
    return res.status(401).json({ error: 'Usuário desativado. Contate o administrador.' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    logger.warn(`Login: senha incorreta para "${username}" (IP: ${req.ip})`);
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }

  await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    getSecret(),
    { expiresIn: TOKEN_EXPIRY }
  );

  await activityLog.log(user.id, user.username, 'login', null, req.ip);
  logger.info(`Login: ${user.username} (${user.role})`);
  res.json({ token, username: user.username, role: user.role, full_name: user.full_name });
});

// ── VERIFY ─────────────────────────────────────────────────────────────────

router.get('/verify', (req, res) => {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ valid: false });

  try {
    const decoded = jwt.verify(token, getSecret());
    res.json({ valid: true, username: decoded.username, role: decoded.role });
  } catch {
    res.status(401).json({ valid: false });
  }
});

// ── LOGOUT ─────────────────────────────────────────────────────────────────

router.post('/logout', auth, async (req, res) => {
  if (req.user) {
    await activityLog.log(req.user.id, req.user.username, 'logout', null, req.ip);
  }
  res.json({ ok: true });
});

// ── TROCA DE SENHA ─────────────────────────────────────────────────────────

router.post('/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Preencha a senha atual e a nova senha' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter no mínimo 6 caracteres' });
  }

  // Modo livre (id=0): usa legado
  if (!req.user || req.user.id === 0) {
    const adminPass = await cfg.get('ADMIN_PASSWORD');
    if (adminPass && current_password !== adminPass) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }
    await cfg.set('ADMIN_PASSWORD', new_password);
    return res.json({ ok: true });
  }

  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });

  const valid = await bcrypt.compare(current_password, rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Senha atual incorreta' });

  const hash = await bcrypt.hash(new_password, 10);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  await activityLog.log(req.user.id, req.user.username, 'change_password', null, req.ip);
  logger.info(`Senha alterada: ${req.user.username}`);
  res.json({ ok: true });
});

// ── PERFIL DO USUÁRIO LOGADO ───────────────────────────────────────────────

router.get('/me', auth, async (req, res) => {
  if (!req.user || req.user.id === 0) {
    return res.json({ username: 'admin', role: 'admin', full_name: 'Administrador' });
  }
  const { rows } = await query(
    'SELECT username, role, full_name, last_login FROM users WHERE id = $1',
    [req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(rows[0]);
});

module.exports = router;
module.exports.seedAdmin = seedAdmin;
module.exports.getSecret = getSecret;
