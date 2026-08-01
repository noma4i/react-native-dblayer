import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '../../..');
const barrel = path.join(srcRoot, 'index.ts');

/**
 * Every module is reachable from the package barrel. A module nobody imports is code that ships,
 * type-checks and passes the suite while running for no one - the tail that survives every refactor
 * because nothing points at it and therefore nothing breaks when it rots.
 */
const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const resolveImport = (from: string, specifier: string): string | null => {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

/** Static imports, lazy `require` and dynamic `import` all count: a module is reached by any of them. */
const importsOf = (file: string): string[] => {
  const text = fs.readFileSync(file, 'utf8');
  const specifiers = [...text.matchAll(/from\s+'([^']+)'/g), ...text.matchAll(/\brequire(?:<[^>]*>)?\(\s*'([^']+)'/g), ...text.matchAll(/\bimport\(\s*'([^']+)'/g)];
  return specifiers.flatMap(match => {
    const target = resolveImport(file, match[1]!);
    return target === null ? [] : [target];
  });
};

/** Walk out from the barrel; whatever the walk never touches has no way into the running package. */
const reachable = (): Set<string> => {
  const seen = new Set<string>([barrel]);
  const queue = [barrel];
  while (queue.length > 0) {
    for (const target of importsOf(queue.pop()!)) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
};

describe('module reachability', () => {
  it('reaches every module from the package barrel', () => {
    const seen = reachable();

    expect(sourceFiles(srcRoot).filter(file => !seen.has(file)).map(file => path.relative(srcRoot, file))).toEqual([]);
  });
});
