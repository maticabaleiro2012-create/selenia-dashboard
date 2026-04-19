/**
 * Selenia local API — serves index.html and powers /ai/chat via Anthropic Claude.
 * Run: npm install && copy .env.example .env (set ANTHROPIC_API_KEY) && npm start
 */

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 8780);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const GATEWAY_URL = (process.env.SELENIA_GATEWAY_URL || '').replace(/\/$/, '');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = (process.env.GITHUB_REPO || '').trim();
const GITHUB_DISPATCH_EVENT = (process.env.GITHUB_DISPATCH_EVENT || 'selenia_approved').trim();
const SELENIA_DISPATCH_KEY = process.env.SELENIA_DISPATCH_KEY || '';

const CORE_V2_URL = (process.env.CORE_V2_URL || 'https://onbox-core-v2.soporte-a90.workers.dev').replace(/\/$/, '');
const ONBOX_CORE_URL = (process.env.ONBOX_CORE_URL || 'https://onbox-core.soporte-a90.workers.dev').replace(/\/$/, '');
const CORE_API_TOKEN = String(process.env.CORE_API_TOKEN || '').trim();
const GASTRONOMIA_PROXY_URL = (
  process.env.GASTRONOMIA_PROXY_URL || 'https://logistica-gastronomica-proxy.soporte-a90.workers.dev'
).replace(/\/$/, '');

const START = Date.now();
const SELENIA_INTERNAL_KEY = String(process.env.SELENIA_INTERNAL_KEY || '').trim();
const KV_KB_MAIN = 'selenia:kb:main';
const KV_ROADMAP_MAIN = 'selenia:roadmap:main';
/** Simula KV de kb/roadmap en Node (misma semántica que Worker). */
const kbNodeStore = new Map();

let cachedContextBundleNode = undefined;
function getContextBundleNode() {
  if (cachedContextBundleNode !== undefined) return cachedContextBundleNode;
  try {
    const p = path.join(__dirname, 'worker', 'src', 'generated', 'context-bundle.json');
    cachedContextBundleNode = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    cachedContextBundleNode = { markdown: '', sections: [], version: '0', hash: '', generatedAt: 0 };
  }
  return cachedContextBundleNode;
}

function getBundledMetaNode() {
  const B = getContextBundleNode();
  const sections = Array.isArray(B.sections) ? B.sections : [];
  return {
    version: String(B.version || '0'),
    hash: String(B.hash || ''),
    generatedAt: B.generatedAt != null ? Number(B.generatedAt) : 0,
    sectionCount: sections.length,
    charCount: String(B.markdown || '').length,
  };
}

function getBundleExcerptNode(maxLen = 4000) {
  const B = getContextBundleNode();
  return String(B.markdown || '').slice(0, maxLen);
}

function getCuratedContextAppendLocal(maxChars = 12000) {
  const B = getContextBundleNode();
  const meta = getBundledMetaNode();
  const md = String(B.markdown || '');
  const header = `## Contexto OnBox (curado, docs/architecture)\nversion=${meta.version} sha256=${meta.hash} generatedAt=${meta.generatedAt}\n\n`;
  const rest = Math.max(0, maxChars - header.length);
  const slice = md.slice(0, rest);
  const tail = md.length > rest ? '\n…(bundle truncado para límite de tokens)' : '';
  return header + slice + tail;
}

function architectureDocToolResultNode(input) {
  const B = getContextBundleNode();
  const sectionId = input && typeof input.section_id === 'string' ? String(input.section_id).trim() : '';
  const sections = Array.isArray(B.sections) ? B.sections : [];
  if (!sectionId) {
    return JSON.stringify({
      index: sections.map((s) => ({ id: s.id, title: s.title })),
      hint: 'Repetí con section_id para el cuerpo completo de una sección.',
    });
  }
  const s = sections.find((x) => x.id === sectionId);
  if (!s) {
    return JSON.stringify({
      error: 'section_id desconocido',
      section_id: sectionId,
      known_ids: sections.map((x) => x.id),
    });
  }
  return JSON.stringify({ id: s.id, title: s.title, body: String(s.body || '').slice(0, 28000) });
}

function internalKeyOkNode(req) {
  if (!SELENIA_INTERNAL_KEY) return true;
  const got = String(req.headers['x-selenia-internal-key'] || '').trim();
  return got === SELENIA_INTERNAL_KEY;
}

async function kvGetJsonNode(key) {
  return kbNodeStore.get(key) || null;
}

/** Insights en memoria (paridad ligera con D1 del Worker). */
const insightMemoryNode = [];

/** Snapshots de diagnóstico en memoria (dev Node; en prod D1 en Worker). */
const diagnosticMemoryNode = [];

function buildTemporalDiagnosticReportNode(rows) {
  if (!rows.length) {
    return {
      ok: true,
      window: 'empty',
      message: 'Sin snapshots. Corré run_system_diagnostic o usá el Worker con D1.',
    };
  }
  const oldest = rows[rows.length - 1];
  const newest = rows[0];
  const o = oldest.payload?.summary || {};
  const n = newest.payload?.summary || {};
  const ao = oldest.payload?.audit_summary || {};
  const an = newest.payload?.audit_summary || {};
  const deltaOrders = (n.orders_in_monitor ?? 0) - (o.orders_in_monitor ?? 0);
  const deltaAuditFail = (an.fail ?? 0) - (ao.fail ?? 0);
  const mergedHints = new Map();
  for (const row of rows) {
    const hs = row.payload?.hints;
    if (Array.isArray(hs)) {
      for (const h of hs) {
        if (h && h.code) mergedHints.set(h.code, h);
      }
    }
  }
  return {
    ok: true,
    window: { from: oldest.created_at, to: newest.created_at, samples: rows.length },
    delta: {
      orders_in_monitor: deltaOrders,
      audit_fail_delta: deltaAuditFail,
      inventory_onbox_units_now: n.inventory_onbox_units,
      inventory_fulfillment_units_now: n.inventory_fulfillment_units,
    },
    recurring_hint_codes: [...mergedHints.keys()],
    recurring_hints: [...mergedHints.values()].slice(0, 12),
    suggested_next_steps: [
      'Actualizar roadmap (KV) y priorizar en insights.',
      'Correcciones Core: core_v2_*_write con APROBADO_DATOS.',
    ],
    auto_fix_policy:
      'Sin auto-fix silencioso. POST a Core solo con APROBADO_DATOS en el chat.',
  };
}

async function buildDiagnosticPayloadForNode(requestUrl) {
  const audit = await buildOpsAuditForNode(requestUrl);
  const audit_summary = {
    total: audit.summary?.total ?? 0,
    ok: audit.summary?.ok ?? 0,
    fail: audit.summary?.fail ?? 0,
  };
  const cv2 = String(CORE_V2_URL || '').replace(/\/$/, '');
  if (!cv2) {
    return {
      generatedAt: Date.now(),
      source: 'node',
      audit_summary,
      core: { error: 'CORE_V2_URL not set' },
      hints: [{ severity: 'error', code: 'no_core_url', detail: 'Falta CORE_V2_URL' }],
    };
  }
  const noopErr = () => {};
  const [ordersR, onb, ful] = await Promise.all([
    fetchJsonNode(`${cv2}/orders/monitor?all=1`, authHeadersNode(), 'hints', '/orders/monitor', noopErr),
    fetchJsonNode(
      `${cv2}/inventory/summary?location=onbox&byLocation=true&limit=2000`,
      authHeadersNode(),
      'hints',
      '/inventory/summary',
      noopErr
    ),
    fetchJsonNode(
      `${cv2}/inventory/summary?location=fulfillment&byLocation=true&limit=2000`,
      authHeadersNode(),
      'hints',
      '/inventory/summary',
      noopErr
    ),
  ]);
  const orderArr = extractOrdersArrayNode(ordersR.json);
  const orderCount = orderArr.length;
  const sumItems = (json) => {
    const items = json && Array.isArray(json.items) ? json.items : [];
    return items.reduce((a, row) => a + (Number(row?.total_available) || 0), 0);
  };
  const onboxUnits = onb.ok ? sumItems(onb.json) : null;
  const fulUnits = ful.ok ? sumItems(ful.json) : null;
  const hints = [];
  const tokenPresent = !!CORE_API_TOKEN;
  if (!tokenPresent) {
    hints.push({ severity: 'info', code: 'no_core_token', detail: 'CORE_API_TOKEN no configurado en .env.' });
  }
  if (!ordersR.ok) hints.push({ severity: 'warn', code: 'orders_monitor_fail', detail: `HTTP ${ordersR.status}` });
  if (!onb.ok) hints.push({ severity: 'warn', code: 'inventory_onbox_fail', detail: `HTTP ${onb.status}` });
  if (!ful.ok) hints.push({ severity: 'warn', code: 'inventory_fulfillment_fail', detail: `HTTP ${ful.status}` });
  if (orderCount > 0 && onboxUnits === 0 && fulUnits === 0 && onb.ok && ful.ok) {
    hints.push({
      severity: 'warn',
      code: 'orders_but_zero_inventory_sum',
      detail: 'Pedidos en monitor pero inventario suma 0 — investigar con líneas y movimientos.',
    });
  }
  return {
    generatedAt: Date.now(),
    source: 'node',
    audit_summary,
    summary: {
      orders_in_monitor: orderCount,
      inventory_onbox_units: onboxUnits,
      inventory_fulfillment_units: fulUnits,
      core_api_token_configured: tokenPresent,
      orders_http_ok: ordersR.ok,
      inventory_onbox_http_ok: onb.ok,
      inventory_fulfillment_http_ok: ful.ok,
    },
    hints,
    improvements: [
      'Roadmap: get_roadmap; trabajo futuro → insights.',
      'Stock: core_v2_inventory_write; líneas: core_v2_orders_write con APROBADO_DATOS.',
    ],
  };
}

