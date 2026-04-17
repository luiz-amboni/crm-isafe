/**
 * Script de autorização OAuth2 do Bling
 * Uso: node scripts/setup-bling-auth.js
 */

require('dotenv').config();
const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

const CLIENT_ID     = process.env.BLING_CLIENT_ID;
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3333/callback';
const ENV_PATH      = path.join(__dirname, '..', '.env');

// ── Validações ────────────────────────────────────────────────────────────────

if (!CLIENT_ID || CLIENT_ID.includes('client_id_aqui')) {
  console.error('\n❌ BLING_CLIENT_ID não está configurado no .env');
  console.error('   Siga o PASSO 1 do tutorial para criar o App no Bling.\n');
  process.exit(1);
}

if (!CLIENT_SECRET || CLIENT_SECRET.includes('client_secret_aqui')) {
  console.error('\n❌ BLING_CLIENT_SECRET não está configurado no .env');
  console.error('   Siga o PASSO 1 do tutorial para criar o App no Bling.\n');
  process.exit(1);
}

// ── Monta URL de autorização ──────────────────────────────────────────────────

const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?` +
  `response_type=code` +
  `&client_id=${CLIENT_ID}` +
  `&state=isafe_setup` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

// ── Abre o navegador ──────────────────────────────────────────────────────────

function openBrowser(url) {
  const { exec } = require('child_process');
  exec(`open "${url}"`);
}

// ── Troca o code pelos tokens ─────────────────────────────────────────────────

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }).toString();

    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const options = {
      hostname: 'www.bling.com.br',
      path:     '/Api/v3/oauth/token',
      method:   'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            resolve(json);
          } else {
            reject(new Error(JSON.stringify(json)));
          }
        } catch (e) {
          reject(new Error(`Resposta inválida: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Salva tokens no .env ──────────────────────────────────────────────────────

function saveTokensToEnv(accessToken, refreshToken) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');

  content = content
    .replace(/^BLING_ACCESS_TOKEN=.*$/m,  `BLING_ACCESS_TOKEN=${accessToken}`)
    .replace(/^BLING_REFRESH_TOKEN=.*$/m, `BLING_REFRESH_TOKEN=${refreshToken}`);

  fs.writeFileSync(ENV_PATH, content);
}

// ── Servidor local para receber o callback ────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname !== '/callback') {
    res.end('...');
    return;
  }

  const code  = parsed.query.code;
  const error = parsed.query.error;

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>❌ Acesso negado pelo Bling.</h2><p>Feche esta aba e tente novamente.</p>`);
    console.error('\n❌ Autorização negada pelo Bling.\n');
    server.close();
    return;
  }

  if (!code) {
    res.end('Código não encontrado.');
    return;
  }

  console.log('\n🔄 Trocando código pelos tokens...');

  try {
    const tokens = await exchangeCode(code);
    saveTokensToEnv(tokens.access_token, tokens.refresh_token);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h1>✅ Bling conectado com sucesso!</h1>
        <p>Tokens salvos no .env automaticamente.</p>
        <p>Pode fechar esta aba e voltar ao Terminal.</p>
      </body></html>
    `);

    console.log('\n✅ Tokens salvos no .env com sucesso!');
    console.log('   BLING_ACCESS_TOKEN  → salvo');
    console.log('   BLING_REFRESH_TOKEN → salvo');
    console.log('\n🔄 Reinicie os containers para aplicar:');
    console.log('   docker compose down && docker compose up -d\n');

    server.close();
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>❌ Erro ao trocar tokens</h2><pre>${err.message}</pre>`);
    console.error('\n❌ Erro ao trocar tokens:', err.message, '\n');
    server.close();
  }
});

// ── Inicia ────────────────────────────────────────────────────────────────────

server.listen(3333, () => {
  console.log('\n════════════════════════════════════════');
  console.log('   iSafe CRM — Autorização Bling OAuth2');
  console.log('════════════════════════════════════════');
  console.log('\n🌐 Abrindo o Bling no navegador...');
  console.log('   Faça login e clique em "Autorizar".');
  console.log('\n⏳ Aguardando autorização...\n');
  openBrowser(authUrl);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n❌ A porta 3333 já está em uso.');
    console.error('   Feche o processo que está usando e tente novamente.\n');
  } else {
    console.error('\n❌ Erro:', err.message, '\n');
  }
  process.exit(1);
});
