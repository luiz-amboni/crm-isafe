-- ════════════════════════════════════════════════════
-- iSafe CRM · Schema PostgreSQL
-- Execute: psql -U isafe -d isafe_crm -f schema.sql
-- ════════════════════════════════════════════════════

-- Extensões
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ── CLIENTES ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id               SERIAL PRIMARY KEY,
  bling_contact_id VARCHAR(50)  UNIQUE,
  name             VARCHAR(255) NOT NULL,
  phone            VARCHAR(30),               -- formato: 5548999999999
  email            VARCHAR(255),
  cpf              VARCHAR(20),
  city             VARCHAR(100),
  state            VARCHAR(50),
  is_active        BOOLEAN      DEFAULT true,
  tags             TEXT[],
  created_at       TIMESTAMPTZ  DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  DEFAULT NOW()
);

-- ── PEDIDOS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  bling_order_id  VARCHAR(50)  UNIQUE NOT NULL,
  client_id       INTEGER      REFERENCES clients(id) ON DELETE CASCADE,
  order_number    VARCHAR(50),
  product_name    VARCHAR(500),              -- nome do produto principal
  product_sku     VARCHAR(100),
  product_category VARCHAR(100),            -- iPhone, MacBook, iPad, etc.
  amount          DECIMAL(10,2),
  status          VARCHAR(100) DEFAULT 'Em Aberto',  -- status real do Bling
  vendedor        VARCHAR(255),
  item_count      INTEGER      DEFAULT 1,
  ordered_at      TIMESTAMPTZ  NOT NULL,
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- Migração: garante que colunas adicionadas após versão inicial existam
ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_count INTEGER DEFAULT 1;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendedor VARCHAR(255);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS state VARCHAR(50);

