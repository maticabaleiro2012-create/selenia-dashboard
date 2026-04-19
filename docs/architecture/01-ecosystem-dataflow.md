# Ecosistema y flujo de datos

## Componentes

- **Core v2 (Neon)**: pedidos, inventario por ubicación, depósitos, monitor de pedidos, clientes (`/health`, rutas con Bearer según `CORE_API_TOKEN`).
- **Onbox Core (legacy)**: API histórica; mismo ecosistema pero migración gradual hacia v2.
- **Gastronomía (proxy Worker)**: admin, Airtable, cadetes, KB D1; probes `GET /health` y `GET /api/health` del proxy.
- **Selenia Command Center**: panel + chat Anthropic; agrega `/ops/overview` y `/ops/audit`; tools allowlist hacia Core y comandos de módulo.

## Dependencias (orden de lectura operativa)

1. Core v2 `/health` y legacy `/health` definen “plataforma viva”.
2. Sin token Core: omiten rutas privadas; el overview igual documenta el contrato en `contract`.
3. Gastronomía: si `/health` del proxy falla, el módulo UI “gastronomía” se marca degradado en overview.
4. Selenia **no** ejecuta shell ni deploy directo: CI / humano.

## Modelos de datos (alto nivel)

- **Pedidos**: monitor y APIs Core v2 (estructura según README Core / fulfillment-api).
- **Inventario**: `inventory/summary` por ubicación (onbox vs fulfillment).
- **Clientes**: `auth-audit` y flujos de registro (Neon); no inventar conteos sin respuesta API.
