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
  it('preserves exact stored types across lazy cyclic association targets', () => {
    const diagnostics = compileFixture(`
      import { belongsTo, defineModel, defineShape, f, hasMany, modelRef, references } from '${entry}';
      type Chat = { id: string; title: string };
      type Message = { id: string; chatId: string; replyToId: string | null; body: string };
      const ChatSchema = defineShape<Chat>()({ title: f.str() });
      const MessageSchema = defineShape<Message>()({
        chatId: f.id(),
        replyToId: f.id().nullable(),
        body: f.str()
      });
      const chats = defineModel('lazy-chats', {
        schema: ChatSchema,
        associations: () => ({
          messages: hasMany<Chat, Message>(modelRef<Message>('lazy-messages'), { foreignKey: 'chatId' })
        })
      });
      const messages = defineModel('lazy-messages', {
        schema: MessageSchema,
        associations: () => ({
          chat: belongsTo<Message, Chat>(modelRef<Chat>('lazy-chats'), { foreignKey: 'chatId' }),
          reply: references<Message, Message>(modelRef<Message>('lazy-messages'), { ids: row => row.replyToId })
        })
      });
      const chat: Chat | undefined = messages.chat('message-1').read();
      const thread: Message[] = chats.messages('chat-1').read();
      const replies: Message[] = messages.reply('message-1').read();
      void chat;
      void thread;
      void replies;
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('accepts server-order, field-sort, and comparator model relations', () => {
    const diagnostics = compileFixture(`
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; rank: number };
      const RowSchema = defineShape<Row>()({ rank: f.num() });
      defineModel('scope-types', {
        schema: RowSchema,
        relations: {
          serverOrder: { sort: 'server-order' },
          fieldSort: { sort: { field: 'rank', dir: 'asc' } },
          comparator: { sort: { comparator: (left, right) => left.rank - right.rank } }
        }
      });
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('keeps the full model type when an inferred scope comparator reads a row subset', () => {
    const diagnostics = compileFixture(`
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; userId: string; createdAt: string; rank: number };
      const compareRows = (
        left: Pick<Row, 'createdAt' | 'rank'>,
        right: Pick<Row, 'createdAt' | 'rank'>
      ): number => right.rank - left.rank || right.createdAt.localeCompare(left.createdAt);
      const isUserRow = (row: Pick<Row, 'userId'>): boolean => row.userId.length > 0;
      const RowSchema = defineShape<Row>()({
          userId: f.str(),
          createdAt: f.str(),
          rank: f.num()
      });
      const rows = defineModel('inferred-comparator', {
        schema: RowSchema,
        relations: {
          byUser: { by: { userId: 'userId' }, member: isUserRow, sort: { comparator: compareRows } }
        },
        statics: model => ({ readUser: (id: string) => model.find(id)?.userId })
      });
      rows.byUser({ userId: 'u1' }).read();
      rows.readUser('row-1');
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('rejects non-orderable fields on typed field-sort surfaces', () => {
    const diagnostics = compileFixture(`
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; rank: number; meta: { rank: number }; tags: string[]; when: Date; count: bigint };
      const RowSchema = defineShape<Row>()({
          rank: f.num(),
          meta: f.raw<{ rank: number }>(),
          tags: f.raw<string[]>()
      });
      const rows = defineModel('orderable-fields', { schema: RowSchema });
      // @ts-expect-error array fields require a comparator
      rows.where({}, { orderBy: { field: 'tags', direction: 'asc' } });
      defineModel('invalid-default-order', {
        schema: RowSchema,
        // @ts-expect-error object fields require a comparator
        defaultOrder: { field: 'meta', direction: 'asc' }
      });
      defineModel('invalid-relation-order', {
        schema: RowSchema,
        relations: {
          invalid: {
            // @ts-expect-error array fields require a comparator
            sort: { field: 'tags', dir: 'asc' }
          }
        }
      });
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('accepts concrete codegen variables across typed document entry surfaces', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineDbSubscriptionEntry, defineFetch, defineModel, defineShape, f, gql } from '${entry}';
      type CounterData = { userCounters: { unread: number } };
      type ExactVariables = { __brand?: 'Exact<{}>' };
      declare const counterDocument: TypedDocumentNode<CounterData, ExactVariables>;
      defineDbSubscriptionEntry({ key: 'userCounters', query: counterDocument, onData: payload => payload.unread });
      const CounterSchema = defineShape<{ id: string; unread: number }>()({ unread: f.num() });
      const counters = defineModel('counter-types', {
        schema: CounterSchema,
        events: {
          userCounters: gql.live(counterDocument, {
            handler: payload => ({ upsert: { id: 'current', unread: payload.unread } })
          })
        }
      });
      counters.events.apply('userCounters', { unread: 1 });
      defineFetch<CounterData, void, number>({ key: 'counter-fetch', document: counterDocument, select: data => data.userCounters.unread });
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('accepts codegen-shaped nullable relay arrays on the connection shorthand', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f, gql } from '${entry}';
      type Node = { id: string; label: string };
      type CodegenConnection = {
        nodes: (Node | null)[] | null;
        pageInfo: { hasNextPage: boolean; endCursor: string | null } | null;
      };
      type CodegenEdges = {
        edges: ({ node: Node | null } | null)[] | null;
        pageInfo: { hasNextPage: boolean; endCursor: string | null } | null;
      };
      type Data = { list: CodegenConnection; alt: CodegenEdges };
      type Variables = { group: string };
      declare const document: TypedDocumentNode<Data, Variables>;
      const NodeSchema = defineShape<Node>()({ label: f.str() });
      const rows = defineModel('nullable-connection', {
        schema: NodeSchema,
        relations: {
          list: {
            sort: 'server-order',
            remote: gql.connection(document, {
              variables: (params: Variables) => params,
              connection: data => data.list
            })
          },
          alt: {
            sort: 'server-order',
            remote: gql.connection(document, {
              variables: (params: Variables) => params,
              connection: data => data.alt
            })
          }
        }
      });
      rows.list({ group: 'one' }).read();
      rows.alt({ group: 'one' }).read();
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('accepts null as a disabled query scope for reactive and imperative reads', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f, gql } from '${entry}';
      type Row = { id: string; accountId: string };
      type Data = { rows: Row[] };
      type Variables = { accountId: string };
      declare const document: TypedDocumentNode<Data, Variables>;
      const RowSchema = defineShape<Row>()({ accountId: f.str() });
      const rows = defineModel('null-query-scope', {
        schema: RowSchema,
        relations: {
          byAccount: {
            by: { accountId: 'accountId' },
            remote: gql.connection(document, {
              variables: (params: { accountId: string | null | undefined }) => ({ accountId: params.accountId ?? '' }),
              connection: data => ({ nodes: data.rows }),
              required: ['accountId']
            })
          }
        }
      });
      rows.byAccount({ accountId: null }).use();
      void rows.byAccount({ accountId: undefined }).use().refresh();
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('types query data by destination: scope reads land as arrays, point model reads as one row', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f, gql } from '${entry}';
      type Row = { id: string; groupId: string; title: string };
      type Data = { items: Row[]; row: Row };
      type Variables = { groupId: string };
      declare const document: TypedDocumentNode<Data, Variables>;
      const RowSchema = defineShape<Row>()({ groupId: f.str(), title: f.str() });
      const rows = defineModel('query-data-typing', {
        schema: RowSchema,
        relations: {
          list: {
            by: { groupId: 'groupId' },
            remote: gql.connection(document, {
              variables: (params: Variables) => params,
              connection: data => ({ nodes: data.items })
            })
          },
          detail: {
            remote: gql.single(document, {
              variables: (params: Variables) => params,
              select: data => data.row
            })
          }
        }
      });
      const listData: Row[] = rows.list({ groupId: 'group-1' }).use().data;
      void listData;
      const pointData: Row | undefined = rows.detail({ groupId: 'group-1' }).use().data;
      void pointData;
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('infers model action input separately from generated transport variables', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f, gql } from '${entry}';
      type Row = { id: string; title: string };
      type Data = { updateRow: { row: Row } };
      type Variables = { input: { rowId: number; title: string } };
      type Input = { rowId: string; title: string; source: 'screen' | 'sync' };
      declare const document: TypedDocumentNode<Data, Variables>;
      const RowSchema = defineShape<Row>()({ title: f.str() });
      const rows = defineModel('action-input-mapping', {
        schema: RowSchema,
        actions: {
          update: gql.action(document, {
            result: 'updateRow',
            variables: (input: Input) => ({
              input: { rowId: Number(input.rowId), title: input.title }
            }),
            kind: 'update',
            id: input => input.rowId,
            select: data => data.updateRow.row,
            before: input => {
              const source: Input['source'] = input.source;
              void source;
            }
          })
        }
      });
      void rows.actions.update.run({ rowId: '1', title: 'typed', source: 'screen' });
      // @ts-expect-error source is part of the model action input
      void rows.actions.update.run({ rowId: '1', title: 'typed' });
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('types model reads and named relations inside the action factory', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f, gql } from '${entry}';
      type Row = { id: string; groupId: string; title: string };
      type Data = { updateRow: { row: Row } };
      type Variables = { input: { rowId: string; title: string } };
      declare const document: TypedDocumentNode<Data, Variables>;
      const RowSchema = defineShape<Row>()({ groupId: f.str(), title: f.str() });
      const rows = defineModel('action-owner-factory', {
        schema: RowSchema,
        relations: {
          byGroup: { by: { groupId: 'groupId' } }
        },
        actions: model => ({
          update: gql.action(document, {
            result: 'updateRow',
            variables: (input: Variables['input']) => ({ input }),
            kind: 'update',
            id: input => input.rowId,
            select: data => data.updateRow.row,
            optimistic: {
              patch: input => ({
                title: model.find(input.rowId)?.title ?? input.title,
                groupId: model.byGroup({ groupId: 'one' }).read()[0]?.groupId
              })
            }
          })
        })
      });
      void rows.actions.update.run({ rowId: '1', title: 'typed' });
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