const MODULES = {
  gastronomia: {
    status: 'running',
    manifest: {
      name: 'Gastronomía OnBox',
      commands: ['health-check', 'run-ci', 'ci-runs', 'listar-pedidos', 'nuevo-pedido', 'estado-cocina', 'asignar-delivery', 'dashboard'],
    },
  },
  logistica: {
    status: 'running',
    manifest: {
      name: 'Logística & Delivery',
      commands: ['asignar-envio', 'tracking', 'listar-drivers', 'optimizar-rutas', 'scan-paquete', 'dashboard'],
    },
  },
  'onbox-market': {
    status: 'running',
    manifest: {
      name: 'Onbox Marketplace',
      commands: ['listar-productos', 'publicar-ml', 'sync-stock', 'importar-ordenes', 'sync-shopify', 'sync-tiendanube', 'dashboard'],
    },
  },
  retail: {
    status: 'running',
    manifest: {
      name: 'Retail & Inventario',
      commands: ['consultar-stock', 'entrada-mercaderia', 'ajuste-inventario', 'alerta-stock-bajo', 'reporte-valorizado', 'dashboard'],
    },
  },
  sistemas: {
    status: 'running',
    manifest: {
      name: 'Sistemas & DevOps',
      commands: ['health-check', 'ci-gastro', 'ci-gastro-runs', 'actions-snapshot', 'deploy-preview', 'deploy-produccion', 'listar-workers', 'logs', 'dashboard'],
    },
  },
  financiera: {
    status: 'running',
    manifest: {
      name: 'Financiera & AFIP',
      commands: ['emitir-factura', 'consultar-ultimo-cbte', 'calcular-iva', 'crear-preferencia-mp', 'dashboard'],
    },
  },
};

const events = [];

function pushEvent(type, payload = {}) {
  events.push({ type, payload, meta: { timestamp: Date.now() } });
  if (events.length > 500) events.splice(0, events.length - 500);
}

pushEvent('selenia.boot', { version: '0.3.0', provider: 'anthropic' });
Object.keys(MODULES).forEach((id) => pushEvent('module.registered', { id }));
pushEvent('gateway.ready', {
  mode: GATEWAY_URL ? 'proxy' : 'local-stub',
  port: PORT,
  routes: [
    'health',
    'events',
    'ops/overview',
    'ops/audit',
    'ai/chat',
    'ai/threads',
    'ai/knowledge',
    'ai/roadmap',
    'ai/insights',
    'ai/diagnostics',
    'ai/diagnostics/snapshot',
    'modules/*/command',
  ],
});

// Sync with worker/src/prompts.js (governance + council lite)
const SYSTEM_BASE_LOCAL = `Sos Selenia, Command Center de OnBox (logística, e-commerce, gastronomía, 6 módulos).
Runtime: Node local (dev). En prod el mismo rol corre en Cloudflare Worker. No shell en el Worker; deploy vía CI.
Español rioplatense si el usuario escribe así. No inventés números de stock o pedidos sin datos de API.

Si el turno trae **Snapshot del panel** (JSON), usá solo eso como fuente de verdad para estado y cifras de este momento; no repitas el JSON ni listes todos los módulos salvo que pidan panorama. Si **no** hay snapshot, no afirmes métricas en vivo: decí que no tenés datos frescos del panel en este turno.

Con herramientas (get_ops_overview, get_ops_audit) o con JSON de ops, anclá números e IDs a campos explícitos (**contract**, **summary**, **probes**, **modules**, **incidents**). Si un dato no aparece ahí, no lo inventes.`;

const SYSTEM_MAP_LOCAL = `
## Mapa del ecosistema (referencia)

| Ámbito | Qué es | Estado / datos reales |
|--------|--------|------------------------|
| Core v2 (Neon) | Pedidos, inventario, depósitos | GET CORE_V2_URL/health; con CORE_API_TOKEN: /clients/auth-audit, /inventory/summary, /orders/monitor, /deposits — GET /ops/overview y GET /ops/audit |
| Onbox Core (legacy) | API histórica | GET ONBOX_CORE_URL/health |
| Gastronomía | Proxy Worker | GET GASTRONOMIA_PROXY_URL/health y /api/health |
| Selenia | Este servidor | GET /health, /connectors/health, /ops/overview, /ops/audit, /ai/knowledge, /ai/roadmap, /ai/insights, **GET /ai/diagnostics** (memoria local; Worker: D1), **POST /ai/diagnostics/snapshot**. Tools: **run_system_diagnostic** / **get_diagnostic_report** + ops + arquitectura + **get_operational_hints**, **get_orders_snapshot**, **get_order_lines**, **core_v2_inventory_write** + **core_v2_orders_write** (solo con **APROBADO_DATOS**). Sin auto-fix silencioso. D1 solo en Worker. Sin SQL directo a Neon. |
| Módulos UI (6) — negocio | Verticales | POST /modules/:id/command — run-ci / ci-gastro (APROBADO_SELENIA); ci-runs; actions-snapshot |
| Plataforma | Core v2, legacy, proxies | Datos vía HTTP Core; escrituras inventario con **APROBADO_DATOS** + tool allowlist |
| Más URLs | Otros servicios | env SELENIA_AUDIT_EXTRA = JSON [{ id, label, url }] para /ops/audit |

Para "auditar todo": priorizá tool get_ops_audit (igual que GET /ops/audit; **summary**, **probes**) + get_ops_overview; leé **contract** en el JSON.`;

const GOVERNANCE_FULL_LOCAL = `
## Gobernanza (obligatorio)

1. **Clasificá** mentalmente el pedido: SOLO_LECTURA | PROPONE_CAMBIOS | DEPLOY_INFRA | DATOS_SENSIBLES.
2. Si es PROPONE_CAMBIOS, DEPLOY_INFRA o DATOS_SENSIBLES: **no asumas que ya se ejecutó nada**. Proponé plan, riesgos, y rollback. Pedí aclaraciones si falta contexto.
3. **Aprobación explícita del humano** antes de dar por hecho cualquier paso irreversible (deploy prod, migraciones, borrados, rotación de secrets, escritura masiva). Hasta que el usuario no envíe exactamente la frase **APROBADO_SELENIA** (sola o en una línea), solo planificá y advertí; no simules que corriste el paso.
4. **Mutaciones Core v2** (inventario apply/reverse): solo con **APROBADO_DATOS** en el chat; sin acceso directo a Neon.
5. Si el usuario ya envió **APROBADO_SELENIA** en el historial reciente y el pedido sigue siendo el mismo: podés detallar pasos concretos siguientes (comandos sugeridos para CI, checks, orden), pero **seguí sin afirmar que el Worker ejecutó deploy** (no puede).
6. Preferí preguntas concretas (una o dos) antes de ramificar en muchas opciones.

## Council compacto (una sola respuesta, formato fijo)

Incluí siempre estas subsecciones con texto breve (máx. ~120 palabras en total en todo el bloque Council+Recomendación):

### Contrarian
Qué puede salir mal, qué falta, supuesto peligroso.

### Ejecutor
Primer paso concreto "el lunes" (o el próximo paso verificable).

### Ojo fresco
Qué puede no entender alguien afuera del equipo (jerga, ambigüedad).

### Recomendación
Qué harías vos y por qué, en 3-5 oraciones.

Si el pedido es trivialmente SOLO_LECTURA (definición, explicación de concepto sin acción), igual podés acortar el Council a 2-3 oraciones totales.

Si hay **Snapshot del panel** y el usuario pregunta algo operativo (qué falla, qué priorizar), acortá Contrarian/Ejecutor al mínimo útil: no re-narres el tablero entero.
`;

const GOVERNANCE_MINIMAL_LOCAL = `
## Gobernanza (obligatorio)
**APROBADO_SELENIA** para CI irreversibles. **APROBADO_DATOS** para mutaciones Core v2 allowlist. No SQL directo a Neon.
Respondé en formato breve: riesgo principal, recomendación, una pregunta si hace falta.
`;

function buildSystemPromptLocal(councilLite, dashboardSnapshotJson = '', curatedArchitectureAppend = '') {
  let out = SYSTEM_BASE_LOCAL + SYSTEM_MAP_LOCAL + (councilLite ? '\n' + GOVERNANCE_FULL_LOCAL : '\n' + GOVERNANCE_MINIMAL_LOCAL);
  const dash = typeof dashboardSnapshotJson === 'string' ? dashboardSnapshotJson.trim() : '';
  if (dash) {
    out += `\n\n## Snapshot del panel (JSON del cliente, este turno)\n${dash}\n`;
  }
  const arch = typeof curatedArchitectureAppend === 'string' ? curatedArchitectureAppend.trim() : '';
  if (arch) {
    out += `\n\n${arch}\n`;
  }
  return out;
}

function sanitizeDashboardContextLocal(raw) {
  if (raw == null) return '';
  let s = '';
  try {
    if (typeof raw === 'string') s = String(raw).trim();
    else if (typeof raw === 'object' && !Array.isArray(raw)) s = JSON.stringify(raw);
    else return '';
  } catch {
    return '';
  }
  const max = 20000;
  if (s.length > max) return `${s.slice(0, max)}\n…(truncado)`;
  return s;
}

const MAX_CHAT_MESSAGES = 24;

function normalizeAnthropicMessages(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const m of list) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.content || '').trim();
    if (!content) continue;
    out.push({ role, content });
  }
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged.slice(-MAX_CHAT_MESSAGES);
}

const MAX_STORED_THREAD_MESSAGES = 80;
const THREAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const threadMemory = new Map();

function isValidThreadId(id) {
  return typeof id === 'string' && THREAD_ID_RE.test(id.trim());
}

function trimThreadMessageContent(s) {
  const t = String(s || '');
  if (t.length <= 48000) return t;
  return t.slice(0, 48000) + '\n…(truncado)';
}

