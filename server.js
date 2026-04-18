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

const SYSTEM_PROMPT = `Sos Selenia, el asistente del Command Center de OnBox (logística, e-commerce, gastronomía).
Tenés visión operativa de 6 módulos: gastronomía, logística, onbox-market (marketplace ML/Shopify/TiendaNube), retail/inventario FIFO, sistemas/workers, financiera/AFIP.
Respondé en español rioplatense cuando el usuario escribe así. Sé concreta: pasos, riesgos, y qué medir.
No inventés datos numéricos de pedidos/stock: si no tenés API en vivo, decilo y proponé qué endpoint o pantalla verificar.
No ejecutes código ni shell: solo guiá.`;

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

async function anthropicChat(userMessage) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error('Falta ANTHROPIC_API_KEY en .env');
    err.code = 'NO_API_KEY';
    throw err;
  }

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
  if (!text) throw new Error('Respuesta vacía de Anthropic');
  return text;
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
    send(res, 200, { status: ANTHROPIC_API_KEY ? 'anthropic_configured' : 'anthropic_missing' });
    return;
  }

  if (req.method === 'POST' && pathname === '/ai/chat') {
    try {
      const body = await readBody(req);
      const message = typeof body.message === 'string' ? body.message : '';
      if (!message.trim()) {
        send(res, 400, { error: 'message required' });
        return;
      }
      pushEvent('selenia.chat.user', { chars: message.length });
      const reply = await anthropicChat(message.trim());
      pushEvent('selenia.chat.assistant', { chars: reply.length });
      send(res, 200, { message: reply });
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
