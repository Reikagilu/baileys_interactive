# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    AUTH_FOLDER=/app/auth \
    WEBHOOK_DB_PATH=/app/data/webhooks.sqlite \
    INTEGRATIONS_DB_PATH=/app/data/integrations.sqlite \
    MESSAGES_DB_PATH=/app/data/messages.sqlite \
    AUDIT_LOG_PATH=/app/data/audit.log

RUN mkdir -p /app/auth /app/data && chown node:node /app /app/auth /app/data

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The upstream Baileys stream patch is applied after every clean install.
COPY --chown=node:node scripts/patch-baileys.mjs ./scripts/patch-baileys.mjs
RUN node ./scripts/patch-baileys.mjs && rm -rf ./scripts

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public

USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "dist/index.js"]