function readThreadDocNode(threadId) {
  return threadMemory.get(threadId) || null;
}

function writeThreadDocNode(threadId, messages) {
  if (!isValidThreadId(threadId)) return false;
  const normalized = normalizeAnthropicMessages(messages).slice(-MAX_STORED_THREAD_MESSAGES);
  const safe = normalized.map((m) => ({
    role: m.role,
    content: trimThreadMessageContent(m.content),
  }));
  const doc = { threadId, updatedAt: Date.now(), messages: safe };
  threadMemory.set(threadId, doc);
  return true;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function corsHeadersNode() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, X-Selenia-Internal-Key',
  };
}

function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

/** Misma definición que worker/src/chat-agent.js (Anthropic tools). */
const SELENIA_TOOL_DEFINITIONS_NODE = [
  {
    name: 'get_ops_overview',
    description:
      'Obtiene estado agregado del ecosistema (Core v2, legacy, inventario, pedidos monitor, gastronomía proxy, incidentes). Usalo cuando haga falta datos frescos más allá del snapshot del panel.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_ops_audit',
    description:
      'Ejecuta probes HTTP de solo lectura contra rutas documentadas. Para auditar conectividad.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_orders_monitor',
    description: 'Solo lectura: GET Core v2 /orders/monitor?all=1.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_inventory_location',
    description: 'Solo lectura: GET Core v2 /inventory/summary onbox o fulfillment.',
    input_schema: {
      type: 'object',
      properties: { location: { type: 'string', enum: ['onbox', 'fulfillment'] } },
      required: ['location'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_architecture_doc',
    description: 'Índice o sección del bundle docs/architecture.',
    input_schema: {
      type: 'object',
      properties: { section_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_system_knowledge',
    description: 'KV simulado en Node (kbNodeStore) bajo selenia:kb:main.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_roadmap',
    description: 'KV simulado selenia:roadmap:main.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_pending_insights',
    description: 'Insights pendientes (memoria en proceso en Node; D1 en Worker).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'query_d1_tables',
    description: 'Solo Worker con D1; en Node devuelve vacío.',
    input_schema: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          enum: ['knowledge_entry', 'roadmap_item', 'conversation_insight', 'diagnostic_snapshot'],
        },
        limit: { type: 'integer' },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_operational_hints',
    description: 'Lectura: hints operativos (monitor + inventario). Igual que Worker.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_orders_snapshot',
    description: 'Muestra recorte de pedidos del monitor Core v2.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_order_lines',
    description: 'GET /orders/lines?orderKey= en Core v2.',
    input_schema: {
      type: 'object',
      properties: { order_key: { type: 'string' } },
      required: ['order_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_system_diagnostic',
    description: 'Captura snapshot (memoria local Node o D1 en Worker) + informe ventana horas.',
    input_schema: {
      type: 'object',
      properties: { hours: { type: 'integer' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_diagnostic_report',
    description: 'Informe sin nueva captura (memoria local / D1 Worker).',
    input_schema: {
      type: 'object',
      properties: { hours: { type: 'integer' } },
      additionalProperties: false,
    },
  },
  {
    name: 'core_v2_orders_write',
    description: 'POST /orders/lines/upsert en Core v2; requiere APROBADO_DATOS.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lines_upsert'] },
        body: { type: 'object', additionalProperties: true },
      },
      required: ['action', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'core_v2_inventory_write',
    description: 'POST inventario Core v2; requiere APROBADO_DATOS en el chat.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['stock_apply', 'stock_reverse'] },
        body: { type: 'object', additionalProperties: true },
      },
      required: ['action', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_module_command',
    description:
      'Comando allowlist (mismo que POST /modules/:id/command). run-ci / ci-gastro solo si el usuario envió APROBADO_SELENIA en el historial del chat.',
    input_schema: {
      type: 'object',
      properties: {
        module_id: { type: 'string', enum: ['gastronomia', 'sistemas'] },
        action: {
          type: 'string',
          enum: [
            'health-check',
            'dashboard',
            'run-ci',
            'ci-gastro',
            'ci-runs',
            'ci-gastro-runs',
            'actions-snapshot',
            'logs',
            'listar-workers',
            'deploy-preview',
            'deploy-produccion',
          ],
        },
        payload: { type: 'object', additionalProperties: true },
      },
      required: ['module_id', 'action'],
      additionalProperties: false,
    },
  },
];

function transcriptHasHumanApprovalNode(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (m.role === 'user' && String(m.content || '').includes('APROBADO_SELENIA')) return true;
  }
  return false;
}

function transcriptHasDataApprovalNode(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (m.role === 'user' && String(m.content || '').includes('APROBADO_DATOS')) return true;
  }
  return false;
}

function extractOrdersArrayNode(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.data?.orders)) return data.data.orders;
  if (Array.isArray(data.orders)) return data.orders;
  return [];
}

function slimOrderRowNode(o) {
  if (!o || typeof o !== 'object') return { _note: 'invalid' };
  const pick = ['orderKey', 'order_key', 'id', 'external_id', 'status', 'state', 'channel', 'source', 'updatedAt', 'updated_at', 'createdAt', 'created_at'];
  const out = {};
  for (const k of pick) {
    if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  }
  if (Object.keys(out).length === 0) {
    try {
      return { _preview: JSON.stringify(o).slice(0, 500) };
    } catch {
      return { _preview: String(o).slice(0, 200) };
    }
  }
  return out;
}

function truncateToolResultNode(str, max = 28000) {
  const t = String(str || '');
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…(truncado)`;
}

function extractTextAndToolUsesNode(data) {
  const content = Array.isArray(data.content) ? data.content : [];
  const textParts = [];
  const toolUses = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) textParts.push(b.text);
    if (b.type === 'tool_use' && b.id && b.name) {
      toolUses.push({ id: b.id, name: b.name, input: b.input && typeof b.input === 'object' ? b.input : {} });
    }
  }
  return { text: textParts.join('').trim(), toolUses, rawBlocks: content };
}

async function executeNodeTool(requestUrl, approvals, name, input) {
  const ciApproval = approvals && approvals.ci;
  const dataApproval = approvals && approvals.data;
  if (name === 'get_ops_overview') {
    pushEvent('selenia.tool', { name });
    const ov = await buildOpsOverviewForNode();
    return JSON.stringify(ov);
  }
  if (name === 'get_ops_audit') {
    pushEvent('selenia.tool', { name });
    const body = await buildOpsAuditForNode(requestUrl);
    return JSON.stringify(body);
  }
  if (name === 'get_orders_monitor') {
    pushEvent('selenia.tool', { name });
    const cv2 = String(CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL not set' });
    const noopErr = () => {};
    const r = await fetchJsonNode(`${cv2}/orders/monitor?all=1`, authHeadersNode(), 'tool', '/orders/monitor', noopErr);
    const data = r.json;
    const ordersArr =
      r.ok && data && Array.isArray(data.data?.orders)
        ? data.data.orders
        : r.ok && data && Array.isArray(data.orders)
          ? data.orders
          : [];
    return JSON.stringify({
      contract: 'GET {CORE_V2_URL}/orders/monitor?all=1',
      http_ok: r.ok,
      http_status: r.status,
      orders_count: ordersArr.length,
    });
  }
  if (name === 'get_inventory_location') {
    const loc = String(input.location || '').trim();
    if (loc !== 'onbox' && loc !== 'fulfillment') {
      return JSON.stringify({ ok: false, error: 'location debe ser onbox o fulfillment' });
    }
    pushEvent('selenia.tool', { name, location: loc });
    const cv2 = String(CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL not set' });
    const noopErr = () => {};
    const url = `${cv2}/inventory/summary?location=${encodeURIComponent(loc)}&byLocation=true&limit=2000`;
    const r = await fetchJsonNode(url, authHeadersNode(), 'tool', '/inventory/summary', noopErr);
    const items = r.ok && r.json && Array.isArray(r.json.items) ? r.json.items : [];
    const totalUnits = items.reduce((a, row) => a + (Number(row?.total_available) || 0), 0);
    return JSON.stringify({
      contract: `GET /inventory/summary?location=${loc}`,
      http_ok: r.ok,
      http_status: r.status,
      sku_rows: items.length,
      total_units: totalUnits,
    });
  }
  if (name === 'get_architecture_doc') {
    pushEvent('selenia.tool', { name });
    return architectureDocToolResultNode(input || {});
  }
  if (name === 'get_system_knowledge') {
    pushEvent('selenia.tool', { name });
    const j = await kvGetJsonNode(KV_KB_MAIN);
    return JSON.stringify(
      j != null ? j : { empty: true, hint: 'KV selenia:kb:main vacío; POST /ai/knowledge/merge (Node) o wrangler kv:key put.' }
    );
  }
  if (name === 'get_roadmap') {
    pushEvent('selenia.tool', { name });
    const j = await kvGetJsonNode(KV_ROADMAP_MAIN);
    return JSON.stringify(j != null ? j : { empty: true });
  }
  if (name === 'list_pending_insights') {
    pushEvent('selenia.tool', { name });
    const rows = insightMemoryNode
      .filter((x) => x.status === 'pending')
      .slice(0, 30)
      .map(({ id, thread_id, summary, detail, status, created_at }) => ({
        id,
        thread_id,
        summary,
        detail,
        status,
        created_at,
      }));
    return JSON.stringify({ ok: true, rows });
  }
  if (name === 'query_d1_tables') {
    return JSON.stringify({ ok: false, error: 'D1 no configurado' });
  }
  if (name === 'get_operational_hints') {
    pushEvent('selenia.tool', { name });
    const cv2 = String(CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL not set' });
    const noopErr = () => {};
    const [ordersR, onb, ful] = await Promise.all([
      fetchJsonNode(`${cv2}/orders/monitor?all=1`, authHeadersNode(), 'hints', '/orders/monitor', noopErr),
      fetchJsonNode(
        `${cv2}/inventory/summary?location=onbox&byLocation=true&limit=2000`,
        authHeadersNode(),
        'hints',
        '/inventory/summary',
        noopErr
      ),
      fetchJsonNode(
        `${cv2}/inventory/summary?location=fulfillment&byLocation=true&limit=2000`,
        authHeadersNode(),
        'hints',
        '/inventory/summary',
        noopErr
      ),
    ]);
    const orderArr = extractOrdersArrayNode(ordersR.json);
    const orderCount = orderArr.length;
    const sumItems = (json) => {
      const items = json && Array.isArray(json.items) ? json.items : [];
      return items.reduce((a, row) => a + (Number(row?.total_available) || 0), 0);
    };
    const onboxUnits = onb.ok ? sumItems(onb.json) : null;
    const fulUnits = ful.ok ? sumItems(ful.json) : null;
    const hints = [];
    const tokenPresent = !!CORE_API_TOKEN;
    if (!tokenPresent) {
      hints.push({
        severity: 'info',
        code: 'no_core_token',
        detail: 'CORE_API_TOKEN no configurado en .env local.',
      });
    }
    if (!ordersR.ok) hints.push({ severity: 'warn', code: 'orders_monitor_fail', detail: `HTTP ${ordersR.status}` });
    if (!onb.ok) hints.push({ severity: 'warn', code: 'inventory_onbox_fail', detail: `HTTP ${onb.status}` });
    if (!ful.ok) hints.push({ severity: 'warn', code: 'inventory_fulfillment_fail', detail: `HTTP ${ful.status}` });
    if (orderCount > 0 && onboxUnits === 0 && fulUnits === 0 && onb.ok && ful.ok) {
      hints.push({
        severity: 'warn',
        code: 'orders_but_zero_inventory_sum',
        detail:
          'Hay pedidos en monitor pero suma de unidades en inventario es 0. Cruzá con get_order_lines y evidencia en Core.',
      });
    }
    return JSON.stringify({
      ok: true,
      generatedAt: Date.now(),
      summary: {
        orders_in_monitor: orderCount,
        inventory_onbox_units: onboxUnits,
        inventory_fulfillment_units: fulUnits,
        core_api_token_configured: tokenPresent,
      },
      hints,
      improvements: [
        'Revisar idempotencia inventory_orders_applied y POST /inventory/stock/apply.',
        'Para “venta sin stock”: orderKey + líneas + permisos del token.',
      ],
    });
  }
  if (name === 'get_orders_snapshot') {
    pushEvent('selenia.tool', { name });
    const lim = Math.min(40, Math.max(1, Number(input.limit) || 20));
    const cv2 = String(CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL not set' });
    const noopErr = () => {};
    const r = await fetchJsonNode(`${cv2}/orders/monitor?all=1`, authHeadersNode(), 'tool', '/orders/monitor', noopErr);
    const slim = extractOrdersArrayNode(r.json).slice(0, lim).map(slimOrderRowNode);
    return JSON.stringify({
      contract: 'GET /orders/monitor?all=1',
      http_ok: r.ok,
      http_status: r.status,
      sample_size: slim.length,
      orders: slim,
    });
  }
  if (name === 'get_order_lines') {
    const orderKey = String(input.order_key || '').trim();
    if (!orderKey) return JSON.stringify({ ok: false, error: 'order_key requerido' });
    pushEvent('selenia.tool', { name, orderKey });
    const cv2 = String(CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL not set' });
    const noopErr = () => {};
    const url = `${cv2}/orders/lines?orderKey=${encodeURIComponent(orderKey)}`;
    const r = await fetchJsonNode(url, authHeadersNode(), 'tool', '/orders/lines', noopErr);
    return JSON.stringify({ contract: 'GET /orders/lines', http_ok: r.ok, http_status: r.status, body: r.json });
  }
  if (name === 'run_system_diagnostic') {
    pushEvent('selenia.tool', { name });
    const payload = await buildDiagnosticPayloadForNode(requestUrl);
    diagnosticMemoryNode.unshift({
      id: randomUUID(),
      created_at: payload.generatedAt,
      payload,
    });
    while (diagnosticMemoryNode.length > 250) diagnosticMemoryNode.pop();
    const hours = Math.min(72, Math.max(1, Number(input.hours) || 12));
    const cutoff = Date.now() - hours * 3600 * 1000;
    const windowRows = diagnosticMemoryNode.filter((x) => x.created_at >= cutoff);
    const report = buildTemporalDiagnosticReportNode(
      windowRows.map((x) => ({ created_at: x.created_at, payload: x.payload }))
    );
    return JSON.stringify({
      ok: true,
      capture: { ok: true, id: windowRows[0]?.id, backend: 'node_memory' },
      window_hours: hours,
      samples_in_window: windowRows.length,
      report,
      note: 'En Cloudflare Worker los snapshots van a D1 (diagnostic_snapshot), no solo memoria.',
    });
  }
  if (name === 'get_diagnostic_report') {
    pushEvent('selenia.tool', { name });
    const hours = Math.min(72, Math.max(1, Number(input.hours) || 12));
    const cutoff = Date.now() - hours * 3600 * 1000;
    const windowRows = diagnosticMemoryNode.filter((x) => x.created_at >= cutoff);
    const report = buildTemporalDiagnosticReportNode(
      windowRows.map((x) => ({ created_at: x.created_at, payload: x.payload }))
    );
    return JSON.stringify({
      ok: true,
      window_hours: hours,
      samples: windowRows.length,
      report,
    });
  }
  if (name === 'core_v2_orders_write') {
    if (!dataApproval) {
      return JSON.stringify({ ok: false, error: 'Requiere APROBADO_DATOS en el chat.' });
    }
    const action = String(input.action || '').trim();
    if (action !== 'lines_upsert') {
      return JSON.stringify({ ok: false, error: 'action debe ser lines_upsert' });
    }
    const cv2 = String(CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL not set' });
    const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : {};
    pushEvent('selenia.tool', { name, path: '/orders/lines/upsert' });
    const headers = { 'Content-Type': 'application/json' };
    if (CORE_API_TOKEN) headers.Authorization = `Bearer ${CORE_API_TOKEN}`;
    const res = await fetch(`${cv2}/orders/lines/upsert`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      j = { raw: text.slice(0, 4000) };
    }
    return JSON.stringify({
      ok: res.ok,
      http_status: res.status,
      path: '/orders/lines/upsert',
      core_response: j,
    });
  }
  if (name === 'core_v2_inventory_write') {
    if (!dataApproval) {
      return JSON.stringify({
        ok: false,
        error: 'Requiere APROBADO_DATOS en el chat antes de mutar inventario en Core v2.',
      });
    }
    const action = String(input.action || '').trim();
    const path =
      action === 'stock_apply' ? '/inventory/stock/apply' : action === 'stock_reverse' ? '/inventory/stock/reverse' : '';
    if (!path) return JSON.stringify({ ok: false, error: 'action debe ser stock_apply o stock_reverse' });
    const cv2 = String(CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL not set' });
    const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : {};
    pushEvent('selenia.tool', { name, action, path });
    const headers = { 'Content-Type': 'application/json' };
    if (CORE_API_TOKEN) headers.Authorization = `Bearer ${CORE_API_TOKEN}`;
    const res = await fetch(cv2 + path, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      j = { raw: text.slice(0, 4000) };
    }
    return JSON.stringify({
      ok: res.ok,
      http_status: res.status,
      path,
      core_response: j,
    });
  }
  if (name === 'run_module_command') {
    const moduleId = String(input.module_id || '').trim();
    const action = String(input.action || '').trim();
    const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
    const key = `${moduleId}:${action}`;
    const needsApproval = key === 'gastronomia:run-ci' || key === 'sistemas:ci-gastro';
    if (needsApproval && !ciApproval) {
      return JSON.stringify({
        ok: false,
        error:
          'Este comando dispara GitHub Actions. El usuario debe haber enviado la frase APROBADO_SELENIA en el chat antes.',
      });
    }
    pushEvent('selenia.tool', { name, moduleId, action });
    const result = await proxyCommand(moduleId, { action, payload });
    return JSON.stringify(result);
  }
  return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${name}` });
}

