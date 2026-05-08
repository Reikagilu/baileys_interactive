# syntax=docker/dockerfile:1.7
# Estratégia: copia o dist/ base do contexto, recompila automaticamente os
# arquivos modificados de src/ durante o build e restaura os módulos reais
# preservados do dist base. Assim `docker compose build` já sobe com tudo certo.

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

COPY --chown=node:node package*.json ./
COPY --chown=node:node node_modules ./node_modules
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
