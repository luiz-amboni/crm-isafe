/**
 * iSafe CRM · Servidor Principal
 */

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const morgan      = require('morgan');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const path        = require('path');
const fs          = require('fs');
const { pool }    = require('./db');
const logger      = require('./services/logger');
const scheduler   = require('./services/scheduler');
const bling       = require('./services/bling');
const apiRoutes      = require('./routes/api');
const extraRoutes    = require('./routes/extras');
const campaignRoutes = require('./routes/campaigns');
const messageRoutes  = require('./routes/messages');
const webhookRoutes  = require('./routes/webhook');
const settingsRoutes = require('./routes/settings');
const authRoutes     = require('./routes/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── SEGURANÇA ──────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false })); // dashboard usa inline scripts

const allowedOrigins = ['http://localhost:3000', 'http://localhost:5173'];
if (process.env.APP_URL) allowedOrigins.push(process.env.APP_URL);

app.use(cors({ origin: allowedOrigins, credentials: true }));

// ── CORRELATION ID ────────────────────────────────────────────────────────
// Cada request recebe um ID único para rastreabilidade nos logs

app.use((req, _res, next) => {
  req.requestId = req.headers['x-request-id']
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  next();
});

// ── RATE LIMIT ─────────────────────────────────────────────────────────────

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      200,
  message:  { error: 'Muitas requisições. Aguarde alguns minutos.' },
  skip:     (req) => req.path === '/health',   // health check sem limite
}));

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
});

// ── PARSERS ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── LOGS DE REQUISIÇÃO (exclui health e webhook de teste do noise) ─────────

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('short', {
    stream: { write: (msg) => logger.info(msg.trim()) },
    skip:   (req) => req.path === '/health' || req.path === '/webhook/bling/test',
  }));
}

// ── FRONTEND ESTÁTICO ──────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ── ROTAS ──────────────────────────────────────────────────────────────────

app.use('/webhook', webhookLimiter, webhookRoutes);
app.use('/api/auth', authRoutes);   // login/verify — sem auth middleware
app.use('/api', settingsRoutes);    // antes do apiRoutes: OAuth Bling não usa JWT
app.use('/api', apiRoutes);
app.use('/api', extraRoutes);
app.use('/api', campaignRoutes);
app.use('/api', messageRoutes);

// Descadastro de email — rota direta para links nos e-mails
app.get('/email/unsubscribe', (req, res) => {
  res.redirect(`/api/email/unsubscribe?${new URLSearchParams(req.query)}`);
});

// ── HEALTH CHECK ───────────────────────────────────────────────────────────
// Verifica DB + indica estado do sistema para load balancers / monitoramento

app.get('/health', async (req, res) => {
  let dbOk = false;
  let dbLatencyMs = null;
  try {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    dbLatencyMs = Date.now() - t0;
    dbOk = true;
  } catch (_) {}

  const status = dbOk ? 'ok' : 'degraded';
  res.status(dbOk ? 200 : 503).json({
    status,
    database:   { ok: dbOk, latencyMs: dbLatencyMs },
    uptime:     Math.floor(process.uptime()),
    memory:     Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
    timestamp:  new Date().toISOString(),
    version:    process.env.npm_package_version || '1.0.0',
  });
});

// ── FALLBACK SPA ───────────────────────────────────────────────────────────

const indexPath = path.join(__dirname, 'public', 'index.html');
const hasIndex  = fs.existsSync(indexPath); // verificado UMA VEZ no startup

app.get('*', (req, res) => {
  if (hasIndex) {
    res.sendFile(indexPath);
  } else {
    res.json({ message: 'iSafe CRM API', version: '1.0.0', docs: '/api/status' });
  }
});

// ── ERROR HANDLER ──────────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  const reqId = req.requestId || '-';
  logger.error(`[${reqId}] Erro não tratado: ${err.message}\n${err.stack}`);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Erro interno do servidor'
      : err.message,
    requestId: reqId,
  });
});

// ── INICIALIZAÇÃO ──────────────────────────────────────────────────────────

async function start() {
  try {
    await pool.query('SELECT 1');
    logger.info('PostgreSQL conectado');
  } catch (err) {
    logger.error(`Falha na conexão com PostgreSQL: ${err.message}`);
    logger.error('Verifique DATABASE_URL no arquivo .env');
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info(`iSafe CRM rodando na porta ${PORT} · ${process.env.NODE_ENV || 'development'}`);
    logger.info(`Dashboard: http://localhost:${PORT}`);
    logger.info(`API:       http://localhost:${PORT}/api`);
    logger.info(`Health:    http://localhost:${PORT}/health`);
  });

  scheduler.start();
  logger.info('Scheduler de automações iniciado');

  if (process.env.APP_URL && process.env.BLING_CLIENT_ID) {
    bling.setupWebhook().catch((err) =>
      logger.warn(`Setup webhook Bling: ${err.message}`)
    );
  }

  // Sync inicial sequencial (respeita rate limit Bling ~3 req/s)
  if (process.env.BLING_ACCESS_TOKEN || process.env.BLING_CLIENT_ID) {
    setTimeout(async () => {
      logger.info('Iniciando sincronização inicial com Bling...');
      try {
        const c = await bling.syncContacts();
        logger.info(`Contatos: ${c} processados`);
        await new Promise(r => setTimeout(r, 2000));
        const o = await bling.syncOrders(90);
        logger.info(`Sync inicial concluído: ${c} contatos, ${o} pedidos`);
      } catch (err) {
        logger.warn(`Sync inicial falhou: ${err.message}`);
      }
    }, 5000);
  }
}

// ── GRACEFUL SHUTDOWN ──────────────────────────────────────────────────────

process.on('SIGTERM', async () => {
  logger.info('SIGTERM recebido — encerrando...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT recebido — encerrando...');
  await pool.end();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Promise Rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});

start();

module.exports = app;
