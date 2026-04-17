/**
 * iSafe CRM · Geração de Mensagens com IA (Claude)
 * Usa o Anthropic API via HTTP (axios) — sem SDK extra.
 * Fallback automático para template resolvido se não houver chave.
 */

const axios  = require('axios');
const cfg    = require('./config');
const logger = require('./logger');
const { renderWhatsApp, buildContext } = require('../templates/messages');

async function generateMessage({ clientName, productName, productCategory, dayOffset, stepLabel, focus, waTemplate }) {
  let apiKey;
  try { apiKey = await cfg.get('ANTHROPIC_API_KEY'); } catch(e) {}

  const firstName = (clientName || 'Cliente').split(' ')[0];

  // Sem chave → resolve template com variáveis (fallback elegante)
  if (!apiKey) {
    if (!waTemplate) return null;
    const ctx = buildContext({
      client: { name: clientName },
      order:  { product_name: productName, product_category: productCategory, amount: null, order_number: null }
    });
    return renderWhatsApp(waTemplate, ctx);
  }

  const prompt = `Você é o assistente de relacionamento pós-venda da iSafe, revendedora Apple Premium em Criciúma, SC. Seu tom é amigável, próximo e profissional — como um amigo que entende muito de tecnologia.

Gere uma mensagem de WhatsApp para a etapa de automação "${stepLabel}" (D+${dayOffset}).
Foco desta etapa: ${focus || stepLabel}

Dados do cliente:
- Nome (use só o primeiro): ${firstName}
- Produto comprado: ${productName}
- Categoria: ${productCategory || 'produto Apple'}

Template base (adapte e personalize, não copie literalmente):
"""
${waTemplate || ''}
"""

Regras obrigatórias:
- Use apenas "${firstName}" — nunca nome completo
- Personalize a mensagem ESPECIFICAMENTE para "${productName}"
- Use *negrito* do WhatsApp para destacar o produto
- Máximo 3 parágrafos curtos e diretos
- Termine com algo que convide o cliente a responder
- Responda SOMENTE com a mensagem final, sem explicações ou prefácio`;

  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages:   [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        timeout: 20000,
      }
    );
    return resp.data.content[0].text;
  } catch (err) {
    logger.warn(`AI generate: ${err.response?.data?.error?.message || err.message}`);
    // Fallback para template resolvido
    if (waTemplate) {
      const ctx = buildContext({
        client: { name: clientName },
        order:  { product_name: productName, product_category: productCategory, amount: null, order_number: null }
      });
      return renderWhatsApp(waTemplate, ctx);
    }
    return null;
  }
}

module.exports = { generateMessage };
