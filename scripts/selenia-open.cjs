/**
 * Abrí Selenia en el navegador con un hilo opcional (para atajos locales: clap, hotkey, etc.).
 *
 * Uso:
 *   node scripts/selenia-open.cjs
 *   node scripts/selenia-open.cjs "https://selenia-command-center.soporte-a90.workers.dev"
 *   node scripts/selenia-open.cjs "https://..." "uuid-del-hilo"
 *   SELENIA_THREAD_ID=<uuid> node scripts/selenia-open.cjs
 *
 * Windows: podés asociar esto a tu detector de aplausos (ej. Task Scheduler / AutoHotkey).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const base = (process.argv[2] || process.env.SELENIA_URL || 'http://127.0.0.1:8780').replace(/\/$/, '');
const argThread = process.argv[3] || process.env.SELENIA_THREAD_ID || '';
const threadFile = path.join(process.cwd(), '.selenia-thread');
let thread = String(argThread).trim();
if (!thread) {
  try {
    thread = fs.readFileSync(threadFile, 'utf8').trim();
  } catch (_) {}
}

const qs = new URLSearchParams();
if (thread) qs.set('thread', thread);
if (process.env.SELENIA_OPEN_VOICE === '1') qs.set('voice', '1');
if (process.env.SELENIA_OPEN_MIC_HINT === '1') qs.set('mic', '1');
const q = qs.toString();
const url = q ? `${base}/?${q}` : `${base}/`;

const platform = process.platform;
if (platform === 'win32') {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
} else if (platform === 'darwin') {
  spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
} else {
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

console.log(url);
