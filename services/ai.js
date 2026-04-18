/**
 * iSafe CRM · Geração de Mensagens com IA
 * Provedores em ordem de prioridade:
 *   1. Groq  (GROQ_API_KEY)  — gratuito, rápido, llama-3.3-70b
 *   2. Anthropic (ANTHROPIC_API_KEY) — pago, Claude Haiku
 *   3. Regra — retorna template existente com placeholders
 */

const axios  = require('axios');
const cfg    = require('./config');
const logger = require('./logger');
const { renderWhatsApp, buildContext } = require('../templates/messages');

// ── Chamada à Groq API (OpenAI-compatible) ─────────────────────────────────

async function _groq(apiKey, messages, maxTokens = 400) {
  const resp = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', max_tokens: maxTokens, messages },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  return resp.data.choices[0].message.content;
}

// ── Chamada à Anthropic API ────────────────────────────────────────────────

async function _anthropic(apiKey, prompt, maxTokens = 400) {
  const resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
    {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 20000,
    }
  );
  return resp.data.content[0].text;
}

// ── Geração para cliente específico (scheduler / step detail) ──────────────

async function generateMessage({ clientName, productName, productCategory, dayOffset, stepLabel, focus, waTemplate }) {
  const firstName = (clientName || 'Cliente').split(' ')[0];

  const prompt = `Você é o assistente de relacionamento pós-venda da iSafe, revendedora Apple Premium em Criciúma, SC. Tom: amigável, próximo, profissional.

Etapa: "${stepLabel}" (D+${dayOffset}) · Foco: ${focus || stepLabel}
Cliente: ${firstName} · Produto: ${productName} · Categoria: ${productCategory || 'Apple'}

${waTemplate ? `Template base (adapte, não copie):\n"""\n${waTemplate}\n"""` : ''}

Regras: use "${firstName}" (nunca nome completo) · personalize para "${productName}" · use *negrito* WA · máx 3 parágrafos · convide o cliente a responder · responda SOMENTE a mensagem final.`;

  let groqKey, anthropicKey;
  try { groqKey      = await cfg.get('GROQ_API_KEY'); } catch(e) {}
  try { anthropicKey = await cfg.get('ANTHROPIC_API_KEY'); } catch(e) {}

  if (groqKey) {
    try {
      return await _groq(groqKey, [{ role: 'user', content: prompt }]);
    } catch(err) {
      logger.warn(`Groq generateMessage: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  if (anthropicKey) {
    try {
      return await _anthropic(anthropicKey, prompt);
    } catch(err) {
      logger.warn(`Anthropic generateMessage: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  // Fallback: resolve template existente com variáveis reais
  if (waTemplate) {
    const ctx = buildContext({
      client: { name: clientName },
      order:  { product_name: productName, product_category: productCategory, amount: null, order_number: null }
    });
    return renderWhatsApp(waTemplate, ctx);
  }
  return null;
}

// ── Geração de TEMPLATE (sem cliente específico, com placeholders) ─────────

async function generateTemplate({ dayOffset, stepLabel, focus, waTemplate }) {
  const prompt = `Você é especialista em copywriting para e-commerce de tecnologia Apple premium (iSafe, Criciúma, SC).

Crie um TEMPLATE de mensagem WhatsApp para a etapa D+${dayOffset} da jornada pós-compra.
Etapa: ${stepLabel}${focus ? `\nFoco: ${focus}` : ''}

${waTemplate ? `Template atual (melhore ou reescreva):\n"""\n${waTemplate}\n"""` : ''}

REGRAS OBRIGATÓRIAS:
- Use EXATAMENTE {{nome}} para o primeiro nome do cliente (variável)
- Use EXATAMENTE {{produto}} para o produto comprado (variável)
- Tom: amigável, pessoal, genuíno — não robótico
- Máximo 5 linhas
- Máximo 2 emojis
- Se o foco for "Dica", gere uma dica específica para o tipo de produto (ex: iPhone, Mac, iPad, AirPods)
- Termine com CTA suave ou pergunta
- Responda SOMENTE o template, sem explicações`;

  let groqKey, anthropicKey;
  try { groqKey      = await cfg.get('GROQ_API_KEY'); } catch(e) {}
  try { anthropicKey = await cfg.get('ANTHROPIC_API_KEY'); } catch(e) {}

  if (groqKey) {
    try {
      return await _groq(groqKey, [{ role: 'user', content: prompt }]);
    } catch(err) {
      logger.warn(`Groq generateTemplate: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  if (anthropicKey) {
    try {
      return await _anthropic(anthropicKey, prompt);
    } catch(err) {
      logger.warn(`Anthropic generateTemplate: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  // Sem API key: retorna template existente ou null
  return waTemplate || null;
}

module.exports = { generateMessage, generateTemplate };
