/**
 * iSafe CRM · Configurações via Dashboard
 * GET  /api/settings          → lista todas as configurações
 * POST /api/settings          → salva uma ou mais configurações
 * GET  /api/bling/oauth/start → inicia autorização OAuth do Bling
 * GET  /api/bling/oauth/callback → recebe o código e troca pelo token
 */

const router    = require('express').Router();
const axios     = require('axios');
const dayjs     = require('dayjs');
const auth      = require('../middleware/auth');
const cfg       = require('../services/config');
const scheduler = require('../services/scheduler');
const { query } = require('../db');
const logger    = require('../services/logger');

// ── LISTAR CONFIGURAÇÕES ───────────────────────────────────────────────────

router.get('/settings', auth, async (req, res) => {
  try {
    const settings = await cfg.getAll();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SALVAR CONFIGURAÇÕES ───────────────────────────────────────────────────
// Body: { "SENDGRID_API_KEY": "SG.xxx", "EMAIL_FROM": "..." }

router.post('/settings', auth, async (req, res) => {
  try {
    const allowed = new Set(cfg.meta.map(m => m.key));
    const saved   = [];

    for (const [key, value] of Object.entries(req.body)) {
      if (!allowed.has(key)) continue;
      // Ignora se o usuário mandou o valor mascarado de volta (não sobrescreve)
      if (typeof value === 'string' && value.startsWith('••')) continue;
      await cfg.set(key, value?.trim() || null);
      saved.push(key);
    }

    res.json({ ok: true, saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BLING OAUTH: INICIAR ───────────────────────────────────────────────────
// Redireciona o usuário para a página de autorização do Bling

router.get('/bling/oauth/start', async (req, res) => {
  const clientId = await cfg.get('BLING_CLIENT_ID');
  const appUrl   = await cfg.get('APP_URL');

  if (!clientId) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>⚠️ Client ID não configurado</h2>
        <p>Configure o <strong>Bling Client ID</strong> na aba Configurações antes de conectar.</p>
        <a href="/">← Voltar</a>
      </body></html>
    `);
  }

  const callbackUrl = `${appUrl}/api/bling/oauth/callback`;
  const state       = Math.random().toString(36).slice(2);
  const authorizeUrl = `https://www.bling.com.br/Api/v3/oauth/authorize`
    + `?response_type=code`
    + `&client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(callbackUrl)}`
    + `&state=${state}`;

  logger.info(`Iniciando OAuth Bling → ${callbackUrl}`);
  res.redirect(authorizeUrl);
});

// ── BLING OAUTH: CALLBACK ─────────────────────────────────────────────────
// Bling redireciona aqui com ?code=XXX após o usuário autorizar

router.get('/bling/oauth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    logger.warn(`OAuth Bling: autorização negada ou erro — ${error}`);
    return res.redirect('/?bling=error');
  }

  try {
    const clientId     = await cfg.get('BLING_CLIENT_ID');
    const clientSecret = await cfg.get('BLING_CLIENT_SECRET');
    const appUrl       = await cfg.get('APP_URL');
    const callbackUrl  = `${appUrl}/api/bling/oauth/callback`;

    // Troca o código pelo token
    const params = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: callbackUrl,
    });

    const { data } = await axios.post(
      'https://www.bling.com.br/Api/v3/oauth/token',
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
      }
    );

    const expiresAt = dayjs().add(data.expires_in, 'second').toISOString();

    // Salva no banco (apaga tokens antigos primeiro)
    await query(`DELETE FROM bling_tokens`);
    await query(
      `INSERT INTO bling_tokens (access_token, refresh_token, expires_at) VALUES ($1, $2, $3)`,
      [data.access_token, data.refresh_token, expiresAt]
    );

    // Salva também no config para o sistema usar
    await cfg.set('BLING_ACCESS_TOKEN',  data.access_token);
    await cfg.set('BLING_REFRESH_TOKEN', data.refresh_token);

    logger.info('✅ Bling OAuth concluído — token salvo com sucesso');
    res.redirect('/?bling=connected');

  } catch (err) {
    logger.error(`Erro no OAuth Bling: ${err.response?.data?.error_description || err.message}`);
    res.redirect('/?bling=error');
  }
});

// ── TESTE DE CONEXÃO WHATSAPP ──────────────────────────────────────────────

router.post('/settings/test/whatsapp', auth, async (req, res) => {
  try {
    const wa = require('../services/whatsapp');
    const status = await wa.getInstanceStatus();
    res.json({ ok: status.connected, ...status });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── TESTE DE CONEXÃO BLING ─────────────────────────────────────────────────

router.post('/settings/test/bling', auth, async (req, res) => {
  try {
    const bling = require('../services/bling');
    await bling.getAccessToken();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── SYNC MANUAL (via dashboard) ───────────────────────────────────────────

router.post('/settings/sync/shopify', auth, async (req, res) => {
  try {
    const shopify = require('../services/shopify');
    const days    = parseInt(req.body.days || '365');
    const result  = await shopify.syncOrders(days);
    res.json({ ok: true, synced: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settings/sync/bagy', auth, async (req, res) => {
  try {
    const bagy = require('../services/bagy');
    const days = parseInt(req.body.days || '365');
    const result = await bagy.syncOrders(days);
    res.json({ ok: true, synced: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scheduler/time — Atualiza horário do scheduler em tempo real
router.post('/scheduler/time', auth, async (req, res) => {
  try {
    const { hour, minute } = req.body;
    const h = parseInt(hour);
    const m = parseInt(minute ?? 0);
    if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59) {
      return res.status(400).json({ error: 'Horário inválido' });
    }
    const cronExpr = `${m} ${h} * * *`;
    await cfg.set('SCHEDULER_CRON', cronExpr);
    scheduler.updateSchedule(cronExpr);
    logger.info(`Scheduler reagendado para ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} por ${req.user?.username}`);
    res.json({ ok: true, cronExpr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
