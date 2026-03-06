---
source: Context7 API
library: Docker BuildKit
package: docker
topic: private-git-dependencies-with-buildkit-ssh-secrets
fetched: 2026-03-06T00:00:00Z
official_docs: https://docs.docker.com/build/building/secrets/
---

# Dependencias Git em imagens Node.js (producao)

## Pratica recomendada

- Nao copie chave SSH/token para a imagem.
- Use BuildKit com `RUN --mount=type=ssh` para acesso temporario a repos privados.
- Se usar token, use `--mount=type=secret` para evitar vazamento em camada.
- Instale `git` apenas no stage de build; nao no runtime final.

Exemplo (build stage):

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
RUN apk add --no-cache git openssh-client
RUN mkdir -p -m 0700 /root/.ssh && ssh-keyscan github.com >> /root/.ssh/known_hosts
WORKDIR /app
COPY package*.json ./
RUN --mount=type=ssh npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
```

Build:

```bash
docker buildx build --ssh default -t baileys-interactive:prod .
```

## Para baileys_interactive

- Se houver dependencia `git+ssh` no `package.json`, trate isso apenas no build stage.
- Remova `git` e clientes SSH da imagem final para reduzir risco e tamanho.
- Prefira fixar commit/tag de dependencia Git para reprodutibilidade.

Docs oficiais relevantes:
- Build secrets e SSH mounts: https://docs.docker.com/build/building/secrets/
- Secrets em CI (GitHub Actions): https://docs.docker.com/build/ci/github-actions/secrets/
