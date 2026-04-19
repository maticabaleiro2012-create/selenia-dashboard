#!/usr/bin/env node
/**
 * Lee docs/architecture/*.md y genera worker/src/generated/context-bundle.json
 * (inyección en system prompt + tool get_architecture_doc).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const docsDir = path.join(root, 'docs', 'architecture');
const outDir = path.join(root, 'worker', 'src', 'generated');
const outFile = path.join(outDir, 'context-bundle.json');

function main() {
  if (!fs.existsSync(docsDir)) {
    console.warn('No existe', docsDir, '— bundle vacío');
    fs.mkdirSync(outDir, { recursive: true });
    const empty = {
      version: '0',
      generatedAt: Date.now(),
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      markdown: '',
      sections: [],
    };
    fs.writeFileSync(outFile, JSON.stringify(empty, null, 2), 'utf8');
    return;
  }

  const files = fs
    .readdirSync(docsDir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort();
  if (!files.length) {
    console.warn('docs/architecture vacío — generando bundle vacío con marca');
  }

  const sections = [];
  const parts = [];
  for (const f of files) {
    const body = fs.readFileSync(path.join(docsDir, f), 'utf8').trim();
    const id = f.replace(/\.md$/i, '');
    const titleLine = body.split('\n')[0] || id;
    const title = titleLine.replace(/^#\s*/, '').trim() || id;
    sections.push({ id, title, body });
    parts.push(`\n\n## [${id}] ${title}\n\n${body}`);
  }

  const markdown = parts.join('\n').trim();
  const hash = crypto.createHash('sha256').update(markdown, 'utf8').digest('hex');

  const bundle = {
    version: '1',
    generatedAt: Date.now(),
    hash,
    markdown,
    sections,
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(bundle, null, 2), 'utf8');
  console.log('Wrote', outFile, 'sections=', sections.length, 'chars=', markdown.length);
}

main();
