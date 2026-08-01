import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const config = JSON.parse(readFileSync(resolve(root, 'stryker.conf.json'), 'utf8')) as {
  mutate?: string[];
  reporters?: string[];
  incremental?: boolean;
  incrementalFile?: string;
  timeoutMS?: number;
  mutator?: { excludedMutations?: string[] };
  eventReporter?: { baseDir?: string };
};
const packageManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const jestConfig = readFileSync(resolve(root, 'jest.stryker.config.js'), 'utf8');

/**
 * The mutation gate is the only instrument that separates a test which checks something from one
 * that merely runs the code, so the ways it can be silently disabled are pinned here. Each of these
 * once held: mutators excluded until a fraction of mutants were generated, behavioural axes dropped
 * from the runner so their own owner tests could kill nothing, and a canonical command wrapped in a
 * timeout shorter than any complete run.
 */
describe('mutation runner contract', () => {
  it('covers the entire executable source surface', () => {
    expect(config.mutate).toEqual(['src/**/*.{ts,tsx}', '!src/__tests__/**', '!src/types/**']);
  });

  it('generates every mutator the tool offers', () => {
    expect(config.mutator?.excludedMutations).toEqual([]);
  });

  it('keeps every behavioural axis in the runner', () => {
    const ignored = /testPathIgnorePatterns:\s*\[([^\]]*)\]/.exec(jestConfig)?.[1] ?? '';
    const droppedAxes = ['perf', 'rerender', 'appshape', 'consumer', 'integrity', 'sufficiency', 'utils', 'read'].filter(axis =>
      ignored.includes(`spec/${axis}/`)
    );

    expect(droppedAxes).toEqual([]);
  });

  it('carries earlier verdicts forward instead of retesting untouched code', () => {
    expect(config.incremental).toBe(true);
    expect(config.incrementalFile).toBe('reports/mutation/incremental.json');
  });

  it('leaves a mutant enough time to reach a real verdict', () => {
    // Measured: at 15s the same 15 mutants produced 11 timeouts and no speed gain, and Stryker scores
    // a timeout as a kill - a starved mutant is reported as caught by a test that never ran.
    expect(config.timeoutMS).toBeGreaterThanOrEqual(60000);
  });

  it('persists one event for every completed mutant', () => {
    expect(config.reporters).toContain('event-recorder');
    expect(config.eventReporter).toEqual({ baseDir: 'reports/mutation/events' });
  });

  it('scopes the routine command to changed lines and leaves the full run explicit', () => {
    expect(packageManifest.scripts?.['test:mutation']).toBe('node scripts/run-mutation.mjs');
    expect(packageManifest.scripts?.['test:mutation:full']).toBe('stryker run --force');
  });
});
