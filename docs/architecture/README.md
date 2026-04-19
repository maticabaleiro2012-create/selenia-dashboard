# Arquitectura OnBox (contexto curado para Selenia)

**Owner:** equipo OnBox / Matias Cabaleiro (actualizar en PR si cambia).

Estos documentos son la **fuente de verdad** que Selenia inyecta como “System Architect” (vía bundle generado en deploy). No reemplazan métricas en vivo: siempre validar con `/ops/overview`, `/ops/audit` y tools de Core.

| Archivo | Contenido |
|---------|-----------|
| [01-ecosystem-dataflow.md](01-ecosystem-dataflow.md) | Flujo Core v2 ↔ legacy ↔ gastronomía y dependencias |
| [02-order-lifecycle.md](02-order-lifecycle.md) | Workflow crítico pedido end-to-end |
| [03-incidents-escalation.md](03-incidents-escalation.md) | Fallas típicas, causas raíz probables, escalación |
| [04-roadmap-human.md](04-roadmap-human.md) | Roadmap y deuda prioritaria (humano, versionado en git) |
| `05-insights-promoted.md` (opcional) | Snapshot auto-generado por workflow `selenia-insights-snapshot` desde D1 (`status=promoted`) |
| [06-selenia-neon-y-datos.md](06-selenia-neon-y-datos.md) | FAQ: contexto, Neon, edición de datos vía Core, módulos vs plataforma |

## Cómo actualizar

1. Editá los `.md` en este directorio.
2. Ejecutá `npm run build:context` (o `npm run deploy`, que lo dispara antes).
3. Commit del `worker/src/generated/context-bundle.json` actualizado **o** solo los `.md` si el CI regenera el bundle.

## Límites

- El bundle se trunca al inyectarse en el system prompt (ver `worker/src/context.js`).
- Para detalle largo usá la tool `get_architecture_doc` en el chat (sección por id).
