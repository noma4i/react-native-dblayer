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

  it('rejects non-orderable fields on typed field-sort surfaces', () => {
    const diagnostics = compileFixture(`
      import { defineModel, f, scope } from '${entry}';
      type Row = { id: string; rank: number; meta: { rank: number }; tags: string[]; when: Date; count: bigint };
      const rows = defineModel({
        id: 'orderable-fields',
        name: 'OrderableFields',
        fields: {
          id: f.id(),
          rank: f.num(),
          meta: f.raw<{ rank: number }>(),
          tags: f.raw<string[]>()
        }
      });
      // @ts-expect-error object fields require a comparator
      rows.use.where({}).orderBy('meta');
      // @ts-expect-error array fields require a comparator
      rows.where({}, { orderBy: { field: 'tags', direction: 'asc' } });
      // @ts-expect-error object fields require a comparator
      scope<Row>({ sort: { field: 'meta', dir: 'asc' } });
      // @ts-expect-error Date fields are not stable across JSON persistence
      scope<Row>({ sort: { field: 'when', dir: 'asc' } });
      // @ts-expect-error bigint fields are not JSON serializable
      scope<Row>({ sort: { field: 'count', dir: 'asc' } });
      defineModel({
        id: 'invalid-default-order',
        name: 'InvalidDefaultOrder',
        fields: { id: f.id(), meta: f.raw<{ rank: number }>() },
        // @ts-expect-error object fields require a comparator
        defaultOrder: { field: 'meta', direction: 'asc' }
      });
      defineModel({
        id: 'invalid-query-scope-order',
        name: 'InvalidQueryScopeOrder',
        fields: { id: f.id(), tags: f.raw<string[]>() },
        queryScopes: {
          invalid: {
            where: {},
            // @ts-expect-error array fields require a comparator
            orderBy: { field: 'tags', direction: 'asc' }
          }
        }
      });
      defineModel({
        id: 'invalid-inline-scope-order',
        name: 'InvalidInlineScopeOrder',
        fields: { id: f.id(), meta: f.raw<{ rank: number }>() },
        scopes: {
          invalid: {
            // @ts-expect-error object fields require a comparator
            sort: { field: 'meta', dir: 'asc' }
          }
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
