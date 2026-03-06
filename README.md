# rscara

API em **TypeScript** para múltiplas contas WhatsApp usando [InfiniteAPI](https://github.com/Beyound/InfiniteAPI) (fork do Baileys), com geração de QR code, gerenciamento de conexões e disparo de componentes especiais (botões, listas, carrossel, enquete). Inclui interface web para conectar números e enviar mensagens.

## Requisitos

- Node.js >= 20
- npm ou yarn

## Instalação

```bash
npm install
```

## Configuração

Copie o arquivo de exemplo e ajuste:

```bash
cp .env.example .env
```

Variáveis em `.env`:

| Variável     | Descrição              | Padrão |
|-------------|------------------------|--------|
| `PORT`      | Porta do servidor      | 8787   |
| `API_KEY`   | Chave para header `x-api-key` (deixe vazio para desativar) | - |
| `API_KEYS_JSON` | Lista de chaves com escopos (`[{"id":"ops","key":"...","scopes":["ops:read"]}]`) | - |
| `AUTH_FOLDER` | Pasta onde salvar credenciais por instância | auth |
| `AUDIT_LOG_PATH` | Caminho do arquivo de auditoria JSONL | data/audit.log |
| `AUDIT_MAX_IN_MEMORY_EVENTS` | Quantidade máxima de eventos em memória para `/v1/ops/audit` | 500 |
| `ALERT_MAX_PENDING_DELIVERIES` | Threshold de alertas para fila pendente | 1000 |
| `ALERT_MAX_FAILED_DELIVERIES` | Threshold de alertas para DLQ | 200 |
| `ALERT_MAX_OLDEST_PENDING_AGE_SECONDS` | Threshold de idade da entrega pendente mais antiga | 300 |
| `ALERT_MIN_CONNECTED_INSTANCES` | Mínimo de instâncias conectadas esperado | 1 |
| `REQUEST_LOGS_ENABLED` | Habilita logs por requisição (health/ready/metrics sempre silenciosos) | true |
| `ALLOW_PRIVATE_NETWORK_WEBHOOKS` | Permite destinos privados (localhost/RFC1918) para webhooks/eventos de instância | false |
| `ALLOW_PRIVATE_NETWORK_INTEGRATIONS` | Permite destinos privados (localhost/RFC1918) para integrações (Chatwoot/n8n) | false |
| `PAIRING_CODE_ENABLED` | Habilita geração de pairing code | true |
| `PAIRING_DEFAULT_COUNTRY_CODE` | DDI padrão quando número vem sem DDI | 55 |
| `PAIRING_FORCE_FRESH_SESSION` | Força sessão limpa antes de pairing em instância não conectada | false |
| `INTEGRATIONS_DB_PATH` | Caminho do banco SQLite das integrações por instância | data/integrations.sqlite |
| `INTEGRATIONS_REQUEST_TIMEOUT_MS` | Timeout para testes de integração (Chatwoot/n8n) | 8000 |
| `WEBHOOK_DB_PATH` | Caminho do banco SQLite de webhooks/deliveries | data/webhooks.sqlite |
| `WEBHOOK_MAX_ATTEMPTS` | Máximo de tentativas por entrega de webhook | 5 |
| `WEBHOOK_RETRY_BASE_DELAY_MS` | Atraso base de retry (backoff exponencial) | 2000 |
| `WEBHOOK_RETRY_MAX_DELAY_MS` | Atraso máximo de retry | 30000 |
| `WEBHOOK_REQUEST_TIMEOUT_MS` | Timeout de requisição ao endpoint do webhook | 8000 |
| `WEBHOOK_MAX_DELIVERY_HISTORY` | Limite de histórico de entregas persistidas | 5000 |
| `WEBHOOK_DEFAULT_SECRET` | Segredo padrão para assinatura HMAC (opcional) | - |
| `WEBHOOK_WORKER_POLL_MS` | Intervalo de polling do worker dedicado | 500 |
| `WEBHOOK_WORKER_BATCH_SIZE` | Tamanho de lote processado por ciclo do worker | 25 |
| `WEBHOOK_WORKER_LOCK_MS` | Tempo do lease/lock de entrega em processamento | 30000 |
| `WEBHOOK_DLQ_RETENTION_MS` | Retenção de itens em DLQ antes de purge automático | 604800000 |
| `WEBHOOK_PURGE_INTERVAL_MS` | Intervalo para purge automático de DLQ no worker | 60000 |
| `IDEMPOTENCY_ENABLED` | Habilita deduplicação por `idempotency-key` | true |
| `IDEMPOTENCY_TTL_MS` | TTL da resposta idempotente em memória | 600000 |
| `IDEMPOTENCY_MAX_ENTRIES` | Máximo de chaves idempotentes em memória | 5000 |

## Desenvolvimento

```bash
npm run dev
```

## Como subir (rápido)

Para subir local em modo produção com API + worker e gestão de PID/logs:

```bash
./scripts/start-stack.sh
```

Comandos úteis:

```bash
./scripts/logs-stack.sh both
./scripts/stop-stack.sh
```

Observação: `./scripts/start-stack.sh` já executa build por padrão. Use `--no-build` se você acabou de rodar `npm run build`.

## Build e produção

```bash
npm run build
npm start
```

Worker dedicado de webhooks (opcional quando `WEBHOOK_EMBEDDED_WORKER_ENABLED=true`, recomendado para escala/processo separado):

```bash
npm run worker:webhooks
```

Executar API + worker juntos:

```bash
npm run start:stack
```

Scripts utilitários (iniciam/pararam com PID + logs em `.runtime/`):

```bash
./scripts/start-stack.sh
./scripts/stop-stack.sh
./scripts/logs-stack.sh both
```

## Interface web

Com o servidor rodando, acesse **http://localhost:8787**. A página inicial e os arquivos estáticos não exigem API key; apenas as rotas `/v1/*` usam o header `x-api-key` quando `API_KEY` está definida.

- **Conexões**: listar conexões salvas (clique em Conectar), conectar por nome, escolher modo **QR Code** ou **Pairing Code**, ver QR/código (atualizado automaticamente), listar instâncias ativas com ações (Desconectar, Novo QR, Deletar). Status é atualizado a cada 2 segundos enquanto a aba estiver aberta.
- **Painel por conexão**: cada conexão possui link para `/instance.html?instance=<nome>` com menu de dashboard, chats, configurações, eventos e integrações.
- **Disparos**: escolher instância, colar **lista de mailing** (um número por linha, com DDI), definir **intervalo mínimo e máximo** (em segundos) entre cada envio, escolher tipo de mensagem e preencher os campos (formulários dinâmicos com adicionar/remover). O envio é feito em lote com espera aleatória entre os números.
- **Integrações**: configurar **por instância** os dados de conexão do Chatwoot e n8n, salvar e testar conectividade diretamente pela interface.

## Endpoints

O header **`x-api-key`** é obrigatório apenas nas rotas `/v1/*` quando `API_KEY` está definida. As rotas `/health`, `/ready` e a interface em `/` não exigem key.

Escopos de autorização suportados por rota:

- `instances:*`
- `messages:send`
- `webhooks:*`
- `chats:*`
- `ops:read`
- `integrations:*`

Quando `API_KEYS_JSON` é informado, cada chave pode ter escopos diferentes. A `API_KEY` legada continua válida com escopo total (`*`).

`GET /metrics` está disponível em formato Prometheus (text/plain) para monitoramento.

### Contrato de resposta

- Toda resposta inclui `ok` e `requestId`.
- Erros padronizados: `{ "ok": false, "error": "machine_code", "message": "optional", "details": {} }`.
- O `requestId` tambem e retornado no header `x-request-id` para rastreamento.
- Endpoints canônicos de mensagem aceitam `idempotency-key` (ou `x-idempotency-key`) para deduplicação de envios.

### Politica de seguranca para URLs de saida

- Por padrao, destinos privados/internos sao bloqueados para reduzir risco de SSRF (`localhost`, `127.0.0.1`, redes RFC1918 e hostnames internos como `.local` e `.internal`).
- Esse bloqueio vale para:
  - webhooks globais (`/v1/webhooks/*` e worker de entregas)
  - eventos por instancia (`/v1/instances/:name/events`)
  - integracoes por instancia (Chatwoot/n8n)
- Em ambientes controlados, use as flags `ALLOW_PRIVATE_NETWORK_WEBHOOKS=true` e/ou `ALLOW_PRIVATE_NETWORK_INTEGRATIONS=true` para liberar.

### Instâncias

| Método | Rota | Descrição |
|--------|------|-----------|
| POST   | `/v1/instances` | Cria/conecta instância e retorna QR (body: `{ "instance": "main" }`) |
| GET    | `/v1/instances` | Lista instâncias ativas e nomes das conexões salvas (`saved`) |
| GET    | `/v1/instances/saved` | Lista apenas nomes das conexões salvas (pastas em `auth/`) |
| GET    | `/v1/instances/:name` | Status de uma instância |
| GET    | `/v1/instances/:name/qr` | QR em base64 (quando status = qr) |
| POST   | `/v1/instances/:name/pairing-code` | Gera pairing code (body: `{ "phoneNumber": "553598828503" }`) |
| GET    | `/v1/instances/:name/details` | Detalhes do painel (status, número, foto, perfil, settings) |
| POST   | `/v1/instances/:name/restart` | Reinicia a instância |
| GET    | `/v1/instances/:name/chats` | Conversas em cache da instância |
| GET    | `/v1/instances/:name/chats/:jid/messages` | Mensagens em cache do chat |
| GET    | `/v1/instances/:name/settings` | Configurações gerais + proxy |
| PATCH  | `/v1/instances/:name/settings/general` | Salva toggles gerais |
| PATCH  | `/v1/instances/:name/settings/proxy` | Salva proxy da instância |
| GET    | `/v1/instances/:name/events` | Lista webhook + toggles de eventos |
| PATCH  | `/v1/instances/:name/events` | Atualiza webhook + toggles |
| POST   | `/v1/instances/:name/events/test` | Envia evento de teste |
| POST   | `/v1/instances/:name/disconnect` | Desconecta e remove da memória (credenciais ficam em disco) |
| POST   | `/v1/instances/:name/logout` | Logout e apaga sessão em disco (próxima conexão gera novo QR) |
| DELETE | `/v1/instances/:name` | Remove instância da memória (fecha socket) |

### Mensagens (canonicas)

| Método | Rota | Descrição |
|--------|------|-----------|
| POST   | `/v1/messages/text` | Envia texto simples |
| POST   | `/v1/messages/media` | Envia mídia (`image`, `video`, `audio`, `document`, `sticker`) por URL |
| POST   | `/v1/messages/location` | Envia localização (latitude/longitude) |
| POST   | `/v1/messages/contact` | Envia contato em vCard |
| POST   | `/v1/messages/reaction` | Reage a uma mensagem por `messageId` |
| POST   | `/v1/messages/forward` | Reenvia conteúdo (`message`) ou texto |

### Mensagens (helpers)

| Método | Rota | Descrição |
|--------|------|-----------|
| POST   | `/v1/messages/send_menu` | Menu texto (opções numeradas) |
| POST   | `/v1/messages/send_buttons_helpers` | Botões quick reply (até 3) |
| POST   | `/v1/messages/send_interactive_helpers` | Botões CTA (URL, Copiar, Ligar) |
| POST   | `/v1/messages/send_list_helpers` | Lista dropdown (nativeList) |
| POST   | `/v1/messages/send_poll` | Enquete |
| POST   | `/v1/messages/send_carousel_helpers` | Carrossel com cards (imagem + botões) |

Em todos os endpoints de mensagens o body deve incluir **`instance`** (nome da instância) e **`to`** (número no formato `5511999999999`).

Quando `idempotency-key` é enviado, respostas repetidas para a mesma rota/instância/destinatário retornam o mesmo resultado com `idempotency.replayed = true`.

### Chats

| Método | Rota | Descrição |
|--------|------|-----------|
| POST   | `/v1/chats/:jid/read` | Marca mensagens como lidas (`messageIds`) |
| POST   | `/v1/chats/:jid/archive` | Arquiva chat |
| POST   | `/v1/chats/:jid/unarchive` | Desarquiva chat |
| POST   | `/v1/chats/:jid/pin` | Fixa chat |
| POST   | `/v1/chats/:jid/unpin` | Desfixa chat |
| POST   | `/v1/chats/:jid/mute` | Silencia chat |
| POST   | `/v1/chats/:jid/unmute` | Remove silencio do chat |

Observação: alguns recursos dependem de suporte do socket Baileys/InfiniteAPI ativo. Quando indisponivel, a API retorna `501`.

### Webhooks

| Método | Rota | Descrição |
|--------|------|-----------|
| GET    | `/v1/webhooks/events` | Lista eventos suportados |
| GET    | `/v1/webhooks` | Lista webhooks cadastrados |
| GET    | `/v1/webhooks/deliveries` | Lista entregas (`status`, `webhookId`, `limit`) (`status`: pending, processing, delivered, failed) |
| GET    | `/v1/webhooks/dlq` | Lista entregas em DLQ (`status=failed`) |
| POST   | `/v1/webhooks/dlq/purge` | Purga DLQ manualmente (`olderThanMs`) |
| GET    | `/v1/webhooks/deliveries/:deliveryId` | Detalhe de uma entrega |
| POST   | `/v1/webhooks/deliveries/:deliveryId/retry` | Reagenda uma entrega para retry imediato |
| POST   | `/v1/webhooks` | Cria webhook (`name`, `url`, `events[]`) |
| PATCH  | `/v1/webhooks/:id` | Atualiza webhook |
| DELETE | `/v1/webhooks/:id` | Remove webhook |
| GET    | `/v1/webhooks/:id/deliveries` | Entregas de um webhook específico |
| POST   | `/v1/webhooks/:id/test` | Enfileira evento de teste para entrega real |

Headers enviados na chamada de webhook:

- `x-webhook-event`
- `x-webhook-delivery-id`
- `x-webhook-webhook-id`
- `x-webhook-attempt`
- `x-webhook-timestamp`
- `x-webhook-signature` (quando houver segredo)

Assinatura HMAC:

- Algoritmo: SHA-256
- Payload assinado: `${x-webhook-timestamp}.${rawBodyJson}`
- Valor: hex em `x-webhook-signature`

Processamento de fila:

- Entregas são persistidas em SQLite (`WEBHOOK_DB_PATH`).
- Por padrão, a API inicia worker embutido (`WEBHOOK_EMBEDDED_WORKER_ENABLED=true`) para processar a fila mesmo no `npm run dev`.
- Worker dedicado (`npm run worker:webhooks`) faz claim distribuído por lease e pode rodar junto/à parte para escala horizontal.
- Falhas definitivas entram em DLQ (`status=failed`) e podem ser reprocessadas por endpoint de retry ou purge manual/automático.

### Integrações (por instância)

| Método | Rota | Descrição |
|--------|------|-----------|
| GET    | `/v1/integrations` | Lista integrações configuradas |
| GET    | `/v1/integrations/:instance` | Obtém configuração da instância |
| PATCH  | `/v1/integrations/:instance/chatwoot` | Atualiza configuração Chatwoot da instância |
| POST   | `/v1/integrations/:instance/chatwoot/test` | Testa credenciais Chatwoot (`GET /api/v1/profile`) |
| PATCH  | `/v1/integrations/:instance/n8n` | Atualiza configuração n8n da instância |
| POST   | `/v1/integrations/:instance/n8n/test` | Envia evento de teste para webhook n8n |

## Testes

```bash
npm test
```

O comando executa build TypeScript e a suite automatizada de validacoes criticas (normalizacao de instancia/JID e politica de URL outbound).

A suíte inclui também testes HTTP de integração para autenticação, validação de nomes de instância e bloqueio/aceite de URLs outbound em webhooks e integrações.

Campos principais sugeridos:

- Chatwoot: `enabled`, `baseUrl`, `accountId`, `inboxId`, `apiAccessToken`
- n8n: `enabled`, `webhookUrl`, `authHeaderName`, `authHeaderValue`

### Operações

| Método | Rota | Descrição |
|--------|------|-----------|
| GET    | `/v1/ops/alerts` | Avalia saúde operacional e retorna alertas + recomendações |
| GET    | `/v1/ops/audit` | Lista eventos recentes de auditoria (`?limit=`) |

## Exemplo rápido

1. Subir a API e abrir a interface em http://localhost:8787 (ou criar instância via API):

```bash
curl -X POST http://localhost:8787/v1/instances \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{"instance": "main"}'
```

2. A resposta pode trazer `qr` em base64. Exiba a imagem ou use `GET /v1/instances/main/qr` até conectar. Na interface, o QR e o status são atualizados automaticamente.

3. Enviar botões:

```bash
curl -X POST http://localhost:8787/v1/messages/send_buttons_helpers \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "553598828503",
    "text": "Como posso ajudar?",
    "footer": "Atendimento 24h",
    "buttons": [
      {"id": "vendas", "text": "Fazer Pedido"},
      {"id": "suporte", "text": "Suporte"}
    ]
  }'
```

## Licença

MIT.
