import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '../../..');
const readSource = (relativePath: string): string => fs.readFileSync(path.join(srcRoot, relativePath), 'utf8');

describe('ordering implementation discipline', () => {
  it('keeps field comparison in one canonical ordering module', () => {
    const localImplementations = ['dsl/modelReadAccess.ts', 'read/incrementalReadEngine.ts'].filter(relativePath =>
      /(?:left|right|a|b)\s*<\s*(?:left|right|a|b)\s*\?\s*-1\s*:\s*1/.test(readSource(relativePath))
    );

    expect(localImplementations).toEqual([]);
  });

  it('routes comparator tie handling through the canonical ordering module', () => {
    const bypasses = [
      ['read/useMergedScopeRows.ts', /\.sort\(comparator\)/],
      ['dsl/modelReactiveReads.ts', /comparator\(row,\s*best\)\s*<\s*0/],
      ['utils/modelMaintenance.ts', /\.sort\(compare\)/]
    ].filter(([relativePath, pattern]) => (pattern as RegExp).test(readSource(relativePath as string)));

    expect(bypasses).toEqual([]);
  });
});