async function anthropicChatMessages(messages, councilLite, dashboardContext, requestUrl) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error('Falta ANTHROPIC_API_KEY en .env');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const dash = sanitizeDashboardContextLocal(dashboardContext);
  const system = buildSystemPromptLocal(councilLite !== false, dash, getCuratedContextAppendLocal());
  const approvals = {
    ci: transcriptHasHumanApprovalNode(messages),
    data: transcriptHasDataApprovalNode(messages),
  };
  const working = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const maxRounds = 8;
  for (let round = 0; round < maxRounds; round++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 8192,
        system,
        tools: SELENIA_TOOL_DEFINITIONS_NODE,
        tool_choice: { type: 'auto' },
        messages: working,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data.error?.message || data.message || resp.statusText || 'Anthropic API error';
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    const { text, toolUses, rawBlocks } = extractTextAndToolUsesNode(data);
    if (!toolUses.length) {
      if (!text) throw new Error('Respuesta vacía de Anthropic');
      return text;
    }
    working.push({ role: 'assistant', content: rawBlocks });
    const toolResultBlocks = [];
    for (const tu of toolUses) {
      let out = '';
      try {
        out = await executeNodeTool(requestUrl, approvals, tu.name, tu.input || {});
      } catch (e) {
        out = JSON.stringify({ ok: false, error: String(e.message || e) });
      }
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: truncateToolResultNode(typeof out === 'string' ? out : JSON.stringify(out)),
      });
    }
    working.push({ role: 'user', content: toolResultBlocks });
  }
  throw new Error('Límite de rondas con herramientas alcanzado');
}

