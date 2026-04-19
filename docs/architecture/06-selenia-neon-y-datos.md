# Selenia: plan, contexto, “cómo piensa” y datos (Neon)

## ¿Puedo ver el plan y el contexto?

Sí, en tres capas complementarias:

1. **Docs en Git** (`docs/architecture/*.md`) — fuente de verdad humana; el bundle `worker/src/generated/context-bundle.json` se genera con `npm run build:context` y se inyecta en el system prompt como **“Contexto OnBox (curado)”** (versión + hash en el texto).
2. **Panel “System Architect”** en el Command Center — muestra versión/hash del bundle, KV y conteos D1 sin pasar por el modelo.
3. **Endpoints** `GET /ai/knowledge`, `/ai/roadmap`, `/ai/insights` — observabilidad (opcionalmente protegidos con `SELENIA_INTERNAL_KEY`).

## ¿Cómo “piensa” Selenia?

No hay un motor de razonamiento aparte: es **Claude** con tu **system prompt** (`worker/src/prompts.js`), el **mapa operativo**, gobernanza (Council lite), el **snapshot del panel** si el UI lo manda, y las **tools** (solo lo que esté cableado en el Worker). No inventa APIs ni credenciales.

## ¿La arquitectura “exacta” de mi sistema?

La que **vos versionás en markdown** (este directorio) + lo que reflejen **Core v2** y los probes (`/ops/overview`, `/ops/audit`). Selenia alinea lenguaje y chequeos a eso; si querés más precisión, mejorá cada `.md` en PR y redeploy.

## ¿Tiene acceso a mi base de datos Neon?

**No directamente.** El Worker **no** usa connection string a Neon. Los datos viven en Neon detrás de **Core v2** (`CORE_V2_URL`). Selenia llama a **HTTP** documentado (GET inventario, monitor de pedidos, etc.) con `CORE_API_TOKEN` si lo configurás.

## ¿Puede editar la base de datos?

Solo **a través de endpoints de Core v2** que ya existan (allowlist en el Worker), y **solo si en el chat aparece la frase exacta `APROBADO_DATOS`** en un mensaje del usuario (misma idea que `APROBADO_SELENIA` para CI). Hoy está cableado el inventario FIFO documentado:

- `POST /inventory/stock/apply`
- `POST /inventory/stock/reverse`

No hay SQL libre ni acceso a tablas arbitrarias desde Selenia.

## Módulos de negocio vs plataforma

| Capa | Qué es |
|------|--------|
| **Módulos (UI)** | Los 6 verticales del panel (gastronomía, logística, …) — comandos allowlist y métricas mostradas. |
| **Plataforma** | Core v2 (Neon), legacy onbox-core, proxies (gastronomía), Workers, Selenia, CI — salud en `/ops/audit` y overview. |

## Errores tipo “no descontó stock”

Selenia puede **sugerir** hipótesis y qué revisar (monitor + líneas de pedido + movimientos) usando tools de lectura; **confirmar** un fallo de negocio concreto suele requerir datos en Core (líneas, `inventory_orders_applied`, movimientos). La tool `get_operational_hints` resume señales y preguntas de seguimiento sin afirmar causas sin evidencia.
