---
source: Webfetch (official docs + GitHub)
library: Evolution API
package: evolution-api
topic: referencias-ui-ux-dashboard-conexao-webhook-integracoes
fetched: 2026-03-06T00:00:00Z
official_docs: https://doc.evolution-api.com
---

# Fontes coletadas

- https://github.com/EvolutionAPI/evolution-manager-v2
- https://github.com/EvolutionAPI/evolution-manager-v2/blob/main/src/pages/Dashboard/index.tsx
- https://github.com/EvolutionAPI/evolution-manager-v2/blob/main/src/pages/instance/DashboardInstance/index.tsx
- https://github.com/EvolutionAPI/evolution-manager-v2/blob/main/src/pages/instance/Webhook/index.tsx
- https://github.com/EvolutionAPI/evolution-manager-v2/blob/main/src/components/sidebar.tsx
- https://github.com/EvolutionAPI/evolution-manager-v2/blob/main/src/index.css
- https://github.com/EvolutionAPI/evolution-manager-v2/raw/main/docs/images/dashboard.png
- https://github.com/EvolutionAPI/evolution-manager-v2/raw/main/docs/images/chat.png
- https://doc.evolution-api.com/v2/api-reference/instance-controller/instance-connect.md
- https://doc.evolution-api.com/v2/api-reference/instance-controller/connection-state.md
- https://doc.evolution-api.com/v2/api-reference/webhook/set.md
- https://doc.evolution-api.com/v2/pt/configuration/webhooks.md
- https://doc.evolution-api.com/v2/pt/integrations/chatwoot.md
- https://doc.evolution-api.com/v2/pt/integrations/typebot.md

# Sinais práticos extraídos

- Visual: uso de cards, badges de status (open/connecting/closed), sidebar com grupos colapsáveis, header enxuto e foco em dados por instância.
- Tema: tokens HSL via CSS custom properties com variações clara/escura e acento em verde/teal.
- Conexão: fluxo com CTA para QR Code e pairing code no mesmo bloco de alerta quando instância não está aberta.
- Webhook: configuração por toggles (enabled/byEvents/base64) + URL + lista de eventos com "marcar todos/desmarcar todos".
- Integrações: arquitetura por módulos/páginas específicas (Chatwoot, Typebot, n8n, OpenAI, etc.) com formulários de configuração por instância.
