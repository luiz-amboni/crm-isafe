# iSafe CRM — Contexto para Claude Code

## O que é este projeto

CRM pós-compra para a iSafe (revendedor Apple Premium em Criciúma, SC). Automatiza jornada de relacionamento D+3 a D+365 via WhatsApp (Evolution API) e e-mail (SendGrid). Integra com Bling ERP como fonte principal de dados.

## Stack

- **Backend**: Node.js + Express (server.js)
- **Banco**: PostgreSQL via `pg` — pool em `db/index.js`
- **Frontend**: SPA monolítica em `public/index.html` (HTML + CSS + JS inline)
- **Infra**: Docker Compose (app + postgres)

## Padrões importantes

### Configurações
- Todas as credenciais de integração (Bling, WA, email) são lidas de `services/config.js`
- Prioridade: banco de dados (`settings` table) > env var > valor padrão
- Cache de 60s em memória — isso é intencional para performance
- **Nunca leia credenciais direto do `process.env`** dentro dos services — sempre use `cfg.get()`

### Auth
- Frontend usa JWT Bearer token (gerado em `POST /api/auth/login`)
- Scripts externos usam `x-api-key` header
- Webhooks (Bling, Shopify, Bagy) têm auth própria por HMAC em `routes/webhook.js`
- `ADMIN_PASSWORD` não configurado = modo livre (desenvolvimento)

### Frontend
- `apiFetch('/api/...')` é o wrapper para todas as chamadas à API — injeta Bearer token e trata 401
- Não use `fetch('/api/...')` diretamente no frontend — use `apiFetch`
- O login overlay (`#login-screen`) é controlado por `checkAuth()`, `doLogin()`, `logout()`

### Banco de dados
- Nunca use queries diretas com string interpolation — sempre `query('...', [params])`
- `db/index.js` exporta `query()` e `transaction()` (com retry em deadlock)

### Bling API v3
- Vendedor está em `data.contato.nome`, não em `data.nome`
- Rate limit ~3 req/s — use `sleep()` de `utils/helpers.js` entre chamadas em batch
- Token OAuth salvo na tabela `bling_tokens` e em `settings` — use `bling.getAccessToken()` para obter

## Estrutura de arquivos

```
routes/api.js       — CRUD principal (clientes, pedidos, pipeline, steps, dashboard)
routes/auth.js      — login/logout/verify
routes/campaigns.js — campanhas WhatsApp e email marketing
routes/messages.js  — templates de mensagens
routes/settings.js  — configurações + OAuth Bling + testes de conexão
routes/extras.js    — win-back, busca global, sync Shopify/Bagy
routes/webhook.js   — recebe eventos do Bling, Shopify e Bagy
services/scheduler.js — roda via cron, processa pipeline e dispara mensagens
services/bling.js   — toda a integração Bling (sync, OAuth, webhook)
utils/helpers.js    — formatPhone, detectCategory, parseDate, sleep
```

## O que NÃO fazer

- Não adicionar `module.exports` no meio de um arquivo de rotas (já causou bug grave)
- Não usar `Promise.all` para chamadas à API do Bling (respeitar rate limit 3 req/s)
- Não hardcodar credenciais — sempre via `cfg.get()` ou env var
- O `index.html` é intencional como monolito — não separar CSS/JS sem pedido explícito
