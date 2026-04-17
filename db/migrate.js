require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool } = require('./index');

async function migrate() {
  console.log('🗄️  Executando migração do banco de dados...');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅ Migração concluída com sucesso!');
    console.log('   Tabelas criadas: clients, orders, pipeline, automation_steps, message_log');
    console.log('   Etapas de automação inseridas: D+3, D+14, D+30, D+60, D+90, D+160, D+220, D+280, D+365');
  } catch (err) {
    console.error('❌ Erro na migração:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
