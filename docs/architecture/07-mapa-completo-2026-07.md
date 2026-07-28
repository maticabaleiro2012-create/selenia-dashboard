# Mapa maestro OnBox — remapeo completo 2026-07-28

> Censo total del ecosistema, generado por barrido de código real (no de memoria).
> Es LA referencia actual; si contradice a docs 01-06, gana este.

## Visión de conjunto

OnBox Logística opera **3 divisiones** sobre Cloudflare Workers + Neon Postgres:

1. **PAQUETES** (fulfillment/última milla e-commerce) — 9 workers, Neon `ep-steep-scene` (sa-east-1).
2. **GASTRONOMÍA** (última milla para locales de comida) — 2 workers + app Expo 4-variantes, Neon PROPIA `ep-dawn-water`.
3. **Transversales** — web institucional (Pages), Selenia (este command center), apps Android nativas.

Regla de oro: **core-v2 es el hub de paquetes** (fuente única de orders/stock/clientes); los demás workers delegan por service binding. En gastro el hub es `logistica-gastronomica-proxy`.

## División PAQUETES — workers

| Worker | Rol | Señas particulares |
|---|---|---|
| **onbox-core-v2** (`core-v2/`, ~35k líneas) | NÚCLEO: orders, stock FIFO (lots/inventory_movements), clientes, WMS (warehouse_locations + unit_key muebles), packing, catálogo maestro, carriers OCA/Andreani (R2 CARRIER_LABELS), cc_*, storage billing, wa_outbox (Twilio), /track | Crons: stock-watchdog */15min + WMS velocity dom 4am. Bindings salientes: OPS_UPSTREAM, STOCK_SYNC |
| **portal-logistico** (`ops/`) | Operaciones: colecta/ruteo, zonas+geocoding (Google Maps), drivers, despacho, caja MP, reingresos, seller-cutoffs (cutoff.js ART), carriers ML sync | Cron 0 */4: auto-link seller IDs. Llama CORE_V2, DELIVERY, ML_SYNC |
| **onbox-portal** (`portal/`, 76k líneas — el más grande) | Portal de sellers: pedidos, catálogo, stock, CC, presupuestos (convert → WEB-<nro>), facturación AFIP, ML OAuth, TN/Shopify | Cron */5: enrich costos + Airtable mirror |
| **onbox-pedidos** (`pedidos/`) | Alta liviana de pedidos (Neon-only, Airtable writes OFF); acepta explicitOrderId WEB/PRES con dedup | — |
| **onbox-admin** (`admin/`) | Consola superadmin: monitor órdenes, patas/rentabilidad, comprobantes, cadetes-gastro (proxy GASTRO_SERVICE), /divisiones Command Center | Crons deshabilitados a propósito (pisaban seller_id) |
| **onbox-delivery-app** (`delivery-app/`) | Backend + WebView choferes: my-route, label-scan FLEX (resuelve QR ML), proof fotos (R2 DELIVERY_PROOFS), FCM push, /apk + /envios.apk | Cron */5: healthcheck del SQL de my-route |
| **onbox-finance** (`finance/`) | Finanzas paquetes: CC, settlements transportistas (R2), AFIP (binding onbox-facturacion), storage_charges/subscriptions, cashflow, patas | Crons lunes 11 + día 1 + día 16 (recordatorios) |
| **onbox-tracking** | Página pública seguimiento (seguimiento.onboxservicioslogisticos.com) — SOLO LECTURA vía CORE_V2, sin secrets | — |
| **onbox-empaque** (`modules/empaque/`) | Mesa de empaque + WMS visual (plano 2D/3D, muebles con unit_key, picker por cuerpo/nivel, asignación masiva de clientes) — cookie httpOnly, valida contra core-v2 /packing/auth | Front = archivos reales public/ con ?v= bump |

Auxiliares: `label-scanner-worker` (dedup por envío_id), `onbox-crashlog` (beacon crashes app repartidores, temporal), `onbox-core` LEGACY (binding CORE aún referenciado — en extinción).

## División GASTRONOMÍA

- **logistica-gastronomica-proxy** (`worker.js` ~22k líneas, en `modules/app-clientes-gastronomia-onbox/`): cadetes (auth/turnos/on-demand/GPS/performance/pagos), clientes-locales (auth/orders/tracking/CC/MP), admin (dashboard/turnos/tarifas-zona/zonas/despacho-ML/liquidación/incidentes), push Expo segmentado por zona, sync Airtable→Neon one-way, IA propia (OpenAI + D1 kb). Crons: 6am diario (sync+performance+cierres) y */15 (recordatorios turno + alerting).
- **onbox-finanzas** (`worker-finanzas.js` ~19k líneas): CC de locales (cc_movements/anulados/cadenas cliente_principal_id), conciliación MP (reglas aprendibles), cobranza WhatsApp Twilio (wa_cobranza_*), AFIP Factura A/NC, conciliacion_diaria (6 checks), scheduler cargos (toggle OFF). Cron 03:10 ART.
- **App Expo multi-variante** (APP_VARIANT): `clientes` (locales), `repartidores` (cadetes, GPS on-duty, OTA canal repartidores — ver incidente 27-jul en docs 03), `admin` (~35 pantallas), `portal` (default, reusa clientes). EAS cuenta onboxlogistica.

