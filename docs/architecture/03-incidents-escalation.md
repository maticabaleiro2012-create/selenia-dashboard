# Incidentes comunes y escalación

## Patrones frecuentes (no exhaustivo)

| Síntoma | Causa raíz probable | Primer chequeo |
|---------|-------------------|----------------|
| Core v2 `/health` no OK | Worker Core, Neon, vars | `/ops/audit` probe `core-v2-health` |
| Legacy `/health` no OK | onbox-core desplegado / rutas | probe `onbox-core-health` |
| Gastro `/api/health` no OK | Proxy, rutas legacy en worker proxy | probes gastro en overview |
| 401 en rutas con datos | `CORE_API_TOKEN` ausente o inválido | `connectors/health` + overview `meta` |

## Escalación (plantilla)

- **Plataforma / Core**: dueño equipo backend; evidencia = JSON de audit + Core logs (fuera de Selenia).
- **Gastronomía proxy**: dueño equipo logística-gastronomía; correlación con `GASTRONOMIA_PROXY_URL`.
- **Seguridad** (ej. clientes sin `password_hash`): revisar `auth-audit` con token; no divulgar listados en chat público.

## SLAs

Los SLAs reales viven en acuerdos de equipo; Selenia solo puede **reflejar** lo documentado aquí y lo observable en APIs. Actualizar este archivo cuando cambien objetivos.
