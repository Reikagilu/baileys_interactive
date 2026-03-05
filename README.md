# rscara

API em **TypeScript** para múltiplas contas WhatsApp usando [InfiniteAPI](https://github.com/rsalcara/InfiniteAPI) (fork do Baileys), com geração de QR code, gerenciamento de conexões e disparo de componentes especiais (botões, listas, carrossel, enquete). Inclui interface web para conectar números e enviar mensagens.

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
| `AUTH_FOLDER` | Pasta onde salvar credenciais por instância | auth |
| `PAIRING_CODE_ENABLED` | Habilita geração de pairing code | true |
| `PAIRING_DEFAULT_COUNTRY_CODE` | DDI padrão quando número vem sem DDI | 55 |

## Desenvolvimento

```bash
npm run dev
```

## Build e produção

```bash
npm run build
npm start
```

## Interface web

Com o servidor rodando, acesse **http://localhost:8787**. A página inicial e os arquivos estáticos não exigem API key; apenas as rotas `/v1/*` usam o header `x-api-key` quando `API_KEY` está definida.

- **Conexões**: listar conexões salvas (clique em Conectar), conectar por nome, escolher modo **QR Code** ou **Pairing Code**, ver QR/código (atualizado automaticamente), listar instâncias ativas com ações (Desconectar, Novo QR, Deletar). Status é atualizado a cada 2 segundos enquanto a aba estiver aberta.
- **Disparos**: escolher instância, colar **lista de mailing** (um número por linha, com DDI), definir **intervalo mínimo e máximo** (em segundos) entre cada envio, escolher tipo de mensagem e preencher os campos (formulários dinâmicos com adicionar/remover). O envio é feito em lote com espera aleatória entre os números.

## Endpoints

O header **`x-api-key`** é obrigatório apenas nas rotas `/v1/*` quando `API_KEY` está definida. A rota `/health` e a interface em `/` não exigem key.

### Instâncias

| Método | Rota | Descrição |
|--------|------|-----------|
| POST   | `/v1/instances` | Cria/conecta instância e retorna QR (body: `{ "instance": "main" }`) |
| GET    | `/v1/instances` | Lista instâncias ativas e nomes das conexões salvas (`saved`) |
| GET    | `/v1/instances/saved` | Lista apenas nomes das conexões salvas (pastas em `auth/`) |
| GET    | `/v1/instances/:name` | Status de uma instância |
| GET    | `/v1/instances/:name/qr` | QR em base64 (quando status = qr) |
| POST   | `/v1/instances/:name/pairing-code` | Gera pairing code (body: `{ "phoneNumber": "553598828503" }`) |
| POST   | `/v1/instances/:name/disconnect` | Desconecta e remove da memória (credenciais ficam em disco) |
| POST   | `/v1/instances/:name/logout` | Logout e apaga sessão em disco (próxima conexão gera novo QR) |
| DELETE | `/v1/instances/:name` | Remove instância da memória (fecha socket) |

### Mensagens (componentes especiais)

| Método | Rota | Descrição |
|--------|------|-----------|
| POST   | `/v1/messages/send_menu` | Menu texto (opções numeradas) |
| POST   | `/v1/messages/send_buttons_helpers` | Botões quick reply (até 3) |
| POST   | `/v1/messages/send_interactive_helpers` | Botões CTA (URL, Copiar, Ligar) |
| POST   | `/v1/messages/send_list_helpers` | Lista dropdown (nativeList) |
| POST   | `/v1/messages/send_poll` | Enquete |
| POST   | `/v1/messages/send_carousel_helpers` | Carrossel com cards (imagem + botões) |

Em todos os endpoints de mensagens o body deve incluir **`instance`** (nome da instância) e **`to`** (número no formato `5511999999999`).

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
