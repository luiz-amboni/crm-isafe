/**
 * ════════════════════════════════════════════════════
 * iSafe CRM · Engine de Templates de Mensagem
 * Substitui variáveis e formata mensagens WA e Email
 * ════════════════════════════════════════════════════
 * Variáveis disponíveis:
 *  {{nome}}           — nome do cliente
 *  {{produto}}        — produto principal do pedido
 *  {{categoria}}      — categoria (iPhone, MacBook, etc.)
 *  {{produto_upgrade}}— próximo produto sugerido
 *  {{dica_produto}}   — dica específica por categoria
 *  {{valor}}          — valor do pedido
 *  {{numero_pedido}}  — número do pedido Bling
 * ════════════════════════════════════════════════════
 */

// ── DICAS POR CATEGORIA ────────────────────────────────────────────────────

const DICAS = {
  'iPhone': [
    'usar o Focus Mode para desligar notificações de trabalho no final do dia',
    'agendar envio de mensagens tocando e segurando o botão de enviar',
    'usar o StandBy (carregamento horizontal) como relógio e hub de informações',
    'ativar o Assistive Touch para gestos personalizados sem usar o botão físico',
  ],
  'MacBook': [
    'usar o Stage Manager para organizar janelas por projeto de forma visual',
    'criar Hot Corners para acionar rapidamente o Exposé, Siri ou proteção de tela',
    'usar Spotlight (⌘+Espaço) para abrir apps, fazer cálculos e pesquisar tudo',
    'conectar dois monitores externos via USB-C com a docking station certa',
  ],
  'iPad': [
    'usar o Split View para trabalhar em dois apps ao mesmo tempo na tela',
    'conectar o Apple Pencil para assinar documentos PDF sem imprimir nada',
    'usar Stage Manager no iPad Pro para ter até 6 apps abertos simultaneamente',
    'configurar o iPad como segunda tela do Mac com o Sidecar',
  ],
  'AirPods': [
    'personalizar o gesto de apertar o cabo para controlar a música sem tirar do bolso',
    'usar o Adaptive Audio para misturar cancelamento de ruído e Transparência automaticamente',
    'configurar o Spatial Audio para uma experiência de cinema no seu iPhone',
    'usar a detecção automática de ouvido para pausar a música ao remover',
  ],
  'Apple Watch': [
    'criar complicações personalizadas no mostrador para ver suas métricas favoritas',
    'usar os atalhos de Saúde para registrar sintomas e dados diretamente no pulso',
    'configurar o assistente de queda para alertar contatos de emergência automaticamente',
    'usar o Mindfulness app para sessões rápidas de respiração entre reuniões',
  ],
};

function getDica(category) {
  const list = DICAS[category] || ['aproveitar ao máximo todos os recursos disponíveis'];
  return list[Math.floor(Math.random() * list.length)];
}

// ── DETECTAR UPGRADE SUGERIDO ──────────────────────────────────────────────

const UPGRADES = {
  'iPhone':      'iPhone 16 Pro',
  'MacBook':     'MacBook Pro com chip M4',
  'iPad':        'iPad Pro M4',
  'AirPods':     'AirPods Pro com chip H2',
  'Apple Watch': 'Apple Watch Ultra 2',
  'outros':      'um produto da nova linha Apple 2025',
};

function getUpgrade(category) {
  return UPGRADES[category] || UPGRADES['outros'];
}

// ── RESOLVER VARIÁVEIS ─────────────────────────────────────────────────────

function resolveVars(template, context) {
  if (!template) return '';
  const firstName = (context.nome || 'Cliente').split(' ')[0];
  const vars = {
    '{{nome}}':          firstName,
    '{{nome_completo}}': context.nome        || 'Cliente',
    '{{produto}}':       context.produto     || 'seu produto',
    '{{categoria}}':     context.categoria   || 'produto',
    '{{produto_upgrade}}': context.produto_upgrade || getUpgrade(context.categoria),
    '{{dica_produto}}':  context.dica        || getDica(context.categoria),
    '{{valor}}':         context.valor       ? `R$ ${parseFloat(context.valor).toFixed(2).replace('.', ',')}` : '',
    '{{numero_pedido}}': context.numero_pedido || '',
  };

  return Object.entries(vars).reduce(
    (msg, [key, val]) => msg.split(key).join(val),
    template
  );
}