async function tryGithubRepositoryDispatchNode(req, body, lastUserContent) {
  if (!lastUserContent || !String(lastUserContent).includes('APROBADO_SELENIA')) return null;
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    pushEvent('selenia.dispatch_skip', { reason: 'github_not_configured' });
    return { skipped: true, reason: 'Set GITHUB_REPO and GITHUB_TOKEN in .env' };
  }
  const provided = String(req.headers['x-selenia-dispatch-key'] || body.dispatchKey || '').trim();
  if (SELENIA_DISPATCH_KEY) {
    if (provided !== SELENIA_DISPATCH_KEY) {
      pushEvent('selenia.dispatch_blocked', { reason: 'dispatch_key_mismatch' });
      return {
        skipped: true,
        reason: 'Protected: header X-Selenia-Dispatch-Key or body.dispatchKey must match SELENIA_DISPATCH_KEY',
      };
    }
  }
  const eventType = GITHUB_DISPATCH_EVENT || 'selenia_approved';
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'Selenia-Local-Server/1.0',
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: { source: 'selenia-server', ts: Date.now() },
    }),
  });
  if (res.status === 204) {
    pushEvent('selenia.dispatch_sent', { repo: GITHUB_REPO, event_type: eventType });
    return { ok: true, httpStatus: 204, repo: GITHUB_REPO, event_type: eventType };
  }
  const detail = await res.text();
  pushEvent('selenia.dispatch_error', { httpStatus: res.status, detail: detail.slice(0, 400) });
  return { ok: false, httpStatus: res.status, detail: detail.slice(0, 800) };
}

function authHeadersNode() {
  const h = { Accept: 'application/json' };
  if (CORE_API_TOKEN) h.Authorization = `Bearer ${CORE_API_TOKEN}`;
  return h;
}

async function fetchJsonNode(url, headers, source, endpoint, pushErr) {
  try {
    const res = await fetch(url, { method: 'GET', headers });
    const text = await res.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      j = { raw: text.slice(0, 800) };
    }
    if (!res.ok) {
      const msg = (j && (j.error || j.message)) || text || res.statusText;
      pushErr(source, endpoint, res.status, msg);
    }
    return { ok: res.ok, status: res.status, json: j };
  } catch (e) {
    pushErr(source, endpoint, 0, e?.message || String(e));
    return { ok: false, status: 0, json: null };
  }
}

async function probeUrlNode(url, opt = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: opt.method || 'GET', headers: opt.headers, redirect: 'manual' });
    const text = await res.text();
    const ms = Date.now() - t0;
    let json = null;
    try {
      json = text && (text.startsWith('{') || text.startsWith('[')) ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const looksJson = !!(json && typeof json === 'object');
    const snippet = looksJson
      ? JSON.stringify(json).slice(0, 360)
      : String(text || '')
          .replace(/\s+/g, ' ')
          .slice(0, 160);
    return { ok: res.ok, status: res.status, ms, looksJson, snippet };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, looksJson: false, snippet: String(e.message || e).slice(0, 200) };
  }
}

async function buildOpsAuditForNode(requestUrl) {
  const origin = new URL(requestUrl || '/', `http://127.0.0.1:${PORT}`).origin;
  const cv2 = String(CORE_V2_URL || '').replace(/\/$/, '');
  const leg = String(ONBOX_CORE_URL || '').replace(/\/$/, '');
  const gastroBase = String(GASTRONOMIA_PROXY_URL || '').replace(/\/$/, '');
  const auth = authHeadersNode();
  const token = CORE_API_TOKEN;

  const plan = [];
  if (cv2) plan.push({ id: 'core-v2-health', label: 'Core v2 /health', url: `${cv2}/health` });
  plan.push({ id: 'onbox-core-health', label: 'Onbox Core /health', url: `${leg}/health` });
  if (gastroBase) {
    plan.push({ id: 'gastro-health', label: 'Gastronomía /health', url: `${gastroBase}/health` });
    plan.push({ id: 'gastro-api-health', label: 'Gastronomía /api/health', url: `${gastroBase}/api/health` });
  }
  plan.push({ id: 'selenia-health', label: 'Selenia /health', url: `${origin}/health` });
  plan.push({ id: 'selenia-connectors', label: 'Selenia /connectors/health', url: `${origin}/connectors/health` });
  if (token && cv2) plan.push({ id: 'core-v2-auth-audit', label: 'Core v2 /clients/auth-audit', url: `${cv2}/clients/auth-audit`, headers: auth });

  const probes = [];
  for (const p of plan) {
    const r = await probeUrlNode(p.url, { headers: p.headers });
    probes.push({ id: p.id, label: p.label, url: p.url, ...r });
  }

  const notes = [];
  try {
    const raw = String(process.env.SELENIA_AUDIT_EXTRA || '').trim();
    if (raw) {
      const extra = JSON.parse(raw);
      if (Array.isArray(extra)) {
        for (const e of extra) {
          const u = e && typeof e.url === 'string' ? e.url.trim() : '';
          if (!u) continue;
          const method = typeof e.method === 'string' ? e.method : 'GET';
          const h = e.headers && typeof e.headers === 'object' ? e.headers : undefined;
          const r = await probeUrlNode(u, { method, headers: h });
          probes.push({ id: String(e.id || 'extra'), label: String(e.label || u), url: u, ...r });
        }
      } else {
        notes.push('SELENIA_AUDIT_EXTRA no es un array JSON');
      }
    }
  } catch (err) {
    notes.push(`SELENIA_AUDIT_EXTRA inválido: ${String(err.message || err)}`);
  }

  const fail = probes.filter((x) => !x.ok).length;
  return {
    generatedAt: Date.now(),
    contract: 'read-only GET (Node local)',
    summary: { total: probes.length, ok: probes.length - fail, fail },
    probes,
    notes,
  };
}

function buildOpsSourcesDocNode(cv2Base, legacyBase) {
  const c = String(cv2Base || '').replace(/\/$/, '');
  const l = String(legacyBase || '').replace(/\/$/, '');
  if (!c) return { calls: [] };
  return {
    calls: [
      { method: 'GET', url: `${c}/health`, note: 'core-v2 (público)' },
      { method: 'GET', url: `${l}/health`, note: 'onbox-core README (público)' },
      {
        method: 'GET',
        url: `${c}/inventory/summary?location=onbox&byLocation=true&limit=2000`,
        note: 'docs/fulfillment-api.md — Bearer si CORE_API_TOKEN',
      },
      {
        method: 'GET',
        url: `${c}/inventory/summary?location=fulfillment&byLocation=true&limit=2000`,
        note: 'docs/fulfillment-api.md — Bearer si CORE_API_TOKEN',
      },
      { method: 'GET', url: `${c}/orders/monitor?all=1`, note: 'core-v2 README — Bearer opcional' },
      { method: 'GET', url: `${c}/clients/auth-audit`, note: 'core-v2 — requiere CORE_API_TOKEN' },
      { method: 'GET', url: `${c}/deposits`, note: 'core-v2 README' },
    ],
  };
}

async function fetchGastronomiaDiagnosticsNode() {
  const proxyBase = GASTRONOMIA_PROXY_URL;
  const paths = ['/health', '/api/health'];
  const probes = [];
  for (const path of paths) {
    const url = proxyBase + path;
    try {
      const res = await fetch(url, { method: 'GET' });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const looksJson = !!(json && typeof json === 'object' && !Array.isArray(json));
      const ok =
        path === '/health'
          ? res.ok && looksJson && json.ok !== false
          : res.ok && looksJson;
      probes.push({
        path,
        url,
        status: res.status,
        ok,
        bodyIsJson: looksJson,
      });
    } catch (e) {
      probes.push({ path, url, status: 0, ok: false, message: String(e.message || e) });
    }
  }
  const mainProbe = probes.find((p) => p.path === '/health');
  const mainOk = !!(mainProbe && mainProbe.ok);
  return { proxyBase, probes, mainOk };
}

function mergeGastronomiaIntoOpsPayloadNode(payload, gastro, pushErr, now) {
  payload.gastronomia = {
    proxyBase: gastro.proxyBase,
    probes: gastro.probes,
    mainOk: gastro.mainOk,
  };
  const apiP = (gastro.probes || []).find((p) => p.path === '/api/health');
  if (!gastro.mainOk) {
    const hp = gastro.probes.find((p) => p.path === '/health');
    pushErr(
      'gastronomia-proxy',
      '/health',
      hp?.status || 0,
      hp?.message || 'GET /health no OK o cuerpo inválido'
    );
    payload.incidents.push({
      id: 'gastro-proxy-health',
      title: 'Gastronomía (proxy): GET /health no OK',
      severity: 'high',
      status: 'open',
      owner: 'gastronomia',
      openedAt: now,
    });
  } else if (apiP && !apiP.ok) {
    pushErr(
      'gastronomia-proxy',
      '/api/health',
      apiP.status || 0,
      'HTTP no OK o respuesta no JSON (monitores / rutas legacy en el proxy)'
    );
    payload.incidents.push({
      id: 'gastro-proxy-api-health',
      title: 'Gastronomía (proxy): GET /api/health falla',
      severity: 'medium',
      status: 'open',
      owner: 'gastronomia',
      openedAt: now,
    });
  }
  payload.modules = (payload.modules || []).map((m) =>
    m.id === 'gastronomia' ? { ...m, status: !gastro.mainOk ? 'error' : m.status } : m
  );
  if (payload.sources && Array.isArray(payload.sources.calls)) {
    payload.sources.calls.push({
      method: 'GET',
      url: `${gastro.proxyBase}/health`,
      note: 'gastronomía — proxy (Selenia probe)',
    });
    payload.sources.calls.push({
      method: 'GET',
      url: `${gastro.proxyBase}/api/health`,
      note: 'gastronomía — probe opcional',
    });
  }
  if (payload.summary) payload.summary.activeAlerts = (payload.incidents || []).length;
}

