/**
 * iSafe CRM · WhatsApp via Evolution API
 * ─────────────────────────────────────────
 * As credenciais são lidas do banco (configuráveis pelo dashboard).
 * Fallback para variáveis de ambiente.
 */

const axios  = require('axios');
const cfg    = require('./config');
const logger = require('./logger');

// Cria o cliente HTTP com as credenciais atuais (lidas a cada chamada)
async function _client() {
  const baseURL  = await cfg.get('EVOLUTION_API_URL');
  const apiKey   = await cfg.get('EVOLUTION_API_KEY');
  const instance = await cfg.get('EVOLUTION_INSTANCE');

  if (!baseURL || !apiKey || !instance) {
    throw new Error('WhatsApp não configurado. Configure em Configurações → WhatsApp.');
  }

  return {
    instance,
    http: axios.create({
      baseURL,
      headers: { apikey: apiKey, 'Content-Type': 'application/json' },
      timeout: 20000,
    }),
  };
}

// ── ENVIAR MENSAGEM ────────────────────────────────────────────────────────

async function sendText(phone, message) {
  const number = normalizePhone(phone);
  if (!number) throw new Error(`Telefone inválido: ${phone}`);

  const { http, instance } = await _client();
  logger.info(`Enviando WhatsApp para ${number.slice(0, 6)}...`);

  try {
    const { data } = await http.post(`/message/sendText/${instance}`, {
      number,
      options: { delay: 1500, presence: 'composing' },
      textMessage: { text: message },
    });
    logger.info(`WhatsApp enviado → ${number.slice(0, 6)}... | msgId: ${data.key?.id}`);
    return { success: true, messageId: data.key?.id, response: data };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    logger.error(`Falha WhatsApp [${number}]: ${errMsg}`);
    throw new Error(errMsg);
  }
}

// ── VERIFICAR SE NÚMERO TEM WHATSAPP ──────────────────────────────────────

async function checkNumber(phone) {
  const number = normalizePhone(phone);
  if (!number) return false;
  try {
    const { http, instance } = await _client();
    const { data } = await http.post(`/chat/whatsappNumbers/${instance}`, { numbers: [number] });
    return data?.[0]?.exists === true;
  } catch {
    return true; // assume que tem WA e tenta enviar
  }
}

// ── STATUS DA INSTÂNCIA ────────────────────────────────────────────────────

async function getInstanceStatus() {
  try {
    const { http, instance } = await _client();
    const { data } = await http.get(`/instance/connectionState/${instance}`);
    return {
      connected: data?.instance?.state === 'open',
      state:     data?.instance?.state,
      number:    data?.instance?.wuid?.split('@')[0],
    };
  } catch (err) {
    logger.error(`Erro ao verificar instância Evolution: ${err.message}`);
    return { connected: false, state: 'error' };
  }
}

// ── QR CODE (primeiro setup) ───────────────────────────────────────────────

async function getQRCode() {
  try {
    const { http, instance } = await _client();
    const { data } = await http.get(`/instance/connect/${instance}`);
    return data?.qrcode?.base64 || null;
  } catch (err) {
    logger.error(`Erro ao obter QR Code: ${err.message}`);
    return null;
  }
}

// ── NORMALIZAR TELEFONE ────────────────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 13) return digits;
  if (digits.length === 12) return digits;
  if (digits.length === 11) return `55${digits}`;
  if (digits.length === 10) return `55${digits}`;
  if (digits.length === 9 || digits.length === 8) return `5548${digits}`;
  return null;
}

module.exports = { sendText, checkNumber, getInstanceStatus, getQRCode, normalizePhone };
