import { buildOpsAudit } from './audit.js';
import { anthropicChatWithTools, transcriptHasDataApproval, transcriptHasHumanApproval } from './chat-agent.js';
import { architectureDocToolResult, getBundledMeta, getBundleExcerpt, getCuratedContextAppend } from './context.js';
import {
  buildTemporalDiagnosticReport,
  captureAndStoreDiagnosticSnapshot,
  listDiagnosticSnapshots,
} from './diagnostics.js';
import { runWatchdog, getWatchdogFindings, getWatchdogSummary, watchdogContextBlock } from './watchdog.js';

/**
 * Selenia on Cloudflare Workers:
 * - Serves static UI from [assets] public/
 * - POST /ai/chat → Anthropic (secret ANTHROPIC_API_KEY)
 * - GET /health, /events/history, GET /ops/overview, POST /modules/:id/command (allowlist only)
 * - POST /ai/threads, GET /ai/threads/:id — historial de chat en KV (misma conversación desde cualquier PC)
 * - GET /ai/knowledge, /ai/roadmap, /ai/insights — observabilidad (opcional secret SELENIA_INTERNAL_KEY)
 * - D1: knowledge_entry, roadmap_item, conversation_insight, diagnostic_snapshot; POST /ai/insights + promote (APROBADO_MEMORIA)
 * - GET /ai/diagnostics — historial de snapshots (~12h); cron opcional para captura automática
 *
 * No bash or terminal: Workers cannot spawn a shell. Commands are HTTP calls to your APIs.
 * Optional: APROBADO_SELENIA in chat → POST repository_dispatch (see README).
 */

const WORKER_BOOT = Date.now();

const MODULES_BASE = {
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
let bootLogged = false;

function pushEvent(type, payload = {}) {
  events.push({ type, payload, meta: { timestamp: Date.now() } });
  if (events.length > 500) events.splice(0, events.length - 500);
}

function ensureBootLogged() {
  if (bootLogged) return;
  bootLogged = true;
  pushEvent('selenia.boot', { version: '0.5.0-cf', provider: 'anthropic', runtime: 'cloudflare-worker' });
  Object.keys(MODULES_BASE).forEach((id) => pushEvent('module.registered', { id }));
  pushEvent('gateway.ready', {
    mode: 'worker',
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
      'modules/*/command',
    ],
  });
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const KV_KB_MAIN = 'selenia:kb:main';
const KV_ROADMAP_MAIN = 'selenia:roadmap:main';

function internalKeyOk(request, env) {
  const need = String(env.SELENIA_INTERNAL_KEY || '').trim();
  if (!need) return true;
  const got = (request.headers.get('x-selenia-internal-key') || '').trim();
  return got === need;
}

async function kvGetJson(env, key) {
  if (!env.SELENIA_KV) return null;
  const raw = await env.SELENIA_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: String(raw).slice(0, 4000) };
  }
}

async function upstreamCore(env, path, init = {}) {
  const base = String(env.CORE_V2_URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, status: 503, json: { error: 'CORE_V2_URL not configured' } };
  const headers = new Headers(init.headers || {});
  if (env.CORE_API_TOKEN) headers.set('Authorization', `Bearer ${env.CORE_API_TOKEN}`);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(base + path, { ...init, headers });
  const text = await res.text();
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = { raw: text.slice(0, 800) };
  }
  return { ok: res.ok, status: res.status, json: j };
}

/** Plain GET with JSON parse — used for ops aggregation (Core v2 + legacy Core). */
async function fetchJson(url, init, source, endpoint, onError) {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      j = { raw: text.slice(0, 800) };
    }
    if (!res.ok) {
      const msg = (j && (j.error || j.message)) || text || res.statusText;
      onError(source, endpoint, res.status, msg);
    }
    return { ok: res.ok, status: res.status, json: j };
  } catch (e) {
    onError(source, endpoint, 0, e?.message || String(e));
    return { ok: false, status: 0, json: null };
  }
}

function coreAuthHeaders(env) {
  const h = new Headers();
  const t = String(env.CORE_API_TOKEN || '').trim();
  if (t) h.set('Authorization', `Bearer ${t}`);
  return h;
}

function extractOrdersArray(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.data?.orders)) return data.data.orders;
  if (Array.isArray(data.orders)) return data.orders;
  return [];
}

