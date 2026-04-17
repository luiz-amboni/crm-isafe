/**
 * iSafe CRM · Scheduler de Automações
 * ─────────────────────────────────────
 * Cron (padrão: 09h00 diário, fuso BRT).
 * Para cada pedido ativo no pipeline verifica se alguma etapa deve ser
 * enviada hoje e, se sim, dispara WhatsApp e/ou Email conforme configurado.
 */

const cron    = require('node-cron');
const dayjs   = require('dayjs');
const { query, transaction } = require('../db');
const wa      = require('./whatsapp');
const email   = require('./email');
const logger  = require('./logger');
const { renderWhatsApp, renderEmailHTML, renderEmailSubject, buildContext } = require('../templates/messages');

// ── INICIAR ───────────────────────────────────────────────────────────────

function start() {
  const cronExpr = process.env.SCHEDULER_CRON || '0 9 * * *';
  logger.info(`Scheduler iniciado · Cron: "${cronExpr}"`);

  cron.schedule(cronExpr, () => {
    runScheduler().catch((err) => {
      logger.error(`Erro crítico no scheduler: ${err.message}\n${err.stack}`);
    });
  }, { timezone: 'America/Sao_Paulo' });

  return { runNow: runScheduler };
}

// ── LÓGICA PRINCIPAL ──────────────────────────────────────────────────────

