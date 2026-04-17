FROM node:20-alpine

LABEL maintainer="iSafe Tecnologia <contato@lojaisafe.com.br>"
LABEL description="iSafe CRM Backend"

WORKDIR /app

# Instala dependências de produção
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copia código
COPY . .

# Cria diretório de logs
RUN mkdir -p logs && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
