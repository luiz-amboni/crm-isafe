/**
 * ════════════════════════════════════════════════════
 * iSafe CRM · Win-Back · Reativar Clientes Inativos
 * ════════════════════════════════════════════════════
 * Segmentos:
 *   Quente  — 90–180 dias sem compra
 *   Frio    — 180–365 dias sem compra
 *   Perdido — +365 dias sem compra
 * ════════════════════════════════════════════════════
 */

const { query }   = require('../db');
const wa          = require('./whatsapp');
const email       = require('./email');
const logger      = require('./logger');

const SEGMENTS = [
  {
    key:    'warm',
    label:  '90–180 dias sem compra',
    minDays: 90,
    maxDays: 180,
    wa_template: `Olá {{nome}}! 😊

Faz um tempinho que não conversamos e sentimos sua falta na iSafe!

Temos novidades incríveis e uma oferta especial pensada especialmente para você, que já conhece nossa qualidade.

Posso te mostrar o que chegou de novo? 🎯`,
    email_subject: 'Sentimos sua falta, {{nome}} ✨',
    discount_pct:  5,
  },
  {
    key:    'cold',
    label:  '180–365 dias sem compra',
    minDays: 180,
    maxDays: 365,
    wa_template: `Oi {{nome}}! 💙

São quase 6 meses sem nos falar — a iSafe sente sua falta!

Preparamos algo especial pra te reconquistar: uma oferta exclusiva no {{produto_sugestao}}, com condição que não anunciamos em lugar nenhum.

Posso te enviar os detalhes?`,
    email_subject: '{{nome}}, temos um presente especial pra você 🎁',
    discount_pct:  10,
  },
  {
    key:    'lost',
    label:  'Mais de 1 ano sem compra',
    minDays: 365,
    maxDays: 9999,
    wa_template: `Olá {{nome}}!

Faz mais de 1 ano que não conversamos. Gostaríamos muito de entender como podemos melhorar sua experiência conosco.

Tem 2 minutos para me contar o que aconteceu? Sua opinião é muito importante para a iSafe 🙏`,
    email_subject: 'Sua opinião importa muito para a iSafe, {{nome}}',
    discount_pct:  15,
  },
];

// ── BUSCAR CLIENTES POR SEGMENTO ──────────────────────────────

async function getSegmentClients(segment) {
  const { rows } = await query(`
    SELECT DISTINCT ON (c.id)
      c.id AS client_id,
      c.name,
      c.phone,
      c.email,
      o.product_name,
      o.product_category,
      MAX(o.ordered_at) AS last_order_at,
      DATE_PART('day', NOW() - MAX(o.ordered_at))::int AS days_inactive
    FROM clients c
    JOIN orders o ON o.client_id = c.id
    WHERE c.is_active = true
      AND (c.phone IS NOT NULL OR c.email IS NOT NULL)
    GROUP BY c.id, c.name, c.phone, c.email, o.product_name, o.product_category
    HAVING DATE_PART('day', NOW() - MAX(o.ordered_at)) BETWEEN $1 AND $2
    ORDER BY c.id, MAX(o.ordered_at) DESC
  `, [segment.minDays, segment.maxDays]);

  return rows;
}

// ── RESUMO DE TODOS OS SEGMENTOS ──────────────────────────────

async function getSummary() {
  const results = [];
  for (const seg of SEGMENTS) {
    const clients = await getSegmentClients(seg);
    results.push({
      ...seg,
      count:   clients.length,
      clients: clients.slice(0, 5), // preview dos 5 primeiros
    });
  }
  return results;
}

// ── ENVIAR CAMPANHA WIN-BACK ───────────────────────────────────

async function runCampaign(segmentKey, customTemplate = null) {
  const segment = SEGMENTS.find(s => s.key === segmentKey);
  if (!segment) throw new Error(`Segmento "${segmentKey}" não encontrado`);

  const clients = await getSegmentClients(segment);
  logger.info(`[Win-Back] Iniciando campanha "${segment.label}" · ${clients.length} clientes`);

  let sent = 0, failed = 0;

  for (const client of clients) {
    const context = buildContext(client);
    const template = customTemplate || segment.wa_template;
    const message  = resolveVars(template, context);

    try {
      if (client.phone) {
        await wa.sendText(client.phone, message);
        await logWinback(client.client_id, segmentKey, 'whatsapp', 'sent', message);
        sent++;
        logger.info(`[Win-Back] ✅ WA → ${client.name}`);
      } else if (client.email) {
        const subject = resolveVars(segment.email_subject, context);
        await email.sendEmail({
          to:   client.email,
          name: client.name,
          subject,
          htmlContent: `<p>${message.replace(/\n/g,'<br>')}</p>`,
        });
        await logWinback(client.client_id, segmentKey, 'email', 'sent', message);
        sent++;
      }
    } catch (err) {
      failed++;
      await logWinback(client.client_id, segmentKey, 'whatsapp', 'failed', message, err.message);
      logger.error(`[Win-Back] ❌ Falha → ${client.name}: ${err.message}`);
    }

    // Rate limit: 1 mensagem por segundo
    await sleep(1100);
  }

  logger.info(`[Win-Back] Campanha "${segment.label}" concluída · Enviados: ${sent} · Falhas: ${failed}`);
  return { sent, failed, total: clients.length };
}

// ── LOG ───────────────────────────────────────────────────────

async function logWinback(clientId, segment, channel, status, message, error = null) {
  await query(
    `INSERT INTO message_log
       (client_id, day_offset, channel, status, sent_at, wa_message, error_message)
     VALUES ($1, -1, $2, $3, $4, $5, $6)`,
    [clientId, channel, status, status === 'sent' ? new Date() : null, message, error]
  );
}

// ── HELPERS ───────────────────────────────────────────────────

const SUGESTOES = {
  iPhone:      'iPhone 16 Pro',
  MacBook:     'MacBook Air M3',
  iPad:        'iPad Pro M4',
  AirPods:     'AirPods Pro 2ª Geração',
  'Apple Watch':'Apple Watch Series 10',
  outros:      'nossas novidades Apple',
};

function buildContext(client) {
  return {
    nome:              client.name,
    produto:           client.product_name || 'seu produto',
    categoria:         client.product_category || 'outros',
    produto_sugestao:  SUGESTOES[client.product_category] || SUGESTOES['outros'],
  };
}

function resolveVars(template, ctx) {
  return Object.entries(ctx).reduce(
    (t, [k, v]) => t.split(`{{${k}}}`).join(v || ''),
    template
  );
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { getSummary, getSegmentClients, runCampaign, SEGMENTS };
