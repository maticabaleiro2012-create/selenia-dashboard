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

## Objetivo “autonomía tipo banco”

Capas típicas: observabilidad, allowlist estricta, **Cloudflare Access** delante del dashboard si exponés acciones, CI para cambios peligrosos, y cero API keys en el browser. El Worker cubre Anthropic + Core; el “24/7” real son **cron en Actions** o **Workers cron** cuando quieras pagar ese tráfico — empezá con dispatch manual para mantener costo ~0.
