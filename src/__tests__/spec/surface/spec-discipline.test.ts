import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const specRoot = path.resolve(__dirname, '..');
const publicBarrel = path.resolve(specRoot, '../../index.ts');

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
        return staysInSpec || target === publicBarrel ? [] : [`${path.relative(specRoot, file)} -> ${specifier}`];
      })
    );

    expect(violations).toEqual([]);
  });
});
