/**
 * iSafe CRM · Serviço de Configuração
 * ─────────────────────────────────────
 * Prioridade: banco de dados > variável de ambiente > valor padrão
 *
 * Isso permite que o usuário configure as integrações pelo dashboard
 * sem precisar editar arquivos no servidor.
 */

const { query } = require('../db');
const logger    = require('./logger');

// Cache em memória — recarrega a cada 60 segundos
let _cache   = new Map();
let _loadedAt = 0;
const TTL    = 60_000;

// ── METADADOS DAS CONFIGURAÇÕES ───────────────────────────────────────────
// Define o que existe, como exibir na tela, e em qual categoria

const SETTINGS_META = [
  // BLING
  { key: 'BLING_CLIENT_ID',     label: 'Client ID',     category: 'bling',     secret: false, hint: 'bling.com.br → Configurações → API → seu app' },
  { key: 'BLING_CLIENT_SECRET', label: 'Client Secret', category: 'bling',     secret: true  },
  { key: 'APP_URL',             label: 'URL do Sistema', category: 'bling',     secret: false, hint: 'Ex: https://crm.lojaisafe.com.br' },

  // WHATSAPP
  { key: 'EVOLUTION_API_URL',   label: 'URL da API',    category: 'whatsapp',  secret: false, hint: 'Ex: https://api.lojaisafe.com.br' },
  { key: 'EVOLUTION_API_KEY',   label: 'API Key',       category: 'whatsapp',  secret: true  },
  { key: 'EVOLUTION_INSTANCE',  label: 'Instance Name', category: 'whatsapp',  secret: false, hint: 'Nome da instância criada na Evolution API' },

  // EMAIL
  { key: 'SENDGRID_API_KEY',    label: 'API Key',       category: 'email',     secret: true  },
  { key: 'EMAIL_FROM',          label: 'E-mail remetente', category: 'email',  secret: false, hint: 'Ex: contato@lojaisafe.com.br' },
  { key: 'EMAIL_FROM_NAME',     label: 'Nome remetente', category: 'email',   secret: false, hint: 'Ex: iSafe Tecnologia' },

  // SCHEDULER
  { key: 'SCHEDULER_CRON',     label: 'Horário de envio (cron)', category: 'scheduler', secret: false, hint: '"0 9 * * *" = todo dia às 9h' },
  { key: 'SCHEDULER_TOLERANCE_DAYS', label: 'Tolerância (dias)', category: 'scheduler', secret: false, hint: 'Margem de dias para envio (padrão: 1)' },

  // SHOPIFY
  { key: 'SHOPIFY_STORE',         label: 'Nome da loja',    category: 'shopify', secret: false, hint: 'Ex: lojaisafe.myshopify.com' },
  { key: 'SHOPIFY_ACCESS_TOKEN',  label: 'Access Token',    category: 'shopify', secret: true  },
  { key: 'SHOPIFY_WEBHOOK_SECRET',label: 'Webhook Secret',  category: 'shopify', secret: true  },

  // BAGY
  { key: 'BAGY_API_KEY',   label: 'API Key', category: 'bagy', secret: true  },
  { key: 'BAGY_STORE_ID',  label: 'Store ID', category: 'bagy', secret: false },

  // IA (geração de mensagens)
  { key: 'GROQ_API_KEY',      label: 'Groq API Key (gratuita)',      category: 'ai', secret: true, hint: 'Obtenha grátis em console.groq.com · usa llama-3.3-70b' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key (pago)',     category: 'ai', secret: true, hint: 'Alternativa paga — deixe em branco se usar Groq' },

  // BLING OAUTH (gerenciado automaticamente — não exibido como campo editável)
  { key: 'BLING_ACCESS_TOKEN',  label: 'Access Token',  category: 'bling', secret: true,  internal: true },
  { key: 'BLING_REFRESH_TOKEN', label: 'Refresh Token', category: 'bling', secret: true,  internal: true },
];

// ── CARREGAR CACHE DO BANCO ────────────────────────────────────────────────

async function _refresh() {
  try {
    const { rows } = await query(`SELECT key, value FROM settings WHERE value IS NOT NULL AND value != ''`);
    _cache = new Map(rows.map(r => [r.key, r.value]));
    _loadedAt = Date.now();
  } catch (err) {
    // DB pode não estar pronto no primeiro segundo — não é erro crítico
    if (!_loadedAt) logger.debug(`Config: aguardando banco... (${err.message})`);
  }
}

async function _maybeRefresh() {
  if (Date.now() - _loadedAt > TTL) await _refresh();
}

// ── API PÚBLICA ────────────────────────────────────────────────────────────

/**
 * Lê um valor de configuração.
 * Prioridade: banco > env var > defaultValue
 */
async function get(key, defaultValue = null) {
  await _maybeRefresh();
  return _cache.get(key) ?? process.env[key] ?? defaultValue;
}

/**
 * Salva um valor de configuração no banco.
 */
async function set(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
  if (value) _cache.set(key, value);
  else _cache.delete(key);
  logger.info(`Configuração salva: ${key}`);
}

/**
 * Retorna todas as configurações para exibição na tela.
 * Valores de segredos são mascarados (••••••).
 */
async function getAll() {
  await _maybeRefresh();
  return SETTINGS_META.map(meta => {
    const dbValue  = _cache.get(meta.key);
    const envValue = process.env[meta.key];
    const hasValue = !!(dbValue || envValue);
    const source   = dbValue ? 'db' : (envValue ? 'env' : 'none');

    return {
      key:      meta.key,
      label:    meta.label,
      category: meta.category,
      secret:   meta.secret,
      hint:     meta.hint || null,
      source,
      // Nunca envia o valor real de segredos para o frontend
      value:    meta.secret
        ? (hasValue ? '••••••••••••••••' : '')
        : (dbValue ?? envValue ?? ''),
      configured: hasValue,
    };
  });
}

module.exports = { get, set, getAll, meta: SETTINGS_META };
