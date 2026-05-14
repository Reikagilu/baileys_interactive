# syntax=docker/dockerfile:1.7
# Estratégia: instala dependências no container (npm ci), copia o dist/ base,
# recompila os arquivos modificados de src/ e restaura os módulos reais do dist base.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787
ENV AUTH_FOLDER=auth
ENV WEBHOOK_DB_PATH=data/webhooks.sqlite
ENV INTEGRATIONS_DB_PATH=data/integrations.sqlite
ENV MESSAGES_DB_PATH=data/messages.sqlite

RUN mkdir -p /app/auth /app/data \
  && chown node:node /app /app/auth /app/data

# Instala dependências primeiro (camada cacheável separada)
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copia o restante do código
COPY --chown=node:node dist ./dist
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src
COPY --chown=node:node tsconfig.build.json ./tsconfig.build.json
COPY --chown=node:node build.sh ./build.sh

RUN bash ./build.sh \
  && find ./dist -type f \( -name "*.map" -o -name "*.d.ts" \) -delete \
  && rm -rf ./dist/tests ./dist/dist ./src ./tsconfig.build.json ./build.sh

USER node

EXPOSE 8787
CMD ["node", "dist/index.js"]
