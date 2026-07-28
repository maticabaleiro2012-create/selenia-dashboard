/**
 * Selenia Watchdog (2026-07-28) — vigilancia activa de TODOS los sistemas OnBox.
 *
 * Corre por cron (cada 30 min, junto al snapshot) o a demanda (POST /watchdog/run).
 * Tres familias de chequeos:
 *   1. SALUD DE WORKERS  — probes HTTP a cada worker del ecosistema (down/500 = crítico).
 *   2. INTEGRIDAD DE DATOS — SQL de solo lectura contra las DOS Neon (paquetes y gastro):
 *      regresiones conocidas (fechas corridas, pedidos sin líneas, stock negativo,
 *      muebles sin unit_key = clobber de core-v2, wa_outbox trabada, conciliación).
 *   3. ANOMALÍAS ESTADÍSTICAS — el volumen de AYER vs el promedio del mismo día de
 *      semana de las 4 semanas previas (desvío > ±45% = aviso). Baseline simple y
 *      explicable antes que "ML" opaco: cada finding dice exactamente qué midió.
 *
 * Los findings viven en D1 (watchdog_finding): se abren cuando un check dispara,
 * se actualizan si persiste y se AUTO-RESUELVEN cuando el check vuelve a pasar.
 * Un check que no puede correr (tabla renombrada, Neon caída) genera su propio
 * finding informativo — el vigilante nunca falla en silencio.
 *
 * Todo SOLO LECTURA sobre los sistemas vigilados. Sin credenciales Neon (vars
 * NEON_PAQUETES_URL / NEON_GASTRO_URL) la familia 2/3 se omite sin romper.
 */

