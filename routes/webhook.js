/**
 * iSafe CRM · Webhooks: Bling + Shopify + Bagy
 */

const router  = require('express').Router();
const crypto  = require('crypto');
const bling   = require('../services/bling');
const shopify = require('../services/shopify');
const bagy    = require('../services/bagy');
const logger  = require('../services/logger');

// ── VALIDAR ASSINATURA HMAC ────────────────────────────────────────────────

function validateBlingSignature(req) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    // Em produção, a ausência de WEBHOOK_SECRET é um aviso de segurança
    if (process.env.NODE_ENV === 'production') {
      logger.warn('WEBHOOK_SECRET não configurado — configure no .env para maior segurança');
    }
    return true;
  }

  const header  = req.headers['x-bling-signature'] || req.headers['x-signature'] || '';
  const payload = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  // Garante que ambos os buffers tenham o mesmo tamanho antes do timingSafeEqual
  const sigBuf = Buffer.from(header.replace('sha256=', ''), 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

function validateShopifySignature(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true;

  const hmac     = req.headers['x-shopify-hmac-sha256'] || '';
  const expected = crypto.createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('base64');
  return hmac === expected;
}

// ── BLING ─────────────────────────────────────────────────────────────────

router.post('/bling', async (req, res) => {
  // Responde 200 imediatamente — Bling exige resposta rápida
  res.status(200).json({ received: true });

  if (!validateBlingSignature(req)) {
    logger.warn('Webhook Bling recebido com assinatura inválida — ignorando');
    return;
  }

  const payload  = req.body;
  const event    = payload.event || payload.tipo || '';
  const orderData = payload.data || payload.retorno?.pedidos?.[0] || {};

  logger.debug(`Webhook Bling: evento "${event}"`);

  const isOrderEvent = ['pedido_incluido', 'pedido_atualizado', 'order.created', 'order.updated']
    .some(e => event.includes(e.split('.')[0]));

  if (!isOrderEvent) return;

  if (!orderData.id && !orderData.numero) {
    logger.warn('Webhook Bling: payload sem dados do pedido');
    return;
  }

  try {
    const orderId = await bling.processOrder(orderData);
    if (orderId) {
      logger.info(`Pedido #${orderData.numero || orderData.id} adicionado ao pipeline via webhook`);
    }
  } catch (err) {
    logger.error(`Erro ao processar webhook Bling: ${err.message}`);
  }
});

// ── WEBHOOK TESTE ─────────────────────────────────────────────────────────

router.get('/bling/test', (req, res) => {
  res.json({
    status:    'ok',
    message:   'Endpoint webhook Bling funcionando',
    url:       `${process.env.APP_URL}/webhook/bling`,
    timestamp: new Date().toISOString(),
  });
});

// ── SHOPIFY ───────────────────────────────────────────────────────────────

router.post('/shopify', async (req, res) => {
  if (!validateShopifySignature(req)) {
    logger.warn('Webhook Shopify: assinatura inválida');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  await shopify.handleWebhook(req, res);
});

// ── BAGY ──────────────────────────────────────────────────────────────────

router.post('/bagy', async (req, res) => {
  await bagy.handleWebhook(req, res);
});

module.exports = router;
