#!/usr/bin/env node
/**
 * E2E Selenia Command Center — HTTP documentados + chat con tools alineado a la API
 * (audit.summary.fail, overview.summary.activeAlerts, run_module_command vs POST, get_orders_monitor vs overview).
 *
 * Uso:
 *   npm run test:e2e
 *   SELENIA_E2E_BASE=https://tu-worker.workers.dev npm run test:e2e
 *   SELENIA_E2E_SKIP_CHAT=1 npm run test:e2e
 *   SELENIA_E2E_CHAT_RETRIES=3 npm run test:e2e
 *   SELENIA_E2E_INTERNAL_KEY=... si el Worker tiene SELENIA_INTERNAL_KEY (GET/POST /ai/*)
 */

const BASE = (process.env.SELENIA_E2E_BASE || 'https://selenia-command-center.soporte-a90.workers.dev').replace(
  /\/$/,
  ''
);
const SKIP_CHAT = process.env.SELENIA_E2E_SKIP_CHAT === '1';
const CHAT_RETRIES = Math.max(1, Math.min(5, Number(process.env.SELENIA_E2E_CHAT_RETRIES || '3') || 3));
const E2E_INTERNAL = String(process.env.SELENIA_E2E_INTERNAL_KEY || '').trim();

function internalHeaders() {
  const h = { Accept: 'application/json' };
  if (E2E_INTERNAL) h['X-Selenia-Internal-Key'] = E2E_INTERNAL;
  return h;
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: internalHeaders() });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: r.ok, status: r.status, data };
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...internalHeaders() },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: r.ok, status: r.status, data };
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function parseTaggedInt(msg, tag) {
  const re = new RegExp(`${tag}\\s*=\\s*(\\d+)`, 'i');
  const clean = String(msg || '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = clean.match(re);
  return m ? Number(m[1]) : null;
}

async function chatUntilMatch(prompt, tag, expected, threadId) {
  let lastMsg = '';
  let got = null;
  for (let attempt = 1; attempt <= CHAT_RETRIES; attempt++) {
    const chat = await post('/ai/chat', {
      messages: [{ role: 'user', content: prompt }],
      councilLite: false,
      threadId,
    });

    if (chat.status === 503 && String(chat.data?.error || '').toLowerCase().includes('api_key')) {
      return { skipped: true, reason: 'anthropic_503' };
    }

    assert(chat.ok && typeof chat.data?.message === 'string', `/ai/chat ${chat.status} ${JSON.stringify(chat.data).slice(0, 500)}`);
    lastMsg = chat.data.message;
    got = parseTaggedInt(lastMsg, tag);
    if (got === expected) return { ok: true, got, lastMsg };
    console.warn(`Chat intento ${attempt}/${CHAT_RETRIES}: ${tag} parseado=${got} esperado=${expected}. Respuesta: ${lastMsg.slice(0, 240)}`);
  }
  return { ok: false, got, lastMsg };
}

async function main() {
  console.log('E2E base:', BASE);

  let r = await get('/health');
  assert(r.ok && r.status === 200, `/health status ${r.status}`);
  assert(r.data && typeof r.data.uptime === 'number', '/health missing uptime');
  assert(r.data.modules && typeof r.data.modules === 'object', '/health missing modules');
  assert(Object.keys(r.data.modules).length === 6, '/health expected 6 modules');

  r = await get('/events/stats');
  assert(r.ok && typeof r.data.historySize === 'number', '/events/stats');

  r = await get('/events/history');
  assert(r.ok && Array.isArray(r.data), '/events/history not array');

  r = await get('/connectors/health');
  assert(r.ok && r.data.anthropic, '/connectors/health');
  assert(typeof r.data.d1 === 'string', '/connectors/health d1');
  assert(typeof r.data.internal_key === 'string', '/connectors/health internal_key');

  r = await get('/ai/knowledge');
  if (r.status === 401) {
    console.warn('SKIP /ai/knowledge: 401 (configurá SELENIA_E2E_INTERNAL_KEY si el destino tiene SELENIA_INTERNAL_KEY).');
  } else {
    assert(r.ok, `/ai/knowledge ${r.status}`);
    assert(r.data && r.data.bundled && typeof r.data.bundled.version === 'string', 'ai/knowledge bundled.version');
    assert(typeof r.data.bundled.hash === 'string', 'ai/knowledge bundled.hash');
    assert(typeof r.data.bundledExcerpt === 'string', 'ai/knowledge bundledExcerpt');
  }

  r = await get('/ai/roadmap');
  if (r.status === 401) {
    console.warn('SKIP /ai/roadmap: 401');
  } else {
    assert(r.ok, `/ai/roadmap ${r.status}`);
    assert(r.data && r.data.bundledMeta && typeof r.data.bundledMeta.version === 'string', 'ai/roadmap bundledMeta');
  }

  r = await get('/ai/insights?status=pending');
  if (r.status === 401) {
    console.warn('SKIP /ai/insights: 401');
  } else {
    assert(r.ok, `/ai/insights ${r.status}`);
    assert(Array.isArray(r.data.rows), 'ai/insights rows');
  }

  const diag = await get('/ai/diagnostics?hours=1');
  if (diag.status === 401) {
    console.warn('SKIP /ai/diagnostics: 401 (configurá SELENIA_E2E_INTERNAL_KEY).');
  } else if (diag.status === 503) {
    console.warn('SKIP /ai/diagnostics: 503 (D1 no configurado en este destino).');
  } else {
    assert(diag.ok, `/ai/diagnostics ${diag.status} ${JSON.stringify(diag.data).slice(0, 300)}`);
    assert(typeof diag.data?.sampleCount === 'number', '/ai/diagnostics sampleCount');
    assert(diag.data?.report && typeof diag.data.report === 'object', '/ai/diagnostics report');
    const before = diag.data.sampleCount;
    const snap = await post('/ai/diagnostics/snapshot', {});
    if (snap.status === 503) {
      console.warn('SKIP POST /ai/diagnostics/snapshot: 503 (D1 no configurado).');
    } else {
      assert(snap.ok && typeof snap.data?.id === 'string', `/ai/diagnostics/snapshot ${snap.status} ${JSON.stringify(snap.data).slice(0, 300)}`);
      const after = await get('/ai/diagnostics?hours=1');
      assert(after.ok, `/ai/diagnostics post-snapshot ${after.status}`);
      assert(
        typeof after.data?.sampleCount === 'number' && after.data.sampleCount >= before + 1,
        `sampleCount no aumentó: antes=${before} después=${after.data?.sampleCount}`
      );
    }
  }

  const ins = await post('/ai/insights', { summary: 'e2e smoke insight', detail: 'autogenerated', threadId: 'e2e' });
  if (ins.status === 401) {
    console.warn('SKIP POST /ai/insights: 401');
  } else if (ins.status === 503) {
    console.warn('SKIP POST /ai/insights: D1 no configurado en el Worker (esperado en algunos entornos).');
  } else {
    assert(ins.ok && ins.data && typeof ins.data.id === 'string', `/ai/insights create ${ins.status} ${JSON.stringify(ins.data)}`);
    const pr = await post(`/ai/insights/${ins.data.id}/promote`, { confirm: 'APROBADO_MEMORIA' });
    assert(pr.ok && pr.data && pr.data.ok === true, `/ai/insights promote ${pr.status} ${JSON.stringify(pr.data)}`);
  }

  r = await get('/ops/overview');
  assert(r.ok, `/ops/overview ${r.status}`);
  const ov = r.data;
  assert(typeof ov.contract === 'string' && ov.contract.length > 0, 'overview.contract');
  assert(typeof ov.generatedAt === 'number', 'overview.generatedAt');
  assert(Array.isArray(ov.modules) && ov.modules.length === 6, 'overview.modules');
  assert(ov.summary && typeof ov.summary === 'object', 'overview.summary');
  const expectAlerts =
    typeof ov.summary.activeAlerts === 'number' && !Number.isNaN(ov.summary.activeAlerts)
      ? ov.summary.activeAlerts
      : 0;
  const expectOrdersMon =
    typeof ov.summary?.ordersMonitorCount === 'number' && !Number.isNaN(ov.summary.ordersMonitorCount)
      ? ov.summary.ordersMonitorCount
      : null;

  r = await get('/ops/audit');
  assert(r.ok, `/ops/audit ${r.status}`);
  const audit = r.data;
  assert(typeof audit.summary?.fail === 'number', 'audit.summary.fail');
  assert(typeof audit.summary?.total === 'number', 'audit.summary.total');
  assert(Array.isArray(audit.probes) && audit.probes.length > 0, 'audit.probes');
  const probeIds = new Set(audit.probes.map((p) => p.id));
  assert(probeIds.has('core-v2-health') || probeIds.has('onbox-core-health'), 'audit probes missing expected core ids');
  const expectFails = audit.summary.fail;

  // POST allowlist: sistemas + gastronomía health (mismo Worker que el panel)
  const sysRes = await post('/modules/sistemas/command', { action: 'health-check' });
  assert(sysRes.ok, `/modules/sistemas/command health-check ${sysRes.status} ${JSON.stringify(sysRes.data).slice(0, 200)}`);
  assert(typeof sysRes.data?.ok === 'boolean', 'sistemas health-check missing ok');
  const expectSysHealth = sysRes.data.ok ? 1 : 0;

  r = await post('/modules/gastronomia/command', { action: 'health-check' });
  assert(r.ok, `/modules/gastronomia/command health-check ${r.status}`);
  assert(typeof r.data?.ok === 'boolean', 'gastronomia health-check missing ok');

  // Solo lectura CI list (puede fallar sin GITHUB_TOKEN — aceptamos ok o error documentado)
  r = await post('/modules/gastronomia/command', { action: 'ci-runs' });
  assert(
    (r.ok && r.data && (r.data.readOnly === true || r.data.recentRuns)) ||
      (r.status === 400 && String(r.data?.error || '').length > 0) ||
      (r.ok === false && r.data?.error),
    `gastronomia ci-runs inesperado: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`
  );

  if (SKIP_CHAT) {
    console.log('OK: contratos HTTP + comandos módulo (chat omitido SELENIA_E2E_SKIP_CHAT=1)');
    return;
  }

  const tr1 = await post('/ai/threads', {});
  assert(tr1.ok && tr1.data.threadId, `/ai/threads ${JSON.stringify(tr1.data)}`);

  const promptAudit =
    'Debés invocar exactamente una vez la herramienta get_ops_audit. Con el JSON que devuelve la tool, respondé una sola línea sin markdown ni texto extra, exactamente en este formato: FAILS=N donde N es el entero summary.fail de ese JSON. No expliques nada más.';

  const a1 = await chatUntilMatch(promptAudit, 'FAILS', expectFails, tr1.data.threadId);
  if (a1.skipped) {
    console.warn('SKIP chat: Anthropic no configurado en el destino (503).');
    return;
  }
  assert(a1.ok, `FAILS mismatch. Última: ${(a1.lastMsg || '').slice(0, 500)}`);

  const tr2 = await post('/ai/threads', {});
  assert(tr2.ok && tr2.data.threadId, `/ai/threads 2 ${JSON.stringify(tr2.data)}`);

  const promptOverview =
    'Debés invocar exactamente una vez la herramienta get_ops_overview. Con el JSON de la tool, respondé una sola línea sin markdown: ALERTS=N donde N es el entero summary.activeAlerts de ese JSON (si no existe, usá 0). Nada más.';

  const a2 = await chatUntilMatch(promptOverview, 'ALERTS', expectAlerts, tr2.data.threadId);
  assert(a2.ok, `ALERTS mismatch (GET overview tenía ${expectAlerts}). Última: ${(a2.lastMsg || '').slice(0, 500)}`);

  const tr3 = await post('/ai/threads', {});
  assert(tr3.ok && tr3.data.threadId, `/ai/threads 3 ${JSON.stringify(tr3.data)}`);
  const promptSysTool =
    'Invocá exactamente una vez la herramienta run_module_command con module_id sistemas y action health-check. Respondé una sola línea: SYSHEALTH=1 si el JSON de la tool tiene ok true, SYSHEALTH=0 si no. Nada más.';
  const a3 = await chatUntilMatch(promptSysTool, 'SYSHEALTH', expectSysHealth, tr3.data.threadId);
  assert(a3.ok, `SYSHEALTH mismatch (POST directo ok=${expectSysHealth}). Última: ${(a3.lastMsg || '').slice(0, 500)}`);

  let ordersLine = '';
  if (expectOrdersMon !== null) {
    const tr4 = await post('/ai/threads', {});
    assert(tr4.ok && tr4.data.threadId, `/ai/threads 4 ${JSON.stringify(tr4.data)}`);
    const promptOrders =
      'Invocá exactamente una vez la herramienta get_orders_monitor. Respondé una sola línea: ORDERS=N donde N es el entero orders_count del JSON de la tool. Nada más.';
    const a4 = await chatUntilMatch(promptOrders, 'ORDERS', expectOrdersMon, tr4.data.threadId);
    assert(a4.ok, `ORDERS mismatch (overview.summary.ordersMonitorCount=${expectOrdersMon}). Última: ${(a4.lastMsg || '').slice(0, 500)}`);
    ordersLine = ` ORDERS=${a4.got}`;
  }

  console.log('OK: E2E HTTP + módulos + chat FAILS=', a1.got, 'ALERTS=', a2.got, 'SYSHEALTH=', a3.got, ordersLine || ' (ORDERS omitido si overview no trae ordersMonitorCount)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
