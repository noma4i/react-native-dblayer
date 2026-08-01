import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '../../..');

/**
 * The reader's subscription belongs to this package, not to the engine's React binding.
 *
 * The binding re-renders on every change to the query and takes neither a projection nor a result
 * comparison, so a reader would repaint where its own value did not move. That is a decided design,
 * not a preference - and until now nothing held it, so the binding could be adopted by anyone who
 * read the engine's docs instead of the spec.
 *
 * The package is present in `node_modules` as a transitive dependency, which is exactly why the
 * import has to be refused here: it resolves, so nothing else would object.
 */
const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

describe('reader subscription ownership', () => {
  it('imports no React binding of the collection engine', () => {
    const offenders = sourceFiles(srcRoot)
      .filter(file => /from\s+'@tanstack\/react-db'|require\(\s*'@tanstack\/react-db'\s*\)/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(srcRoot, file));

    expect(offenders).toEqual([]);
  });

  it('declares every engine package it imports', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(srcRoot, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
    const imported = new Set(
      sourceFiles(srcRoot).flatMap(file =>
        [...fs.readFileSync(file, 'utf8').matchAll(/from '(@tanstack\/[a-z-]+)'/g)].map(match => match[1]!)
      )
    );

    expect([...imported].filter(name => !declared.has(name)).sort()).toEqual([]);
  });
});
