/**
 * ════════════════════════════════════════════════════
 * iSafe CRM · Email via SendGrid
 * Anti-spam: SPF + DKIM + DMARC + boas práticas
 * ════════════════════════════════════════════════════
 */

const sgMail = require('@sendgrid/mail');
const cfg    = require('./config');
const logger = require('./logger');

// ── ENVIAR E-MAIL ──────────────────────────────────────────────────────────

async function sendEmail({ to, name, subject, htmlContent, textContent, unsubscribeEmail }) {
  if (!to || !subject || !htmlContent) {
    throw new Error('Parâmetros obrigatórios: to, subject, htmlContent');
  }

  // Configura API Key dinamicamente (do banco ou env)
  const apiKey    = await cfg.get('SENDGRID_API_KEY');
  const fromEmail = await cfg.get('EMAIL_FROM',      'contato@lojaisafe.com.br');
  const fromName  = await cfg.get('EMAIL_FROM_NAME', 'iSafe');
  const appUrl    = await cfg.get('APP_URL', '');

  if (!apiKey) throw new Error('SendGrid não configurado. Configure em Configurações → E-mail.');
  sgMail.setApiKey(apiKey);

  // Verifica descadastro
  const { query } = require('../db');
  const unsub = await query(
    `SELECT 1 FROM email_unsubscribes WHERE email = $1`, [to]
  );
  if (unsub.rows.length > 0) {
    logger.info(`📧 E-mail para ${to} ignorado (descadastrado)`);
    return { success: false, reason: 'unsubscribed' };
  }

  const html = wrapEmailTemplate(htmlContent, name, to, appUrl);
  const text = textContent || htmlToText(htmlContent);

  const msg = {
    to:       { email: to, name: name || '' },
    from:     { email: fromEmail, name: fromName },
    subject,
    html,
    text,
    headers: {
      'X-Priority':       '3',
      'X-Mailer':         'iSafe CRM v1.1',
      'List-Unsubscribe': `<mailto:sair@lojaisafe.com.br?subject=sair>, <${appUrl}/email/unsubscribe?email=${encodeURIComponent(to)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    // ── TRACKING ─────────────────────────────────────────
    trackingSettings: {
      clickTracking:  { enable: true },
      openTracking:   { enable: true },
    },
    // ── CATEGORIAS (para relatórios SendGrid) ─────────────
    categories: ['isafe-crm', `pipeline-automatico`],
  };

  try {
    const [response] = await sgMail.send(msg);
    logger.info(`✅ E-mail enviado → ${to} | Status: ${response.statusCode}`);
    return {
      success:    true,
      statusCode: response.statusCode,
      headers:    response.headers,
    };
  } catch (err) {
    const errBody = err.response?.body?.errors?.[0]?.message || err.message;
    logger.error(`❌ Falha no envio de e-mail para ${to}: ${errBody}`);
    throw new Error(errBody);
  }
}

// ── TEMPLATE HTML WRAPPER (inclui header/footer padrão iSafe) ─────────────

function wrapEmailTemplate(content, name, email, appUrl = '') {
  const unsubUrl = `${appUrl}/email/unsubscribe?email=${encodeURIComponent(email)}`;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>iSafe Tecnologia</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">

  <!-- HEADER -->
  <tr>
    <td style="background:#0b1320;padding:24px 32px;text-align:left;">
      <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.5px;">
        i<span style="color:#00c9a7;">Safe</span>
      </span>
      <span style="color:#4a5a78;font-size:12px;margin-left:8px;">Tecnologia Premium</span>
    </td>
  </tr>

  <!-- CONTENT -->
  <tr>
    <td style="padding:32px 32px 24px;color:#1a2438;font-size:15px;line-height:1.7;">
      ${content}
    </td>
  </tr>

  <!-- CTA DIVIDER -->
  <tr>
    <td style="padding:0 32px 24px;">
      <hr style="border:none;border-top:1px solid #e8ecf4;margin:0 0 24px;">
      <p style="color:#4a5a78;font-size:13px;margin:0 0 8px;">
        Atenciosamente,<br>
        <strong style="color:#0b1320;">Equipe iSafe Tecnologia</strong><br>
        <a href="https://lojaisafe.com.br" style="color:#00c9a7;text-decoration:none;">lojaisafe.com.br</a>
        &nbsp;·&nbsp;Criciúma, SC
      </p>
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e8ecf4;text-align:center;">
      <p style="color:#8494b0;font-size:11px;margin:0 0 6px;">
        Você está recebendo este e-mail pois é cliente iSafe.
      </p>
      <p style="color:#8494b0;font-size:11px;margin:0;">
        <a href="${unsubUrl}" style="color:#8494b0;text-decoration:underline;">Cancelar recebimento</a>
        &nbsp;·&nbsp;
        <a href="https://lojaisafe.com.br/privacidade" style="color:#8494b0;text-decoration:underline;">Privacidade</a>
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── HELPERS ────────────────────────────────────────────────────────────────

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── REGISTRAR DESCADASTRO ──────────────────────────────────────────────────

async function unsubscribe(email, reason = null) {
  const { query } = require('../db');
  await query(
    `INSERT INTO email_unsubscribes (email, reason) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, reason]
  );
  logger.info(`📧 E-mail ${email} descadastrado`);
}

// ── VERIFICAR DNS ANTI-SPAM ────────────────────────────────────────────────

async function checkDNSStatus(domain) {
  const dns = require('dns').promises;
  const results = {};

  // SPF
  try {
    const records = await dns.resolveTxt(domain);
    results.spf = records.flat().some(r => r.startsWith('v=spf1'));
  } catch { results.spf = false; }

  // DKIM (chave padrão SendGrid)
  try {
    await dns.resolveCname(`em._domainkey.${domain}`);
    results.dkim = true;
  } catch { results.dkim = false; }

  // DMARC
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`);
    results.dmarc = records.flat().some(r => r.startsWith('v=DMARC1'));
  } catch { results.dmarc = false; }

  results.domain = domain;
  results.allOk  = results.spf && results.dkim && results.dmarc;
  return results;
}

module.exports = { sendEmail, unsubscribe, checkDNSStatus };
