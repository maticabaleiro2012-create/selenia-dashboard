/**
 * Selenia on Cloudflare Workers:
 * - Serves static UI from [assets] public/
 * - POST /ai/chat → Anthropic (secret ANTHROPIC_API_KEY)
 * - GET /health, /events/history, POST /modules/:id/command (allowlist only)
 *
 * No bash or terminal: Workers cannot spawn a shell. Commands are HTTP calls to your APIs.
 * For runbooks, use GitHub Actions workflow_dispatch with repo secrets.
 */

const WORKER_BOOT = Date.now();

const MODULES_BASE = {
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
let bootLogged = false;

function pushEvent(type, payload = {}) {
  events.push({ type, payload, meta: { timestamp: Date.now() } });
  if (events.length > 500) events.splice(0, events.length - 500);
}

function ensureBootLogged() {
  if (bootLogged) return;
  bootLogged = true;
  pushEvent('selenia.boot', { version: '0.4.0-cf', provider: 'anthropic', runtime: 'cloudflare-worker' });
  Object.keys(MODULES_BASE).forEach((id) => pushEvent('module.registered', { id }));
  pushEvent('gateway.ready', { mode: 'worker', routes: ['health', 'events', 'ai/chat', 'modules/*/command'] });
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

const SYSTEM_PROMPT = `Sos Selenia, el asistente del Command Center de OnBox (logística, e-commerce, gastronomía).
Corré en Cloudflare Workers: no tenés shell ni acceso a bash; los "comandos" son llamadas HTTP a APIs internas (Core, Admin, etc.).
Explicá eso si el usuario pide terminal o SSH. En español rioplatense si el usuario escribe así.
No inventés datos de pedidos/stock sin API.`;

async function anthropicChat(env, userMessage) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    const e = new Error('ANTHROPIC_API_KEY not configured (wrangler secret put ANTHROPIC_API_KEY)');
    e.code = 'NO_API_KEY';
    throw e;
  }
  const model = env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
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
  if (!text) throw new Error('Empty Anthropic response');
  return text;
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
      },
      200,
      corsHeaders()
    );
  }

  if (method === 'POST' && pathname === '/ai/chat') {
    try {
      const body = await readJson(request);
      const message = typeof body.message === 'string' ? body.message : '';
      if (!message.trim()) return json({ error: 'message required' }, 400, corsHeaders());
      pushEvent('selenia.chat.user', { chars: message.length });
      const reply = await anthropicChat(env, message.trim());
      pushEvent('selenia.chat.assistant', { chars: reply.length });
      return json({ message: reply }, 200, corsHeaders());
    } catch (e) {
      pushEvent('selenia.chat.error', { message: e.message, code: e.code });
      const status = e.code === 'NO_API_KEY' ? 503 : e.status >= 400 && e.status < 600 ? e.status : 502;
      return json({ error: e.message }, status, corsHeaders());
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function isApiPath(pathname) {
  if (pathname === '/health') return true;
  if (pathname.startsWith('/events')) return true;
  if (pathname.startsWith('/ai/')) return true;
  if (pathname.startsWith('/modules/') && pathname.endsWith('/command')) return true;
  if (pathname === '/connectors/health') return true;
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
};