Tablas gastro clave: cadetes, cadet_users, reserva_turnos(+_cadetes), turnos_fijos_am/pm, shift_claims, cadete_incidents, cadete_performance, cadete_pagos, push_tokens, clientes, delivery_tracking, tarifas_zona(+draft/history), zonas, loans, cuentas_corrientes, pagos, servicios_diarios, conciliacion_diaria.

## Otras piezas

- **web-site/** → Cloudflare Pages `onbox-logistics` (www.onboxservicioslogisticos.com): landings SEO por zona + altas gastro.
- **delivery-scanner-android/** → app Kotlin de PLANTA (escanea etiquetas y asigna a repartidores contra onbox-delivery-app; APK 3.6.13, keystore nuevo respaldado en R2).
- **label-scanner-system/** → app Android de escaneo ML v4 (QR JSON id/sender_id) + worker; regla de oro: dedup por ENVÍO.
- **marketplace-blueprint** (onbox-market): prototipo B2C SIN front — dormido. `onbox-orders-api` y `get-shit-done`: submódulos sin checkout — muertos.
- **Selenia** (`modules/selenia-dashboard/`): este command center — chat Claude (ANTHROPIC_API_KEY), context bundle desde docs/architecture, snapshots D1 cada 30min, y desde 2026-07-28 **watchdog** (ver abajo).

## Datos e infraestructura

- **Neon paquetes** `ep-steep-scene-acqsuknf` — orders/lots/clients/warehouse/cc/finance/etc.
- **Neon gastro** `ep-dawn-water-actahwq3` — todo lo de gastronomía (¡separada a propósito!).
- **R2**: product-images-v2, carrier-labels, delivery-proofs-v2, settlements-v2, onbox-crashlog, cadetes-onboarding-photos (todos los históricos migrados a `-v2` tras la corrupción de buckets 2026-07-20; los viejos revivieron y quedan de backup).
- **D1**: selenia-kb (knowledge/snapshots/watchdog), onbox_ai_kb (gastro).
- **Airtable**: SOLO espejo/legacy (paquetes: fallback lecturas; gastro: sync one-way + servicios diarios). Neon-first en todo.

## Integraciones externas (quién habla con quién)

Mercado Libre (portal OAuth + ops sync + delivery-app FLEX resolver + core-v2), Mercado Pago (portal/ops caja/finance/gastro MP + conciliación), Shopify + TiendaNube (core-v2/portal/pedidos), AFIP (finance + portal + finanzas-gastro, vía onbox-facturacion gateway), Twilio WhatsApp (core-v2 wa_outbox logística [OFF esperando secrets] + finanzas-gastro cobranza [sender prueba]), Expo Push (gastro), FCM (delivery-app/admin), Google Maps/People, OpenAI (solo gastro IA), Resend (emails).

## Vigilante Selenia (watchdog, 2026-07-28)

Cron 30min + POST /watchdog/run. Familias: (1) salud HTTP de 8 workers; (2) integridad de datos vía SQL read-only en ambas Neon — regresión fechas UTC, pedidos sin líneas 72h, lotes negativos, **muebles sin unit_key = detector de clobber de core-v2**, wa_outbox trabada, conciliación diaria en rojo, incidentes cadetes >48h, turnos de hoy sin cadete; (3) anomalía de volumen (ayer vs mismo día-de-semana ×4 semanas, ±45%). Findings en D1 `watchdog_finding` con auto-resolución; expuestos en /watchdog/findings|summary y SIEMPRE inyectados al contexto del chat de Selenia.

## Riesgos y reglas operativas vigentes (2026-07-28)

1. **CLOBBER entre sesiones**: el 27-jul se pisó core-v2 3 veces + admin + empaque deployando desde worktrees viejos. REGLA DURA: `git fetch && git rev-list --left-right --count master...HEAD` antes de CUALQUIER deploy; si no es 0 → mergear master primero. Todo el trabajo vivo se commitea a master (GitHub maticabaleiro2012-create/onbox-universe).
2. **Jamás deployar core-v2/empaque/admin desde el worktree gastro** (core-v2 fósil del 14-jul).
3. App repartidores: OTA solo tras verificar bundle (tsc + expo export) — el auto-updater convierte un update roto en loop de flota (guard anti-loop en App.tsx desde 27-jul; incidente abierto: reinicios con causa local al device, beacon listo sin publicar).
4. Rotaciones pendientes: token Expo, Twilio auth token, logins compartidos (ops/empaque/finanzas Admin), keystore passwords en build.gradle, y las URLs Neon presentes en scripts commiteados.
5. Deploys "money-safe": facturación/cobros se regresionan al centavo antes de deployar (patrón baterías de tests en cobranzas/facturación).
