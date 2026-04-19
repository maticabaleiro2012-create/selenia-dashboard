/**
 * Snapshots agregados (D1) para tendencias ~12h + informe operativo.
 * No reemplaza métricas en Core; es memoria operativa en Selenia.
 */
import { buildOpsAudit } from './audit.js';

function coreAuthHeaders(env) {
  const h = new Headers();
  const t = String(env.CORE_API_TOKEN || '').trim();
  if (t) h.set('Authorization', `Bearer ${t}`);
  return h;
}

async function fetchJsonDiag(url, init) {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      j = { raw: text.slice(0, 400) };
    }
    return { ok: res.ok, status: res.status, json: j };
  } catch (e) {
    return { ok: false, status: 0, json: { error: String(e.message || e) } };
  }
}

function extractOrdersArray(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.data?.orders)) return data.data.orders;
  if (Array.isArray(data.orders)) return data.orders;
  return [];
}

/** Payload compacto: audit + señales Core (mismo espíritu que get_operational_hints). */
export async function gatherDiagnosticPayload(env, source = 'tool') {
  const cv2 = String(env.CORE_V2_URL || '').replace(/\/$/, '');
  const selfBase = String(env.SELENIA_PUBLIC_BASE || 'https://selenia-command-center.soporte-a90.workers.dev').replace(
    /\/$/,
    ''
  );
  const noop = () => {};
  const authH = coreAuthHeaders(env);
  const tokenPresent = !!String(env.CORE_API_TOKEN || '').trim();

  let auditSummary = { total: 0, ok: 0, fail: 0 };
  try {
    const audit = await buildOpsAudit(env, selfBase, { headers: authH });
    const s = audit?.summary;
    if (s && typeof s === 'object') {
      auditSummary = {
        total: Number(s.total) || 0,
        ok: Number(s.ok) || 0,
        fail: Number(s.fail) || 0,
      };
    }
  } catch (_) {
    auditSummary = { total: 0, ok: 0, fail: -1 };
  }

  if (!cv2) {
    return {
      generatedAt: Date.now(),
      source,
      audit_summary: auditSummary,
      core: { error: 'CORE_V2_URL no configurado' },
      hints: [{ severity: 'error', code: 'no_core_url', detail: 'Falta CORE_V2_URL' }],
    };
  }

  const [ordersR, onb, ful] = await Promise.all([
    fetchJsonDiag(`${cv2}/orders/monitor?all=1`, { method: 'GET', headers: authH }),
    fetchJsonDiag(`${cv2}/inventory/summary?location=onbox&byLocation=true&limit=2000`, { method: 'GET', headers: authH }),
    fetchJsonDiag(
      `${cv2}/inventory/summary?location=fulfillment&byLocation=true&limit=2000`,
      { method: 'GET', headers: authH }
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
      detail: 'CORE_API_TOKEN no configurado en Selenia.',
    });
  }
  if (!ordersR.ok) hints.push({ severity: 'warn', code: 'orders_monitor_fail', detail: `HTTP ${ordersR.status}` });
  if (!onb.ok) hints.push({ severity: 'warn', code: 'inventory_onbox_fail', detail: `HTTP ${onb.status}` });
  if (!ful.ok) hints.push({ severity: 'warn', code: 'inventory_fulfillment_fail', detail: `HTTP ${ful.status}` });
  if (orderCount > 0 && onboxUnits === 0 && fulUnits === 0 && onb.ok && ful.ok) {
    hints.push({
      severity: 'warn',
      code: 'orders_but_zero_inventory_sum',
      detail: 'Pedidos en monitor pero suma inventario 0 — investigar con líneas y movimientos.',
    });
  }

  return {
    generatedAt: Date.now(),
    source,
    audit_summary: auditSummary,
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
      'Roadmap humano: get_roadmap / KV; próximos pasos: proponer en chat y persistir en insights.',
      'Corrección stock: core_v2_inventory_write con APROBADO_DATOS; líneas: core_v2_orders_write.',
    ],
  };
}

export async function pruneOldDiagnosticSnapshots(env, maxAgeMs = 48 * 3600 * 1000) {
  if (!env.SELENIA_DB) return { ok: false };
  const cutoff = Date.now() - maxAgeMs;
  await env.SELENIA_DB.prepare('DELETE FROM diagnostic_snapshot WHERE created_at < ?').bind(cutoff).run();
  return { ok: true };
}

export async function insertDiagnosticSnapshot(env, payload, source = 'scheduled') {
  if (!env.SELENIA_DB) return { ok: false, error: 'D1 no configurado' };
  const id = crypto.randomUUID();
  const createdAt = typeof payload.generatedAt === 'number' ? payload.generatedAt : Date.now();
  const p = { ...payload, source };
  await env.SELENIA_DB.prepare(
    'INSERT INTO diagnostic_snapshot (id, created_at, source, payload_json) VALUES (?, ?, ?, ?)'
  )
    .bind(id, createdAt, source, JSON.stringify(p))
    .run();
  await pruneOldDiagnosticSnapshots(env);
  return { ok: true, id, createdAt };
}

export async function captureAndStoreDiagnosticSnapshot(env, source = 'scheduled') {
  const payload = await gatherDiagnosticPayload(env, source);
  return insertDiagnosticSnapshot(env, payload, source);
}

export async function listDiagnosticSnapshots(env, hours = 12, limit = 120) {
  if (!env.SELENIA_DB) return { ok: false, error: 'D1 no configurado', rows: [] };
  const since = Date.now() - Math.min(72, Math.max(1, hours)) * 3600 * 1000;
  const lim = Math.min(500, Math.max(1, limit));
  const r = await env.SELENIA_DB.prepare(
    'SELECT id, created_at, source, payload_json FROM diagnostic_snapshot WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?'
  )
    .bind(since, lim)
    .all();
  const rows = (r.results || []).map((row) => {
    let parsed = null;
    try {
      parsed = JSON.parse(row.payload_json || '{}');
    } catch {
      parsed = {};
    }
    return { id: row.id, created_at: row.created_at, source: row.source, payload: parsed };
  });
  return { ok: true, hours, since, count: rows.length, rows };
}

/** Comparación simple entre snapshots (tendencia en ventana). */
export function buildTemporalDiagnosticReport(rows) {
  if (!rows.length) {
    return {
      ok: true,
      window: 'empty',
      message: 'Sin snapshots en la ventana. Corré run_system_diagnostic o esperá el cron.',
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
      'Si audit_fail sube: revisar probes en GET /ops/audit.',
      'Si orders suben y stock no: cruzar orderKey con get_order_lines y movimientos en Core.',
      'Para trabajo futuro: actualizar roadmap (KV) o insights pending → promote con APROBADO_MEMORIA.',
    ],
    auto_fix_policy:
      'Selenia no aplica POST a Core sin APROBADO_DATOS en el chat. No hay auto-fix silencioso en producción.',
  };
}
