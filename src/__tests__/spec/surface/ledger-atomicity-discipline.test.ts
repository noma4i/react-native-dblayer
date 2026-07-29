import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Structural counterpart to the behavioral atomicity specs: a commit envelope carries immutable
// operation transitions and materialized entries. Callback-valued envelope arguments and the old
// persist:false escape hatch are forbidden because both make pre-WAL live ledger mutation expressible.

const srcRoot = path.resolve(__dirname, '../../..');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__tests__') return [];
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

type Violation = { file: string; line: number; kind: string };

type CommitBypass = { file: string; line: number; callee: string };

const unwrapExpression = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const scanFile = (file: string): Violation[] => {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createCommitEnvelope') {
      if (node.arguments.some(argument => ts.isArrowFunction(unwrapExpression(argument)) || ts.isFunctionExpression(unwrapExpression(argument)))) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({ file: path.relative(srcRoot, file), line: line + 1, kind: 'callback-envelope' });
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'persist' &&
      node.initializer.kind === ts.SyntaxKind.FalseKeyword
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push({ file: path.relative(srcRoot, file), line: line + 1, kind: 'persist-false' });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
};

describe('ledger/row persist atomicity discipline', () => {
  it('forbids callback envelopes and the pre-WAL persist:false escape hatch', () => {
    const violations = sourceFiles(srcRoot).flatMap(scanFile);
    expect(violations).toEqual([]);
  });

  it('routes every runtime write through commit(envelope)', () => {
    const bypasses: CommitBypass[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const text = fs.readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'apply') {
          const receiver = node.expression.expression.getText(source);
          if (receiver === 'getApplyRuntime()' || receiver === 'runtime') {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            bypasses.push({ file: path.relative(srcRoot, file), line: line + 1, callee: `${receiver}.apply` });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(bypasses).toEqual([]);
  });
});
