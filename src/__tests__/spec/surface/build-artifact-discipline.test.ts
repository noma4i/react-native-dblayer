import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readRootFile = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('build artifact discipline', () => {
  it('uses one canonical build and build-drift check', () => {
    const packageJson = JSON.parse(readRootFile('package.json')) as { scripts: Record<string, string> };
    expect(packageJson.scripts.build).toBe('bob build');
    expect(packageJson.scripts['check:build']).toBe('node scripts/check-build-artifacts.mjs');
  });

  it('runs the build-drift check in CI and pre-commit', () => {
    expect(readRootFile('.github/workflows/ci.yml')).toContain('run: yarn check:build');
    expect(readRootFile('.githooks/pre-commit')).toContain('yarn check:build');
  });

  it('rebuilds the complete output before comparing it with the index', () => {
    const checkScript = readRootFile('scripts/check-build-artifacts.mjs');
    expect(checkScript).toContain("spawnSync('yarn', ['build']");
    expect(checkScript).toContain("['diff', '--quiet', '--', 'lib']");
  });
});
