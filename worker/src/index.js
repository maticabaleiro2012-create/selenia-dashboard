import { buildSystemPrompt } from './prompts.js';

/**
 * Selenia on Cloudflare Workers:
 * - Serves static UI from [assets] public/
 * - POST /ai/chat → Anthropic (secret ANTHROPIC_API_KEY)
 * - GET /health, /events/history, POST /modules/:id/command (allowlist only)
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
  pushEvent('selenia.boot', { version: '0.5.0-cf', provider: 'anthropic', runtime: 'cloudflare-worker' });
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

async function anthropicChatMessages(env, messages, councilLite) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    const e = new Error('ANTHROPIC_API_KEY not configured (wrangler secret put ANTHROPIC_API_KEY)');
    e.code = 'NO_API_KEY';
    throw e;
  }
  const model = env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  const system = buildSystemPrompt(councilLite !== false);
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
  if (!text) throw new Error('Empty Anthropic response');
  return text;
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
        github_dispatch: env.GITHUB_TOKEN && String(env.GITHUB_REPO || '').trim() ? 'configured' : 'off',
      },
      200,
      corsHeaders()
    );
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

      const councilLite = body.councilLite !== false;
      pushEvent('selenia.chat.user', { chars: lastUser?.content?.length || 0, turns: messages.length, councilLite });
      const reply = await anthropicChatMessages(env, messages, councilLite);
      pushEvent('selenia.chat.assistant', { chars: reply.length });
      const githubDispatch = await tryGithubRepositoryDispatch(request, env, body, lastUser?.content || '');
      return json({ message: reply, githubDispatch }, 200, corsHeaders());
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Selenia-Dispatch-Key',
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
