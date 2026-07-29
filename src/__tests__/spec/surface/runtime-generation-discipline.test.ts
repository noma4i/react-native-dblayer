import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const sourceRoot = path.resolve(__dirname, '../../..');
const comparisonOwners = new Set(['core/apply/transaction.ts', 'dsl/configure.ts', 'read/incrementalReadEngine.ts', 'read/scopeReadEngine.ts', 'utils/runtimeGeneration.ts']);

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(target);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const isGenerationCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'getRuntimeGeneration';

const containsGenerationCall = (node: ts.Node): boolean => {
  if (isGenerationCall(node)) return true;
  let found = false;
  ts.forEachChild(node, child => {
    if (!found && containsGenerationCall(child)) found = true;
  });
  return found;
};

describe('runtime generation discipline', () => {
  it('routes async generation comparisons through createGenerationFence', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const relative = path.relative(sourceRoot, file);
      if (comparisonOwners.has(relative)) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (
          ts.isBinaryExpression(node) &&
          [
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken
          ].includes(node.operatorToken.kind) &&
          (containsGenerationCall(node.left) || containsGenerationCall(node.right))
        ) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          violations.push(`${relative}:${line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(violations).toEqual([]);
  });
});
