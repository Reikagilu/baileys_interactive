---
source: Context7 API
library: Docker + Docker Compose
package: docker
topic: nodejs-production-dockerfile-compose-best-practices
fetched: 2026-03-06T00:00:00Z
official_docs: https://docs.docker.com/guides/nodejs/containerize/
---

# Node.js em producao com Dockerfile e Compose (objetivo e aplicavel)

## Dockerfile: multi-stage + usuario nao-root

- Use multi-stage para separar build/runtime e reduzir superficie de ataque.
- Em Node.js, instale deps com `npm ci` antes de copiar todo o codigo para melhor cache.
- Execute runtime com `USER` nao-root (ex.: `node` do Official Image ou usuario dedicado).
- Copie so artefatos necessarios para runtime (`dist/`, `node_modules` de producao, `package.json`).

Exemplo base:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package*.json ./
USER node
CMD ["node", "dist/index.js"]
```

## Healthcheck confiavel

- Defina endpoint dedicado (`/healthz`) que valide o processo Node e dependencias criticas (ex.: conexao minima necessaria).
- Use `start_period` para evitar falso negativo no boot.
- Em Compose, prefira `CMD`/`CMD-SHELL` com timeout curto e retries consistentes.

Exemplo Compose:

```yaml
services:
  app:
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

## Persistencia de volume (producao)

- Use named volume para estado persistente (mais portavel que bind mount em prod).
- Evite bind mount do codigo em producao.
- Para `baileys_interactive`, persista diretorios de estado da sessao/auth e qualquer store local critica.

Exemplo:

```yaml
services:
  app:
    volumes:
      - baileys_state:/app/data
volumes:
  baileys_state:
```

## Env vars e secrets

- Variaveis nao-sensiveis: `environment` / `.env`.
- Segredos (token/API key/senha): use `secrets` (nao hardcode em imagem nem em compose versionado).
- Aplique validacao de env obrigatoria (`${VAR:?error}`) para falhar cedo no deploy.

Exemplo:

```yaml
services:
  app:
    environment:
      NODE_ENV: production
      PORT: ${PORT:?PORT obrigatoria}
    secrets:
      - baileys_api_key

secrets:
  baileys_api_key:
    file: ./secrets/baileys_api_key.txt
```

## Compose operacional para producao

- Use `restart: unless-stopped`.
- Use `docker compose up -d --wait` para aguardar `healthy`.
- Separe `compose.yaml` (base) e `compose.prod.yaml` (override de producao).

Docs oficiais relevantes:
- Node.js guide: https://docs.docker.com/guides/nodejs/containerize/
- Compose healthcheck/services: https://docs.docker.com/reference/compose-file/services/
- Compose volumes: https://docs.docker.com/reference/compose-file/volumes/
- Compose env vars/best practices: https://docs.docker.com/compose/environment-variables/best-practices/