function slimOrderRow(o) {
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

/** URLs que consume `/ops/overview` (para el UI: enlaces a las mismas rutas que documentación). */
function buildOpsSourcesDoc(cv2Base, legacyBase) {
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

async function fetchGastronomiaDiagnostics(env) {
  const proxyBase = String(
    env.GASTRONOMIA_PROXY_URL || 'https://logistica-gastronomica-proxy.soporte-a90.workers.dev'
  ).replace(/\/$/, '');
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

  // Best-effort: traer /ops/summary (contadores agregados anónimos, sin PII).
  // Si falla o no existe, el resto del flujo queda intacto.
  let summary = null;
  try {
    const sres = await fetch(`${proxyBase}/ops/summary`, { method: 'GET' });
    if (sres.ok) {
      const sjson = await sres.json();
      if (sjson && sjson.ok !== false) {
        summary = {
          fetchedAt: Date.now(),
          cache: sres.headers.get('x-cache') || null,
          cadetesOnline: sjson.cadetes_online_count ?? null,
          onboardingPending: sjson.onboarding_pending_count ?? null,
          loanAlerts: sjson.loan_alerts_count ?? null,
          sources: sjson.sources || null,
          serverNow: sjson.now || null,
        };
      }
    }
  } catch { /* best-effort */ }

  return { proxyBase, probes, mainOk, summary };
}

function mergeGastronomiaIntoOpsPayload(payload, gastro, pushErr, now) {
  payload.gastronomia = {
    proxyBase: gastro.proxyBase,
    probes: gastro.probes,
    mainOk: gastro.mainOk,
    summary: gastro.summary || null,
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

async function buildHealth(env) {
  const uptime = Math.floor((Date.now() - WORKER_BOOT) / 1000);
  const core = await upstreamCore(env, '/health');
  const coreOk = core.ok && core.json && core.json.ok !== false;

  const modules = {};
  for (const [id, def] of Object.entries(MODULES_BASE)) {
    const st =
      !env.CORE_V2_URL ? 'booting' : coreOk ? 'running' : id === 'sistemas' ? 'error' : 'booting';
    modules[id] = { ...def, status: st };
  }

  return { uptime, modules };
}

/**
 * Ops overview — solo fuentes documentadas (core-v2 README + fulfillment-api + onbox-core README).
 * No heurísticas ni “probe” de rutas inventadas. Si falla una llamada, queda registro en `errors[]`
 * y el resto de bloques puede venir parcial.
 */
async function buildOpsOverview(env) {
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
  const [health, gastro] = await Promise.all([buildHealth(env), fetchGastronomiaDiagnostics(env)]);
  const cv2Base = String(env.CORE_V2_URL || '').replace(/\/$/, '');
  const legacyBase = String(env.ONBOX_CORE_URL || 'https://onbox-core.soporte-a90.workers.dev').replace(/\/$/, '');
  const token = String(env.CORE_API_TOKEN || '').trim();
  const authH = coreAuthHeaders(env);

  if (!cv2Base) {
    pushErr('selenia-worker', 'env.CORE_V2_URL', 0, 'CORE_V2_URL not configured');
  }

  const tokenPresent = !!token;
  const empty = {
    generatedAt: now,
    errors,
    contract: 'core-v2 README + docs/fulfillment-api.md + onbox-core README + gastronomía proxy',
    meta: { coreApiTokenConfigured: tokenPresent },
    sources: buildOpsSourcesDoc(cv2Base, legacyBase),
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

  mergeGastronomiaIntoOpsPayload(empty, gastro, pushErr, now);

  if (!cv2Base) {
    return empty;
  }

  const authAuditPromise = token
    ? fetchJson(`${cv2Base}/clients/auth-audit`, { headers: authH }, 'core-v2', '/clients/auth-audit', pushErr)
    : Promise.resolve({ ok: false, status: 0, json: null });

  if (!token) {
    pushErr('selenia-worker', '/ops/overview', 0, 'CORE_API_TOKEN not set: omitiendo /clients/auth-audit (requiere Bearer en core-v2)');
  }

  const [
    cv2Health,
    legacyHealth,
    invOnbox,
    invFulfillment,
    ordersMon,
    authAudit,
    deposits,
  ] = await Promise.all([
    fetchJson(`${cv2Base}/health`, { method: 'GET' }, 'core-v2', '/health', pushErr),
    fetchJson(`${legacyBase}/health`, { method: 'GET' }, 'onbox-core', '/health', pushErr),
    fetchJson(
      `${cv2Base}/inventory/summary?location=onbox&byLocation=true&limit=2000`,
      { method: 'GET', headers: authH },
      'core-v2',
      '/inventory/summary?location=onbox',
      pushErr
    ),
    fetchJson(
      `${cv2Base}/inventory/summary?location=fulfillment&byLocation=true&limit=2000`,
      { method: 'GET', headers: authH },
      'core-v2',
      '/inventory/summary?location=fulfillment',
      pushErr
    ),
    fetchJson(
      `${cv2Base}/orders/monitor?all=1`,
      { method: 'GET', headers: authH },
      'core-v2',
      '/orders/monitor?all=1',
      pushErr
    ),
    authAuditPromise,
    fetchJson(`${cv2Base}/deposits`, { method: 'GET', headers: authH }, 'core-v2', '/deposits', pushErr),
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
    sources: buildOpsSourcesDoc(cv2Base, legacyBase),
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
  mergeGastronomiaIntoOpsPayload(out, gastro, pushErr, now);
  return out;
}

const MAX_CHAT_MESSAGES = 24;
const MAX_STORED_THREAD_MESSAGES = 80;
const THREAD_KV_PREFIX = 'selenia:thread:';
const THREAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidThreadId(id) {
  return typeof id === 'string' && THREAD_ID_RE.test(id.trim());
}

function trimMessageContent(s) {
  const t = String(s || '');
  if (t.length <= 48000) return t;
  return t.slice(0, 48000) + '\n…(truncado)';
}

async function readThreadDoc(env, threadId) {
  if (!env.SELENIA_KV) return null;
  try {
    const raw = await env.SELENIA_KV.get(THREAD_KV_PREFIX + threadId);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch {
    return null;
  }
}

async function writeThreadDoc(env, threadId, messages) {
  if (!env.SELENIA_KV || !isValidThreadId(threadId)) return false;
  const normalized = normalizeAnthropicMessages(messages).slice(-MAX_STORED_THREAD_MESSAGES);
  const safe = normalized.map((m) => ({
    role: m.role,
    content: trimMessageContent(m.content),
  }));
  const doc = {
    threadId,
    updatedAt: Date.now(),
    messages: safe,
  };
  await env.SELENIA_KV.put(THREAD_KV_PREFIX + threadId, JSON.stringify(doc));
  return true;
}

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

async function executeWorkerTool(env, requestUrl, approvals, name, input) {
  const ciApproval = approvals && approvals.ci;
  const dataApproval = approvals && approvals.data;
  if (name === 'get_ops_overview') {
    pushEvent('selenia.tool', { name });
    const ov = await buildOpsOverview(env);
    return JSON.stringify(ov);
  }
  if (name === 'get_ops_audit') {
    pushEvent('selenia.tool', { name });
    let origin = '';
    try {
      origin = new URL(requestUrl).origin;
    } catch (_) {
      origin = '';
    }
    const body = await buildOpsAudit(env, origin, { headers: coreAuthHeaders(env) });
    return JSON.stringify(body);
  }
  if (name === 'get_orders_monitor') {
    pushEvent('selenia.tool', { name });
    const cv2 = String(env.CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) {
      return JSON.stringify({
        ok: false,
        error: 'CORE_V2_URL no configurado',
        contract: 'GET {CORE_V2_URL}/orders/monitor?all=1',
      });
    }
    const noop = () => {};
    const r = await fetchJson(
      `${cv2}/orders/monitor?all=1`,
      { method: 'GET', headers: coreAuthHeaders(env) },
      'tool',
      '/orders/monitor',
      noop
    );
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
      note: 'Sin token válido el Core puede devolver 401 y orders_count 0.',
    });
  }
  if (name === 'get_inventory_location') {
    const loc = String(input.location || '').trim();
    if (loc !== 'onbox' && loc !== 'fulfillment') {
      return JSON.stringify({ ok: false, error: 'location debe ser onbox o fulfillment' });
    }
    pushEvent('selenia.tool', { name, location: loc });
    const cv2 = String(env.CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) {
      return JSON.stringify({ ok: false, error: 'CORE_V2_URL no configurado' });
    }
    const noop = () => {};
    const url = `${cv2}/inventory/summary?location=${encodeURIComponent(loc)}&byLocation=true&limit=2000`;
    const r = await fetchJson(url, { method: 'GET', headers: coreAuthHeaders(env) }, 'tool', '/inventory/summary', noop);
    const items = r.ok && r.json && Array.isArray(r.json.items) ? r.json.items : [];
    const totalUnits = items.reduce((a, row) => a + (Number(row?.total_available) || 0), 0);
    return JSON.stringify({
      contract: `GET /inventory/summary?location=${loc}&byLocation=true&limit=2000`,
      http_ok: r.ok,
      http_status: r.status,
      sku_rows: items.length,
      total_units: totalUnits,
    });
  }
  if (name === 'get_architecture_doc') {
    pushEvent('selenia.tool', { name });
    return architectureDocToolResult(input || {});
  }
  if (name === 'get_system_knowledge') {
    pushEvent('selenia.tool', { name });
    const j = await kvGetJson(env, KV_KB_MAIN);
    return JSON.stringify(
      j != null ? j : { empty: true, hint: 'KV selenia:kb:main vacío; wrangler kv:key put o POST /ai/knowledge/merge.' }
    );
  }
  if (name === 'get_roadmap') {
    pushEvent('selenia.tool', { name });
    const j = await kvGetJson(env, KV_ROADMAP_MAIN);
    return JSON.stringify(j != null ? j : { empty: true });
  }
  if (name === 'list_pending_insights') {
    pushEvent('selenia.tool', { name });
    if (!env.SELENIA_DB) return JSON.stringify({ ok: false, error: 'D1 no configurado' });
    const r = await env.SELENIA_DB.prepare(
      'SELECT id, thread_id, summary, detail, status, created_at FROM conversation_insight WHERE status = ? ORDER BY created_at DESC LIMIT ?'
    )
      .bind('pending', 30)
      .all();
    return JSON.stringify({ ok: true, rows: r.results || [] });
  }
  if (name === 'query_d1_tables') {
    pushEvent('selenia.tool', { name, table: input?.table });
    if (!env.SELENIA_DB) return JSON.stringify({ ok: false, error: 'D1 no configurado' });
    const table = String(input.table || '').trim();
    const allowed = new Set(['knowledge_entry', 'roadmap_item', 'conversation_insight', 'diagnostic_snapshot']);
    if (!allowed.has(table)) return JSON.stringify({ ok: false, error: 'table no permitida' });
    const lim = Math.min(50, Math.max(1, Number(input.limit) || 20));
    const r = await env.SELENIA_DB.prepare(`SELECT * FROM ${table} LIMIT ?`).bind(lim).all();
    return JSON.stringify({ ok: true, table, rows: r.results || [] });
  }
  if (name === 'get_operational_hints') {
    pushEvent('selenia.tool', { name });
    const cv2 = String(env.CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL no configurado' });
    const noop = () => {};
    const authH = coreAuthHeaders(env);
    const tokenPresent = !!String(env.CORE_API_TOKEN || '').trim();
    const [ordersR, onb, ful] = await Promise.all([
      fetchJson(`${cv2}/orders/monitor?all=1`, { method: 'GET', headers: authH }, 'hints', '/orders/monitor', noop),
      fetchJson(
        `${cv2}/inventory/summary?location=onbox&byLocation=true&limit=2000`,
        { method: 'GET', headers: authH },
        'hints',
        '/inventory/summary',
        noop
      ),
      fetchJson(
        `${cv2}/inventory/summary?location=fulfillment&byLocation=true&limit=2000`,
        { method: 'GET', headers: authH },
        'hints',
        '/inventory/summary',
        noop
      ),
    ]);
    const orderArr = extractOrdersArray(ordersR.json);
    const orderCount = orderArr.length;
    const sumItems = (json) => {
      const items = json && Array.isArray(json.items) ? json.items : [];
      return items.reduce((a, row) => a + (Number(row?.total_available) || 0), 0);
    };
    const onboxUnits = onb.ok ? sumItems(onb.json) : null;
    const fulUnits = ful.ok ? sumItems(ful.json) : null;
    const hints = [];
    if (!tokenPresent) {
      hints.push({
        severity: 'info',
        code: 'no_core_token_selenia',
        detail:
          'CORE_API_TOKEN no configurado en el Worker Selenia: muchas rutas Core pueden devolver 401 o datos vacíos.',
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
          'Hay pedidos en monitor pero la suma de unidades en inventario (onbox+fulfillment) es 0. Cruzá con líneas del pedido (get_order_lines) y movimientos en Core; no afirmes causa sin evidencia.',
      });
    }
    const improvements = [
      'Revisar en Core idempotencia inventory_orders_applied y POST /inventory/stock/apply vs estado del pedido.',
      'Si sospechás venta sin descuento de stock: orderKey + líneas + token con permiso.',
      'Mantené /ops/audit verde en probes críticos.',
    ];
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
      improvements,
      note: 'Solo lectura; combiná con get_orders_snapshot y get_order_lines para profundizar.',
    });
  }
  if (name === 'get_orders_snapshot') {
    pushEvent('selenia.tool', { name });
    const lim = Math.min(40, Math.max(1, Number(input.limit) || 20));
    const cv2 = String(env.CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL no configurado' });
    const noop = () => {};
    const r = await fetchJson(
      `${cv2}/orders/monitor?all=1`,
      { method: 'GET', headers: coreAuthHeaders(env) },
      'tool',
      '/orders/monitor',
      noop
    );
    const arr = extractOrdersArray(r.json).slice(0, lim);
    const slim = arr.map(slimOrderRow);
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
    const cv2 = String(env.CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL no configurado' });
    const noop = () => {};
    const url = `${cv2}/orders/lines?orderKey=${encodeURIComponent(orderKey)}`;
    const r = await fetchJson(url, { method: 'GET', headers: coreAuthHeaders(env) }, 'tool', '/orders/lines', noop);
    return JSON.stringify({
      contract: 'GET /orders/lines',
      http_ok: r.ok,
      http_status: r.status,
      body: r.json,
    });
  }
  if (name === 'run_system_diagnostic') {
    pushEvent('selenia.tool', { name });
    if (!env.SELENIA_DB) return JSON.stringify({ ok: false, error: 'D1 no configurado' });
    const hours = Math.min(72, Math.max(1, Number(input.hours) || 12));
    const cap = await captureAndStoreDiagnosticSnapshot(env, 'tool');
    const list = await listDiagnosticSnapshots(env, hours, 200);
    const report = buildTemporalDiagnosticReport(
      list.rows.map((r) => ({ created_at: r.created_at, payload: r.payload }))
    );
    return JSON.stringify({
      ok: true,
      capture: cap,
      window_hours: hours,
      samples_in_window: list.count,
      report,
      note: 'Snapshots guardados en D1 (diagnostic_snapshot). Política auto-fix en report.auto_fix_policy.',
    });
  }
  if (name === 'get_diagnostic_report') {
    pushEvent('selenia.tool', { name });
    if (!env.SELENIA_DB) return JSON.stringify({ ok: false, error: 'D1 no configurado' });
    const hours = Math.min(72, Math.max(1, Number(input.hours) || 12));
    const list = await listDiagnosticSnapshots(env, hours, 200);
    const report = buildTemporalDiagnosticReport(
      list.rows.map((r) => ({ created_at: r.created_at, payload: r.payload }))
    );
    return JSON.stringify({
      ok: true,
      window_hours: hours,
      samples: list.count,
      report,
      note: 'Solo lectura del historial; no crea snapshot nuevo.',
    });
  }
  if (name === 'core_v2_orders_write') {
    if (!dataApproval) {
      return JSON.stringify({
        ok: false,
        error: 'POST a Core v2: el usuario debe enviar APROBADO_DATOS en el chat antes de orders/lines/upsert.',
      });
    }
    const action = String(input.action || '').trim();
    if (action !== 'lines_upsert') {
      return JSON.stringify({ ok: false, error: 'action debe ser lines_upsert' });
    }
    const cv2 = String(env.CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL no configurado' });
    const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : {};
    pushEvent('selenia.tool', { name, path: '/orders/lines/upsert' });
    const headers = coreAuthHeaders(env);
    headers.set('Content-Type', 'application/json');
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
        error:
          'Mutación de datos Core v2: el usuario debe enviar la frase APROBADO_DATOS en el chat antes de ejecutar esta tool.',
      });
    }
    const action = String(input.action || '').trim();
    const path =
      action === 'stock_apply' ? '/inventory/stock/apply' : action === 'stock_reverse' ? '/inventory/stock/reverse' : '';
    if (!path) return JSON.stringify({ ok: false, error: 'action debe ser stock_apply o stock_reverse' });
    const cv2 = String(env.CORE_V2_URL || '').replace(/\/$/, '');
    if (!cv2) return JSON.stringify({ ok: false, error: 'CORE_V2_URL no configurado' });
    const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : {};
    pushEvent('selenia.tool', { name, action, path });
    const headers = coreAuthHeaders(env);
    headers.set('Content-Type', 'application/json');
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
      note: 'POST directo a Core v2 con CORE_API_TOKEN del Worker. Auditoría en Core/Neon fuera de Selenia.',
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
    const result = await runWhitelistedCommand(env, moduleId, action, payload);
    return JSON.stringify(result);
  }
  return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${name}` });
}

async function anthropicChatMessages(env, messages, councilLite, dashboardContext, requestUrl) {
  if (!env.ANTHROPIC_API_KEY) {
    const e = new Error('ANTHROPIC_API_KEY not configured (wrangler secret put ANTHROPIC_API_KEY)');
    e.code = 'NO_API_KEY';
    throw e;
  }
  const approvals = {
    ci: transcriptHasHumanApproval(messages),
    data: transcriptHasDataApproval(messages),
  };
  // El chat SIEMPRE ve los hallazgos abiertos del vigilante (estado real del sistema).
  const watchdogBlock = await watchdogContextBlock(env);
  return anthropicChatWithTools({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    councilLite: councilLite !== false,
    dashboardContext,
    messages,
    curatedContextAppend: getCuratedContextAppend(3500) + watchdogBlock,
    executeTool: (toolName, toolInput) => executeWorkerTool(env, requestUrl, approvals, toolName, toolInput),
  });
}

/**
 * Triggers GitHub repository_dispatch when the user message contains APROBADO_SELENIA.
 * Secrets: GITHUB_TOKEN. Vars: GITHUB_REPO (owner/name). Optional secret SELENIA_DISPATCH_KEY → require header or body.dispatchKey.
 */
async function tryGithubRepositoryDispatch(request, env, body, lastUserContent) {
  if (!lastUserContent || !String(lastUserContent).includes('APROBADO_SELENIA')) return null;

  const repo = String(env.GITHUB_REPO || '').trim();
  const token = env.GITHUB_TOKEN;
  if (!token || !repo) {
    pushEvent('selenia.dispatch_skip', { reason: 'github_not_configured' });
    return { skipped: true, reason: 'Configure wrangler var GITHUB_REPO and secret GITHUB_TOKEN' };
  }

  const requiredKey = env.SELENIA_DISPATCH_KEY;
  const provided = (request.headers.get('x-selenia-dispatch-key') || body.dispatchKey || '').trim();
  if (requiredKey) {
    if (provided !== requiredKey) {
      pushEvent('selenia.dispatch_blocked', { reason: 'dispatch_key_mismatch' });
      return {
        skipped: true,
        reason: 'Protected: set X-Selenia-Dispatch-Key header or JSON dispatchKey to match wrangler secret SELENIA_DISPATCH_KEY',
      };
    }
  }

  const eventType = String(env.GITHUB_DISPATCH_EVENT || 'selenia_approved').trim() || 'selenia_approved';
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'Selenia-Command-Center/1.0',
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: { source: 'selenia-worker', ts: Date.now() },
    }),
  });

  if (res.status === 204) {
    pushEvent('selenia.dispatch_sent', { repo, event_type: eventType });
    return { ok: true, httpStatus: 204, repo, event_type: eventType };
  }

  const detail = await res.text();
  pushEvent('selenia.dispatch_error', { httpStatus: res.status, detail: detail.slice(0, 400) });
  return { ok: false, httpStatus: res.status, detail: detail.slice(0, 800) };
}

function githubWebRepoBase(repo) {
  return `https://github.com/${repo}`;
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function gastroActionsConfig(env) {
  const repo = String(env.SELENIA_ACTIONS_REPO || 'maticabaleiro2012-create/onbox-universe').trim();
  const wf = String(env.SELENIA_GASTRO_WORKFLOW || 'gastronomia-smoke.yml').trim();
  const token = env.GITHUB_TOKEN;
  return { repo, wf, token };
}

/** Lista corridas del workflow (útil justo después de workflow_dispatch). */
async function fetchGitHubWorkflowRuns(token, repo, workflowFile, perPage = 5) {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${perPage}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Selenia-Command-Center/1.0',
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

/** Últimas corridas de cualquier workflow del repo (solo lectura). */
async function fetchGitHubRepoRuns(token, repo, perPage = 8) {
  const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=${perPage}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Selenia-Command-Center/1.0',
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

function pickNewWorkflowRun(beforeIds, runs) {
  if (!Array.isArray(runs)) return null;
  return runs.find((r) => !beforeIds.has(r.id)) || null;
}

/** Whitelisted "commands" = safe HTTP to Core (expand gradually). */
async function runWhitelistedCommand(env, moduleId, action, payload) {
  const key = `${moduleId}:${action}`;

  if (key === 'sistemas:health-check') {
    const core = await upstreamCore(env, '/health');
    pushEvent('module.command', { moduleId, action, path: '/health' });
    return {
      ok: core.ok,
      result: core.json,
      via: 'core-v2',
      status: core.status,
    };
  }

  if (key === 'gastronomia:health-check' || key === 'gastronomia:dashboard') {
    const gastro = await fetchGastronomiaDiagnostics(env);
    pushEvent('module.command', { moduleId, action, via: 'gastronomia-proxy' });
    return {
      ok: gastro.mainOk,
      result: gastro,
      via: 'logistica-gastronomica-proxy',
    };
  }

  /** Dispara workflow_dispatch en onbox-universe (tests + E2E gastro). Requiere GITHUB_TOKEN con scope repo/workflow. */
  if (key === 'gastronomia:run-ci' || key === 'sistemas:ci-gastro') {
    const { repo, wf, token } = gastroActionsConfig(env);
    const ref = String(env.SELENIA_ACTIONS_REF || 'master').trim() || 'master';
    if (!token) {
      return { ok: false, error: 'Falta secret GITHUB_TOKEN (PAT con permiso workflow en el repo de actions)' };
    }
    const p = payload && typeof payload === 'object' ? payload : {};
    const runSmoke = p.run_smoke === true;
    const workerUrl = typeof p.worker_url === 'string' ? p.worker_url : '';
    const beforeSnap = await fetchGitHubWorkflowRuns(token, repo, wf, 8);
    const beforeIds = new Set(beforeSnap.ok ? beforeSnap.runs.map((r) => r.id) : []);
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'Selenia-Command-Center/1.0',
      },
      body: JSON.stringify({
        ref,
        inputs: { run_smoke: runSmoke, worker_url: workerUrl },
      }),
    });
    if (res.status === 204) {
      pushEvent('module.command', { moduleId, action, via: 'github-actions', repo, workflow: wf, ref });
      const links = {
        workflow: `${githubWebRepoBase(repo)}/actions/workflows/${encodeURIComponent(wf)}`,
        actions: `${githubWebRepoBase(repo)}/actions`,
      };
      await sleepMs(750);
      let runsInfo = await fetchGitHubWorkflowRuns(token, repo, wf, 8);
      let triggeredRun = runsInfo.ok ? pickNewWorkflowRun(beforeIds, runsInfo.runs) : null;
      if (!triggeredRun && runsInfo.ok) {
        await sleepMs(900);
        runsInfo = await fetchGitHubWorkflowRuns(token, repo, wf, 8);
        triggeredRun = runsInfo.ok ? pickNewWorkflowRun(beforeIds, runsInfo.runs) : null;
      }
      const out = {
        ok: true,
        message: 'Workflow encolado en GitHub Actions',
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
            'No apareció un run con ID nuevo todavía: usá «Actualizar corridas» (comando ci-runs) o abrí el workflow en GitHub.';
        }
      } else {
        out.recentRunsError = { httpStatus: runsInfo.httpStatus, detail: runsInfo.detail };
      }
      return out;
    }
    const detail = await res.text();
    pushEvent('module.command.error', { moduleId, action, httpStatus: res.status, detail: detail.slice(0, 400) });
    return { ok: false, httpStatus: res.status, detail: detail.slice(0, 800) };
  }

  /** Solo lectura: últimas corridas del workflow gastronomía (sin dispatch). */
  if (key === 'gastronomia:ci-runs' || key === 'sistemas:ci-gastro-runs') {
    const { repo, wf, token } = gastroActionsConfig(env);
    if (!token) {
      return { ok: false, error: 'Falta secret GITHUB_TOKEN (PAT con permiso workflow/metadata en el repo)' };
    }
    const links = {
      workflow: `${githubWebRepoBase(repo)}/actions/workflows/${encodeURIComponent(wf)}`,
      actions: `${githubWebRepoBase(repo)}/actions`,
    };
    const runsInfo = await fetchGitHubWorkflowRuns(token, repo, wf, 8);
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

  /** Solo lectura: últimas corridas de cualquier workflow del repo (SELENIA_ACTIONS_REPO). */
  if (key === 'sistemas:actions-snapshot') {
    const { repo, token } = gastroActionsConfig(env);
    if (!token) {
      return { ok: false, error: 'Falta secret GITHUB_TOKEN (PAT con permiso metadata/actions en el repo)' };
    }
    const runsInfo = await fetchGitHubRepoRuns(token, repo, 8);
    pushEvent('module.command', { moduleId, action, via: 'github-actions-repo-runs' });
    if (!runsInfo.ok) {
      return { ok: false, httpStatus: runsInfo.httpStatus, detail: runsInfo.detail };
    }
    return {
      ok: true,
      readOnly: true,
      message: 'Snapshot de corridas recientes del repo (todos los workflows)',
      repo,
      links: { actions: `${githubWebRepoBase(repo)}/actions` },
      recentRepoRuns: runsInfo.runs,
    };
  }

  if (key === 'sistemas:logs') {
    pushEvent('module.command', { moduleId, action, stub: true });
    return {
      ok: true,
      stub: true,
      message:
        'Los Workers de Cloudflare no tienen terminal. Para logs: `wrangler tail <worker>` en tu máquina, Logpush, o exponer un endpoint de logs en Admin. Para ejecutar scripts, GitHub Actions (workflow_dispatch) con secret en el repo.',
    };
  }

  if (key === 'sistemas:listar-workers') {
    return {
      ok: true,
      stub: true,
      message:
        'Listado de workers: usá el dashboard de Cloudflare o `wrangler deployments list`. Podemos cablear la API de Cloudflare con token aparte si lo necesitás.',
    };
  }

  if (key === 'sistemas:deploy-preview' || key === 'sistemas:deploy-produccion') {
    return {
      ok: false,
      error:
        'Deploy desde el browser deshabilitado por seguridad. Usá CI (GitHub Actions) o `wrangler deploy` desde entorno controlado.',
    };
  }

  return {
    ok: false,
    error: `Comando no cableado aún: ${key}. Pedí agregar mapping en worker/src/index.js (solo allowlist).`,
    payload: payload || {},
  };
}

async function handleApi(request, env) {
  ensureBootLogged();
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  if (method === 'GET' && pathname === '/health') {
    const body = await buildHealth(env);
    return json(body, 200, corsHeaders());
  }

  if (method === 'GET' && pathname === '/events/stats') {
    return json({ historySize: events.length }, 200, corsHeaders());
  }

  if (method === 'GET' && pathname === '/events/history') {
    return json(events, 200, corsHeaders());
  }

  if (method === 'GET' && pathname === '/connectors/health') {
    const core = await upstreamCore(env, '/health');
    return json(
      {
        anthropic: env.ANTHROPIC_API_KEY ? 'configured' : 'missing',
        core: core.ok ? 'reachable' : 'down',
        coreStatus: core.status,
        github_dispatch: env.GITHUB_TOKEN && String(env.GITHUB_REPO || '').trim() ? 'configured' : 'off',
        chatThreads: env.SELENIA_KV ? 'kv' : 'off',
        d1: env.SELENIA_DB ? 'bound' : 'off',
        internal_key: String(env.SELENIA_INTERNAL_KEY || '').trim() ? 'configured' : 'off',
      },
      200,
      corsHeaders()
    );
  }

  // ── Watchdog: vigilancia activa de todos los sistemas (2026-07-28) ────────
  if (method === 'GET' && pathname === '/watchdog/findings') {
    const body = await getWatchdogFindings(env);
    return json(body, body.ok ? 200 : 503, corsHeaders());
  }
  if (method === 'GET' && pathname === '/watchdog/summary') {
    const body = await getWatchdogSummary(env);
    return json(body, body.ok ? 200 : 503, corsHeaders());
  }
  if (method === 'POST' && pathname === '/watchdog/run') {
    const body = await runWatchdog(env, 'manual');
    pushEvent('watchdog.run', body);
    return json(body, body.ok ? 200 : 503, corsHeaders());
  }

  if (method === 'GET' && pathname === '/ai/knowledge') {
    if (!internalKeyOk(request, env)) return json({ error: 'unauthorized' }, 401, corsHeaders());
    const payload = {
      bundled: getBundledMeta(),
      bundledExcerpt: getBundleExcerpt(4000),
      kvKb: await kvGetJson(env, KV_KB_MAIN),
      kvRoadmap: await kvGetJson(env, KV_ROADMAP_MAIN),
      authRequired: !!String(env.SELENIA_INTERNAL_KEY || '').trim(),
    };
    return json(payload, 200, corsHeaders());
  }

  if (method === 'GET' && pathname === '/ai/roadmap') {
    if (!internalKeyOk(request, env)) return json({ error: 'unauthorized' }, 401, corsHeaders());
    return json(
      {
        kvRoadmap: await kvGetJson(env, KV_ROADMAP_MAIN),
        bundledMeta: getBundledMeta(),
        authRequired: !!String(env.SELENIA_INTERNAL_KEY || '').trim(),
      },
      200,
      corsHeaders()
    );
  }

  if (method === 'GET' && pathname === '/ai/insights') {
    if (!internalKeyOk(request, env)) return json({ error: 'unauthorized' }, 401, corsHeaders());
    const st = (url.searchParams.get('status') || 'pending').trim();
    if (!['pending', 'promoted', 'rejected', 'all'].includes(st)) {
      return json({ error: 'invalid status' }, 400, corsHeaders());
    }
    if (!env.SELENIA_DB) {
      return json({ rows: [], note: 'D1 no configurado en este Worker' }, 200, corsHeaders());
    }
    if (st === 'all') {
      const r = await env.SELENIA_DB.prepare(
        'SELECT id, thread_id, summary, status, created_at, promoted_at FROM conversation_insight ORDER BY created_at DESC LIMIT 100'
      ).all();
      return json({ rows: r.results || [] }, 200, corsHeaders());
    }
    const r = await env.SELENIA_DB.prepare(
      'SELECT id, thread_id, summary, status, created_at, promoted_at FROM conversation_insight WHERE status = ? ORDER BY created_at DESC LIMIT 100'
    )
      .bind(st)
      .all();
    return json({ rows: r.results || [] }, 200, corsHeaders());
  }

  if (method === 'GET' && pathname === '/ai/diagnostics') {
    if (!internalKeyOk(request, env)) return json({ error: 'unauthorized' }, 401, corsHeaders());
    if (!env.SELENIA_DB) return json({ error: 'D1 no configurado' }, 503, corsHeaders());
    const hours = Math.min(72, Math.max(1, Number(url.searchParams.get('hours')) || 12));
    const list = await listDiagnosticSnapshots(env, hours, 200);
    const report = buildTemporalDiagnosticReport(
      list.rows.map((r) => ({ created_at: r.created_at, payload: r.payload }))
    );
    return json(
      {
        hours,
        sampleCount: list.count,
        report,
        recent: list.rows.slice(0, 8),
      },
      200,
      { ...corsHeaders(), 'Cache-Control': 'no-store' }
    );
  }

  if (method === 'POST' && pathname === '/ai/diagnostics/snapshot') {
    if (!internalKeyOk(request, env)) return json({ error: 'unauthorized' }, 401, corsHeaders());
    if (!env.SELENIA_DB) return json({ error: 'D1 no configurado' }, 503, corsHeaders());
    try {
      const r = await captureAndStoreDiagnosticSnapshot(env, 'api');
      pushEvent('selenia.diagnostics.snapshot', { ok: r.ok, id: r.id });
      return json(r, 200, corsHeaders());
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, corsHeaders());
    }
  }

  if (method === 'POST' && pathname === '/ai/knowledge/merge') {
    if (!internalKeyOk(request, env)) return json({ error: 'unauthorized' }, 401, corsHeaders());
    if (!env.SELENIA_KV) return json({ error: 'KV no configurado' }, 503, corsHeaders());
    const body = await readJson(request);
    const prev = await kvGetJson(env, KV_KB_MAIN);
    const base = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
    const merged = {
      ...base,
      ...body,
      updatedAt: Date.now(),
      source: 'api_merge',
    };
    await env.SELENIA_KV.put(KV_KB_MAIN, JSON.stringify(merged));
    pushEvent('selenia.kb.merge', { keys: Object.keys(merged).length });
    return json({ ok: true }, 200, corsHeaders());
  }

  if (method === 'POST' && pathname === '/ai/insights') {
    if (!internalKeyOk(request, env)) return json({ error: 'unauthorized' }, 401, corsHeaders());
    if (!env.SELENIA_DB) return json({ error: 'D1 no configurado' }, 503, corsHeaders());
    const body = await readJson(request);
    const summary = String(body.summary || '').trim().slice(0, 2000);
    const detail = String(body.detail || '').trim().slice(0, 12000);
    const threadId = typeof body.threadId === 'string' ? body.threadId.trim().slice(0, 80) : '';
    if (!summary) return json({ error: 'summary required' }, 400, corsHeaders());
    const id = crypto.randomUUID();
    await env.SELENIA_DB.prepare(
      'INSERT INTO conversation_insight (id, thread_id, summary, detail, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(id, threadId || null, summary, detail || null, 'pending', Date.now())
      .run();
    pushEvent('selenia.insight.create', { id });
    return json({ ok: true, id }, 200, corsHeaders());
  }

  const insightPromote = pathname.match(/^\/ai\/insights\/([^/]+)\/promote$/);
  if (method === 'POST' && insightPromote) {
    if (!internalKeyOk(request, env)) return json({ error: 'unauthorized' }, 401, corsHeaders());
    if (!env.SELENIA_DB) return json({ error: 'D1 no configurado' }, 503, corsHeaders());
    const body = await readJson(request);
    if (String(body.confirm || '').trim() !== 'APROBADO_MEMORIA') {
      return json({ error: 'confirm must be APROBADO_MEMORIA' }, 400, corsHeaders());
    }
    const id = insightPromote[1];
    await env.SELENIA_DB.prepare(
      "UPDATE conversation_insight SET status = 'promoted', promoted_at = ? WHERE id = ? AND status = 'pending'"
    )
      .bind(Date.now(), id)
      .run();
    pushEvent('selenia.insight.promote', { id });
    return json({ ok: true, id }, 200, corsHeaders());
  }

  if (method === 'POST' && pathname === '/ai/threads') {
    if (!env.SELENIA_KV) {
      return json({ threadId: crypto.randomUUID(), ephemeral: true }, 200, corsHeaders());
    }
    const id = crypto.randomUUID();
    await writeThreadDoc(env, id, []);
    return json({ threadId: id, ephemeral: false }, 200, corsHeaders());
  }

  const threadGet = pathname.match(/^\/ai\/threads\/([^/]+)$/);
  if (method === 'GET' && threadGet) {
    const threadId = threadGet[1];
    if (!isValidThreadId(threadId)) return json({ error: 'invalid threadId' }, 400, corsHeaders());
    if (!env.SELENIA_KV) {
      return json({ threadId, updatedAt: Date.now(), messages: [], ephemeral: true }, 200, corsHeaders());
    }
    const doc = await readThreadDoc(env, threadId);
    if (!doc) return json({ threadId, updatedAt: null, messages: [] }, 200, corsHeaders());
    return json(
      {
        threadId: doc.threadId || threadId,
        updatedAt: doc.updatedAt || null,
        messages: Array.isArray(doc.messages) ? doc.messages : [],
        ephemeral: false,
      },
      200,
      corsHeaders()
    );
  }

  if (method === 'GET' && pathname === '/ops/overview') {
    try {
      const body = await buildOpsOverview(env);
      return json(body, 200, { ...corsHeaders(), 'Cache-Control': 'no-store' });
    } catch (e) {
      pushEvent('ops.overview.error', { message: e.message });
      return json({ error: e.message }, 502, { ...corsHeaders(), 'Cache-Control': 'no-store' });
    }
  }

  if (method === 'GET' && pathname === '/ops/audit') {
    try {
      const origin = new URL(request.url).origin;
      const body = await buildOpsAudit(env, origin, { headers: coreAuthHeaders(env) });
      pushEvent('ops.audit', { total: body.summary?.total, fail: body.summary?.fail });
      return json(body, 200, { ...corsHeaders(), 'Cache-Control': 'no-store' });
    } catch (e) {
      pushEvent('ops.audit.error', { message: e.message });
      return json({ error: e.message }, 502, { ...corsHeaders(), 'Cache-Control': 'no-store' });
    }
  }

  if (method === 'POST' && pathname === '/ai/chat') {
    try {
      const body = await readJson(request);
      const single = typeof body.message === 'string' ? body.message.trim() : '';
      let messages = normalizeAnthropicMessages(body.messages);
      if (single) messages = normalizeAnthropicMessages([...messages, { role: 'user', content: single }]);
      if (!messages.length) return json({ error: 'message or messages[] required' }, 400, corsHeaders());

      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUser && lastUser.content.includes('APROBADO_SELENIA')) {
        pushEvent('selenia.human_approval', { token: 'APROBADO_SELENIA' });
      }
      if (lastUser && lastUser.content.includes('APROBADO_DATOS')) {
        pushEvent('selenia.human_approval', { token: 'APROBADO_DATOS' });
      }

      const councilLite = body.councilLite !== false;
      pushEvent('selenia.chat.user', { chars: lastUser?.content?.length || 0, turns: messages.length, councilLite });
      const reply = await anthropicChatMessages(env, messages, councilLite, body.dashboardContext, request.url);
      pushEvent('selenia.chat.assistant', { chars: reply.length });
      const githubDispatch = await tryGithubRepositoryDispatch(request, env, body, lastUser?.content || '');
      const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
      let threadSaved = false;
      if (threadId && isValidThreadId(threadId) && env.SELENIA_KV) {
        const merged = normalizeAnthropicMessages([...messages, { role: 'assistant', content: reply }]);
        threadSaved = await writeThreadDoc(env, threadId, merged);
      }
      return json({ message: reply, githubDispatch, threadId: threadId || undefined, threadSaved }, 200, corsHeaders());
    } catch (e) {
      pushEvent('selenia.chat.error', { message: e.message, code: e.code, status: e.status });
      const status = e.code === 'NO_API_KEY' ? 503 : e.status >= 400 && e.status < 600 ? e.status : 502;
      const isRate = status === 429 || /rate limit|tokens per minute/i.test(String(e.message || ''));
      const friendly = isRate
        ? 'Selenia llegó al límite de tokens por minuto de Anthropic. Esperá ~60 s y volvé a pedir, o partí la consulta en partes más cortas (ej. usá un quick-action específico).'
        : e.message;
      return json({ error: friendly, rateLimited: isRate, retryAfterSeconds: isRate ? 60 : undefined }, status, corsHeaders());
    }
  }

  const cmdMatch = pathname.match(/^\/modules\/([^/]+)\/command$/);
  if (method === 'POST' && cmdMatch) {
    const moduleId = cmdMatch[1];
    if (!MODULES_BASE[moduleId]) return json({ error: 'unknown module' }, 404, corsHeaders());
    const body = await readJson(request);
    const action = typeof body.action === 'string' ? body.action : '';
    if (!action) return json({ error: 'action required' }, 400, corsHeaders());
    try {
      const result = await runWhitelistedCommand(env, moduleId, action, body.payload || {});
      const status = result.ok === false && result.error ? 400 : 200;
      return json(result, status, corsHeaders());
    } catch (e) {
      pushEvent('module.command.error', { message: e.message });
      return json({ error: e.message }, 502, corsHeaders());
    }
  }

  return json({ error: 'not found' }, 404, corsHeaders());
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Selenia-Dispatch-Key, X-Selenia-Thread-Key, X-Selenia-Internal-Key',
  };
}

function isApiPath(pathname) {
  if (pathname === '/health') return true;
  if (pathname.startsWith('/events')) return true;
  if (pathname === '/ops/overview' || pathname === '/ops/audit') return true;
  if (pathname.startsWith('/ai/')) return true;
  if (pathname.startsWith('/modules/') && pathname.endsWith('/command')) return true;
  if (pathname === '/connectors/health') return true;
  if (pathname.startsWith('/watchdog/')) return true;
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (isApiPath(pathname) || request.method === 'OPTIONS') {
      return handleApi(request, env);
    }

    if (env.ASSETS) {
      const assetUrl =
        pathname === '/' || pathname === '' ? new URL('/index.html', request.url).toString() : request.url;
      const res = await env.ASSETS.fetch(new Request(assetUrl, request));
      if (res.status !== 404) return res;
    }

    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ensureBootLogged();
    try {
      if (!env.SELENIA_DB) return;
      await captureAndStoreDiagnosticSnapshot(env, 'cron');
      pushEvent('diagnostic.snapshot.cron', { cron: event.cron, ok: true });
    } catch (e) {
      pushEvent('diagnostic.snapshot.cron', { ok: false, error: String(e.message || e) });
    }
    // Vigilante: cada corrida del cron revisa TODOS los sistemas (workers + datos).
    try {
      const r = await runWatchdog(env, 'cron');
      pushEvent('watchdog.cron', r);
    } catch (e) {
      pushEvent('watchdog.cron', { ok: false, error: String(e.message || e) });
    }
  },
};
