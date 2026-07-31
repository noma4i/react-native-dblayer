import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const srcRoot = path.resolve(__dirname, '../../..');
const lifetimeHome = path.join(srcRoot, 'core/storeSync.ts');
const LIFETIME_EXPORT = 'OWNED_COLLECTION_LIFETIME';

/**
 * This package owns the lifetime of every collection it builds. The collection library also runs a
 * retention timer of its own and clears a collection left without subscribers, which deletes rows
 * the app still holds and leaves the indexes built over that collection naming rows it no longer
 * holds. One declared lifetime, spread by every construction site, is what keeps the owner single.
 */
const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'types' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const parsed = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Collection factories this package imports from the collection library, taken from the imports themselves. */
const collectionFactories = (files: readonly string[]): Set<string> => {
  const names = new Set<string>();
  for (const file of files) {
    const source = parsed(file);
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === '@tanstack/db' &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const element of node.importClause.namedBindings.elements) {
          if (/^create\w*Collection$/.test(element.name.text)) names.add(element.name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
};

/** Construction sites whose config literal does not spread the declared lifetime. */
const undeclaredSites = (file: string, factories: ReadonlySet<string>): string[] => {
  const source = parsed(file);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && factories.has(node.expression.text)) {
      const config = node.arguments[0];
      const declares =
        config !== undefined &&
        ts.isObjectLiteralExpression(config) &&
        config.properties.some(property => ts.isSpreadAssignment(property) && property.expression.getText(source) === LIFETIME_EXPORT);
      if (!declares) violations.push(`${path.relative(srcRoot, file)}: ${node.expression.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
};

describe('collection lifetime discipline', () => {
  it('declares the owned lifetime at every collection this package builds', () => {
    const files = sourceFiles(srcRoot);
    const factories = collectionFactories(files);
    expect([...factories].sort()).toEqual(['createCollection', 'createLiveQueryCollection']);

    const violations = files.flatMap(file => undeclaredSites(file, factories));

    expect(violations).toEqual([]);
  });

  it('keeps the declared lifetime in one place', () => {
    const declarations = sourceFiles(srcRoot).filter(file => new RegExp(`export const ${LIFETIME_EXPORT}\\b`).test(fs.readFileSync(file, 'utf8')));

    expect(declarations).toEqual([lifetimeHome]);
  });
});
