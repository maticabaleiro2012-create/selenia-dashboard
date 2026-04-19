# Workflow crítico: pedido end-to-end

## Feliz camino (referencia)

1. **Ingreso**: canal (marketplace, gastro app, etc.) → Core v2 u orquestación según producto.
2. **Fulfillment**: asignación logística / cocina según módulo gastronomía y reglas de negocio.
3. **Facturación / cierre**: módulo financiera / AFIP según jurisdicción (no asumir sin datos).

## Puntos de coordinación

- Estados de pedido y SLA real dependen de **Core v2** y del proxy gastronómico; Selenia debe usar **tools** o overview, no suposiciones.
- Cualquier “fix” que toque datos productivos requiere **APROBADO_SELENIA** (o proceso humano equivalente) antes de tratarse como ejecutado.

## Métricas que importan (operativas)

- Tasa de error de probes en `/ops/audit`.
- `ordersMonitorCount` y salud de `/orders/monitor` cuando hay token.
- Incidentes activos en `overview.incidents`.
