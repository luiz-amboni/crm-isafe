#!/usr/bin/env node
require('dotenv').config();
const bagy = require('../services/bagy');
const { pool } = require('../db');
const days = parseInt(process.argv.find(a=>a.startsWith('--days='))?.split('=')[1]||'365');
async function main() {
  console.log(`🏪  Sincronizando Bagy (${days} dias)...`);
  try {
    const orders = await bagy.syncOrders(days);
    console.log(`✅ ${orders} pedidos sincronizados`);
  } catch(e){ console.error('❌', e.message); process.exit(1); }
  finally { await pool.end(); }
}
main();
