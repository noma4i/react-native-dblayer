import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const specRoot = path.resolve(__dirname, '..');
const publicBarrel = path.resolve(specRoot, '../../index.ts');
const incrementalEngineSpec = path.resolve(specRoot, 'rerender/r04-incremental-read-engine.test.ts');
const incrementalEngineSource = path.resolve(specRoot, '../../read/incrementalReadEngine.ts');

/**
 * `bootDb`/`collectGarbage`/`flushPersistence` are internal to `DbProvider` and not on the public
 * barrel (see index.ts); these specs exercise boot/GC/persistence behavior directly and must reach
 * past the barrel for it, the same way `incrementalEngineSpec` reaches `incrementalReadEngine.ts`.
 */
const internalAccessExceptions: ReadonlyArray<{ spec: string; source: string }> = [
  { spec: path.resolve(specRoot, 'consumer/c-failure-contract.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'consumer/c-failure-contract.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'consumer/c-gc-reset-and-subscription-utils.test.ts'), source: path.resolve(specRoot, '../../core/gc.ts') },
  { spec: path.resolve(specRoot, 'consumer/c07-maintenance-trim.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'integrity/i03-dedupe.test.ts'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'integrity/i03-dedupe.test.ts'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'sufficiency/s07-pending-flag.test.tsx'), source: path.resolve(specRoot, '../../dsl/lifecycle.ts') },
  { spec: path.resolve(specRoot, 'perf/p05-pending-index-scale.test.tsx'), source: path.resolve(specRoot, '../../dsl/configure.ts') },
  { spec: path.resolve(specRoot, 'perf/p05-pending-index-scale.test.tsx'), source: path.resolve(specRoot, '../../core/planes/operationState.ts') }
];

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const resolvedImport = (file: string, specifier: string): string => {
  const base = path.resolve(path.dirname(file), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find(candidate => fs.existsSync(candidate)) ?? base;
};

const relativeImports = (file: string): string[] => {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports.filter(specifier => specifier.startsWith('.'));
};

describe('spec import discipline', () => {
  it('allows source imports only through the public barrel', () => {
    const violations = sourceFiles(specRoot).flatMap(file =>
      relativeImports(file).flatMap(specifier => {
        const target = resolvedImport(file, specifier);
        const staysInSpec = !path.relative(specRoot, target).startsWith('..');
        const isIncrementalEngineContract = file === incrementalEngineSpec && target === incrementalEngineSource;
        const isInternalAccessException = internalAccessExceptions.some(exception => file === exception.spec && target === exception.source);
        return staysInSpec || target === publicBarrel || isIncrementalEngineContract || isInternalAccessException ? [] : [`${path.relative(specRoot, file)} -> ${specifier}`];
      })
    );

    expect(violations).toEqual([]);
  });
});