async function buildHealthForNode() {
  const uptime = Math.floor((Date.now() - START) / 1000);
  let coreOk = false;
  try {
    const r = await fetch(`${CORE_V2_URL}/health`);
    const j = await r.json().catch(() => ({}));
    coreOk = r.ok && j && j.ok !== false;
  } catch (_) {
    coreOk = false;
  }
  const modules = {};
  for (const [id, def] of Object.entries(MODULES)) {
    const st = !CORE_V2_URL ? 'booting' : coreOk ? 'running' : id === 'sistemas' ? 'error' : 'booting';
    modules[id] = { ...def, status: st };
  }
  return { uptime, modules };
}

/** Misma agregación que `worker/src/index.js` → `GET /ops/overview` (solo rutas documentadas). */
async function buildOpsOverviewForNode() {
  const errors = [];
  const pushErr = (source, endpoint, status, message) => {
    errors.push({
      source,
      endpoint,
      status: status || 0,
      message: String(message || '').slice(0, 500),
    });
  };

  const now = Date.now();
  const [health, gastro] = await Promise.all([buildHealthForNode(), fetchGastronomiaDiagnosticsNode()]);
  const cv2Base = CORE_V2_URL;
  const legacyBase = ONBOX_CORE_URL;
  const token = CORE_API_TOKEN;
  const authH = authHeadersNode();
  const tokenPresent = !!token;

  if (!cv2Base) {
    pushErr('selenia-local', 'env.CORE_V2_URL', 0, 'CORE_V2_URL not configured');
    const empty = {
      generatedAt: now,
      errors,
      contract: 'core-v2 README + docs/fulfillment-api.md + onbox-core README + gastronomía proxy',
      meta: { coreApiTokenConfigured: tokenPresent },
      sources: buildOpsSourcesDocNode(cv2Base, legacyBase),
      summary: {
        availability: null,
        errorRate: null,
        latencyP95: null,
        queueDepth: null,
        throughputPerMin: null,
        ordersMonitorCount: null,
        mttrMin: null,
        activeAlerts: 0,
        inventory: { onbox: null, fulfillment: null },
        depositsCount: null,
      },
      services: [],
      modules: Object.entries(health.modules || {}).map(([id, data]) => ({
        id,
        name: data.manifest?.name || id,
        status: data.status,
        slo: null,
        latencyP95: null,
        event5m: null,
        errors5m: null,
        queueDepth: null,
        heartbeatSec: null,
      })),
      incidents: [],
    };
    mergeGastronomiaIntoOpsPayloadNode(empty, gastro, pushErr, now);
    return empty;
  }

  if (!token) {
    pushErr('selenia-local', '/ops/overview', 0, 'CORE_API_TOKEN not set: omitiendo /clients/auth-audit (requiere Bearer en core-v2)');
  }

  const authAuditPromise = token
    ? fetchJsonNode(`${cv2Base}/clients/auth-audit`, authH, 'core-v2', '/clients/auth-audit', pushErr)
    : Promise.resolve({ ok: false, status: 0, json: null });

  const [cv2Health, legacyHealth, invOnbox, invFulfillment, ordersMon, authAudit, deposits] = await Promise.all([
    fetchJsonNode(`${cv2Base}/health`, {}, 'core-v2', '/health', pushErr),
    fetchJsonNode(`${legacyBase}/health`, {}, 'onbox-core', '/health', pushErr),
    fetchJsonNode(
      `${cv2Base}/inventory/summary?location=onbox&byLocation=true&limit=2000`,
      authH,
      'core-v2',
      '/inventory/summary?location=onbox',
      pushErr
    ),
    fetchJsonNode(
      `${cv2Base}/inventory/summary?location=fulfillment&byLocation=true&limit=2000`,
      authH,
      'core-v2',
      '/inventory/summary?location=fulfillment',
      pushErr
    ),
    fetchJsonNode(`${cv2Base}/orders/monitor?all=1`, authH, 'core-v2', '/orders/monitor?all=1', pushErr),
    authAuditPromise,
    fetchJsonNode(`${cv2Base}/deposits`, authH, 'core-v2', '/deposits', pushErr),
  ]);

  const sumQty = (items) =>
    (Array.isArray(items) ? items : []).reduce((a, r) => a + (Number(r?.total_available) || 0), 0);
  const skuRows = (items) => (Array.isArray(items) ? items.length : 0);

  const itemsOnbox = invOnbox.ok && invOnbox.json && Array.isArray(invOnbox.json.items) ? invOnbox.json.items : [];
  const itemsFulfillment =
    invFulfillment.ok && invFulfillment.json && Array.isArray(invFulfillment.json.items) ? invFulfillment.json.items : [];

  const ordersArr =
    ordersMon.ok && ordersMon.json && Array.isArray(ordersMon.json.data?.orders)
      ? ordersMon.json.data.orders
      : ordersMon.ok && ordersMon.json && Array.isArray(ordersMon.json.orders)
        ? ordersMon.json.orders
        : [];
  const ordersMonitorCount = ordersArr.length;

  const cv2Ok = !!(cv2Health.ok && cv2Health.json && cv2Health.json.ok !== false);
  const legacyOk = !!(legacyHealth.ok && legacyHealth.json && legacyHealth.json.ok !== false);
  const availability = cv2Ok && legacyOk ? 100 : cv2Ok || legacyOk ? 85 : 0;

  const withoutPw =
    token && authAudit.ok && authAudit.json && authAudit.json.ok !== false
      ? Number(authAudit.json.without_password_hash || 0)
      : null;
  const totalClients =
    token && authAudit.ok && authAudit.json && authAudit.json.ok !== false ? Number(authAudit.json.total || 0) : null;

  const errorRate =
    totalClients != null && totalClients > 0 && withoutPw != null
      ? Number(((withoutPw / totalClients) * 100).toFixed(2))
      : null;

  const depositsList =
    deposits.ok && deposits.json && Array.isArray(deposits.json.deposits) ? deposits.json.deposits : [];
  const depositsCount = deposits.ok ? depositsList.length : null;

  const incidents = [];
  if (!cv2Ok) {
    incidents.push({
      id: 'core-v2-health',
      title: 'Core v2: /health no OK',
      severity: 'high',
      status: 'open',
      owner: 'platform',
      openedAt: now,
    });
  }
  if (!legacyOk) {
    incidents.push({
      id: 'onbox-core-health',
      title: 'Onbox Core (legacy): /health no OK',
      severity: 'high',
      status: 'open',
      owner: 'platform',
      openedAt: now,
    });
  }
  if (withoutPw != null && withoutPw > 0) {
    incidents.push({
      id: 'clients-without-password',
      title: `${withoutPw} clientes sin password_hash (Neon)`,
      severity: withoutPw > 5 ? 'high' : 'medium',
      status: 'open',
      owner: 'security',
      openedAt: now,
    });
  }

  const services = [
    {
      id: 'core-v2',
      name: 'Core v2 (Neon)',
      status: cv2Ok ? 'running' : 'error',
      neon: !!(cv2Health.json && cv2Health.json.neon),
      endpoint: '/health',
    },
    {
      id: 'onbox-core',
      name: 'Onbox Core (legacy)',
      status: legacyOk ? 'running' : 'error',
      endpoint: '/health',
    },
  ];

  const modules = Object.entries(health.modules || {}).map(([id, data]) => ({
    id,
    name: data.manifest?.name || id,
    status: data.status,
    slo: null,
    latencyP95: null,
    event5m: null,
    errors5m: null,
    queueDepth: null,
    heartbeatSec: null,
  }));

  const out = {
    generatedAt: now,
    errors,
    contract: 'core-v2 README + docs/fulfillment-api.md + onbox-core README + gastronomía proxy',
    meta: { coreApiTokenConfigured: tokenPresent },
    sources: buildOpsSourcesDocNode(cv2Base, legacyBase),
    summary: {
      availability,
      errorRate,
      latencyP95: null,
      queueDepth: null,
      throughputPerMin: null,
      ordersMonitorCount,
      mttrMin: null,
      activeAlerts: incidents.length,
      inventory: {
        onbox: { skuRows: skuRows(itemsOnbox), totalUnits: sumQty(itemsOnbox) },
        fulfillment: { skuRows: skuRows(itemsFulfillment), totalUnits: sumQty(itemsFulfillment) },
      },
      depositsCount,
    },
    services,
    modules,
    incidents,
  };
  mergeGastronomiaIntoOpsPayloadNode(out, gastro, pushErr, now);
  return out;
}

function githubWebRepoBaseNode(repo) {
  return `https://github.com/${repo}`;
}

function sleepMsNode(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function gastroActionsConfigNode() {
  const repo = String(process.env.SELENIA_ACTIONS_REPO || 'maticabaleiro2012-create/onbox-universe').trim();
  const wf = String(process.env.SELENIA_GASTRO_WORKFLOW || 'gastronomia-smoke.yml').trim();
  const token = GITHUB_TOKEN;
  return { repo, wf, token };
}

async function fetchGitHubWorkflowRunsNode(token, repo, workflowFile, perPage = 5) {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${perPage}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Selenia-local/1.0',
    },
  });
  if (!res.ok) return { ok: false, httpStatus: res.status, detail: (await res.text()).slice(0, 400) };
  const data = await res.json();
  const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
  return {
    ok: true,
    runs: runs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      html_url: r.html_url,
      created_at: r.created_at,
      head_branch: r.head_branch,
    })),
  };
}

