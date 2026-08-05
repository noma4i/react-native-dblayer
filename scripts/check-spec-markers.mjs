#!/usr/bin/env node
/**
 * Spec-marker catalog gate.
 *
 * (a) Every criterion row in specs/[0-9]*.md (| ID | rule | check | `suite`[, `suite`] |) must have
 *     at least one test case carrying its [ID] marker inside one of its DECLARED suites. A marker
 *     found only outside the declared suites is catalog drift; a marker found nowhere is MISSING.
 * (b) Ratchet: the number of test cases without any [ID] marker must not grow past the recorded
 *     baseline (scripts/.spec-markers-ratchet). Lower it when marking more cases; never raise it.
 *
 * Usage: node scripts/check-spec-markers.mjs [--report]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const specsDir = join(root, 'specs');
const testsDir = join(root, 'src/__tests__/spec');
const ratchetFile = join(root, 'scripts/.spec-markers-ratchet');
const report = process.argv.includes('--report');
const writeBaseline = process.argv.includes('--write-baseline');

const criterionRow = /^\|\s*([A-Z]{1,4}[0-9]+[a-z]?)\s*\|(.+)\|(.+)\|\s*(.+?)\s*\|\s*$/;
const criteria = [];
for (const file of readdirSync(specsDir).filter(name => /^\d.*\.md$/.test(name))) {
  const lines = readFileSync(join(specsDir, file), 'utf8').split('\n');
  for (const line of lines) {
    const match = criterionRow.exec(line);
    if (!match) continue;
    const suites = [...match[4].matchAll(/`([^`]+)`/g)].map(hit => hit[1]).filter(suite => !suite.startsWith('scripts/'));
    if (suites.length === 0) continue;
    criteria.push({ id: match[1], spec: file, suites });
  }
}

const testFiles = [];
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.test\.(ts|tsx)$/.test(entry.name)) testFiles.push(path);
  }
};
walk(testsDir);

// Two passes: plain it/test('title') heads, then the tail of a multi-line it.each([...])('title')
// - the bracket body can hold ')' so the head regex cannot span it.
const titleCase = /\b(?:it|test)(?:\.skip|\.only)?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const eachTail = /\]\s*(?:as\s+const\s*)?\)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const suiteMarkers = new Map();
let unmarked = 0;
let totalCases = 0;
for (const path of testFiles) {
  const suite = path.split('/').pop().replace(/\.test\.(ts|tsx)$/, '');
  const source = readFileSync(path, 'utf8');
  const markers = new Set();
  for (const pattern of [titleCase, eachTail]) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      totalCases += 1;
      const ids = [...match[2].matchAll(/\[([A-Z]{1,4}[0-9]+[a-z]?)\]/g)].map(hit => hit[1]);
      if (ids.length === 0) unmarked += 1;
      for (const id of ids) markers.add(id);
    }
  }
  const existing = suiteMarkers.get(suite) ?? new Set();
  for (const id of markers) existing.add(id);
  suiteMarkers.set(suite, existing);
}

const missing = [];
const drifted = [];
for (const criterion of criteria) {
  const inDeclared = criterion.suites.some(suite => suiteMarkers.get(suite)?.has(criterion.id));
  if (inDeclared) continue;
  const elsewhere = [...suiteMarkers.entries()].filter(([, ids]) => ids.has(criterion.id)).map(([suite]) => suite);
  if (elsewhere.length > 0) drifted.push({ ...criterion, elsewhere });
  else missing.push(criterion);
}

if (report) {
  console.log(`criteria: ${criteria.length}, test cases: ${totalCases}, unmarked cases: ${unmarked}`);
  for (const item of missing) console.log(`MISSING ${item.id} (${item.spec}) declared in: ${item.suites.join(', ')}`);
  for (const item of drifted) console.log(`DRIFT ${item.id} (${item.spec}) declared: ${item.suites.join(', ')} found: ${item.elsewhere.join(', ')}`);
}

if (writeBaseline) {
  writeFileSync(ratchetFile, `${unmarked}\n`);
  console.log(`baseline written: ${unmarked}`);
  process.exit(0);
}

let failed = false;
if (missing.length > 0 || drifted.length > 0) {
  console.error(`spec-markers: ${missing.length} missing, ${drifted.length} drifted criteria (run with --report for the list)`);
  failed = true;
}
if (existsSync(ratchetFile)) {
  const baseline = Number(readFileSync(ratchetFile, 'utf8').trim());
  if (unmarked > baseline) {
    console.error(`spec-markers: unmarked test cases grew ${baseline} -> ${unmarked}; mark new cases with their criterion id`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`spec-markers: OK (${criteria.length} criteria, ${unmarked} unmarked cases)`);
