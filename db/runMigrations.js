/**
 * iSafe CRM · Migrations incrementais
 * Chamado na inicialização do servidor — idempotente.
 */

const { pool } = require('./index');
const logger   = require('../services/logger');

const MIGRATIONS = [
  {
    name: '001_users',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name     VARCHAR(100),
        role          VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
        is_active     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login    TIMESTAMPTZ
      );
    `,
  },
  {
    name: '003_message_log_triggered_by',
    sql: `
      ALTER TABLE message_log ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(50);
      COMMENT ON COLUMN message_log.triggered_by IS 'scheduler = automático, ou username de quem disparou manualmente';
    `,
  },
  {
    name: '002_activity_log',
    sql: `
      CREATE TABLE IF NOT EXISTS activity_log (
        id         BIGSERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        username   VARCHAR(50),
        action     VARCHAR(100) NOT NULL,
        details    JSONB,
        ip         VARCHAR(50),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_log_user    ON activity_log (user_id);
    `,
  },
];

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(100) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied  = new Set(rows.map(r => r.name));

  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    await pool.query(m.sql);
    await pool.query(
      'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
      [m.name]
    );
    logger.info(`Migration aplicada: ${m.name}`);
  }
}

module.exports = { runMigrations };
