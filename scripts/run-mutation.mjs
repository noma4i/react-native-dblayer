#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Mutation testing scoped to what actually changed.
 *
 * A full run mutates every line of the package and takes hours, so it can only ever be an occasional
 * background job - which in practice meant the verdict was never read. This runner asks git which
 * lines differ from the base ref and mutates exactly those, using Stryker's `file:start-end` mutation
 * range. The incremental file carries every earlier verdict forward, so untouched code keeps its
 * result instead of being retested.
 *
 * Usage: node scripts/run-mutation.mjs <baseRef> [-- extra stryker args]
 */

const SOURCE = /^src\/.*\.tsx?$/;
const EXCLUDED = /^src\/(__tests__|types)\//;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

const resolveBase = requested => {
  if (!requested) throw new Error('Mutation base ref is required');
  git('rev-parse', '--verify', '--quiet', requested);
  return requested;
};

/** Changed line ranges per file, read from a zero-context diff so every hunk is exactly the changed lines. */
const changedRanges = base => {
  const diff = git('diff', '-U0', base, '--', 'src');
  const ranges = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file || !SOURCE.test(file) || EXCLUDED.test(file)) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    if (!ranges.has(file)) ranges.set(file, []);
    ranges.get(file).push(`${file}:${start}-${start + count - 1}`);
  }
  return ranges;
};

const [, , maybeBase, ...rest] = process.argv;
const base = resolveBase(maybeBase && !maybeBase.startsWith('-') ? maybeBase : undefined);
const passthrough = maybeBase && maybeBase.startsWith('-') ? [maybeBase, ...rest] : rest;

const ranges = [...changedRanges(base).values()].flat();
if (ranges.length === 0) {
  console.error(`No mutable source changes against ${base}.`);
  process.exit(1);
}

console.log(`Mutating ${ranges.length} changed range(s) against ${base}:`);
for (const range of ranges) console.log(`  ${range}`);

const result = spawnSync('npx', ['stryker', 'run', '--mutate', ranges.join(','), ...passthrough], { stdio: 'inherit' });
process.exit(result.status ?? 1);
