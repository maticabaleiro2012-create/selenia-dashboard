# Selenia — Command Center

Panel para módulos OnBox, event stream y chat con **Claude (Anthropic)**. Hay dos formas de correrlo:

| Modo | Cuándo | Comando |
|------|--------|---------|
| **Node local** | desarrollo rápido en tu PC | `npm start` |
| **Cloudflare Worker** | mismo origen para UI + API (recomendado prod) | `npm run cf:dev` o `npm run deploy` |

## Cloudflare Worker (prod / preview)

1. `npm install`
2. Crear el worker en tu cuenta (la primera vez `npm run deploy` te guía).
3. Secretos (no van en git):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CORE_API_TOKEN   # opcional, si Core exige Bearer
```

4. Revisá `wrangler.toml` → `CORE_V2_URL` (default apunta al Core v2 de prod; cambiá en `[env.preview.vars]` si agregás entorno preview).

5. Deploy:

```bash
npm run deploy
```

6. Dev local con el mismo runtime que prod:

```bash
npm run cf:dev
```

Archivos: `worker/src/index.js` (API), `public/index.html` (UI), `wrangler.toml`.

### Contexto curado + bundle (System Architect)

- **Fuente de verdad en Git**: [`docs/architecture/`](docs/architecture/) — ecosistema, pedidos, incidentes, roadmap humano. Owner: equipo Sistemas (PR + review).
- **Artefacto embebido**: `npm run build:context` genera [`worker/src/generated/context-bundle.json`](worker/src/generated/context-bundle.json) (hash + versión). Se ejecuta en **predeploy** al hacer `npm run deploy` y en CI antes de `wrangler deploy`.
- **Runtime**: el bloque *Contexto OnBox (curado)* se inyecta en el system prompt (`worker/src/context.js`, `prompts.js`). Herramienta **`get_architecture_doc`** devuelve secciones del bundle.
- **KV + observabilidad**: claves `selenia:kb:main` y `selenia:roadmap:main`. **GET** [`/ai/knowledge`](worker/src/index.js), [`/ai/roadmap`](worker/src/index.js), [`/ai/insights`](worker/src/index.js) — si configurás `SELENIA_INTERNAL_KEY` (Worker: `wrangler secret put SELENIA_INTERNAL_KEY`), enviá header **`X-Selenia-Internal-Key`**. **POST** [`/ai/knowledge/merge`](worker/src/index.js) mergea JSON en KV (mismo header si aplica).
- **D1** (Worker): binding `SELENIA_DB` en `wrangler.toml`; migración inicial `worker/migrations/0001_init.sql`. Aplicar remoto: `npx wrangler d1 execute SELENIA_DB --remote --file=worker/migrations/0001_init.sql`. Tools **`list_pending_insights`** y **`query_d1_tables`**.
- **Insights con human-in-the-loop**: **POST** `/ai/insights` crea fila `pending`; **POST** `/ai/insights/:id/promote` con body `{ "confirm": "APROBADO_MEMORIA" }` + header interno si corresponde.
- **Datos Core v2 (Neon vía API, no SQL libre)**: en el chat, la tool `core_v2_inventory_write` hace `POST` a `/inventory/stock/apply` o `/inventory/stock/reverse` solo si el usuario escribió **`APROBADO_DATOS`** en el historial. Requiere `CORE_API_TOKEN` en el Worker. Otras tools de lectura: `get_operational_hints`, `get_orders_snapshot`, `get_order_lines`. Detalle: [`docs/architecture/06-selenia-neon-y-datos.md`](docs/architecture/06-selenia-neon-y-datos.md).
- **Snapshot a docs (PR)**: workflow [`onbox-universe/.github/workflows/selenia-insights-snapshot.yml`](../../.github/workflows/selenia-insights-snapshot.yml) (manual) corre [`scripts/snapshot-promoted-insights.mjs`](scripts/snapshot-promoted-insights.mjs) y abre PR con `docs/architecture/05-insights-promoted.md`. Requiere secrets `SELENIA_BASE` y opcionalmente `SELENIA_INTERNAL_KEY`.
- **Paridad local**: `server.js` expone los mismos paths; KV e insights en memoria; D1 solo en Cloudflare.
- **UI**: en `public/index.html`, bloque **System Architect — contexto & memoria** muestra bundle (versión/hash), KV y conteos D1 (insights pending/promoted); clave interna opcional guardada en `localStorage` (`selenia_internal_key_ui`).

## Node local

```bash
copy .env.example .env   # Windows
```

Completá `ANTHROPIC_API_KEY` en `.env`, luego `npm start` y abrí **http://127.0.0.1:8780/**.

`server.js` sirve `public/index.html` y replica los mismos endpoints que el Worker (más `SELENIA_GATEWAY_URL` si querés proxy genérico).

## ¿Terminal? ¿Ejecutar comandos?

- **En Cloudflare Workers no hay bash ni terminal.** No se puede `ssh` ni `npm run migrate` dentro del isolate.
- Lo que sí podés es **“comandos” = HTTP** hacia tus workers (Core, Admin, etc.) con tokens solo en el Worker (`wrangler secret`).
- En `worker/src/index.js` hay una **allowlist** (ej. `sistemas` → `health-check` llama `GET {CORE_V2_URL}/health`). Los demás comandos del UI devuelven “no cableado” hasta que agreguemos cada mapping con cuidado.
- Para **scripts / migraciones / deploy**: lo sano es **GitHub Actions** (`workflow_dispatch`) o **CI**, y opcionalmente que el Worker dispare el workflow con un `GITHUB_TOKEN` guardado como secret (siguiente iteración).

## Council + aprobación humana (bajo costo)

- **Un solo request por mensaje** a Anthropic incluye *council compacto* (Contrarian, Ejecutor, Ojo fresco, Recomendación) y reglas de gobernanza. Es la forma barata de “no cagarla”: no son 5 sub-agentes como en Cursor, pero fuerza tensión y checklist.
- **APROBADO_SELENIA**: la IA no debe tratar como ejecutado ningún paso irreversible (deploy prod, migraciones, borrados masivos, rotación de secrets) hasta que vos mandés exactamente esa frase en el chat. El Worker registra el evento `selenia.human_approval` en el stream.
- **Historial de chat**: el front manda `messages[]` completo; **no usamos KV** para eso → costo de storage ~$0; solo pagás tokens de Anthropic.
- **Checkbox “Council”**: desactivalo para respuestas más cortas (menos tokens de salida) en preguntas simples.
- **Decisiones enormes** (pivot de producto, arquitectura): usá el skill **llm-council** en el repo OnBox (`.cursor/skills/llm-council/`) con Cursor; Selenia queda para operación diaria con council lite.

## GitHub Actions (sin cron = sin costo fijo)

`.github/workflows/selenia-ci.yml` — solo **workflow_dispatch**. Default `dry_run: true` valida el bundle. Para deploy desde GitHub: `dry_run: false` y secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

### Cadena APROBADO_SELENIA → deploy (repository_dispatch)

1. En el repo **selenia-dashboard** ya existe `.github/workflows/selenia-repository-dispatch.yml` (escucha `repository_dispatch` con tipo `selenia_approved`).
2. En GitHub → Settings → Developer settings → PAT (**fine-grained**): permisos sobre ese repo → **Contents: Read and write** (alcanza para `dispatches`) + **Metadata read**. O PAT classic con scope `repo`.
3. En Cloudflare Worker (o `.env` local):
   - `wrangler secret put GITHUB_TOKEN`
   - Variable **`GITHUB_REPO`**: `owner/repo` (mismo repo del workflow). Podés setearla en el dashboard del worker o `wrangler versions upload` con `[vars]` en un env aparte.
   - Opcional `wrangler secret put SELENIA_DISPATCH_KEY`: si existe, cada disparo exige la misma clave en el campo **Clave dispatch** del UI o header `X-Selenia-Dispatch-Key` (recomendado si el dashboard es público).
4. En el chat, cuando la IA pidió confirmación, mandá **`APROBADO_SELENIA`**. Después de la respuesta de Claude, el Worker llama a `POST /repos/{GITHUB_REPO}/dispatches` y GitHub encola el job de deploy.

Sin `GITHUB_TOKEN` o `GITHUB_REPO`, el chat sigue igual y `githubDispatch` en la API indica `skipped`.

## Objetivo “autonomía tipo banco”

Capas típicas: observabilidad, allowlist estricta, **Cloudflare Access** delante del dashboard si exponés acciones, CI para cambios peligrosos, y cero API keys en el browser. El Worker cubre Anthropic + Core; el “24/7” real son **cron en Actions** o **Workers cron** cuando quieras pagar ese tráfico — empezá con dispatch manual para mantener costo ~0.
