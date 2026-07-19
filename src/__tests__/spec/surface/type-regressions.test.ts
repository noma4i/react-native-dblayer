import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../../../..');
const fixtureName = path.join(root, 'scope-inference.fixture.ts');
const entry = path.join(root, 'src/index.ts').split(path.sep).join('/');

const compileFixture = (source: string): readonly ts.Diagnostic[] => {
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    noEmit: true
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = fileName => fileName === fixtureName || ts.sys.fileExists(fileName);
  host.readFile = fileName => (fileName === fixtureName ? source : ts.sys.readFile(fileName));
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === fixtureName ? ts.createSourceFile(fileName, source, languageVersion, true) : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);

  return ts.getPreEmitDiagnostics(ts.createProgram([fixtureName], options, host));
};

describe('public type regressions', () => {
  it('accepts server-order, field-sort, and comparator model scopes', () => {
    const diagnostics = compileFixture(`
      import { defineModel, f, scope } from '${entry}';

      type Row = { id: string; rank: number };

      defineModel({
        id: 'scope-types',
        name: 'ScopeTypes',
        fields: { id: f.id(), rank: f.num() },
        scopes: {
          serverOrder: scope({ sort: 'server-order' }),
          fieldSort: scope<Row>({ sort: { field: 'rank', dir: 'asc' } }),
          comparator: scope<Row>({ sort: { comparator: (left, right) => left.rank - right.rank } })
        }
      });
    `);

    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });
});
