const { query } = require('../db');
const logger    = require('./logger');

async function log(userId, username, action, details = null, ip = null) {
  try {
    await query(
      `INSERT INTO activity_log (user_id, username, action, details, ip)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId || null, username || null, action, details ? JSON.stringify(details) : null, ip || null]
    );
  } catch (err) {
    logger.warn(`Falha ao registrar activity_log [${action}]: ${err.message}`);
  }
}

module.exports = { log };
