import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Structural counterpart to i-gc-store-projection: every commit batch that carries data
// (rows, scope writes, scope changes) must reach the bus through `publishProjectedBatch`
// (src/core/store.ts), the single seam that projects memberships into the store before
// publishing. A direct `.publish(...)` elsewhere may only ship a data-free signal batch -
// empty `rows`/`scopes` array literals and no `scopeChanges`/`maintenanceModels` keys -
// so an unprojected data batch (orphaned store memberships) is unwritable.

const srcRoot = path.resolve(__dirname, '../../..');
const seamFile = path.join(srcRoot, 'core/store.ts');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__tests__') return [];
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const isEmptyArrayLiteral = (expression: ts.Expression): boolean => ts.isArrayLiteralExpression(expression) && expression.elements.length === 0;

/** A batch literal is data-free when rows/scopes are empty array literals and no scope-carrying key exists. */
const isDataFreeBatchLiteral = (literal: ts.ObjectLiteralExpression): boolean =>
  literal.properties.every(property => {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return false;
    const name = property.name.text;
    if (name === 'scopeChanges' || name === 'maintenanceModels') return false;
    if (name === 'rows' || name === 'scopes') return isEmptyArrayLiteral(property.initializer);
    return true;
  });

describe('commit publish discipline', () => {
  it('routes every data-carrying commit batch through the store projection seam', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      if (file === seamFile) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'publish' &&
          !(node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0]!) && isDataFreeBatchLiteral(node.arguments[0] as ts.ObjectLiteralExpression))
        ) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          violations.push(`${path.relative(srcRoot, file)}:${line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });
});