// ── TEMPLATES DE EMAIL HTML (para etapas que usam email) ──────────────────

const EMAIL_TEMPLATES = {
  14: (ctx) => `
    <h2 style="font-size:22px;font-weight:700;color:#0b1320;margin:0 0 16px;">
      Olá, ${ctx.firstName}! Está curtindo o ${ctx.produto}? 🔥
    </h2>
    <p>Já fazem 2 semanas desde que seu <strong>${ctx.produto}</strong> chegou. Esperamos que esteja aproveitando ao máximo!</p>
    <p>Separamos uma curadoria especial de acessórios que os nossos clientes mais amam para completar a experiência:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <tr>
        <td style="background:#f4f9ff;border-radius:8px;padding:16px;margin-bottom:10px;">
          <strong style="color:#0b1320;">🎧 AirPods Pro 2ª Geração</strong><br>
          <span style="color:#4a5a78;font-size:13px;">Cancelamento de ruído ativo · Chip H2</span>
        </td>
      </tr>
      <tr><td style="height:8px;"></td></tr>
      <tr>
        <td style="background:#f4f9ff;border-radius:8px;padding:16px;">
          <strong style="color:#0b1320;">🔋 Carregador MagSafe 15W</strong><br>
          <span style="color:#4a5a78;font-size:13px;">Carregamento magnético sem fio</span>
        </td>
      </tr>
    </table>
    <p>Temos condição especial para clientes iSafe. Quer ver as opções completas?</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td style="background:#00c9a7;border-radius:8px;padding:0;">
          <a href="https://lojaisafe.com.br/acessorios" style="display:block;padding:14px 28px;color:#0b1320;font-weight:700;font-size:15px;text-decoration:none;">
            Ver acessórios exclusivos →
          </a>
        </td>
      </tr>
    </table>
    <p style="color:#4a5a78;font-size:13px;">Ou responda este e-mail e conversamos por WhatsApp 💬</p>`,

  60: (ctx) => `
    <h2 style="font-size:22px;font-weight:700;color:#0b1320;margin:0 0 16px;">
      Sentimos sua falta, ${ctx.firstName}! ✨
    </h2>
    <p>Faz um tempo que não conversamos. Tudo bem por aí?</p>
    <p>Estamos com novidades incríveis na iSafe — produtos novos chegaram e temos uma <strong>oferta exclusiva para clientes que já compraram conosco</strong>.</p>
    <div style="background:#f0fdf9;border-left:3px solid #00c9a7;padding:16px;border-radius:0 8px 8px 0;margin:20px 0;">
      <p style="margin:0;font-weight:600;color:#0b1320;">🎁 Oferta cliente iSafe</p>
      <p style="margin:8px 0 0;color:#4a5a78;font-size:13px;">5% de desconto na sua próxima compra + frete grátis para Criciúma e região.</p>
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td style="background:#00c9a7;border-radius:8px;padding:0;">
          <a href="https://lojaisafe.com.br" style="display:block;padding:14px 28px;color:#0b1320;font-weight:700;font-size:15px;text-decoration:none;">
            Ver novidades da iSafe →
          </a>
        </td>
      </tr>
    </table>`,

  160: (ctx) => `
    <h2 style="font-size:22px;font-weight:700;color:#0b1320;margin:0 0 16px;">
      Recursos do ${ctx.produto} que poucos conhecem 🔓
    </h2>
    <p>Já são 5 meses com o seu <strong>${ctx.produto}</strong>! Você já é um expert — mas apostamos que ainda tem recursos escondidos esperando por você.</p>
    <p style="font-weight:600;color:#0b1320;">Sabia que você pode ${getDica(ctx.categoria)}?</p>
    <p>Preparamos um guia completo com os melhores recursos do ${ctx.produto} que a maioria dos usuários nunca descobre:</p>
    <ul style="color:#1a2438;line-height:2;padding-left:20px;">
      <li>Gestos e atalhos que economizam horas</li>
      <li>Configurações escondidas de produtividade</li>
      <li>Integrações com outros dispositivos Apple</li>
      <li>Recursos de acessibilidade que todo mundo deveria usar</li>
    </ul>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td style="background:#00c9a7;border-radius:8px;padding:0;">
          <a href="https://lojaisafe.com.br/dicas/${ctx.categoria?.toLowerCase()}" style="display:block;padding:14px 28px;color:#0b1320;font-weight:700;font-size:15px;text-decoration:none;">
            Acessar guia completo →
          </a>
        </td>
      </tr>
    </table>`,

  280: (ctx) => `
    <h2 style="font-size:22px;font-weight:700;color:#0b1320;margin:0 0 16px;">
      Prepare-se: o próximo nível está chegando 🚀
    </h2>
    <p>Olá, ${ctx.firstName}! Quase 9 meses com o seu <strong>${ctx.produto}</strong> e você sem dúvida já tirou o máximo dele.</p>
    <p>Pensando em você, quero te contar uma novidade antes de todo mundo:</p>
    <div style="background:#f0f0ff;border-left:3px solid #6366f1;padding:16px;border-radius:0 8px 8px 0;margin:20px 0;">
      <p style="margin:0;font-weight:600;color:#1a1a4e;">Já pensou em ter o ${getUpgrade(ctx.categoria)}?</p>
      <p style="margin:8px 0 0;color:#4a5a78;font-size:13px;">A nova geração chegou com melhorias significativas. Quando lançarmos nossa promoção de upgrade, você será o primeiro a saber.</p>
    </div>
    <p>Não é pressão nenhuma — só quero garantir que você tenha acesso à melhor condição antes de todos 😊</p>
    <p style="color:#4a5a78;font-size:13px;">Responda este e-mail com "quero saber mais" e te explico tudo.</p>`,

  365: (ctx) => `
    <div style="text-align:center;margin:0 0 24px;">
      <span style="font-size:40px;">🎉</span>
      <h2 style="font-size:24px;font-weight:700;color:#0b1320;margin:12px 0 8px;">
        Feliz aniversário de iSafe, ${ctx.firstName}!
      </h2>
      <p style="color:#4a5a78;font-size:14px;">1 ano de jornada tech juntos</p>
    </div>
    <p>Há exatamente 1 ano você escolheu a iSafe e o <strong>${ctx.produto}</strong>. Foi uma honra fazer parte da sua jornada!</p>
    <p>Para celebrar, temos uma <strong>proposta especial de upgrade</strong> exclusiva para quem é cliente há 1 ano:</p>
    <div style="background:#fef9ec;border:1px solid #f59e0b;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
      <p style="font-weight:700;font-size:18px;color:#0b1320;margin:0 0 8px;">
        🎁 ${getUpgrade(ctx.categoria)}
      </p>
      <p style="color:#4a5a78;font-size:13px;margin:0 0 16px;">
        Condição especial de 1 ano · Trade-in do seu ${ctx.produto} + oferta exclusiva
      </p>
      <a href="https://lojaisafe.com.br/upgrade" style="display:inline-block;background:#00c9a7;color:#0b1320;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:15px;">
        Ver minha proposta de upgrade →
      </a>
    </div>
    <p style="color:#4a5a78;font-size:13px;">Obrigado por fazer parte da família iSafe. Você merece o melhor! 💚</p>`,
};

