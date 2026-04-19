/**
 * Anthropic tool-use loop para Selenia (allowlist: overview, audit, lecturas Core v2, comandos módulo).
 * El ejecutor concreto (fetch ops, GitHub, etc.) lo inyecta el caller (Worker o Node).
 */

import { buildSystemPrompt } from './prompts.js';

export const SELENIA_TOOL_DEFINITIONS = [
  {
    name: 'get_ops_overview',
    description: 'Estado agregado del ecosistema (Core v2, legacy, inventario, pedidos, gastro, incidentes).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_ops_audit',
    description: 'Probes HTTP read-only a /health y rutas documentadas. Para auditar conectividad.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_orders_monitor',
    description: 'GET Core v2 /orders/monitor?all=1. Devuelve orders_count y HTTP status.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_inventory_location',
    description: 'GET Core v2 /inventory/summary por location (onbox|fulfillment).',
    input_schema: {
      type: 'object',
      properties: { location: { type: 'string', enum: ['onbox', 'fulfillment'] } },
      required: ['location'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_architecture_doc',
    description: 'Bundle curado docs/architecture. Sin section_id devuelve índice.',
    input_schema: {
      type: 'object',
      properties: { section_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_system_knowledge',
    description: 'KV selenia:kb:main (memoria humana/ops).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_roadmap',
    description: 'KV selenia:roadmap:main.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_pending_insights',
    description: 'D1 conversation_insight status=pending.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'query_d1_tables',
    description: 'SELECT limitado sobre tablas D1 allowlist.',
    input_schema: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          enum: ['knowledge_entry', 'roadmap_item', 'conversation_insight', 'diagnostic_snapshot'],
        },
        limit: { type: 'integer', description: 'Max 50, default 20' },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_operational_hints',
    description: 'Resumen pedidos+inventario+señales con hints. No afirma causas sin datos.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_orders_snapshot',
    description: 'Recorte de los primeros pedidos del monitor.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max 40, default 20' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_order_lines',
    description: 'GET /orders/lines?orderKey=… (cruzar pedido vs stock).',
    input_schema: {
      type: 'object',
      properties: { order_key: { type: 'string' } },
      required: ['order_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'core_v2_inventory_write',
    description:
      'POST FIFO stock_apply|stock_reverse. Requiere APROBADO_DATOS del usuario. Body README core-v2.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['stock_apply', 'stock_reverse'] },
        body: { type: 'object' },
      },
      required: ['action', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_system_diagnostic',
    description:
      'Captura snapshot en D1 + informe vs ventana N horas (deltas, hints, próximos pasos).',
    input_schema: {
      type: 'object',
      properties: { hours: { type: 'integer', description: 'Default 12, max 72.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_diagnostic_report',
    description: 'Lectura: historial D1 + informe temporal (sin nueva captura).',
    input_schema: {
      type: 'object',
      properties: { hours: { type: 'integer', description: 'Default 12, max 72.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'core_v2_orders_write',
    description: 'POST orders/lines/upsert. Requiere APROBADO_DATOS.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lines_upsert'] },
        body: { type: 'object' },
      },
      required: ['action', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_module_command',
    description:
      'Comando allowlist del panel. run-ci/ci-gastro disparan GitHub Actions: requieren APROBADO_SELENIA en el chat.',
    input_schema: {
      type: 'object',
      properties: {
        module_id: { type: 'string', enum: ['gastronomia', 'sistemas'] },
        action: {
          type: 'string',
          enum: [
            'health-check',
            'dashboard',
            'run-ci',
            'ci-gastro',
            'ci-runs',
            'ci-gastro-runs',
            'actions-snapshot',
            'logs',
            'listar-workers',
            'deploy-preview',
            'deploy-produccion',
          ],
        },
        payload: { type: 'object', additionalProperties: true },
      },
      required: ['module_id', 'action'],
      additionalProperties: false,
    },
  },
];

export function sanitizeDashboardContextForPrompt(raw) {
  if (raw == null) return '';
  let s = '';
  try {
    if (typeof raw === 'string') s = String(raw).trim();
    else if (typeof raw === 'object' && !Array.isArray(raw)) s = JSON.stringify(raw);
    else return '';
  } catch {
    return '';
  }
  const max = 4000;
  if (s.length > max) return `${s.slice(0, max)}\n…(truncado para límite de tokens; pedí get_ops_overview si querés el detalle)`;
  return s;
}

export function truncateToolResult(str, max = 28000) {
  const t = String(str || '');
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…(truncado)`;
}

/** True si algún mensaje user del turno incluye la frase de aprobación (misma regla que GitHub dispatch). */
export function transcriptHasHumanApproval(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (m.role === 'user' && String(m.content || '').includes('APROBADO_SELENIA')) return true;
  }
  return false;
}

/** Mutaciones de datos en Core v2 (inventario, etc.) — frase explícita del usuario. */
export function transcriptHasDataApproval(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (m.role === 'user' && String(m.content || '').includes('APROBADO_DATOS')) return true;
  }
  return false;
}

function extractTextAndToolUses(data) {
  const content = Array.isArray(data.content) ? data.content : [];
  const textParts = [];
  const toolUses = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) textParts.push(b.text);
    if (b.type === 'tool_use' && b.id && b.name) {
      toolUses.push({ id: b.id, name: b.name, input: b.input && typeof b.input === 'object' ? b.input : {} });
    }
  }
  return { text: textParts.join('').trim(), toolUses, rawBlocks: content };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {boolean} opts.councilLite
 * @param {unknown} opts.dashboardContext
 * @param {{role:string,content:string}[]} opts.messages
 * @param {(name: string, input: object) => Promise<string>} opts.executeTool
 * @param {string} [opts.curatedContextAppend]
 */
export async function anthropicChatWithTools(opts) {
  const { apiKey, model, councilLite, dashboardContext, messages, executeTool, curatedContextAppend = '' } = opts;
  if (!apiKey) {
    const e = new Error('ANTHROPIC_API_KEY not configured (wrangler secret put ANTHROPIC_API_KEY)');
    e.code = 'NO_API_KEY';
    throw e;
  }
  const dash = sanitizeDashboardContextForPrompt(dashboardContext);
  const system = buildSystemPrompt(councilLite !== false, dash, curatedContextAppend);

  const working = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const maxRounds = 8;
  for (let round = 0; round < maxRounds; round++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system,
        tools: SELENIA_TOOL_DEFINITIONS,
        tool_choice: { type: 'auto' },
        messages: working,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data.error?.message || data.message || resp.statusText || 'Anthropic API error';
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }

    const { text, toolUses, rawBlocks } = extractTextAndToolUses(data);
    if (!toolUses.length) {
      if (!text) throw new Error('Empty Anthropic response');
      return text;
    }

    working.push({ role: 'assistant', content: rawBlocks });
    const toolResultBlocks = [];
    for (const tu of toolUses) {
      let out = '';
      try {
        out = await executeTool(tu.name, tu.input || {});
      } catch (e) {
        out = JSON.stringify({ ok: false, error: String(e.message || e) });
      }
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: truncateToolResult(typeof out === 'string' ? out : JSON.stringify(out)),
      });
    }
    working.push({ role: 'user', content: toolResultBlocks });
  }
  throw new Error('Límite de rondas con herramientas alcanzado');
}
