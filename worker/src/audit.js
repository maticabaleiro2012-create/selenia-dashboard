/**
 * GET /ops/audit — probes HTTP de solo lectura hacia servicios conocidos del ecosistema.
 * Extendé con var Worker SELENIA_AUDIT_EXTRA: JSON [{ "id", "label", "url", "method"?, "headers"? }]
 */

function headersFromRecord(h) {
  if (!h || typeof h !== 'object') return undefined;
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === 'string') out.set(k, v);
  }
  return out;
}

async function probeUrl(url, init = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: init.method || 'GET', headers: init.headers, redirect: 'manual' });
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
    return {
      ok: res.ok,
      status: res.status,
      ms,
      looksJson,
      snippet,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - t0,
      looksJson: false,
      snippet: String(e.message || e).slice(0, 200),
    };
  }
}

/**
 * @param {Record<string, unknown>} env
 * @param {string} selfOrigin - ej. https://selenia-command-center....workers.dev
 * @param {{ headers: Headers }} auth - CORE_API_TOKEN bearer
 */
export async function buildOpsAudit(env, selfOrigin, auth) {
  const cv2 = String(env.CORE_V2_URL || '').replace(/\/$/, '');
  const leg = String(env.ONBOX_CORE_URL || 'https://onbox-core.soporte-a90.workers.dev').replace(/\/$/, '');
  const gastroBase = String(
    env.GASTRONOMIA_PROXY_URL || 'https://logistica-gastronomica-proxy.soporte-a90.workers.dev'
  ).replace(/\/$/, '');
  const token = String(env.CORE_API_TOKEN || '').trim();
  const baseOrigin = String(selfOrigin || '').replace(/\/$/, '');

  /** @type {{ id: string, label: string, url: string, headers?: Headers }[]} */
  const plan = [];

  if (cv2) plan.push({ id: 'core-v2-health', label: 'Core v2 /health', url: `${cv2}/health` });
  plan.push({ id: 'onbox-core-health', label: 'Onbox Core (legacy) /health', url: `${leg}/health` });
  plan.push({ id: 'gastro-health', label: 'Gastronomía proxy /health', url: `${gastroBase}/health` });
  plan.push({ id: 'gastro-api-health', label: 'Gastronomía proxy /api/health', url: `${gastroBase}/api/health` });
  if (baseOrigin) {
    plan.push({ id: 'selenia-health', label: 'Selenia /health', url: `${baseOrigin}/health` });
    plan.push({ id: 'selenia-connectors', label: 'Selenia /connectors/health', url: `${baseOrigin}/connectors/health` });
  }
  if (token && cv2) {
    plan.push({
      id: 'core-v2-auth-audit',
      label: 'Core v2 /clients/auth-audit',
      url: `${cv2}/clients/auth-audit`,
      headers: auth.headers,
    });
  }

  const probes = [];
  for (const p of plan) {
    const r = await probeUrl(p.url, { headers: p.headers });
    probes.push({
      id: p.id,
      label: p.label,
      url: p.url,
      ...r,
    });
  }

  const notes = [];
  try {
    const raw = String(env.SELENIA_AUDIT_EXTRA || '').trim();
    if (raw) {
      const extra = JSON.parse(raw);
      if (Array.isArray(extra)) {
        for (const e of extra) {
          const u = e && typeof e.url === 'string' ? e.url.trim() : '';
          if (!u) continue;
          const method = typeof e.method === 'string' ? e.method : 'GET';
          const h = headersFromRecord(e.headers);
          const r = await probeUrl(u, { method, headers: h });
          probes.push({
            id: String(e.id || 'extra'),
            label: String(e.label || u),
            url: u,
            ...r,
          });
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
    contract: 'read-only GET (auth-audit con Bearer si hay token)',
    summary: { total: probes.length, ok: probes.length - fail, fail },
    probes,
    notes,
  };
}