async function fetchGitHubRepoRunsNode(token, repo, perPage = 8) {
  const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=${perPage}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Selenia-local/1.0',
    },
  });
  if (!res.ok) return { ok: false, httpStatus: res.status, detail: (await res.text()).slice(0, 400) };
  const data = await res.json();
  const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
  return {
    ok: true,
    runs: runs.map((r) => ({
      id: r.id,
      name: r.name,
      display_title: r.display_title || r.name,
      workflow_path: r.path,
      status: r.status,
      conclusion: r.conclusion,
      html_url: r.html_url,
      created_at: r.created_at,
      head_branch: r.head_branch,
    })),
  };
}

function pickNewWorkflowRunNode(beforeIds, runs) {
  if (!Array.isArray(runs)) return null;
  return runs.find((r) => !beforeIds.has(r.id)) || null;
}

async function proxyCommand(moduleId, body) {
  const action = typeof body.action === 'string' ? body.action : '';
  if (moduleId === 'sistemas' && action === 'health-check') {
    try {
      const r = await fetch(`${CORE_V2_URL}/health`);
      const j = await r.json().catch(() => ({}));
      pushEvent('module.command', { moduleId, action, path: '/health' });
      return { ok: r.ok && j && j.ok !== false, result: j, via: 'core-v2', status: r.status };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }
  if (moduleId === 'gastronomia' && (action === 'health-check' || action === 'dashboard')) {
    const gastro = await fetchGastronomiaDiagnosticsNode();
    pushEvent('module.command', { moduleId, action, via: 'gastronomia-proxy' });
    return { ok: gastro.mainOk, result: gastro, via: 'logistica-gastronomica-proxy' };
  }
  if (
    (moduleId === 'gastronomia' && action === 'run-ci') ||
    (moduleId === 'sistemas' && action === 'ci-gastro')
  ) {
    const { repo, wf, token } = gastroActionsConfigNode();
    const ref = String(process.env.SELENIA_ACTIONS_REF || 'master').trim() || 'master';
    if (!token) return { ok: false, error: 'Falta GITHUB_TOKEN en .env' };
    const p = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const runSmoke = p.run_smoke === true;
    const workerUrl = typeof p.worker_url === 'string' ? p.worker_url : '';
    const beforeSnap = await fetchGitHubWorkflowRunsNode(token, repo, wf, 8);
    const beforeIds = new Set(beforeSnap.ok ? beforeSnap.runs.map((r) => r.id) : []);
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'Selenia-local/1.0',
      },
      body: JSON.stringify({ ref, inputs: { run_smoke: runSmoke, worker_url: workerUrl } }),
    });
    if (res.status === 204) {
      pushEvent('module.command', { moduleId, action, via: 'github-actions', repo, workflow: wf });
      const links = {
        workflow: `${githubWebRepoBaseNode(repo)}/actions/workflows/${encodeURIComponent(wf)}`,
        actions: `${githubWebRepoBaseNode(repo)}/actions`,
      };
      await sleepMsNode(750);
      let runsInfo = await fetchGitHubWorkflowRunsNode(token, repo, wf, 8);
      let triggeredRun = runsInfo.ok ? pickNewWorkflowRunNode(beforeIds, runsInfo.runs) : null;
      if (!triggeredRun && runsInfo.ok) {
        await sleepMsNode(900);
        runsInfo = await fetchGitHubWorkflowRunsNode(token, repo, wf, 8);
        triggeredRun = runsInfo.ok ? pickNewWorkflowRunNode(beforeIds, runsInfo.runs) : null;
      }
      const out = {
        ok: true,
        message: 'Workflow encolado',
        repo,
        workflow: wf,
        ref,
        inputs: { run_smoke: runSmoke, worker_url: workerUrl || undefined },
        links,
      };
      if (runsInfo.ok) {
        out.recentRuns = runsInfo.runs;
        if (triggeredRun) {
          out.triggeredRun = triggeredRun;
          out.recentRunsHint =
            'Corrida nueva detectada comparando IDs de runs antes y después del dispatch (o tras un segundo intento de lectura).';
        } else {
          out.recentRunsHint =
            'No apareció un run con ID nuevo todavía: usá el comando ci-runs / ci-gastro-runs o abrí GitHub.';
        }
      } else {
        out.recentRunsError = { httpStatus: runsInfo.httpStatus, detail: runsInfo.detail };
      }
      return out;
    }
    return { ok: false, httpStatus: res.status, detail: (await res.text()).slice(0, 800) };
  }
  if (
    (moduleId === 'gastronomia' && action === 'ci-runs') ||
    (moduleId === 'sistemas' && action === 'ci-gastro-runs')
  ) {
    const { repo, wf, token } = gastroActionsConfigNode();
    if (!token) return { ok: false, error: 'Falta GITHUB_TOKEN en .env' };
    const links = {
      workflow: `${githubWebRepoBaseNode(repo)}/actions/workflows/${encodeURIComponent(wf)}`,
      actions: `${githubWebRepoBaseNode(repo)}/actions`,
    };
    const runsInfo = await fetchGitHubWorkflowRunsNode(token, repo, wf, 8);
    pushEvent('module.command', { moduleId, action, via: 'github-actions-read' });
    if (!runsInfo.ok) {
      return { ok: false, httpStatus: runsInfo.httpStatus, detail: runsInfo.detail, links };
    }
    return {
      ok: true,
      readOnly: true,
      message: 'Listado de corridas del workflow (sin disparar CI)',
      repo,
      workflow: wf,
      links,
      recentRuns: runsInfo.runs,
    };
  }
  if (moduleId === 'sistemas' && action === 'actions-snapshot') {
    const { repo, token } = gastroActionsConfigNode();
    if (!token) return { ok: false, error: 'Falta GITHUB_TOKEN en .env' };
    const runsInfo = await fetchGitHubRepoRunsNode(token, repo, 8);
    pushEvent('module.command', { moduleId, action, via: 'github-actions-repo-runs' });
    if (!runsInfo.ok) {
      return { ok: false, httpStatus: runsInfo.httpStatus, detail: runsInfo.detail };
    }
    return {
      ok: true,
      readOnly: true,
      message: 'Snapshot de corridas recientes del repo (todos los workflows)',
      repo,
      links: { actions: `${githubWebRepoBaseNode(repo)}/actions` },
      recentRepoRuns: runsInfo.runs,
    };
  }
  if (!GATEWAY_URL) {
    return {
      ok: true,
      stub: true,
      moduleId,
      note: 'SELENIA_GATEWAY_URL no está configurado: comando simulado. Conectá el gateway OnBox para ejecución real.',
      echo: body,
    };
  }
  const r = await fetch(`${GATEWAY_URL}/modules/${encodeURIComponent(moduleId)}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Gateway ${r.status}`);
  return r.json();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname.replace(/\/$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeadersNode());
    res.end();
    return;
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveStatic(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    try {
      const h = await buildHealthForNode();
      send(res, 200, h);
    } catch (_) {
      send(res, 200, { uptime: Math.floor((Date.now() - START) / 1000), modules: MODULES });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/ops/overview') {
    try {
      const body = await buildOpsOverviewForNode();
      send(res, 200, body, { 'Cache-Control': 'no-store' });
    } catch (e) {
      send(res, 502, { error: e.message || String(e) }, { 'Cache-Control': 'no-store' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/ops/audit') {
    try {
      const fullUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`).toString();
      const body = await buildOpsAuditForNode(fullUrl);
      pushEvent('ops.audit', { total: body.summary?.total, fail: body.summary?.fail });
      send(res, 200, body, { 'Cache-Control': 'no-store' });
    } catch (e) {
      send(res, 502, { error: e.message || String(e) }, { 'Cache-Control': 'no-store' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/events/stats') {
    send(res, 200, { historySize: events.length });
    return;
  }

  if (req.method === 'GET' && pathname === '/events/history') {
    send(res, 200, events);
    return;
  }

  if (req.method === 'GET' && pathname === '/ai/knowledge') {
    if (!internalKeyOkNode(req)) {
      send(res, 401, { error: 'unauthorized' }, corsHeadersNode());
      return;
    }
    const kvKb = await kvGetJsonNode(KV_KB_MAIN);
    send(
      res,
      200,
      {
        bundled: getBundledMetaNode(),
        bundledExcerpt: getBundleExcerptNode(4000),
        kvKb,
        kvRoadmap: await kvGetJsonNode(KV_ROADMAP_MAIN),
        authRequired: !!SELENIA_INTERNAL_KEY,
      },
      { ...corsHeadersNode(), 'Cache-Control': 'no-store' }
    );
    return;
  }

  if (req.method === 'GET' && pathname === '/ai/roadmap') {
    if (!internalKeyOkNode(req)) {
      send(res, 401, { error: 'unauthorized' }, corsHeadersNode());
      return;
    }
    send(
      res,
      200,
      {
        kvRoadmap: await kvGetJsonNode(KV_ROADMAP_MAIN),
        bundledMeta: getBundledMetaNode(),
        authRequired: !!SELENIA_INTERNAL_KEY,
      },
      { ...corsHeadersNode(), 'Cache-Control': 'no-store' }
    );
    return;
  }

  if (req.method === 'GET' && pathname === '/ai/insights') {
    if (!internalKeyOkNode(req)) {
      send(res, 401, { error: 'unauthorized' }, corsHeadersNode());
      return;
    }
    const st = (url.searchParams.get('status') || 'pending').trim();
    if (!['pending', 'promoted', 'rejected', 'all'].includes(st)) {
      send(res, 400, { error: 'invalid status' }, corsHeadersNode());
      return;
    }
    let rows = insightMemoryNode;
    if (st !== 'all') rows = rows.filter((x) => x.status === st);
    rows = [...rows].sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 100);
    send(
      res,
      200,
      {
        rows: rows.map(({ id, thread_id, summary, status, created_at, promoted_at }) => ({
          id,
          thread_id,
          summary,
          status,
          created_at,
          promoted_at,
        })),
        note: 'Node dev: insights en memoria. Worker: D1.',
      },
      { ...corsHeadersNode(), 'Cache-Control': 'no-store' }
    );
    return;
  }

  if (req.method === 'GET' && pathname === '/ai/diagnostics') {
    if (!internalKeyOkNode(req)) {
      send(res, 401, { error: 'unauthorized' }, corsHeadersNode());
      return;
    }
    const hours = Math.min(72, Math.max(1, Number(url.searchParams.get('hours')) || 12));
    const cutoff = Date.now() - hours * 3600 * 1000;
    const windowRows = diagnosticMemoryNode.filter((x) => x.created_at >= cutoff);
    const report = buildTemporalDiagnosticReportNode(
      windowRows.map((x) => ({ created_at: x.created_at, payload: x.payload }))
    );
    send(
      res,
      200,
      {
        hours,
        sampleCount: windowRows.length,
        report,
        recent: windowRows.slice(0, 8),
        note: 'Node dev: snapshots en memoria. Worker: D1 (diagnostic_snapshot).',
      },
      { ...corsHeadersNode(), 'Cache-Control': 'no-store' }
    );
    return;
  }

  if (req.method === 'POST' && pathname === '/ai/diagnostics/snapshot') {
    if (!internalKeyOkNode(req)) {
      send(res, 401, { error: 'unauthorized' }, corsHeadersNode());
      return;
    }
    try {
      const fullUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`).toString();
      const payload = await buildDiagnosticPayloadForNode(fullUrl);
      const id = randomUUID();
      const createdAt = payload.generatedAt;
      diagnosticMemoryNode.unshift({ id, created_at: createdAt, source: 'api', payload });
      while (diagnosticMemoryNode.length > 250) diagnosticMemoryNode.pop();
      pushEvent('selenia.diagnostics.snapshot', { ok: true, id });
      send(res, 200, { ok: true, id, createdAt }, corsHeadersNode());
    } catch (e) {
      send(res, 502, { error: e.message || String(e) }, corsHeadersNode());
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/ai/knowledge/merge') {
    if (!internalKeyOkNode(req)) {
      send(res, 401, { error: 'unauthorized' }, corsHeadersNode());
      return;
    }
    try {
      const body = await readBody(req);
      const prev = await kvGetJsonNode(KV_KB_MAIN);
      const base = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
      const merged = { ...base, ...body, updatedAt: Date.now(), source: 'api_merge' };
      kbNodeStore.set(KV_KB_MAIN, merged);
      pushEvent('selenia.kb.merge', { keys: Object.keys(merged).length });
      send(res, 200, { ok: true }, corsHeadersNode());
    } catch (e) {
      send(res, 400, { error: e.message || String(e) }, corsHeadersNode());
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/ai/insights') {
    if (!internalKeyOkNode(req)) {
      send(res, 401, { error: 'unauthorized' }, corsHeadersNode());
      return;
    }
    try {
      const body = await readBody(req);
      const summary = String(body.summary || '').trim().slice(0, 2000);
      const detail = String(body.detail || '').trim().slice(0, 12000);
      const threadId = typeof body.threadId === 'string' ? body.threadId.trim().slice(0, 80) : '';
      if (!summary) {
        send(res, 400, { error: 'summary required' }, corsHeadersNode());
        return;
      }
      const id = randomUUID();
      insightMemoryNode.push({
        id,
        thread_id: threadId || null,
        summary,
        detail: detail || null,
        status: 'pending',
        created_at: Date.now(),
        promoted_at: null,
      });
      pushEvent('selenia.insight.create', { id });
      send(res, 200, { ok: true, id }, corsHeadersNode());
    } catch (e) {
      send(res, 400, { error: e.message || String(e) }, corsHeadersNode());
    }
    return;
  }

  const insightPromoteMatch = pathname.match(/^\/ai\/insights\/([^/]+)\/promote$/);
  if (req.method === 'POST' && insightPromoteMatch) {
    if (!internalKeyOkNode(req)) {
      send(res, 401, { error: 'unauthorized' }, corsHeadersNode());
      return;
    }
    try {
      const body = await readBody(req);
      if (String(body.confirm || '').trim() !== 'APROBADO_MEMORIA') {
        send(res, 400, { error: 'confirm must be APROBADO_MEMORIA' }, corsHeadersNode());
        return;
      }
      const id = insightPromoteMatch[1];
      const row = insightMemoryNode.find((x) => x.id === id);
      if (!row || row.status !== 'pending') {
        send(res, 400, { error: 'insight not found or not pending' }, corsHeadersNode());
        return;
      }
      row.status = 'promoted';
      row.promoted_at = Date.now();
      pushEvent('selenia.insight.promote', { id });
      send(res, 200, { ok: true, id }, corsHeadersNode());
    } catch (e) {
      send(res, 400, { error: e.message || String(e) }, corsHeadersNode());
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/connectors/health') {
    send(
      res,
      200,
      {
        anthropic: ANTHROPIC_API_KEY ? 'configured' : 'missing',
        status: ANTHROPIC_API_KEY ? 'anthropic_configured' : 'anthropic_missing',
        github_dispatch: GITHUB_TOKEN && GITHUB_REPO ? 'configured' : 'off',
        chatThreads: 'memory',
        d1: 'off',
        internal_key: SELENIA_INTERNAL_KEY ? 'configured' : 'off',
      },
      corsHeadersNode()
    );
    return;
  }

  if (req.method === 'POST' && pathname === '/ai/threads') {
    const id = randomUUID();
    writeThreadDocNode(id, []);
    send(res, 200, { threadId: id, ephemeral: false });
    return;
  }

  const threadGet = pathname.match(/^\/ai\/threads\/([^/]+)$/);
  if (req.method === 'GET' && threadGet) {
    const threadId = threadGet[1];
    if (!isValidThreadId(threadId)) {
      send(res, 400, { error: 'invalid threadId' });
      return;
    }
    const doc = readThreadDocNode(threadId);
    if (!doc) {
      send(res, 200, { threadId, updatedAt: null, messages: [], ephemeral: false });
      return;
    }
    send(res, 200, {
      threadId: doc.threadId || threadId,
      updatedAt: doc.updatedAt || null,
      messages: Array.isArray(doc.messages) ? doc.messages : [],
      ephemeral: false,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/ai/chat') {
    try {
      const body = await readBody(req);
      const single = typeof body.message === 'string' ? body.message.trim() : '';
      let messages = normalizeAnthropicMessages(body.messages);
      if (single) messages = normalizeAnthropicMessages([...messages, { role: 'user', content: single }]);
      if (!messages.length) {
        send(res, 400, { error: 'message or messages[] required' });
        return;
      }
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUser && lastUser.content.includes('APROBADO_SELENIA')) {
        pushEvent('selenia.human_approval', { token: 'APROBADO_SELENIA' });
      }
      if (lastUser && lastUser.content.includes('APROBADO_DATOS')) {
        pushEvent('selenia.human_approval', { token: 'APROBADO_DATOS' });
      }
      const councilLite = body.councilLite !== false;
      pushEvent('selenia.chat.user', { chars: lastUser?.content?.length || 0, turns: messages.length, councilLite });
      const proto = String(req.headers['x-forwarded-proto'] || 'http')
        .split(',')[0]
        .trim();
      const host = req.headers.host || `127.0.0.1:${PORT}`;
      const requestFullUrl = `${proto}://${host}${req.url || ''}`;
      const reply = await anthropicChatMessages(messages, councilLite, body.dashboardContext, requestFullUrl);
      pushEvent('selenia.chat.assistant', { chars: reply.length });
      const githubDispatch = await tryGithubRepositoryDispatchNode(req, body, lastUser?.content || '');
      const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
      let threadSaved = false;
      if (threadId && isValidThreadId(threadId)) {
        const merged = normalizeAnthropicMessages([...messages, { role: 'assistant', content: reply }]);
        threadSaved = writeThreadDocNode(threadId, merged);
      }
      send(res, 200, { message: reply, githubDispatch, threadId: threadId || undefined, threadSaved });
    } catch (e) {
      pushEvent('selenia.chat.error', { message: e.message, code: e.code, status: e.status });
      const status = e.code === 'NO_API_KEY' ? 503 : e.status >= 400 && e.status < 600 ? e.status : 502;
      const isRate = status === 429 || /rate limit|tokens per minute/i.test(String(e.message || ''));
      const friendly = isRate
        ? 'Selenia llegó al límite de tokens por minuto de Anthropic. Esperá ~60 s y volvé a pedir, o partí la consulta en partes más cortas.'
        : e.message;
      send(res, status, { error: friendly, rateLimited: isRate, retryAfterSeconds: isRate ? 60 : undefined });
    }
    return;
  }

  const cmdMatch = pathname.match(/^\/modules\/([^/]+)\/command$/);
  if (req.method === 'POST' && cmdMatch) {
    try {
      const moduleId = cmdMatch[1];
      if (!MODULES[moduleId]) {
        send(res, 404, { error: 'unknown module' });
        return;
      }
      const body = await readBody(req);
      const result = await proxyCommand(moduleId, body);
      pushEvent('module.command', { moduleId, action: body.action });
      send(res, 200, result);
    } catch (e) {
      pushEvent('module.command.error', { message: e.message });
      send(res, 502, { error: e.message });
    }
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Selenia dashboard → http://127.0.0.1:${PORT}/`);
  console.log(`Anthropic: ${ANTHROPIC_API_KEY ? `model=${ANTHROPIC_MODEL}` : 'ANTHROPIC_API_KEY missing (solo health/events; chat fallará)'}`);
  console.log(
    `Core: CORE_V2_URL=${CORE_V2_URL} ONBOX_CORE_URL=${ONBOX_CORE_URL} CORE_API_TOKEN=${CORE_API_TOKEN ? 'set' : 'missing'}`
  );
});
