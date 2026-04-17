/**
 * iSafe CRM · Autenticação
 * POST /api/auth/login   → valida credenciais, retorna JWT
 * GET  /api/auth/verify  → verifica se o token ainda é válido
 * POST /api/auth/logout  → stateless, apenas confirmação
 */

const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const logger = require('../services/logger');
const cfg    = require('../services/config');
const auth   = require('../middleware/auth');

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

// ── LOGIN ──────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  const adminUser = process.env.ADMIN_USER || 'admin';
  // Prioridade: settings (BD) > .env — permite troca de senha pelo dashboard
  const adminPass = await cfg.get('ADMIN_PASSWORD');

  // Sem senha configurada → modo sem auth (dev / primeira execução)
  if (!adminPass) {
    const token = jwt.sign({ user: adminUser }, getSecret(), { expiresIn: TOKEN_EXPIRY });
    return res.json({ token, user: adminUser, warning: 'ADMIN_PASSWORD não configurado — acesso livre' });
  }

  if (!username || !password || username !== adminUser || password !== adminPass) {
    logger.warn(`Login falhou para: "${username}" (IP: ${req.ip})`);
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }

  const token = jwt.sign({ user: username }, getSecret(), { expiresIn: TOKEN_EXPIRY });
  logger.info(`Login: ${username}`);
  res.json({ token, user: username });
});

// ── VERIFY ─────────────────────────────────────────────────────

router.get('/verify', (req, res) => {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ valid: false });

  try {
    const decoded = jwt.verify(token, getSecret());
    res.json({ valid: true, user: decoded.user });
  } catch {
    res.status(401).json({ valid: false });
  }
});

// ── LOGOUT (stateless — o frontend descarta o token) ───────────

router.post('/logout', (_req, res) => {
  res.json({ ok: true });
});

// ── TROCA DE SENHA ─────────────────────────────────────────────
// Rota protegida (requer JWT válido)
router.post('/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Preencha a senha atual e a nova senha' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter no mínimo 6 caracteres' });
  }

  const adminPass = await cfg.get('ADMIN_PASSWORD');
  if (adminPass && current_password !== adminPass) {
    logger.warn(`Tentativa de troca de senha com senha atual incorreta (IP: ${req.ip})`);
    return res.status(401).json({ error: 'Senha atual incorreta' });
  }

  await cfg.set('ADMIN_PASSWORD', new_password);
  logger.info('Senha do admin alterada via dashboard');
  res.json({ ok: true });
});

// ── PERFIL DO USUÁRIO ──────────────────────────────────────────
// Retorna dados do usuário logado (nome, nível de acesso)
router.get('/me', auth, (req, res) => {
  const adminUser = process.env.ADMIN_USER || 'admin';
  res.json({
    username: adminUser,
    role:     'admin',
    since:    null,
  });
});

module.exports = router;
