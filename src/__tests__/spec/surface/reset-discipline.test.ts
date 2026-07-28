import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Structural counterpart to i-reset-definition-registries: a `define*` builder runs once per
// DEFINITION and may re-run (Fast Refresh, test setups), so a bare `registerReset(...)` inside a
// builder body accumulates one resetter per re-run forever. Builder-owned state must register
// through `registerKeyedReset` (replace semantics) instead. Module-level `registerReset` calls
// (one per module load) stay legal.

const dslRoot = path.resolve(__dirname, '../../../dsl');

const builderFiles = (): string[] =>
  fs.readdirSync(dslRoot).filter(name => /^(define|model)[A-Za-z]*\.tsx?$/.test(name)).map(name => path.join(dslRoot, name));

describe('reset discipline', () => {
  it('never registers an unkeyed resetter from inside a definition builder body', () => {
    const violations: string[] = [];
    for (const file of builderFiles()) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node, insideFunction: boolean): void => {
        const nextInside =
          insideFunction || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
        if (insideFunction && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerReset') {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          violations.push(`${path.relative(dslRoot, file)}:${line + 1}`);
        }
        ts.forEachChild(node, child => visit(child, nextInside));
      };
      visit(source, false);
    }
    expect(violations).toEqual([]);
  });
});
