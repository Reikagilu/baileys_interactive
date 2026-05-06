# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG REPO_URL
ARG REPO_REF=main

# garante que REPO_URL foi informado
RUN test -n "${REPO_URL}"

# clona o projeto no build (ideal para seu servidor)
RUN git clone --depth 1 --branch "${REPO_REF}" "${REPO_URL}" /app

# sobrescreve public/ com os arquivos locais customizados (Chatwoot + visual)
COPY public/ /app/public/
# sobrescreve src/ modificado (integrations expandido com novos campos Chatwoot)
COPY src/ /app/src/

RUN npm ci \
  && npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

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

COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/public ./public

USER node

EXPOSE 8787
CMD ["node", "dist/index.js"]
