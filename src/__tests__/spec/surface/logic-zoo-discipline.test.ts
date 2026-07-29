import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

const sourceRoot = resolve(process.cwd(), 'src');
const generationComparisonOwners = new Set([
  'core/apply/transaction.ts',
  'dsl/configure.ts',
  'read/incrementalReadEngine.ts',
  'read/scopeReadEngine.ts',
  'utils/runtimeGeneration.ts'
]);

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

const parsedSources = sourceFiles(sourceRoot).map((file) => ({
  file,
  name: relative(sourceRoot, file),
  source: readFileSync(file, 'utf8'),
  tree: ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}));

const lineOf = (tree: ts.SourceFile, node: ts.Node): number => tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } =>
  (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) && node.body !== undefined;
const containsGenerationCall = (node: ts.Node): boolean => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'getRuntimeGeneration') return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsGenerationCall(child)) found = true;
  });
  return found;
};

describe('logic zoo discipline', () => {
  it('routes semantic mechanisms through their canonical owners', () => {
    const violations: string[] = [];
    for (const entry of parsedSources) {
      const visit = (node: ts.Node): void => {
        if (
          entry.name !== 'core/syncError.ts' &&
          ((ts.isPropertyAccessExpression(node) && node.name.text === 'onSyncError') ||
            (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'onSyncError'))
        ) {
          violations.push(`onSyncError ${entry.name}:${lineOf(entry.tree, node)}`);
        }
        if (
          !generationComparisonOwners.has(entry.name) &&
          ts.isBinaryExpression(node) &&
          [
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken
          ].includes(node.operatorToken.kind) &&
          (containsGenerationCall(node.left) || containsGenerationCall(node.right))
        ) {
          violations.push(`generation-comparison ${entry.name}:${lineOf(entry.tree, node)}`);
        }
        if (entry.name !== 'core/generationRegistry.ts' && isFunctionLike(node) && containsGenerationCall(node)) {
          const text = node.getText(entry.tree);
          if (text.includes('registered') && text.includes('.has(') && text.includes('.get(') && text.includes('.set(')) {
            violations.push(`generation-registry ${entry.name}:${lineOf(entry.tree, node)}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(entry.tree);

      if (entry.name !== 'core/fetch/retryPolicy.ts' && (/Math\.pow\(\s*2\s*,/.test(entry.source) || /\b2\s*\*\*/.test(entry.source))) {
        violations.push(`backoff-formula ${entry.name}`);
      }
      if (entry.name !== 'utils/arrayEquality.ts') {
        const lengthGuard = /(\w+)\.length\s*!==\s*(\w+)\.length/g;
        for (const match of entry.source.matchAll(lengthGuard)) {
          const body = entry.source.slice(match.index, match.index + 500);
          if (body.includes(`${match[1]}[index]`) && body.includes(`${match[2]}[index]`)) {
            violations.push(`array-equality ${entry.name}:${entry.source.slice(0, match.index).split('\n').length}`);
          }
        }
      }
    }
    expect(violations.sort()).toEqual([]);
  });

  it('keeps shallow array equality in one dependency-neutral owner', () => {
    const definitions = parsedSources.filter((entry) => /\b(?:const|function) arraysShallowEqual\b/.test(entry.source)).map((entry) => entry.name);
    expect(definitions).toEqual(['utils/arrayEquality.ts']);
  });

  it('forbids normalized function clones large enough to represent a second mechanism', () => {
    const groups = new Map<string, string[]>();
    for (const entry of parsedSources) {
      const visit = (node: ts.Node): void => {
        if (isFunctionLike(node)) {
          let nodeCount = 0;
          const kinds: number[] = [];
          const fingerprint = (child: ts.Node): void => {
            nodeCount += 1;
            if (!ts.isIdentifier(child) && !ts.isStringLiteral(child) && !ts.isNumericLiteral(child) && !ts.isNoSubstitutionTemplateLiteral(child)) {
              kinds.push(child.kind);
            }
            ts.forEachChild(child, fingerprint);
          };
          fingerprint(node.body);
          if (nodeCount >= 50) {
            const key = kinds.join(',');
            const location = `${entry.name}:${lineOf(entry.tree, node)}`;
            groups.set(key, [...(groups.get(key) ?? []), location]);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(entry.tree);
    }
    const clones = [...groups.values()].filter((locations) => locations.length > 1);
    expect(clones).toEqual([]);
  });
});
