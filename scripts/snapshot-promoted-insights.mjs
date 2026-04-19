#!/usr/bin/env node
/**
 * Snapshot insights `promoted` → escribe modules/selenia-dashboard/docs/architecture/05-insights-promoted.md
 * para que el GitHub Action abra un PR con el diff. Trazabilidad humana del "auto-aprendizaje".
 *
 * Uso (workflow):
 *   SELENIA_BASE=https://selenia-command-center.soporte-a90.workers.dev \
 *   SELENIA_INTERNAL_KEY=*** \
 *   node scripts/snapshot-promoted-insights.mjs
 *
 * No hace cambios si no hay filas o el endpoint devuelve 401/503; sale 0 igual.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const target = path.join(root, 'docs', 'architecture', '05-insights-promoted.md');

const BASE = String(process.env.SELENIA_BASE || '').replace(/\/$/, '');
const KEY = String(process.env.SELENIA_INTERNAL_KEY || '').trim();

if (!BASE) {
  console.error('SELENIA_BASE requerido (URL del Worker).');
  process.exit(2);
}

async function main() {
  const headers = { Accept: 'application/json' };
  if (KEY) headers['X-Selenia-Internal-Key'] = KEY;
  const r = await fetch(`${BASE}/ai/insights?status=promoted`, { headers });
  if (r.status === 401) {
    console.warn('401 /ai/insights — configurá SELENIA_INTERNAL_KEY si el Worker tiene secret.');
    return;
  }
  if (!r.ok) {
    console.warn('Endpoint no OK:', r.status, '— omito snapshot.');
    return;
  }
  const data = await r.json().catch(() => ({}));
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!rows.length) {
    console.log('Sin insights promoted; nada que sincronizar.');
    return;
  }

  const lines = [
    '# Insights promoted (snapshot)',
    '',
    '> Generado por `scripts/snapshot-promoted-insights.mjs` desde `GET /ai/insights?status=promoted`.',
    '> Fuente real: D1 `conversation_insight`. Editar via PR si querés reescribir el detalle.',
    '',
    `Total: ${rows.length}`,
    '',
  ];
  for (const r2 of rows) {
    lines.push(`## ${r2.id}`);
    if (r2.thread_id) lines.push(`- thread: \`${r2.thread_id}\``);
    if (r2.created_at) lines.push(`- created_at: ${new Date(Number(r2.created_at)).toISOString()}`);
    if (r2.promoted_at) lines.push(`- promoted_at: ${new Date(Number(r2.promoted_at)).toISOString()}`);
    lines.push('');
    lines.push(String(r2.summary || '').trim());
    lines.push('');
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  console.log('Wrote', target, 'rows=', rows.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
