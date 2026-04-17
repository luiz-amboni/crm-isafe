# iSafe CRM

Sistema de relacionamento pós-compra para lojas Apple Premium — automatiza WhatsApp e e-mail em 9 momentos estratégicos do D+3 ao D+365 após cada compra.

---

## 🛠 Stack Tecnológica

- **Backend**: [Node.js](https://nodejs.org/) com [Express](https://expressjs.com/)
- **Banco de Dados**: [PostgreSQL](https://www.postgresql.org/)
- **Integrações**: [Bling ERP v3](https://developer.bling.com.br/), [Evolution API](https://evolution-api.com/) (WhatsApp), [SendGrid](https://sendgrid.com/) (E-mail)
- **Segurança**: [JWT](https://jwt.io/) (Autenticação) e [Helmet](https://helmetjs.github.io/) (Proteção de headers)
- **Infraestrutura**: [Docker](https://www.docker.com/) e [Docker Compose](https://docs.docker.com/compose/)

---

## O que o sistema faz

- **Importa clientes e pedidos** do Bling ERP automaticamente via API v3 e webhooks
- **Dispara mensagens automáticas** por WhatsApp e e-mail nos momentos certos pós-compra
- **Dashboard web completo** com pipeline, clientes, campanhas e relatórios
- **Reativação de clientes** inativos com segmentação inteligente
- **Suporte a múltiplas lojas**: Bling, Shopify e Bagy

---

## Pré-requisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado
- Porta 3000 disponível no seu computador

> Não precisa instalar Node.js, PostgreSQL ou nada mais — o Docker cuida de tudo.

---

## Instalação rápida (5 minutos)

### 1. Baixar o projeto

```bash
git clone https://github.com/luiz-amboni/crm-isafe.git
cd crm-isafe
```

### 2. Criar o arquivo de configuração

```bash
cp .env.example .env
```

Abra o arquivo `.env` e preencha **no mínimo** estas variáveis:

```env
DB_PASSWORD=uma_senha_forte_aqui
ADMIN_USER=admin
ADMIN_PASSWORD=sua_senha_de_acesso
JWT_SECRET=string_aleatoria_longa_aqui
APP_URL=http://localhost:3000
```

> Para gerar o `JWT_SECRET`, rode:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

### 3. Subir o sistema

```bash
docker compose up -d
```

### 4. Criar as tabelas do banco

```bash
docker compose exec app npm run migrate
```

### 5. Acessar o painel

Abra no navegador: **http://localhost:3000**

Faça login com o usuário e senha que você definiu no `.env`.

---

## Primeiro acesso

Ao entrar no painel, vá em **Configurações** e configure as integrações:

### Bling (obrigatório)
1. Acesse [bling.com.br](https://bling.com.br) → Configurações → API → Criar App
2. Nome do app: `iSafe CRM`
3. Redirect URI: `http://localhost:3000/api/bling/oauth/callback` *(ou sua URL de produção)*
4. Escopos: **contatos · pedidos de venda · hooks**
5. Cole o **Client ID** e **Client Secret** na aba Configurações → Bling ERP
6. Clique em **"Conectar ao Bling"** — você será redirecionado para autorizar
7. Após autorizar, clique em **Sincronizar** para importar os pedidos

### WhatsApp (via Evolution API)
1. Na aba Configurações → WhatsApp, preencha:
   - **URL da API**: endereço da sua instalação da Evolution API
   - **API Key**: chave de acesso
   - **Instance Name**: nome da instância criada
2. Clique em **Testar conexão** para verificar

### E-mail (via SendGrid)
1. Crie uma conta em [sendgrid.com](https://sendgrid.com) (gratuito até 100 e-mails/dia)
2. Acesse Settings → API Keys → Create API Key
3. Cole a chave na aba Configurações → E-mail

---

## Automações pós-compra

O sistema dispara mensagens automaticamente após cada compra:

| Etapa | Quando | Canal | Objetivo |
|-------|--------|-------|----------|
| D+3 | 3 dias | WhatsApp | Confirmar experiência de compra |
| D+14 | 2 semanas | WA + E-mail | Dica de valor do produto |
| D+30 | 1 mês | WhatsApp | Oferta de acessório |
| D+60 | 2 meses | E-mail | Reativar interesse |
| D+90 | 3 meses | WhatsApp | Prova social |
| D+160 | ~5 meses | E-mail | Dicas avançadas |
| D+220 | ~7 meses | WhatsApp | Oferta VIP |
| D+280 | ~9 meses | E-mail | Preparar upgrade |
| D+365 | 1 ano | WA + E-mail | Celebrar + propor upgrade |

Os horários e textos são totalmente editáveis no painel em **Automações**.

---

## Comandos úteis

```bash
# Subir o sistema
docker compose up -d

# Parar o sistema
docker compose down

# Ver logs em tempo real
docker compose logs -f crm

# Criar/recriar as tabelas do banco
docker compose exec crm npm run migrate

# Sincronizar pedidos do Bling (últimos 90 dias)
docker compose exec crm npm run sync

# Verificar se o sistema está saudável
curl http://localhost:3000/health
```

---

## Instalação sem Docker (desenvolvimento)

### Requisitos
- Node.js 18+
- PostgreSQL 14+

```bash
# Instalar dependências
npm install

# Criar banco de dados
createdb isafe_crm
psql -d isafe_crm -f db/schema.sql

# Configurar variáveis
cp .env.example .env
# Edite .env com suas configurações

# Iniciar em modo desenvolvimento
npm run dev
```

---

## Acesso pela rede local

Para acessar o painel de outros computadores na mesma rede (Wi-Fi da empresa):

1. Descubra o IP do computador que roda o sistema:
   - **macOS/Linux**: `ifconfig | grep "inet "` ou `hostname -I`
   - **Windows**: `ipconfig` → procure "Endereço IPv4"

2. Acesse de qualquer dispositivo na mesma rede:
   ```
   http://192.168.1.XXX:3000
   ```
   *(substitua pelo IP encontrado)*

3. Para expor na internet (produção), use um servidor VPS com domínio próprio e configure HTTPS.

> **⚠️ Importante em Produção**: Nunca rode este sistema em HTTP aberto na internet. O uso de um Reverse Proxy (Nginx/Traefik) com certificado SSL (Let's Encrypt) é obrigatório para proteger os tokens do Bling e os dados dos seus clientes.

---

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `DB_PASSWORD` | Sim | Senha do banco PostgreSQL |
| `ADMIN_USER` | Não | Usuário do painel (padrão: `admin`) |
| `ADMIN_PASSWORD` | Sim | Senha de acesso ao painel |
| `JWT_SECRET` | Sim | Segredo para tokens de sessão |
| `APP_URL` | Sim | URL pública do sistema |
| `BLING_CLIENT_ID` | Bling | Client ID do app Bling |
| `BLING_CLIENT_SECRET` | Bling | Client Secret do app Bling |
| `EVOLUTION_API_URL` | WhatsApp | URL da Evolution API |
| `EVOLUTION_API_KEY` | WhatsApp | Chave de acesso da Evolution API |
| `EVOLUTION_INSTANCE` | WhatsApp | Nome da instância WhatsApp |
| `SENDGRID_API_KEY` | E-mail | Chave API do SendGrid |
| `WEBHOOK_SECRET` | Segurança | Segredo para validar webhooks |
| `SCHEDULER_CRON` | Não | Horário dos envios (padrão: `0 9 * * *`) |

> Todas as integrações (Bling, WhatsApp, E-mail) também podem ser configuradas diretamente no painel em **Configurações**, sem precisar editar o `.env`.

---

## Estrutura do projeto

```
crm-isafe/
├── server.js          # Servidor principal Express
├── db/
│   ├── schema.sql     # Estrutura do banco de dados
│   ├── migrate.js     # Script de migração
│   └── index.js       # Conexão com PostgreSQL (pool + transaction)
├── routes/
│   ├── api.js         # API REST principal (clientes, pedidos, pipeline)
│   ├── auth.js        # Login e autenticação
│   ├── campaigns.js   # Campanhas de marketing
│   ├── messages.js    # Templates de mensagens
│   ├── settings.js    # Configurações via dashboard + OAuth Bling
│   ├── webhook.js     # Webhooks (Bling, Shopify, Bagy)
│   └── extras.js      # Win-back, busca global, sincronizações
├── services/
│   ├── bling.js       # Integração Bling API v3
│   ├── whatsapp.js    # Evolution API (WhatsApp)
│   ├── email.js       # SendGrid
│   ├── scheduler.js   # Agendador de automações (node-cron)
│   ├── config.js      # Configurações via banco de dados (cache 60s)
│   ├── logger.js      # Logs estruturados (Winston)
│   ├── shopify.js     # Integração Shopify
│   ├── bagy.js        # Integração Bagy
│   ├── winback.js     # Lógica de reativação de clientes inativos
│   └── ai.js          # Geração de mensagens com IA (Claude API, fallback automático)
├── middleware/
│   └── auth.js        # JWT + x-api-key
├── templates/
│   └── messages.js    # Engine de templates (variáveis e HTML de e-mail)
├── utils/
│   └── helpers.js     # formatPhone, detectCategory, parseDate, sleep
├── scripts/
│   ├── sync-bling.js  # Sync manual Bling (npm run sync)
│   ├── sync-shopify.js
│   ├── sync-bagy.js
│   ├── test-whatsapp.js
│   ├── test-email.js
│   └── setup-bling-auth.js
├── public/
│   └── index.html     # Dashboard SPA (HTML + CSS + JS inline)
├── logs/              # Logs de aplicação (gerado automaticamente)
├── nginx.conf         # Exemplo de configuração Nginx com SSL
├── .env.example       # Modelo de configuração
├── docker-compose.yml # Configuração Docker (app + postgres)
└── Dockerfile
```

---

## Segurança

- Nenhuma senha ou token é armazenada no código-fonte
- O arquivo `.env` está no `.gitignore` e nunca vai para o GitHub
- O painel exige login com usuário e senha (JWT)
- Webhooks são validados por assinatura HMAC
- Rate limiting: 200 req/15min (geral) e 60 req/min (webhooks)
- Headers de segurança via Helmet

---

## Suporte

Abra uma issue no repositório ou entre em contato pelo e-mail do projeto.
