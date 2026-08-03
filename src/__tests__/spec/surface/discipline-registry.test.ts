import fs from 'node:fs';
import path from 'node:path';

const surfaceRoot = path.resolve(__dirname);
const specFile = path.resolve(__dirname, '../../../../specs/10-testing.md');
const describeWithLocalSpecs = fs.existsSync(specFile) ? describe : describe.skip;

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
    .flatMap(name => (/\.(?:test\.tsx?|typecheck\.ts)$/.test(name) ? [name.replace(/\.(?:test\.tsx?|typecheck\.ts)$/, '')] : []))
    .sort();

const specsRoot = path.dirname(specFile);
const specRoot = path.resolve(__dirname, '..');

/** Every test file of the suite, by bare name, wherever its axis folder happens to be. */
const allSpecTests = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return allSpecTests(target);
    return /\.test\.tsx?$/.test(entry.name) ? [entry.name.replace(/\.test\.tsx?$/, '')] : [];
  });

/** Success criteria carry a fourth column naming the test that pins them: four columns, six cells. */
const criterionTests = (): string[] => {
  const rows = fs
    .readdirSync(specsRoot)
    .filter(name => name.endsWith('.md'))
    .flatMap(name =>
      fs
        .readFileSync(path.join(specsRoot, name), 'utf8')
        .split('\n')
        .filter(line => /^\| [A-Z]+\d+ \|/.test(line) && line.split('|').length === 6)
    );
  return [...new Set(rows.flatMap(row => [...(row.split('|')[4] ?? '').matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/gi)].map(match => match[1]!)))].sort();
};

describeWithLocalSpecs('discipline registry', () => {
  it('names an existing test for every declared discipline', () => {
    const declared = declaredTests();
    expect(declared.length).toBeGreaterThan(10);

    expect(
      declared.filter(
        name =>
          !['.test.ts', '.test.tsx', '.typecheck.ts'].some(suffix => fs.existsSync(path.join(surfaceRoot, `${name}${suffix}`)))
      )
    ).toEqual([]);
  });

  it('declares every surface gate that exists', () => {
    const declared = new Set(declaredTests());

    expect(surfaceTests().filter(name => name !== 'discipline-registry' && !declared.has(name))).toEqual([]);
  });

  it('names an existing test for every success criterion that claims one', () => {
    const named = criterionTests();
    expect(named.length).toBeGreaterThan(20);
    const existing = new Set(allSpecTests(specRoot));

    expect(named.filter(name => !existing.has(name))).toEqual([]);
  });
});
