import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../../../..');
const fixtureName = path.join(root, 'model-facade.fixture.ts');
const entry = path.join(root, 'src/index.ts').split(path.sep).join('/');
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
const packageFiles = new Map<string, ts.SourceFile | undefined>();
let fixtureSource = '';
let previousProgram: ts.Program | undefined;
const host = ts.createCompilerHost(options);
const readPackageFile = host.getSourceFile.bind(host);
host.fileExists = fileName => fileName === fixtureName || ts.sys.fileExists(fileName);
host.readFile = fileName => (fileName === fixtureName ? fixtureSource : ts.sys.readFile(fileName));
host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
  if (fileName === fixtureName) return ts.createSourceFile(fileName, fixtureSource, languageVersion, true);
  if (!packageFiles.has(fileName)) packageFiles.set(fileName, readPackageFile(fileName, languageVersion, onError, shouldCreateNewSourceFile));
  return packageFiles.get(fileName);
};
const compileFixture = (source: string): string[] => {
  fixtureSource = source;
  const program = ts.createProgram([fixtureName], options, host, previousProgram);
  previousProgram = program;
  return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
};

describe('public type regressions', () => {
  it('preserves stored types across lazy cyclic associations', () => {
    expect(
      compileFixture(`
        import { belongsTo, defineModel, defineShape, f, hasMany, modelRef, references } from '${entry}';
        type Chat = { id: string; title: string };
        type Message = { id: string; chatId: string; replyToId: string | null; body: string };
        const chats = defineModel('typed-chats', {
          schema: defineShape<Chat>()({ title: f.str() }),
          associations: () => ({ messages: hasMany<Chat, Message>(modelRef<Message>('typed-messages'), { foreignKey: 'chatId' }) })
        });
        const messages = defineModel('typed-messages', {
          schema: defineShape<Message>()({ chatId: f.id(), replyToId: f.id().nullable(), body: f.str() }),
          associations: () => ({
            chat: belongsTo<Message, Chat>(modelRef<Chat>('typed-chats'), { foreignKey: 'chatId' }),
            reply: references<Message, Message>(modelRef<Message>('typed-messages'), { ids: row => row.replyToId })
          })
        });
        const chat: Chat | undefined = messages.chat('message-1').read();
        const thread: Message[] = chats.messages('chat-1').read();
        const replies: Message[] = messages.reply('message-1').read();
        void chat; void thread; void replies;
      `)
    ).toEqual([]);
  });

  it('types owner-bound relations, actions, events, and exact GraphQL variables', () => {
    expect(
      compileFixture(`
        import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
        import { defineModel, defineShape, f } from '${entry}';
        type Row = { id: string; groupId: string; label: string };
        type Params = { groupId: string };
        type QueryData = { rows: Row[] };
        type ActionData = { save: { row: Row } };
        type EventData = { changed: { row: Row } };
        declare const queryDocument: TypedDocumentNode<QueryData, Params>;
        declare const actionDocument: TypedDocumentNode<ActionData, { input: { groupId: string; label: string } }>;
        declare const eventDocument: TypedDocumentNode<EventData, { groupId: string }>;
        const audit = defineModel('typed-audit', { schema: defineShape<{ id: string; label: string }>()({ label: f.str() }) });
        const rows = defineModel('typed-owner', {
          schema: defineShape<Row>()({ groupId: f.id(), label: f.str() }),
          relations: owner => ({
            byGroup: {
              by: { groupId: 'groupId' },
              sort: { field: 'label', dir: 'asc' },
              remote: owner.gql.list(queryDocument, {
                variables: (params: Params) => params,
                select: data => data.rows,
                required: ['groupId']
              })
            }
          }),
          actions: owner => ({
            save: owner.gql.action(actionDocument, {
              result: 'save',
              variables: input => ({ input }),
              root: { insert: { select: context => context.data.save.row } },
              write: (context, plan) => plan.upsert(audit, { id: context.data.save.row.id, label: 'saved' })
            })
          }),
          events: owner => ({
            changed: owner.gql.live(eventDocument, {
              variables: { groupId: 'group-1' },
              root: { update: { select: context => ({ id: context.payload.row.id, patch: { label: context.payload.row.label } }) } }
            })
          })
        });
        const relation = rows.byGroup({ groupId: 'group-1' });
        const result: Row[] = relation.read();
        const action: Promise<{ row: Row } | null> = rows.actions.save.run({ groupId: 'group-1', label: 'next' });
        const stop: () => void = rows.events.changed.subscribe(payload => void payload.row.label);
        void result; void action; stop();
      `)
    ).toEqual([]);
  });

  it('types nullable Relay connections and disabled relation identity', () => {
    expect(
      compileFixture(`
        import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
        import { defineModel, defineShape, f } from '${entry}';
        type Row = { id: string; groupId: string; label: string };
        type Data = { rows: { nodes?: ReadonlyArray<Row | null> | null; pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null } | null };
        declare const document: TypedDocumentNode<Data, { groupId: string; after?: string | null }>;
        const rows = defineModel('typed-connection', {
          schema: defineShape<Row>()({ groupId: f.id(), label: f.str() }),
          relations: owner => ({
            page: {
              by: { groupId: 'groupId' },
              remote: owner.gql.connection(document, {
                variables: (params: { groupId: string }) => params,
                connection: data => data.rows,
                required: ['groupId']
              })
            }
          })
        });
        rows.page(null).use();
        rows.page({ groupId: 'group-1' }).use().loadMore();
        // @ts-expect-error required identity fields cannot be undefined
        rows.page({ groupId: undefined }).use();
      `)
    ).toEqual([]);
  });

  it('rejects every removed legacy entry surface', () => {
    expect(
      compileFixture(`
        import { defineModel, defineShape, f } from '${entry}';
        const rows = defineModel('removed-surface', { schema: defineShape<{ id: string; label: string }>()({ label: f.str() }) });
        // @ts-expect-error removed mutation terminal
        rows.mutation('save', {});
        // @ts-expect-error removed ingest terminal
        rows.ingest({});
        // @ts-expect-error removed fetch terminal
        rows.fetch('load', {});
        // @ts-expect-error removed public poller terminal
        rows.poller('status', {});
        // @ts-expect-error removed public query terminal
        rows.query('list', {});
        // @ts-expect-error owner factories are mandatory
        defineModel('object-relations', { schema: defineShape<{ id: string; label: string }>()({ label: f.str() }), relations: {} });
      `)
    ).toEqual([]);
  });
});
