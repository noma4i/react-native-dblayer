import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const srcRoot = path.resolve(__dirname, '../../..');

/**
 * Cache is the ONLY wipeable class of data. `compositeStorageKey` is typed to `CacheNamespace`,
 * so a durable key cannot be built through the cache-key surface - unless someone bypasses the
 * type with a cast or a computed namespace. This gate closes that bypass: every call passes a
 * plain string literal from the cache set, and no source casts into `CacheNamespace`.
 */
const CACHE_NAMESPACES = new Set(['row', 'scope', 'tombstones', 'query', 'query-invalidation']);

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

describe('reset discipline', () => {
  it('passes every cache-key namespace as a literal from the cache set', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'compositeStorageKey') {
          const namespace = node.arguments[1];
          if (namespace === undefined || !ts.isStringLiteral(namespace) || !CACHE_NAMESPACES.has(namespace.text)) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            violations.push(`${path.relative(srcRoot, file)}:${line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });

  it('never casts into CacheNamespace to smuggle a durable key through the cache surface', () => {
    const offenders = sourceFiles(srcRoot)
      .filter(file => /as CacheNamespace/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(srcRoot, file));
    expect(offenders).toEqual([]);
  });
});
