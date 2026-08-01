import fs from 'node:fs';
import path from 'node:path';

const surfaceRoot = path.resolve(__dirname);
const specFile = path.resolve(__dirname, '../../../../specs/10-testing.md');

/**
 * The discipline table of the testing spec is the registry of surface gates, and it is checked both
 * ways. A named discipline without a test is declared but never written - the failure that let an
 * ordering drift live for months. A test outside the table is a gate the spec does not know about,
 * so nothing keeps its subject described.
 */
/**
 * A declared gate is a hyphenated backticked name in the middle column of a three-column table. The
 * shape is what identifies it, not the wording of the heading, so the registry keeps working while
 * the prose around it is edited.
 */
const declaredTests = (): string[] => {
  const rows = fs
    .readFileSync(specFile, 'utf8')
    .split('\n')
    .filter(line => line.startsWith('|') && line.split('|').length === 5);
  return [...new Set(rows.flatMap(row => [...(row.split('|')[2] ?? '').matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)].map(match => match[1]!)))].sort();
};

const surfaceTests = (): string[] =>
  fs
    .readdirSync(surfaceRoot)
    .flatMap(name => (name.endsWith('.test.ts') || name.endsWith('.test.tsx') ? [name.replace(/\.test\.tsx?$/, '')] : []))
    .sort();

describe('discipline registry', () => {
  it('names an existing test for every declared discipline', () => {
    const declared = declaredTests();
    expect(declared.length).toBeGreaterThan(10);

    expect(declared.filter(name => !fs.existsSync(path.join(surfaceRoot, `${name}.test.ts`)))).toEqual([]);
  });

  it('declares every surface gate that exists', () => {
    const declared = new Set(declaredTests());

    expect(surfaceTests().filter(name => name !== 'discipline-registry' && !declared.has(name))).toEqual([]);
  });
});
