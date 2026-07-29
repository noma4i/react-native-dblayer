import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const sourceRoot = path.resolve(__dirname, '../../..');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(target);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [target] : [];
  });

describe('sync error discipline', () => {
  it('routes every onSyncError notification through the canonical reporter', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const relative = path.relative(sourceRoot, file);
      if (relative === 'core/syncError.ts') continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (
          (ts.isPropertyAccessExpression(node) && node.name.text === 'onSyncError') ||
          (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'onSyncError')
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
