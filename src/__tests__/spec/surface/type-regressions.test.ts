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

      defineDbSubscriptionEntry({
        key: 'userCounters',
        query: counterDocument,
        onData: payload => payload.unread
      });

      const counters = defineModel({
        id: 'counter-types',
        name: 'CounterTypes',
        fields: { id: f.id(), unread: f.num() }
      });
      counters.ingest({ userCounters: { document: counterDocument, apply: 'upsert' } });

      defineFetch<CounterData, void, number>({
        key: 'counter-fetch',
        document: counterDocument,
        select: data => data.userCounters.unread
      });
    `);

    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('types view source rows, declared includes, include models, and render keys', () => {
    const diagnostics = compileFixture(`
      import { defineModel, f, scope } from '${entry}';
      import type { ModelStored } from '${entry}';

      const users = defineModel({
        id: 'view-user-types',
        name: 'ViewUserTypes',
        fields: { id: f.id(), fullName: f.str() }
      });
      const chats = defineModel({
        id: 'view-chat-types',
        name: 'ViewChatTypes',
        fields: { id: f.id(), title: f.str(), userIds: f.raw<string[]>() },
        scopes: { list: scope({ sort: 'server-order' }) }
      });
      type UserRow = ModelStored<typeof users>;
      type ChatItem = { id: string; title: string; userNames: string[] };

      chats.view<ChatItem, { users: UserRow[] }>('typed', {
        source: chats.scopes.list,
        include: { users: { model: users, ids: row => row.userIds, renderKeys: ['id', 'fullName'] } },
        select: (row, included) => ({ id: row.id, title: row.title, userNames: included.users.map(user => user.fullName) }),
        renderKeys: ['title']
      });
    `);

    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('rejects include render keys outside the declared included row type', () => {
    const diagnostics = compileFixture(`
      import { defineModel, f, scope } from '${entry}';
      import type { ModelStored } from '${entry}';

      const users = defineModel({
        id: 'invalid-view-include-user-types',
        name: 'InvalidViewIncludeUserTypes',
        fields: { id: f.id(), fullName: f.str() }
      });
      const chats = defineModel({
        id: 'invalid-view-include-chat-types',
        name: 'InvalidViewIncludeChatTypes',
        fields: { id: f.id(), userIds: f.raw<string[]>() },
        scopes: { list: scope({ sort: 'server-order' }) }
      });
      type UserRow = ModelStored<typeof users>;

      chats.view<{ id: string }, { users: UserRow[] }>('invalid-include-render-key', {
        source: chats.scopes.list,
        include: { users: { model: users, ids: row => row.userIds, renderKeys: ['notAUserKey'] } },
        select: row => ({ id: row.id })
      });
    `);
    const messages = diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));

    expect(messages.some(message => message.includes('notAUserKey'))).toBe(true);
  });

  it('rejects unknown view source fields and projected render keys', () => {
    const diagnostics = compileFixture(`
      import { defineModel, f, scope } from '${entry}';

      const chats = defineModel({
        id: 'invalid-view-types',
        name: 'InvalidViewTypes',
        fields: { id: f.id(), title: f.str() },
        scopes: { list: scope({ sort: 'server-order' }) }
      });
      type ChatItem = { id: string; title: string };

      chats.view<ChatItem, {}>('invalid', {
        source: 'list',
        include: {},
        select: row => ({ id: row.id, title: row.notAField }),
        renderKeys: ['notAKey']
      });
    `);
    const messages = diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));

    expect(messages.some(message => message.includes("Property 'notAField' does not exist"))).toBe(true);
    expect(messages.some(message => message.includes('Type \'"notAKey"\' is not assignable'))).toBe(true);
  });
});
