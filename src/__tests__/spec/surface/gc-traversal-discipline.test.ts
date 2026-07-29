import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

describe('GC traversal discipline', () => {
  it('never dequeues reachability work with a linear Array.shift operation', () => {
    const file = path.resolve(__dirname, '../../../core/gc.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const violations: number[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'shift'
      ) {
        violations.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(violations).toEqual([]);
  });
});
