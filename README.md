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

## Objetivo “autonomía tipo banco”

Capas típicas: observabilidad, allowlist estricta, Access (Zero Trust) delante del dashboard, CI para cambios peligrosos, y cero API keys en el browser. El Worker cubre lo último para Anthropic y Core.
