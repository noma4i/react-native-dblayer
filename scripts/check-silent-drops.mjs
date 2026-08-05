#!/usr/bin/env node
// Silent-drop gate: every code point that can discard data must carry a verdict in
// scripts/silent-drop-registry.json. A new unclassified hit fails the commit, so a silent
// data-drop cannot enter the tree unnamed. Verdicts: CONTRACT (spec rule named), COUNTED
// (diagnostics mechanism named), HOLE (open defect, tracked), NONDROP (not a data-drop point).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const LIB_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SURFACES = ['src/core', 'src/dsl', 'src/read', 'src/queries'];
const REGISTRY_PATH = path.join(LIB_ROOT, 'scripts', 'silent-drop-registry.json');
const PATTERNS = [
  /\bcontinue\b/,
  /return (null|undefined)\b/,
  /\breturn;/,
  /\.filter\(/,
  /\bcatch\b/,
  /\?\? \[\]/,
  /\?\? \{\}/,
  /\.set\(/,
  /\?\? 0\b/,
  /\?\? ''/,
  /\?\? null\b/,
  /\.delete\(/,
  /\.clear\(/,
  /\.slice\(/,
  /\.splice\(/,
  /Object\.assign\(/,
  /Number\.isFinite/,
  /Number\(/
];
const VERDICTS = new Set(['CONTRACT', 'COUNTED', 'HOLE', 'NONDROP']);

const walk = dir => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...walk(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
};

export const scanSurface = (root, surfaces) => {
  const hits = [];
  const seenText = new Map();
  for (const surface of surfaces) {
    for (const file of walk(path.join(root, surface))) {
      const rel = path.relative(root, file);
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!PATTERNS.some(pattern => pattern.test(line))) return;
        const text = line.trim();
        const textKey = `${rel}|${text}`;
        const occurrence = (seenText.get(textKey) ?? 0) + 1;
        seenText.set(textKey, occurrence);
        hits.push({ key: `${textKey}|${occurrence}`, file: rel, line: index + 1, text });
      });
    }
  }
  return hits;
};

const mode = process.argv[2] ?? '--check';
const hits = scanSurface(LIB_ROOT, SURFACES);

if (mode === '--scan') {
  process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
  process.exit(0);
}

let registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
} catch {
  console.error(`silent-drops: registry missing or unreadable at ${REGISTRY_PATH}`);
  process.exit(1);
}

const entries = new Map();
const problems = [];
for (const entry of registry.entries ?? []) {
  if (typeof entry.key !== 'string' || !VERDICTS.has(entry.verdict) || typeof entry.ref !== 'string' || entry.ref.length === 0) {
    problems.push(`malformed entry: ${JSON.stringify(entry).slice(0, 120)}`);
    continue;
  }
  if (entries.has(entry.key)) problems.push(`duplicate entry: ${entry.key}`);
  entries.set(entry.key, entry);
}

const hitKeys = new Set(hits.map(hit => hit.key));
const unclassified = hits.filter(hit => !entries.has(hit.key));
const stale = [...entries.keys()].filter(key => !hitKeys.has(key));

for (const hit of unclassified) problems.push(`UNCLASSIFIED ${hit.file}:${hit.line} :: ${hit.text.slice(0, 100)}`);
for (const key of stale) problems.push(`STALE ${key.slice(0, 140)}`);

if (problems.length > 0) {
  console.error(`silent-drops: RED (${unclassified.length} unclassified, ${stale.length} stale)`);
  for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
  if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
  process.exit(1);
}

const holes = [...entries.values()].filter(entry => entry.verdict === 'HOLE').length;
console.log(`silent-drops: OK (${hits.length} points, ${entries.size} classified, ${holes} open HOLE)`);
