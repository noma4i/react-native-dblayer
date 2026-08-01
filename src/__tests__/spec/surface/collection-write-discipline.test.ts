import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const srcRoot = path.resolve(__dirname, '../../..');

/**
 * The collections have exactly one writer: the sync feed the store drives after the journal made a
 * change durable. A second writer - an adapter that fills a collection from its own fetch, or an
 * optimistic mutation of the engine - would put rows on screen that the journal never recorded, and
 * a process kill would then lose them silently.
 */
const FEED_WRITERS = ['core/storeEntities.ts', 'core/storeScopeCollections.ts', 'core/storeSync.ts'];

/** Engine entry points that write into a collection outside the sync feed. */
const FORBIDDEN_IMPORTS = ['createTransaction', 'createOptimisticAction'];

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const parsed = (file: string): ts.SourceFile => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

const feedCalls = (file: string): string[] => {
  const source = parsed(file);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['pushMessage', 'truncate'].includes(node.expression.name.text)) {
      found.push(`${path.relative(srcRoot, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const engineImports = (file: string): string[] => {
  const source = parsed(file);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('@tanstack/') && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        if (FORBIDDEN_IMPORTS.includes(element.name.text)) found.push(`${path.relative(srcRoot, file)}: ${element.name.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('collection write discipline', () => {
  it('drives the sync feed from the store planes only', () => {
    const writers = sourceFiles(srcRoot)
      .filter(file => feedCalls(file).length > 0)
      .map(file => path.relative(srcRoot, file))
      .sort();

    expect(writers).toEqual([...FEED_WRITERS].sort());
  });

  it('imports no engine mutation entry point', () => {
    expect(sourceFiles(srcRoot).flatMap(engineImports)).toEqual([]);
  });
});
