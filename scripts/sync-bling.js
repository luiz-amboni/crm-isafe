#!/usr/bin/env node
/**
 * Script de sincronização manual com o Bling
 * Uso: npm run sync
 *   ou: node scripts/sync-bling.js [--days=365]
 */
require('dotenv').config();
const bling = require('../services/bling');
const { pool } = require('../db');

const days = parseInt(
  process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '365'
);

async function main() {
  console.log('🔄 Sincronizando com Bling...');
  console.log(`   Período: últimos ${days} dias`);
  console.log('');

  try {
    console.log('1/2 Sincronizando contatos...');
    const contacts = await bling.syncContacts();
    console.log(`    ✅ ${contacts} contatos processados`);

    console.log('2/2 Sincronizando pedidos...');
    const orders = await bling.syncOrders(days);
    console.log(`    ✅ ${orders} pedidos processados`);

    console.log('\n✅ Sincronização concluída!');
  } catch (err) {
    console.error('\n❌ Erro na sincronização:', err.message);
    if (err.message.includes('Token')) {
      console.error('   Configure BLING_ACCESS_TOKEN no arquivo .env');
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
