# Selenia — Command Center

Panel único para ver módulos OnBox, event stream y chat con **Claude (Anthropic)** vía API local.

## Arranque rápido

```bash
cd modules/selenia-dashboard   # o la ruta de este repo
npm install
copy .env.example .env         # Windows; en mac/linux: cp .env.example .env
```

Editá `.env` y poné `ANTHROPIC_API_KEY` (clave de [Anthropic Console](https://console.anthropic.com/)).

```bash
npm start
```

Abrí **http://127.0.0.1:8780/** (o el `PORT` que definas).

Sin API key, el dashboard carga pero el chat responde error hasta que configures Anthropic.

## Qué hace el servidor (`server.js`)

- Sirve `index.html`.
- `GET /health`, `GET /events/history`, `POST /ai/chat` — lo que espera el front.
- `POST /modules/:id/command` — hoy es **stub** local salvo que definas `SELENIA_GATEWAY_URL` apuntando a un gateway real OnBox.

## Objetivo “autonomía tipo banco”

Eso es varias capas: observabilidad (métricas, alertas), ejecutores acotados (PR bots, runbooks), revisiones humanas en cambios sensibles, y claves **nunca** en el browser. Este repo da el **paso 1**: IA fuerte con Claude detrás de un servidor tuyo, sin exponer la key al cliente.

Siguientes pasos razonables: Worker Cloudflare como proxy único, colas para tareas largas, webhooks de CI, y conectar comandos al core real vía `SELENIA_GATEWAY_URL`.