// ── API PÚBLICA ────────────────────────────────────────────────────────────

/**
 * Renderiza uma mensagem WhatsApp com as variáveis do contexto
 */
function renderWhatsApp(template, context) {
  return resolveVars(template, context);
}

/**
 * Renderiza o HTML de e-mail para uma etapa específica
 */
function renderEmailHTML(dayOffset, context) {
  const templateFn = EMAIL_TEMPLATES[dayOffset];
  if (!templateFn) return null;
  const firstName = (context.nome || 'Cliente').split(' ')[0];
  return templateFn({ ...context, firstName });
}

/**
 * Renderiza o assunto do e-mail
 */
function renderEmailSubject(subject, context) {
  return resolveVars(subject, context);
}

/**
 * Monta o contexto completo a partir dos dados do DB
 */
function buildContext({ client, order }) {
  return {
    nome:            client.name,
    produto:         order.product_name,
    categoria:       order.product_category,
    produto_upgrade: getUpgrade(order.product_category),
    dica:            getDica(order.product_category),
    valor:           order.amount,
    numero_pedido:   order.order_number || order.bling_order_id,
  };
}

module.exports = {
  renderWhatsApp,
  renderEmailHTML,
  renderEmailSubject,
  buildContext,
  getDica,
  getUpgrade,
};
