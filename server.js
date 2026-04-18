/**
 * Selenia local API — serves index.html and powers /ai/chat via Anthropic Claude.
 * Run: npm install && copy .env.example .env (set ANTHROPIC_API_KEY) && npm start
 */

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8780);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const GATEWAY_URL = (process.env.SELENIA_GATEWAY_URL || '').replace(/\/$/, '');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = (process.env.GITHUB_REPO || '').trim();
const GITHUB_DISPATCH_EVENT = (process.env.GITHUB_DISPATCH_EVENT || 'selenia_approved').trim();
const SELENIA_DISPATCH_KEY = process.env.SELENIA_DISPATCH_KEY || '';

const START = Date.now();

const MODULES = {
  gastronomia: {
    status: 'running',
    manifest: {
      name: 'Gastronomía OnBox',
      commands: ['listar-pedidos', 'nuevo-pedido', 'estado-cocina', 'asignar-delivery', 'dashboard'],
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
      commands: ['health-check', 'deploy-preview', 'deploy-produccion', 'listar-workers', 'logs', 'dashboard'],
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
pushEvent('gateway.ready', { mode: GATEWAY_URL ? 'proxy' : 'local-stub', port: PORT });

// Sync with worker/src/prompts.js (governance + council lite)
const SYSTEM_BASE_LOCAL = `Sos Selenia, Command Center de OnBox (logística, e-commerce, gastronomía, 6 módulos).
Runtime: Node local (dev). En prod el mismo rol corre en Cloudflare Worker. No shell en el Worker; deploy vía CI.
Español rioplatense si el usuario escribe así. No inventés números de stock o pedidos sin datos de API.`;

const GOVERNANCE_FULL_LOCAL = `
## Gobernanza (obligatorio)

1. **Clasificá** mentalmente el pedido: SOLO_LECTURA | PROPONE_CAMBIOS | DEPLOY_INFRA | DATOS_SENSIBLES.
2. Si es PROPONE_CAMBIOS, DEPLOY_INFRA o DATOS_SENSIBLES: **no asumas que ya se ejecutó nada**. Proponé plan, riesgos, y rollback. Pedí aclaraciones si falta contexto.
3. **Aprobación explícita del humano** antes de dar por hecho cualquier paso irreversible (deploy prod, migraciones, borrados, rotación de secrets, escritura masiva). Hasta que el usuario no envíe exactamente la frase **APROBADO_SELENIA** (sola o en una línea), solo planificá y advertí; no simules que corriste el paso.
4. Si el usuario ya envió **APROBADO_SELENIA** en el historial reciente y el pedido sigue siendo el mismo: podés detallar pasos concretos siguientes (comandos sugeridos para CI, checks, orden), pero **seguí sin afirmar que el Worker ejecutó deploy** (no puede).
5. Preferí preguntas concretas (una o dos) antes de ramificar en muchas opciones.

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
`;

const GOVERNANCE_MINIMAL_LOCAL = `
## Gobernanza (obligatorio)
Misma regla de **APROBADO_SELENIA** para pasos irreversibles. No shell en Worker. Deploy vía CI.
Respondé en formato breve: riesgo principal, recomendación, una pregunta si hace falta.
`;

function buildSystemPromptLocal(councilLite) {
  return SYSTEM_BASE_LOCAL + (councilLite ? '\n' + GOVERNANCE_FULL_LOCAL : '\n' + GOVERNANCE_MINIMAL_LOCAL);
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

async function anthropicChatMessages(messages, councilLite) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error('Falta ANTHROPIC_API_KEY en .env');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const system = buildSystemPromptLocal(councilLite !== false);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system,
      messages,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data.error?.message || data.message || resp.statusText || 'Anthropic API error';
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }

  const block = (data.content || []).find((b) => b.type === 'text');
  const text = block?.text || '';
  if (!text) throw new Error('Respuesta vacía de Anthropic');
  return text;
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

async function proxyCommand(moduleId, body) {
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

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveStatic(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    send(res, 200, { uptime: Math.floor((Date.now() - START) / 1000), modules: MODULES });
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

  if (req.method === 'GET' && pathname === '/connectors/health') {
    send(res, 200, {
      status: ANTHROPIC_API_KEY ? 'anthropic_configured' : 'anthropic_missing',
      github_dispatch: GITHUB_TOKEN && GITHUB_REPO ? 'configured' : 'off',
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
      const councilLite = body.councilLite !== false;
      pushEvent('selenia.chat.user', { chars: lastUser?.content?.length || 0, turns: messages.length, councilLite });
      const reply = await anthropicChatMessages(messages, councilLite);
      pushEvent('selenia.chat.assistant', { chars: reply.length });
      const githubDispatch = await tryGithubRepositoryDispatchNode(req, body, lastUser?.content || '');
      send(res, 200, { message: reply, githubDispatch });
    } catch (e) {
      pushEvent('selenia.chat.error', { message: e.message, code: e.code });
      const status = e.code === 'NO_API_KEY' ? 503 : e.status >= 400 && e.status < 600 ? e.status : 502;
      send(res, status, { error: e.message });
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
});
