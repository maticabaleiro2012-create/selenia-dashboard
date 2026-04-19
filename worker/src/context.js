/**
 * Bundle curado generado por scripts/build-context-bundle.mjs (docs/architecture).
 */
import bundle from './generated/context-bundle.json';

const B = bundle && typeof bundle === 'object' ? bundle : { markdown: '', sections: [], version: '0', hash: '', generatedAt: 0 };

export function getBundledMeta() {
  const sections = Array.isArray(B.sections) ? B.sections : [];
  return {
    version: String(B.version || '0'),
    hash: String(B.hash || ''),
    generatedAt: B.generatedAt != null ? Number(B.generatedAt) : 0,
    sectionCount: sections.length,
    charCount: String(B.markdown || '').length,
  };
}

export function getBundleExcerpt(maxLen = 4000) {
  return String(B.markdown || '').slice(0, maxLen);
}

/** Texto para append al system prompt (truncado). */
export function getCuratedContextAppend(maxChars = 12000) {
  const meta = getBundledMeta();
  const md = String(B.markdown || '');
  const header = `## Contexto OnBox (curado, docs/architecture)\nversion=${meta.version} sha256=${meta.hash} generatedAt=${meta.generatedAt}\n\n`;
  const rest = Math.max(0, maxChars - header.length);
  const slice = md.slice(0, rest);
  const tail = md.length > rest ? '\n…(bundle truncado para límite de tokens)' : '';
  return header + slice + tail;
}

/** Respuesta JSON string para tool get_architecture_doc. */
export function architectureDocToolResult(input) {
  const sectionId =
    input && typeof input.section_id === 'string' ? String(input.section_id).trim() : '';
  const sections = Array.isArray(B.sections) ? B.sections : [];
  if (!sectionId) {
    return JSON.stringify({
      index: sections.map((s) => ({ id: s.id, title: s.title })),
      hint: 'Repetí con section_id para el cuerpo completo de una sección.',
    });
  }
  const s = sections.find((x) => x.id === sectionId);
  if (!s) {
    return JSON.stringify({
      error: 'section_id desconocido',
      section_id: sectionId,
      known_ids: sections.map((x) => x.id),
    });
  }
  return JSON.stringify({
    id: s.id,
    title: s.title,
    body: String(s.body || '').slice(0, 28000),
  });
}
