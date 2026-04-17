#!/usr/bin/env node
require('dotenv').config();
const shopify = require('../services/shopify');
const { pool } = require('../db');
const days = parseInt(process.argv.find(a=>a.startsWith('--days='))?.split('=')[1]||'365');
async function main() {
  console.log(`🛍️  Sincronizando Shopify (${days} dias)...`);
  try {
    const [orders, customers] = await Promise.all([shopify.syncOrders(days), shopify.syncCustomers(days)]);
    console.log(`✅ ${orders} pedidos · ${customers} clientes`);
  } catch(e){ console.error('❌', e.message); process.exit(1); }
  finally { await pool.end(); }
}
main();
