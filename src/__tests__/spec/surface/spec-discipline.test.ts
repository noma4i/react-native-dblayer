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
    const compilerTestBarrel = path.resolve(specRoot, '../testApi.ts');
    const violations = sourceFiles(specRoot).flatMap(file =>
      relativeImports(file).flatMap(specifier => {
        const target = resolvedImport(file, specifier);
        const staysInSpec = !path.relative(specRoot, target).startsWith('..');
        return staysInSpec || target === publicBarrel || target === compilerTestBarrel ? [] : [`${path.relative(specRoot, file)} -> ${specifier}`];
      })
    );

    expect(violations).toEqual([]);
  });

  it('keeps perf and appshape gates free of wall-clock measurements', () => {
    const gateFiles = ['perf', 'appshape'].flatMap(directory => sourceFiles(path.join(specRoot, directory)));

    for (const file of gateFiles) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/performance\.now/);
      expect(source).not.toMatch(/\bmedian\b/);
    }
  });

  it('keeps nullable scalar conversion inside the shared field codec', () => {
    const sourceRoot = path.resolve(specRoot, '../..');
    const violations = sourceFiles(sourceRoot)
      .filter(file => !file.includes(`${path.sep}__tests__${path.sep}`))
      .flatMap(file => (/\breadNullable[A-Z]/.test(fs.readFileSync(file, 'utf8')) ? [path.relative(sourceRoot, file)] : []));

    expect(violations).toEqual([]);
  });
});
