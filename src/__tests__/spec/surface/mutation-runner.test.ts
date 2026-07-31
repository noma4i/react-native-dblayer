import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const config = JSON.parse(readFileSync(resolve(root, 'stryker.conf.json'), 'utf8')) as {
  mutate?: string[];
  reporters?: string[];
  eventReporter?: { baseDir?: string };
};
const packageManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

describe('mutation runner contract', () => {
  it('covers the entire executable source surface', () => {
    expect(config.mutate).toEqual(['src/**/*.{ts,tsx}', '!src/__tests__/**', '!src/types/**']);
  });

  it('persists one event for every completed mutant', () => {
    expect(config.reporters).toContain('event-recorder');
    expect(config.eventReporter).toEqual({ baseDir: 'reports/mutation/events' });
  });

  it('enforces the hard process budget in the canonical command', () => {
    expect(packageManifest.scripts?.['test:mutation']).toBe('gtimeout 180 stryker run');
  });
});
