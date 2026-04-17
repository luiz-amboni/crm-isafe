#!/usr/bin/env node
/**
 * Testa conexão WhatsApp e envia mensagem de teste
 * Uso: node scripts/test-whatsapp.js +5548999999999
 */
require('dotenv').config();
const wa = require('../services/whatsapp');

async function main() {
  console.log('📱 Testando conexão WhatsApp (Evolution API)...\n');

  const status = await wa.getInstanceStatus();
  console.log('Status da instância:');
  console.log(`  Conectado: ${status.connected ? '✅ Sim' : '❌ Não'}`);
  console.log(`  Estado:    ${status.state}`);
  if (status.number) console.log(`  Número:    ${status.number}`);

  if (!status.connected) {
    console.log('\n⚠️  WhatsApp não conectado!');
    console.log('   Acesse o painel Evolution API e escaneie o QR Code.');
    process.exit(1);
  }

  const testPhone = process.argv[2];
  if (!testPhone) {
    console.log('\n✅ Conexão OK. Para enviar mensagem de teste:');
    console.log('   node scripts/test-whatsapp.js +5548999999999');
    process.exit(0);
  }

  console.log(`\n📤 Enviando mensagem de teste para ${testPhone}...`);
  try {
    const result = await wa.sendText(testPhone, `✅ *iSafe CRM* — teste de conexão\n\nMensagem enviada com sucesso em ${new Date().toLocaleString('pt-BR')} 🚀`);
    console.log('✅ Mensagem enviada!', result.messageId);
  } catch (err) {
    console.error('❌ Falha:', err.message);
  }
}

main().catch(console.error);