async function runScheduler() {
  logger.info('Iniciando ciclo do scheduler...');
  const startTime = Date.now();
  const tolerance = parseInt(process.env.SCHEDULER_TOLERANCE_DAYS || '1');
  const today     = dayjs().startOf('day');

  // 1. Busca etapas ativas
  const { rows: steps } = await query(
    `SELECT * FROM automation_steps WHERE is_active = true ORDER BY day_offset`
  );

  // 2. Busca pipelines ativos (corrigido: parênteses ao redor do OR)
  const { rows: pipelines } = await query(`
    SELECT
      p.id          AS pipeline_id,
      p.order_id,
      p.client_id,
      o.ordered_at,
      o.product_name,
      o.product_category,
      o.amount,
      o.order_number,
      o.bling_order_id,
      c.name        AS client_name,
      c.phone,
      c.email
    FROM pipeline p
    JOIN orders  o ON o.id = p.order_id
    JOIN clients c ON c.id = p.client_id
    WHERE p.status = 'active'
      AND (c.phone IS NOT NULL OR c.email IS NOT NULL)
    ORDER BY o.ordered_at
  `);

  if (pipelines.length === 0 || steps.length === 0) {
    logger.info('Nenhum pipeline ativo ou etapa configurada — nada a fazer.');
    return { sent: 0, skipped: 0, failed: 0 };
  }

  logger.info(`${pipelines.length} pipelines · ${steps.length} etapas`);

  // 3. PRÉ-BUSCA de todos os logs de envio em UMA só query (elimina N×M queries)
  const pipelineIds = pipelines.map(p => p.pipeline_id);
  const { rows: sentRows } = await query(
    `SELECT pipeline_id, step_id
     FROM message_log
     WHERE pipeline_id = ANY($1)
       AND status IN ('sent', 'skipped')`,
    [pipelineIds]
  );
  const sentSet = new Set(sentRows.map(r => `${r.pipeline_id}:${r.step_id}`));

  // 4. Processa
  let sent = 0, skipped = 0, failed = 0;

  for (const pipeline of pipelines) {
    const orderedAt = dayjs(pipeline.ordered_at).startOf('day');
    const daysSince = today.diff(orderedAt, 'day');

    for (const step of steps) {
      if (Math.abs(daysSince - step.day_offset) > tolerance) continue;
      if (sentSet.has(`${pipeline.pipeline_id}:${step.id}`)) continue;

      const context = buildContext({
        client: { name: pipeline.client_name },
        order: {
          product_name:     pipeline.product_name,
          product_category: pipeline.product_category,
          amount:           pipeline.amount,
          order_number:     pipeline.order_number,
          bling_order_id:   pipeline.bling_order_id,
        },
      });

      const result = await sendStep({ pipeline, step, context });
      if (result.success) sent++;
      else if (result.skipped) skipped++;
      else failed++;
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`Ciclo concluído em ${duration}s · Enviados: ${sent} · Pulados: ${skipped} · Falhas: ${failed}`);
  return { sent, skipped, failed };
}

// ── ENVIAR UMA ETAPA ──────────────────────────────────────────────────────

async function sendStep({ pipeline, step, context }) {
  let waResult    = null;
  let emailResult = null;
  const errors    = [];

  // WhatsApp
  if ((step.channel === 'whatsapp' || step.channel === 'both') && pipeline.phone) {
    const message = renderWhatsApp(step.wa_template, context);
    try {
      waResult = await wa.sendText(pipeline.phone, message);
    } catch (err) {
      errors.push(`WA: ${err.message}`);
      logger.error(`Falha WA [pipeline ${pipeline.pipeline_id}, D+${step.day_offset}]: ${err.message}`);
    }
  }

  // Email
  if ((step.channel === 'email' || step.channel === 'both') && pipeline.email) {
    const subject = renderEmailSubject(step.email_subject, context);
    const html    = renderEmailHTML(step.day_offset, context);
    if (html && subject) {
      try {
        emailResult = await email.sendEmail({
          to:          pipeline.email,
          name:        pipeline.client_name,
          subject,
          htmlContent: html,
        });
      } catch (err) {
        errors.push(`Email: ${err.message}`);
        logger.error(`Falha Email [pipeline ${pipeline.pipeline_id}, D+${step.day_offset}]: ${err.message}`);
      }
    }
  }

  // Determina status
  const noChannel = (!pipeline.phone && !pipeline.email) ||
    (step.channel === 'whatsapp' && !pipeline.phone) ||
    (step.channel === 'email'    && !pipeline.email);

  const allFailed = errors.length > 0 && !waResult && !emailResult;
  const finalStatus = noChannel ? 'skipped' : allFailed ? 'failed' : 'sent';

  // Persiste log
  await query(
    `INSERT INTO message_log
       (pipeline_id, client_id, order_id, step_id, day_offset, channel,
        status, scheduled_for, sent_at, wa_message, wa_response,
        email_subject, email_response, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      pipeline.pipeline_id, pipeline.client_id, pipeline.order_id,
      step.id, step.day_offset, step.channel,
      finalStatus,
      new Date().toISOString().split('T')[0],
      finalStatus === 'sent' ? new Date() : null,
      waResult ? renderWhatsApp(step.wa_template, context) : null,
      waResult  ? JSON.stringify(waResult)  : null,
      emailResult ? renderEmailSubject(step.email_subject, context) : null,
      emailResult ? JSON.stringify(emailResult) : null,
      errors.length > 0 ? errors.join(' | ') : null,
    ]
  );

  if (finalStatus === 'sent') {
    logger.info(`D+${step.day_offset} enviado → ${pipeline.client_name} [${step.channel}]`);
  } else if (finalStatus === 'skipped') {
    logger.debug(`D+${step.day_offset} pulado → ${pipeline.client_name} (sem canal)`);
  } else {
    logger.warn(`D+${step.day_offset} falhou → ${pipeline.client_name}: ${errors.join(' | ')}`);
  }

  return {
    success: finalStatus === 'sent',
    skipped: finalStatus === 'skipped',
    failed:  finalStatus === 'failed',
  };
}

// ── REENVIO MANUAL ────────────────────────────────────────────────────────

async function resendManual(pipelineId, dayOffset) {
  const { rows } = await query(`
    SELECT p.id AS pipeline_id, p.order_id, p.client_id,
           o.product_name, o.product_category, o.amount, o.order_number, o.bling_order_id,
           c.name AS client_name, c.phone, c.email
    FROM pipeline p
    JOIN orders o ON o.id = p.order_id
    JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1
  `, [pipelineId]);

  if (rows.length === 0) throw new Error('Pipeline não encontrado');

  const { rows: steps } = await query(
    `SELECT * FROM automation_steps WHERE day_offset = $1 AND is_active = true`,
    [dayOffset]
  );
  if (steps.length === 0) throw new Error(`Etapa D+${dayOffset} não encontrada ou inativa`);

  const pipeline = rows[0];
  const step     = steps[0];
  const context  = buildContext({
    client: { name: pipeline.client_name },
    order: {
      product_name:     pipeline.product_name,
      product_category: pipeline.product_category,
      amount:           pipeline.amount,
      order_number:     pipeline.order_number,
      bling_order_id:   pipeline.bling_order_id,
    },
  });

  return sendStep({ pipeline, step, context });
}

module.exports = { start, runScheduler, resendManual };
