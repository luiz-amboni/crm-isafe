const { createLogger, format, transports } = require('winston');
const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';

// ── Formato legível para console (desenvolvimento) ────────────────────────
const consoleFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.printf(({ timestamp, level, message, stack }) => {
    const symbol = { error: '❌', warn: '⚠️ ', info: '✅', debug: '🔍' }[level] || '  ';
    return `${timestamp} ${symbol} [${level.toUpperCase().padEnd(5)}] ${stack || message}`;
  })
);

// ── Formato JSON estruturado para produção (DataDog, CloudWatch, Loki) ────
const jsonFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }),
  format.json()
);

const logger = createLogger({
  level: isProduction ? 'info' : 'debug',
  format: isProduction ? jsonFormat : consoleFormat,
  transports: [
    new transports.Console(),
    new transports.File({
      filename: path.join(__dirname, '../logs/error.log'),
      level:    'error',
      maxsize:  5_000_000,
      maxFiles: 3,
      format:   jsonFormat,      // logs de arquivo sempre em JSON
    }),
    new transports.File({
      filename: path.join(__dirname, '../logs/combined.log'),
      maxsize:  10_000_000,
      maxFiles: 5,
      format:   jsonFormat,
    }),
  ],
});

module.exports = logger;
