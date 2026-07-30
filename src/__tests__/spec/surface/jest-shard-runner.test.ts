import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const runnerPath = resolve(process.cwd(), 'scripts/run-jest-shards.mjs');
const fakeJestPath = resolve(process.cwd(), 'scripts/__fixtures__/fake-jest-shard.mjs');
const jestConfig = require(resolve(process.cwd(), 'jest.config.js')) as {
  collectCoverageFrom?: string[];
  coverageThreshold?: { global?: Record<string, number> };
};
const testFiles = ['alpha.test.ts', 'beta.test.tsx', 'gamma.test.ts', 'delta.test.tsx'].map((file) =>
  resolve(process.cwd(), 'src/__tests__/spec/surface', file)
);

const runFake = (options?: { failOn?: string; sleepOn?: string; timeoutMs?: number }) => {
  const directory = mkdtempSync(join(tmpdir(), 'dblayer-jest-shards-'));
  const logPath = join(directory, 'calls.jsonl');
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DBLAYER_JEST_BIN: fakeJestPath,
      DBLAYER_JEST_SHARDS: '2',
      DBLAYER_JEST_TEST_FILES: JSON.stringify(testFiles),
      DBLAYER_JEST_TIMEOUT_MS: String(options?.timeoutMs ?? 1_000),
      DBLAYER_FAKE_JEST_LOG: logPath,
      ...(options?.failOn ? { DBLAYER_FAKE_JEST_FAIL_ON: options.failOn } : {}),
      ...(options?.sleepOn ? { DBLAYER_FAKE_JEST_SLEEP_ON: options.sleepOn } : {})
    }
  });
  const calls = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  rmSync(directory, { recursive: true, force: true });
  return { calls, result };
};

describe('Jest shard runner', () => {
  it('runs every discovered test file exactly once', () => {
    const { calls, result } = runFake();
    expect(result.status).toBe(0);
    expect(calls.flat().sort()).toEqual([...testFiles].sort());
  });

  it('fails the aggregate run when any shard fails', () => {
    const { result } = runFake({ failOn: 'gamma.test.ts' });
    expect(result.status).not.toBe(0);
  });

  it('fails the aggregate run when any shard exceeds its timeout', () => {
    const { result } = runFake({ sleepOn: 'beta.test.tsx', timeoutMs: 50 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('timed out');
  });

  it('uses more than one child for a full multi-file run', () => {
    const { calls, result } = runFake();
    expect(result.status).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('measures every production source file at 100 percent', () => {
    expect(jestConfig.collectCoverageFrom).toEqual([
      'src/**/*.{ts,tsx}',
      '!src/**/*.types.ts',
      '!src/**/__tests__/**',
      '!src/index.ts'
    ]);
    expect(jestConfig.coverageThreshold?.global).toEqual({
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    });
  });
});
