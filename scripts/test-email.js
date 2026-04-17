#!/usr/bin/env node
/**
 * Testa envio de e-mail e verifica DNS anti-spam
 * Uso: node scripts/test-email.js email@teste.com
 */
require('dotenv').config();
const emailSvc = require('../services/email');
const { query, pool } = require('../db');

async function main() {
  console.log('📧 Verificando configuração de e-mail...\n');

  // Verifica DNS
  const domain = process.env.EMAIL_FROM?.split('@')[1] || 'lojaisafe.com.br';
  console.log(`Domínio: ${domain}`);
  const dns = await emailSvc.checkDNSStatus(domain);
  console.log(`  SPF:   ${dns.spf   ? '✅ OK' : '❌ Não configurado'}`);
  console.log(`  DKIM:  ${dns.dkim  ? '✅ OK' : '❌ Não configurado'}`);
  console.log(`  DMARC: ${dns.dmarc ? '✅ OK' : '❌ Não configurado'}`);

  if (!dns.allOk) {
    console.log('\n⚠️  Configure SPF/DKIM/DMARC para evitar spam!');
    console.log('   Acesse: app.sendgrid.com → Settings → Sender Authentication');
  }

  const testEmail = process.argv[2];
  if (!testEmail) {
    console.log('\nPara enviar e-mail de teste:');
    console.log('  node scripts/test-email.js seu@email.com');
    await pool.end();
    return;
  }

  console.log(`\n📤 Enviando e-mail de teste para ${testEmail}...`);
  try {
    const result = await emailSvc.sendEmail({
      to:          testEmail,
      name:        'Cliente Teste',
      subject:     '✅ iSafe CRM — Teste de e-mail',
      htmlContent: `
        <h2>Teste de envio iSafe CRM</h2>
        <p>Se você está lendo isto, o envio de e-mails está funcionando corretamente! 🎉</p>
        <p><strong>Data/hora:</strong> ${new Date().toLocaleString('pt-BR')}</p>
        <p><strong>De:</strong> ${process.env.EMAIL_FROM}</p>
        <hr>
        <p style="color:#666;font-size:13px;">Configuração SPF: ${dns.spf ? 'OK' : 'Pendente'} · DKIM: ${dns.dkim ? 'OK' : 'Pendente'} · DMARC: ${dns.dmarc ? 'OK' : 'Pendente'}</p>
      `,
    });
    console.log('✅ E-mail enviado com sucesso!', result.statusCode);
  } catch (err) {
    console.error('❌ Falha:', err.message);
    if (err.message.includes('API key')) {
      console.error('   Verifique SENDGRID_API_KEY no arquivo .env');
    }
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
