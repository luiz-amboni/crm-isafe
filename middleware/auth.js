/**
 * iSafe CRM · Middleware de Autenticação
 *
 * Aceita dois métodos:
 *  1. Bearer JWT  → gerado pelo POST /api/auth/login (dashboard web)
 *  2. x-api-key   → para scripts e integrações externas
 *
 * Se ADMIN_PASSWORD não estiver configurado, passa tudo sem bloqueio
 * (útil na primeira execução / desenvolvimento local).
 */

const jwt    = require('jsonwebtoken');
const logger = require('../services/logger');

const PLACEHOLDER = 'chave_para_autenticar_frontend_com_backend';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    logger.error('FALHA CRÍTICA: JWT_SECRET não configurado no ambiente de produção.');
    throw new Error('JWT_SECRET é obrigatório em produção para garantir a segurança dos dados.');
  }
  return secret || 'isafe-crm-dev-secret-inseguro';
}

function authMiddleware(req, res, next) {
  const adminPass = process.env.ADMIN_PASSWORD;
  const apiKey    = process.env.API_KEY;

  // Sem credenciais configuradas → modo livre (dev / primeira execução)
  if (!adminPass && (!apiKey || apiKey === PLACEHOLDER)) {
    return next();
  }

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
    return next();
  }

  logger.warn(`Acesso não autorizado: ${req.method} ${req.path} (IP: ${req.ip})`);
  res.status(401).json({ error: 'Não autorizado' });
}

module.exports = authMiddleware;
