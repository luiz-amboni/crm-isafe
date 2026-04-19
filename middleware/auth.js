/**
 * iSafe CRM · Middleware de Autenticação
 *
 * Aceita dois métodos:
 *  1. Bearer JWT  → gerado pelo POST /api/auth/login
 *  2. x-api-key   → para scripts e integrações externas
 *
 * JWT payload: { id, username, role }
 */

const jwt    = require('jsonwebtoken');
const logger = require('../services/logger');
const { query } = require('../db');

const PLACEHOLDER = 'chave_para_autenticar_frontend_com_backend';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    logger.error('FALHA CRÍTICA: JWT_SECRET não configurado no ambiente de produção.');
    throw new Error('JWT_SECRET é obrigatório em produção.');
  }
  return secret || 'isafe-crm-dev-secret-inseguro';
}

async function authMiddleware(req, res, next) {
  const apiKey = process.env.API_KEY;

  // 1. Bearer JWT (dashboard)
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      req.user = jwt.verify(token, getSecret());
      return next();
    } catch {
      return res.status(401).json({ error: 'Token inválido ou expirado. Faça login novamente.' });
    }
  }

  // 2. x-api-key (scripts / integrações externas)
  if (apiKey && apiKey !== PLACEHOLDER && req.headers['x-api-key'] === apiKey) {
    req.user = { id: 0, username: 'api-key', role: 'admin' };
    return next();
  }

  // 3. Modo livre: sem usuários cadastrados e sem API_KEY configurado
  try {
    const { rows } = await query('SELECT id FROM users WHERE is_active = true LIMIT 1');
    if (rows.length === 0 && (!apiKey || apiKey === PLACEHOLDER)) {
      req.user = { id: 0, username: 'admin', role: 'admin' };
      return next();
    }
  } catch {
    // tabela users não existe ainda (primeira execução) → modo livre
    req.user = { id: 0, username: 'admin', role: 'admin' };
    return next();
  }

  logger.warn(`Acesso não autorizado: ${req.method} ${req.path} (IP: ${req.ip})`);
  res.status(401).json({ error: 'Não autorizado' });
}

// Middleware que exige role=admin
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

module.exports = authMiddleware;
module.exports.requireAdmin = requireAdmin;
