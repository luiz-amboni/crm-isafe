const { Pool } = require('pg');
const logger   = require('../services/logger');

// Pool configurável via ambiente — adequado para qualquer escala
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:                    parseInt(process.env.DB_POOL_MAX  || '10'),
  idleTimeoutMillis:      parseInt(process.env.DB_IDLE_MS  || '30000'),
  connectionTimeoutMillis: parseInt(process.env.DB_CONN_MS || '5000'),
  // SSL em produção: usa certificado real se disponível, sem desabilitar a verificação
  ssl: process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT !== 'false' }
    : false,
});

pool.on('error', (err) => {
  logger.error(`PostgreSQL pool error: ${err.message}`);
});

// ── QUERY ─────────────────────────────────────────────────────────────────

async function query(sql, params = []) {
  const start = Date.now();
  try {
    const result   = await pool.query(sql, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn(`Query lenta (${duration}ms): ${sql.substring(0, 100)}`);
    }
    return result;
  } catch (err) {
    logger.error(`Erro na query: ${err.message} | SQL: ${sql.substring(0, 200)}`);
    throw err;
  }
}

// ── TRANSACTION com retry automático em deadlock ───────────────────────────

async function transaction(fn, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      // Deadlock ou serialization failure → tenta novamente
      const isRetryable = err.code === '40P01' || err.code === '40001';
      if (isRetryable && ++attempt < maxRetries) {
        logger.warn(`Transação sofreu ${err.code} — tentativa ${attempt}/${maxRetries}`);
        await new Promise(r => setTimeout(r, attempt * 100));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { pool, query, transaction };