-- ── PIPELINE (uma entrada por pedido) ────────────────
CREATE TABLE IF NOT EXISTS pipeline (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER     REFERENCES orders(id) ON DELETE CASCADE UNIQUE,
  client_id   INTEGER     REFERENCES clients(id) ON DELETE CASCADE,
  status      VARCHAR(20) DEFAULT 'active',  -- active | paused | completed | cancelled
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── ETAPAS DE AUTOMAÇÃO (configuração das sequências) ──
CREATE TABLE IF NOT EXISTS automation_steps (
  id             SERIAL PRIMARY KEY,
  day_offset     INTEGER      NOT NULL UNIQUE, -- 3,14,30,60,90,160,220,280,365
  label          VARCHAR(100) NOT NULL,
  focus          TEXT,
  channel        VARCHAR(20)  NOT NULL,  -- whatsapp | email | both
  wa_template    TEXT,
  email_subject  VARCHAR(255),
  email_template TEXT,
  is_active      BOOLEAN      DEFAULT true,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW()
);

-- ── LOG DE MENSAGENS ENVIADAS ─────────────────────────
CREATE TABLE IF NOT EXISTS message_log (
  id            SERIAL PRIMARY KEY,
  pipeline_id   INTEGER     REFERENCES pipeline(id) ON DELETE CASCADE,
  client_id     INTEGER     REFERENCES clients(id),
  order_id      INTEGER     REFERENCES orders(id),
  step_id       INTEGER     REFERENCES automation_steps(id),
  day_offset    INTEGER     NOT NULL,
  channel       VARCHAR(20) NOT NULL,
  status        VARCHAR(20) DEFAULT 'pending',  -- pending | sent | failed | skipped | bounced
  scheduled_for DATE,
  sent_at       TIMESTAMPTZ,
  wa_message    TEXT,
  wa_response   JSONB,
  email_subject VARCHAR(255),
  email_html    TEXT,
  email_response JSONB,
  error_message TEXT,
  retry_count   INTEGER     DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── TOKENS BLING (OAuth2) ─────────────────────────────
CREATE TABLE IF NOT EXISTS bling_tokens (
  id            SERIAL PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── EMAIL UNSUBSCRIBES ────────────────────────────────
CREATE TABLE IF NOT EXISTS email_unsubscribes (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) UNIQUE NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── CAMPANHAS DE MARKETING ───────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  channel       VARCHAR(20)  NOT NULL CHECK (channel IN ('whatsapp','email')),
  status        VARCHAR(20)  NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','scheduled','sending','completed','paused')),
  subject       VARCHAR(255),
  message       TEXT,
  scheduled_at  TIMESTAMPTZ,
  audience_filter VARCHAR(50) DEFAULT 'manual',
  total_clients INTEGER DEFAULT 0,
  sent_count    INTEGER DEFAULT 0,
  failed_count  INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_clients (
  id          SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  client_id   INTEGER NOT NULL REFERENCES clients(id)   ON DELETE CASCADE,
  status      VARCHAR(20) DEFAULT 'pending'
                CHECK (status IN ('pending','sent','failed','skipped')),
  sent_at     TIMESTAMPTZ,
  error_msg   TEXT,
  UNIQUE(campaign_id, client_id)
);

-- ── CONFIGURAÇÕES DO SISTEMA (editáveis pelo dashboard) ─────
-- Sobrescreve variáveis de ambiente. Chaves sensíveis ficam aqui, não no .env.
CREATE TABLE IF NOT EXISTS settings (
  key        VARCHAR(100) PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── TEMPLATES DE MENSAGEM (biblioteca reutilizável) ──
CREATE TABLE IF NOT EXISTS message_templates (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  channel    VARCHAR(20)  NOT NULL CHECK (channel IN ('whatsapp','email','both')),
  category   VARCHAR(100),               -- iPhone, MacBook, etc. (NULL = genérico)
  subject    VARCHAR(255),               -- apenas para canal email
  content    TEXT         NOT NULL,
  is_active  BOOLEAN      DEFAULT true,
  created_at TIMESTAMPTZ  DEFAULT NOW(),
  updated_at TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_templates_channel  ON message_templates(channel);
CREATE INDEX IF NOT EXISTS idx_templates_category ON message_templates(category);

-- ── FUNÇÃO: atualizar updated_at automaticamente ──────
-- Definida aqui pois é usada pelos triggers abaixo e pelos de clients/pipeline
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_templates_updated_at
  BEFORE UPDATE ON message_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── ÍNDICES ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_client     ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_ordered_at ON orders(ordered_at);
CREATE INDEX IF NOT EXISTS idx_pipeline_status   ON pipeline(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_order    ON pipeline(order_id);
CREATE INDEX IF NOT EXISTS idx_msglog_pipeline   ON message_log(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_msglog_status     ON message_log(status);
CREATE INDEX IF NOT EXISTS idx_msglog_scheduled  ON message_log(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_clients_phone     ON clients(phone);
CREATE INDEX IF NOT EXISTS idx_clients_email     ON clients(email);
CREATE INDEX IF NOT EXISTS idx_campaigns_channel ON campaigns(channel);
CREATE INDEX IF NOT EXISTS idx_campaigns_status  ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_camp_clients_camp ON campaign_clients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_camp_clients_cli  ON campaign_clients(client_id);

-- ── SEED: ETAPAS DE AUTOMAÇÃO ─────────────────────────
INSERT INTO automation_steps (day_offset, label, focus, channel, wa_template, email_subject, email_template) VALUES

(3, 'Confirmar Experiência', 'Confirmar a chegada do produto e criar vínculo emocional', 'whatsapp',
'Olá {{nome}}! 😊

Vi aqui que seu *{{produto}}* chegou!

Como está sendo a experiência? A gente da iSafe adora saber quando nossos clientes estão felizes. 

Precisa de alguma ajuda para configurar ou tem alguma dúvida?',
NULL, NULL),

(14, 'Oferta de Acessório', 'Apresentar acessório complementar de forma natural e relevante', 'both',
'Olá {{nome}}! Está curtindo o *{{produto}}*? 🔥

Separei alguns acessórios que mais combinam com o seu aparelho — desde capas MagSafe até AirPods. Quem leva costumam amar a experiência completa!

Posso te mostrar as opções? 😊',
'Acessórios perfeitos para o seu {{produto}} 🎯',
'<h2>Olá, {{nome}}!</h2><p>Já faz duas semanas com o seu <strong>{{produto}}</strong>. Que tal completar a experiência?</p>'),

(30, 'Entrega de Valor', 'Dica prática que agrega valor real ao produto comprado', 'whatsapp',
'Oi {{nome}}! Uma dica rápida do time iSafe 💡

Você sabia que no *{{produto}}* você pode aproveitar {{dica_produto}}?

Isso faz muita diferença no dia a dia! Qualquer novidade da iSafe você é um dos primeiros a saber 😊',
NULL, NULL),

(60, 'Reativar Interesse', 'Reengajar com conteúdo de valor e oferta exclusiva para clientes', 'email',
NULL,
'Novidades exclusivas para você, {{nome}} ✨',
'<h2>Olá, {{nome}}!</h2><p>Já são 2 meses com o seu <strong>{{produto}}</strong>! Separamos novidades e uma oferta especial para clientes iSafe.</p>'),

(90, 'Prova Social e Desejo', 'Compartilhar depoimentos reais e despertar desejo por novos produtos', 'whatsapp',
'Olá {{nome}}! 🌟

Nossos clientes estão amando as novidades que chegaram! Veja o que a Ana disse sobre o AirPods Pro que levou:

"Melhor compra do ano, o som é outro nível!"

Quer ver o que tem de novo na iSafe? Tenho uma curadoria especial que acho que você vai curtir 😊',
NULL, NULL),

(160, 'Dicas Avançadas', 'Tutorial com recursos avançados do produto comprado — entregar valor real', 'email',
NULL,
'Recursos do {{produto}} que poucos conhecem 🔓',
'<h2>Olá, {{nome}}!</h2><p>Já são 5 meses com o seu <strong>{{produto}}</strong> — que tal desbloquear recursos que poucos conhecem?</p>'),

(220, 'Oferta VIP', 'Acessório premium ou produto complementar para clientes fidelizados', 'whatsapp',
'Olá {{nome}}! Tudo bem? 😊

Com *{{produto}}* por 7 meses, você já é um verdadeiro especialista!

Temos algumas novidades exclusivas para clientes VIP da iSafe — peças e acessórios que elevam ainda mais a experiência.

Posso te mostrar? 🎯',
NULL, NULL),

(280, 'Preparar Upgrade', 'Plantar a semente do upgrade com conteúdo sobre a nova geração', 'email',
NULL,
'Prepare-se: o próximo nível está chegando 🚀',
'<h2>Olá, {{nome}}!</h2><p>Você sabia que já existe um <strong>{{produto_upgrade}}</strong> disponível? Antes de lançarmos uma promoção especial, quero que você seja o primeiro a saber.</p>'),

(365, '1 Ano · Upgrade!', 'Celebrar 1 ano de cliente e propor upgrade iPhone/iPad/Mac nova geração', 'both',
'🎉 Parabéns, {{nome}}!

Hoje faz exatamente 1 ano que você escolheu a iSafe! Foi uma honra fazer parte da sua jornada tech.

O novo *{{produto_upgrade}}* chegou e temos uma condição especial para quem é cliente há 1 ano 🎁

Posso te apresentar as opções?',
'🎉 1 ano de iSafe — presente especial pra você, {{nome}}',
'<h2>🎉 Feliz aniversário de iSafe, {{nome}}!</h2><p>1 ano atrás você escolheu a iSafe e o <strong>{{produto}}</strong>. Para celebrar, temos uma proposta especial de upgrade para você.</p>')

ON CONFLICT (day_offset) DO NOTHING;

CREATE OR REPLACE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_pipeline_updated_at
  BEFORE UPDATE ON pipeline FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── NORMALIZAÇÃO DE STATUS (idempotente) ──────────────
-- Garante que todos os pedidos usem apenas: Em aberto, Cancelado, Atendido
UPDATE orders SET status = 'Cancelado'
  WHERE LOWER(status) LIKE '%cancelad%'
    AND status != 'Cancelado';

UPDATE orders SET status = 'Atendido'
  WHERE LOWER(status) IN ('atendido','faturado','aprovado','confirmado',
                           'nota fiscal emitida','entregue')
    AND status != 'Atendido';

UPDATE orders SET status = 'Em aberto'
  WHERE status NOT IN ('Atendido','Cancelado')
    AND status IS NOT NULL;
