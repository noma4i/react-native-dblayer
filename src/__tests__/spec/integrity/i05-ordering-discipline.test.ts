import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '../../..');
const readSource = (relativePath: string): string => fs.readFileSync(path.join(srcRoot, relativePath), 'utf8');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

describe('ordering implementation discipline', () => {
  it('keeps field comparison in one canonical ordering module', () => {
    // Every module of the package is checked, so a new home for a hand-rolled comparison cannot slip in
    // by simply not being on a list.
    const localImplementations = sourceFiles(srcRoot)
      .filter(file => file !== path.join(srcRoot, 'core/ordering.ts'))
      .filter(file => /(?:left|right|a|b)\s*<\s*(?:left|right|a|b)\s*\?\s*-1\s*:\s*1/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(srcRoot, file));

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
