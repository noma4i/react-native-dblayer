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

  it('accepts concrete codegen variables across typed document entry surfaces', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineDbSubscriptionEntry, defineFetch, defineModel, f } from '${entry}';
      type CounterData = { userCounters: { unread: number } };
      type ExactVariables = { __brand?: 'Exact<{}>' };
      declare const counterDocument: TypedDocumentNode<CounterData, ExactVariables>;
      defineDbSubscriptionEntry({ key: 'userCounters', query: counterDocument, onData: payload => payload.unread });
      const counters = defineModel({ id: 'counter-types', name: 'CounterTypes', fields: { id: f.id(), unread: f.num() } });
      counters.ingest({ userCounters: { document: counterDocument, apply: 'upsert' } });
      defineFetch<CounterData, void, number>({ key: 'counter-fetch', document: counterDocument, select: data => data.userCounters.unread });
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('accepts null as a disabled query scope for reactive and imperative reads', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, f, scope } from '${entry}';
      type Row = { id: string; accountId: string };
      type Data = { rows: Row[] };
      type Variables = { accountId: string };
      declare const document: TypedDocumentNode<Data, Variables>;
      const rows = defineModel({
        id: 'null-query-scope',
        name: 'NullQueryScope',
        fields: { id: f.id(), accountId: f.str() },
        scopes: { byAccount: scope<Row>({ by: { accountId: 'accountId' } }) }
      });
      const query = rows.query<Data, Variables, { accountId: string }, Row>('byAccount', {
        document,
        vars: scopeValue => ({ accountId: scopeValue.accountId }),
        select: data => data.rows,
        into: rows.scopes.byAccount
      });
      query.use(null);
      void query.fetch(null);
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('rejects the historical invalidate: true boolean on an ingest declaration', () => {
    const diagnostics = compileFixture(`
      import type { IngestDecl } from '${entry}';
      const decl: IngestDecl = { invalidate: true };
    `);
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