// ── Neon por HTTP (sin dependencias: el endpoint /sql del driver serverless) ──
async function neonSql(connStr, query, params = []) {
  const m = String(connStr || '').match(/@([^/]+)\//);
  if (!m) throw new Error('conn string inválida');
  const r = await fetch(`https://${m[1]}/sql`, {
    method: 'POST',
    headers: { 'Neon-Connection-String': connStr, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || ('neon http ' + r.status));
  return j.rows || [];
}

// Fecha ART (los datos de negocio están anclados a America/Argentina/Buenos_Aires).
function artYmd(offsetDays = 0) {
  const d = new Date(Date.now() - 3 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

// ── 1) Salud de workers ──────────────────────────────────────────────────────
const WORKERS = [
  { id: 'core-v2', label: 'onbox-core-v2 (núcleo paquetes)', url: 'https://onbox-core-v2.soporte-a90.workers.dev/' },
  { id: 'ops', label: 'portal-logistico (ops)', url: 'https://portal-logistico.soporte-a90.workers.dev/' },
  { id: 'portal', label: 'onbox-portal (sellers)', url: 'https://onbox-portal.soporte-a90.workers.dev/' },
  { id: 'pedidos', label: 'onbox-pedidos', url: 'https://onbox-pedidos.soporte-a90.workers.dev/' },
  { id: 'admin', label: 'onbox-admin', url: 'https://onbox-admin.soporte-a90.workers.dev/' },
  { id: 'delivery', label: 'onbox-delivery-app (choferes)', url: 'https://onbox-delivery-app.soporte-a90.workers.dev/' },
  { id: 'empaque', label: 'onbox-empaque (WMS)', url: 'https://onbox-empaque.soporte-a90.workers.dev/' },
  { id: 'gastro', label: 'logistica-gastronomica-proxy', url: 'https://logistica-gastronomica-proxy.soporte-a90.workers.dev/health' },
];

async function checkWorkers() {
  const out = [];
  await Promise.all(WORKERS.map(async (w) => {
    const t0 = Date.now();
    try {
      const r = await fetch(w.url, { method: 'GET', signal: AbortSignal.timeout(10000) });
      const ms = Date.now() - t0;
      if (r.status >= 500) {
        out.push({ checkId: 'worker_down:' + w.id, system: 'workers', severity: 'critical', title: w.label + ' responde ' + r.status, detail: w.url + ' → HTTP ' + r.status + ' en ' + ms + 'ms', count: 1 });
      } else if (ms > 8000) {
        out.push({ checkId: 'worker_slow:' + w.id, system: 'workers', severity: 'warn', title: w.label + ' lento (' + ms + 'ms)', detail: w.url, count: 1 });
      }
    } catch (e) {
      out.push({ checkId: 'worker_down:' + w.id, system: 'workers', severity: 'critical', title: w.label + ' NO RESPONDE', detail: w.url + ' → ' + String(e.message || e).slice(0, 140), count: 1 });
    }
  }));
  return out;
}

// ── 2) Integridad de datos (SQL solo lectura) ────────────────────────────────
// Cada check: { id, system, severity, title(n), query } — dispara si count > 0.
function paquetesChecks() {
  const hoy = artYmd(0);
  return [
    {
      id: 'fechas_futuras', severity: 'critical',
      title: (n) => n + ' pedido(s) con Fecha de venta en el FUTURO',
      detail: 'Regresión del bug de fechas UTC (27-jul): la fecha de venta debe ser ART. Revisar deploy de core-v2.',
      query: `SELECT count(*)::int n FROM orders WHERE (fields->>'Fecha de venta') IS NOT NULL AND (fields->>'Fecha de venta')::date > '${hoy}'::date AND created_at > now() - interval '7 days'`,
    },
    {
      id: 'pedidos_sin_lineas', severity: 'warn',
      title: (n) => n + ' pedido(s) CON DUEÑO de las últimas 72h sin líneas de producto',
      detail: 'Pedidos reales (con seller y pedido_id) que facturarían sin detalle. Causa histórica: token vencido / DLQ applyfail.',
      query: `SELECT count(*)::int n FROM orders o WHERE o.created_at > now() - interval '72 hours' AND o.seller_id IS NOT NULL AND o.pedido_id IS NOT NULL AND COALESCE(o.fields->>'Estado','') NOT IN ('Cancelado','Anulado') AND NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.order_external_id IN (o.order_external_id, o.unified_id, o.pedido_id, regexp_replace(COALESCE(o.order_external_id,''), '^(meli|tn|shopify|full):', '')) OR l.ml_order_id = o.pedido_id)`,
    },
    {
      id: 'ventas_sin_dueno', severity: 'info',
      title: (n) => n + ' venta(s) SIN DUEÑO ingresadas en 72h (shadow del sync carriers/scanner)',
      detail: 'Filas de tracking sin seller ni pedido — el problema estructural "ventas sin dueño" de la auditoría de stock; crecen solas, medirlas evita sorpresas.',
      query: `SELECT count(*)::int n FROM orders o WHERE o.created_at > now() - interval '72 hours' AND (o.seller_id IS NULL OR o.pedido_id IS NULL)`,
    },
    {
      id: 'stock_negativo', severity: 'warn',
      title: (n) => n + ' lote(s) con stock NEGATIVO',
      detail: 'Lotes por debajo de cero: doble descuento o venta sin ingreso. Ver auditoría de stock.',
      query: `SELECT count(*)::int n FROM inventory_lots WHERE qty_available < 0`,
    },
    {
      id: 'muebles_sin_unitkey', severity: 'critical',
      title: (n) => n + ' posiciones de depósito creadas SIN unit_key en 24h',
      detail: 'Huele a CLOBBER: un deploy viejo de core-v2 sin el código de muebles (pasó 3 veces el 27-jul). Verificar wrangler deployments.',
      query: `SELECT count(*)::int n FROM warehouse_locations WHERE created_at > now() - interval '24 hours' AND unit_key IS NULL AND bay IS NOT NULL AND level IS NOT NULL`,
    },
    {
      id: 'wa_outbox_trabada', severity: 'warn',
      title: (n) => n + ' mensaje(s) de WhatsApp trabados >24h en la cola',
      detail: 'wa_outbox con estado pendiente desde hace más de un día — revisar drainer/secrets Twilio.',
      query: `SELECT count(*)::int n FROM wa_outbox WHERE status IN ('pendiente','pendiente_token','aprobado') AND created_at < now() - interval '24 hours'`,
    },
    {
      id: 'volumen_anomalo', severity: 'warn',
      title: (n) => 'Volumen de pedidos de AYER inusual (desvío ' + n + '%)',
      detail: 'Ayer vs promedio del mismo día de semana (4 semanas previas). >±45% = revisar: caída de ingesta o pico real.',
      query: `WITH ayer AS (SELECT count(*)::float n FROM orders WHERE created_at::date = '${artYmd(-1)}'::date),
              base AS (SELECT count(*)::float / 4.0 avg_n FROM orders WHERE created_at::date IN ('${artYmd(-8)}','${artYmd(-15)}','${artYmd(-22)}','${artYmd(-29)}'))
              SELECT CASE WHEN base.avg_n < 5 THEN 0 ELSE (CASE WHEN abs(ayer.n - base.avg_n) / base.avg_n > 0.45 THEN round(100 * (ayer.n - base.avg_n) / base.avg_n)::int ELSE 0 END) END n FROM ayer, base`,
    },
  ];
}

function gastroChecks() {
  return [
    {
      id: 'gastro_incidentes_viejos', severity: 'warn',
      title: (n) => n + ' incidente(s) de cadetes ABIERTOS hace más de 48h',
      detail: 'cadete_incidents sin resolver — el admin tiene el inbox en Cadetes → Problemas.',
      query: `SELECT count(*)::int n FROM cadete_incidents WHERE status = 'open' AND created_at < now() - interval '48 hours'`,
    },
    {
      id: 'gastro_turnos_sin_cadete', severity: 'info',
      title: (n) => n + ' turno(s) de HOY publicados sin cadete asignado',
      detail: 'Turnos de hoy sin ningún cadete en la junction — puede ser normal temprano, crítico cerca del inicio.',
      query: `SELECT count(*)::int n FROM reserva_turnos r WHERE r.fecha_solo::date = current_date AND COALESCE(r.estado,'') NOT IN ('cancelado','cerrado') AND NOT EXISTS (SELECT 1 FROM reserva_turnos_cadetes rc WHERE rc.reserva_id = r.id)`,
    },
    {
      id: 'gastro_conciliacion_roja', severity: 'warn',
      title: (n) => 'La conciliación diaria de finanzas gastro reportó ' + n + ' hallazgo(s)',
      detail: 'Tabla conciliacion_diaria (cargos duplicados, créditos flotantes, semanas sin facturar) — ver botón 🩺 Control en finanzas.',
      query: `SELECT COALESCE((SELECT jsonb_array_length(findings) FROM conciliacion_diaria ORDER BY created_at DESC LIMIT 1), 0)::int n`,
    },
  ];
}

async function runSqlChecks(connStr, checks, system) {
  const out = [];
  for (const c of checks) {
    try {
      const rows = await neonSql(connStr, c.query);
      const n = Number(rows && rows[0] && rows[0].n) || 0;
      if (n > 0 || (c.id === 'volumen_anomalo' && n !== 0)) {
        out.push({ checkId: c.id, system, severity: c.severity, title: c.title(n), detail: c.detail, count: Math.abs(n) });
      }
    } catch (e) {
      out.push({ checkId: 'check_error:' + c.id, system, severity: 'info', title: 'El check "' + c.id + '" no pudo correr', detail: String(e.message || e).slice(0, 180) + ' — revisar nombre de tabla/columna en watchdog.js', count: 1 });
    }
  }
  return out;
}

// ── Persistencia en D1 ───────────────────────────────────────────────────────
async function ensureWatchdogSchema(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS watchdog_finding (id INTEGER PRIMARY KEY AUTOINCREMENT, check_id TEXT NOT NULL, system TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, count INTEGER, status TEXT NOT NULL DEFAULT 'open', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, resolved_at TEXT)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS watchdog_run (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, findings INTEGER, resolved INTEGER, duration_ms INTEGER, trigger_src TEXT)`);
}

export async function runWatchdog(env, trigger = 'cron') {
  const db = env.SELENIA_DB;
  if (!db) return { ok: false, error: 'sin D1' };
  await ensureWatchdogSchema(db);
  const t0 = Date.now();
  const found = [];
  found.push(...await checkWorkers());
  if (env.NEON_PAQUETES_URL) found.push(...await runSqlChecks(env.NEON_PAQUETES_URL, paquetesChecks(), 'paquetes'));
  if (env.NEON_GASTRO_URL) found.push(...await runSqlChecks(env.NEON_GASTRO_URL, gastroChecks(), 'gastronomia'));

  const now = new Date().toISOString();
  const activeIds = new Set(found.map((f) => f.checkId));
  // Upsert de los que dispararon
  for (const f of found) {
    const open = await db.prepare(`SELECT id FROM watchdog_finding WHERE check_id = ? AND status = 'open' LIMIT 1`).bind(f.checkId).first();
    if (open) {
      await db.prepare(`UPDATE watchdog_finding SET last_seen = ?, title = ?, detail = ?, count = ?, severity = ? WHERE id = ?`)
        .bind(now, f.title, f.detail || '', f.count || 1, f.severity, open.id).run();
    } else {
      await db.prepare(`INSERT INTO watchdog_finding (check_id, system, severity, title, detail, count, status, first_seen, last_seen) VALUES (?,?,?,?,?,?, 'open', ?, ?)`)
        .bind(f.checkId, f.system, f.severity, f.title, f.detail || '', f.count || 1, now, now).run();
    }
  }
  // Auto-resolver los abiertos que ya no disparan
  const stillOpen = await db.prepare(`SELECT id, check_id FROM watchdog_finding WHERE status = 'open'`).all();
  let resolved = 0;
  for (const row of (stillOpen.results || [])) {
    if (!activeIds.has(row.check_id)) {
      await db.prepare(`UPDATE watchdog_finding SET status = 'resolved', resolved_at = ? WHERE id = ?`).bind(now, row.id).run();
      resolved++;
    }
  }
  await db.prepare(`INSERT INTO watchdog_run (ts, findings, resolved, duration_ms, trigger_src) VALUES (?,?,?,?,?)`)
    .bind(now, found.length, resolved, Date.now() - t0, trigger).run();
  return { ok: true, findings: found.length, resolved, duration_ms: Date.now() - t0 };
}

export async function getWatchdogFindings(env) {
  const db = env.SELENIA_DB;
  if (!db) return { ok: false, error: 'sin D1' };
  await ensureWatchdogSchema(db);
  const open = await db.prepare(`SELECT * FROM watchdog_finding WHERE status = 'open' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, last_seen DESC`).all();
  const recent = await db.prepare(`SELECT * FROM watchdog_finding WHERE status = 'resolved' ORDER BY resolved_at DESC LIMIT 15`).all();
  const lastRun = await db.prepare(`SELECT * FROM watchdog_run ORDER BY id DESC LIMIT 1`).first();
  return { ok: true, open: open.results || [], resolved_recent: recent.results || [], last_run: lastRun || null };
}

export async function getWatchdogSummary(env) {
  const f = await getWatchdogFindings(env);
  if (!f.ok) return f;
  const rank = { critical: 3, warn: 2, info: 1 };
  const systems = { workers: 'ok', paquetes: 'ok', gastronomia: 'ok' };
  const worst = {};
  for (const x of f.open) {
    if ((rank[x.severity] || 0) > (rank[worst[x.system]] || 0)) worst[x.system] = x.severity;
  }
  for (const s of Object.keys(systems)) if (worst[s]) systems[s] = worst[s];
  return { ok: true, systems, open_count: f.open.length, critical: f.open.filter((x) => x.severity === 'critical').length, last_run: f.last_run ? f.last_run.ts : null };
}

/** Resumen compacto de findings abiertos para inyectar al contexto del chat. */
export async function watchdogContextBlock(env) {
  try {
    const f = await getWatchdogFindings(env);
    if (!f.ok) return '';
    if (!f.open.length) return '\n\n[VIGILANTE] Sin hallazgos abiertos ahora mismo (última corrida: ' + (f.last_run ? f.last_run.ts : 'nunca') + ').';
    const lines = f.open.slice(0, 12).map((x) => `- [${x.severity}] (${x.system}) ${x.title}${x.detail ? ' — ' + x.detail : ''}`);
    return '\n\n[VIGILANTE — HALLAZGOS ABIERTOS AHORA]\n' + lines.join('\n');
  } catch (_) { return ''; }
}
