import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '../../..');
const readSource = (relativePath: string): string => fs.readFileSync(path.join(srcRoot, relativePath), 'utf8');

describe('fetch ownership discipline', () => {
  it('delegates freshness decisions to React Query instead of comparing timestamps locally', () => {
    const manualFreshness = ['dsl/defineQuery.ts', 'dsl/defineFetch.ts'].filter(relativePath => /Date\.now\(\)\s*-\s*\w+\.dataUpdatedAt/.test(readSource(relativePath)));

    expect(manualFreshness).toEqual([]);
    expect(readSource('core/fetch/queryFreshness.ts')).toContain('.isStaleByTime(');
  });

  it('delegates scheduled checkpoint and maintenance pacing to TanStack Pacer', () => {
    const rawTimers = ['core/apply/checkpoint.ts', 'core/maintenanceScheduler.ts'].filter(relativePath => /\bsetTimeout\s*\(/.test(readSource(relativePath)));

    expect(rawTimers).toEqual([]);
  });
});
