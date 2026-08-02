import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../../../..');
const fixtureName = path.join(root, 'scope-inference.fixture.ts');
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

/**
 * Every fixture type-checks against the whole package, and the package does not change between
 * fixtures: its parsed files are read once and handed to each program, and each program reuses the
 * previous one. Without that sharing the gate re-parses the package per fixture and outgrows the
 * shard budget, which would push the suite toward dropping cases rather than keeping them cheap.
 */
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

const compileFixture = (source: string): readonly ts.Diagnostic[] => {
  fixtureSource = source;
  const program = ts.createProgram([fixtureName], options, host, previousProgram);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  previousProgram = program;
  return diagnostics;
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
        }),
        sideloads: () => ({
          chat: {
            model: modelRef<Chat>('lazy-chats'),
            select: message => ({ id: message.chatId, title: 'chat' })
          }
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

  it('requires every by key even when remote params declare it optional', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f, gql } from '${entry}';
      type Row = { id: string; status: string };
      type Data = { rows: { nodes: Row[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      type Variables = { status?: string };
      const document = {} as TypedDocumentNode<Data, Variables>;
      const RowSchema = defineShape<Row>()({ status: f.str() });
      const rows = defineModel('required-by-params', {
        schema: RowSchema,
        relations: {
          byStatus: {
            by: { statusFilter: 'status' },
            remote: gql.connection(document, {
              variables: (params: { statusFilter?: string }) => ({ status: params.statusFilter }),
              connection: data => data.rows
            })
          }
        }
      });
      rows.byStatus({ statusFilter: 'open' });
      // @ts-expect-error mapped relation keys are required even when remote params make them optional
      rows.byStatus({});
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('rejects nullish mapped by values even when the stored field is nullable', () => {
    const diagnostics = compileFixture(`
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; bucket: string | null };
      const RowSchema = defineShape<Row>()({ bucket: f.str().nullable() });
      const rows = defineModel('required-by-values', {
        schema: RowSchema,
        relations: {
          byBucket: { by: { bucket: 'bucket' } }
        }
      });
      rows.byBucket({ bucket: 'visual' });
      rows.byBucket(null);
      // @ts-expect-error mapped relation values are non-nullish
      rows.byBucket({ bucket: null });
      // @ts-expect-error mapped relation values are non-nullish
      rows.byBucket({ bucket: undefined });
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

  it('accepts null as the disabled relation identity and rejects nullish required by fields', () => {
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
              variables: (params: { accountId: string }) => ({ accountId: params.accountId }),
              connection: data => ({ nodes: data.rows }),
              required: ['accountId']
            })
          }
        }
      });
      rows.byAccount(null).use();
      void rows.byAccount(null).use().refresh();
      // @ts-expect-error use null as the whole inactive relation identity
      rows.byAccount({ accountId: null }).use();
      // @ts-expect-error use null as the whole inactive relation identity
      rows.byAccount({ accountId: undefined }).use();
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

  it('types complete lists, node mapping, custom cursors, and imperative relation methods', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f, gql } from '${entry}';
      type TransportRow = { id: number; groupId: number; title: string };
      type RowInput = { id: string | number; groupId: string | number; title: string; flagged?: boolean };
      type Data = {
        catalog: TransportRow[];
        page: {
          nodes: TransportRow[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nextSequence: number | null;
        };
      };
      type Variables = { groupId: number; afterSequence?: number };
      declare const document: TypedDocumentNode<Data, Variables>;
      const RowSchema = defineShape<RowInput>()({ groupId: f.id(), title: f.str(), flagged: f.bool().optional() });
      const rows = defineModel('relation-complete-list', {
        schema: RowSchema,
        relations: {
          catalog: {
            sort: 'server-order',
            remote: gql.list(document, {
              variables: () => ({ groupId: 1 }),
              select: data => data.catalog,
              map: node => ({ ...node, flagged: true })
            })
          },
          page: {
            by: { groupId: 'groupId' },
            sort: 'server-order',
            remote: gql.connection(document, {
              variables: (params: { groupId: string }) => ({ groupId: Number(params.groupId) }),
              connection: data => data.page,
              map: node => ({ ...node, flagged: true }),
              cursor: data => data.page.nextSequence == null ? null : String(data.page.nextSequence),
              mapCursor: cursor => Number(cursor),
              coverage: 'page'
            })
          }
        }
      });
      const catalog = rows.catalog({});
      catalog.seed([{ id: 'seed', groupId: '1', title: 'seed' }]);
      void catalog.fetch();
      const pageResult = rows.page({ groupId: '1' }).use();
      const inactiveData: RowInput[] = rows.page(null).use().data;
      const fetching: boolean = pageResult.isFetchingMore;
      const previous: boolean = pageResult.isPreviousData;
      void inactiveData;
      void fetching;
      void previous;
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
            variables: (input: Input) => {
              return { input: { rowId: Number(input.rowId), title: input.title } };
            },
            kind: 'update',
            id: input => input.rowId,
            select: data => data.updateRow.row,
            before: (input, context) => {
              const source: Input['source'] = input.source;
              void context.operationId;
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

  it('accepts an inferred optimistic insert action', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f, gql } from '${entry}';
      type Row = { id: string; title: string };
      type Data = { insertRow: { row: Row } };
      type Variables = { input: { title: string } };
      type Input = { title: string; source: 'screen' | 'sync' };
      declare const document: TypedDocumentNode<Data, Variables>;
      const RowSchema = defineShape<Row>()({ title: f.str() });
      const rows = defineModel('action-insert-optimistic', {
        schema: RowSchema,
        actions: {
          insert: gql.action(document, {
            result: 'insertRow',
            variables: (input: Input) => {
              return { input: { title: input.title } };
            },
            kind: 'insert',
            optimistic: {
              build: (input, context) => {
                const source: Input['source'] = input.source;
                void source;
                return { id: context.tempId, title: input.title };
              }
            },
            select: data => data.insertRow.row
          })
        }
      });
      void rows.actions.insert.run({ title: 'typed', source: 'screen' });
      // @ts-expect-error source is part of the model action input
      void rows.actions.insert.run({ title: 'typed' });
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
            variables: (input: Variables['input']) => {
              return { input };
            },
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

  it('types the exact write plan surface and action write context', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f, gql, type WritePlan } from '${entry}';

      type User = { id: string; teamId: string; label: string };
      type Team = { id: string; name: string };
      type ActionInput = { id: string; teamId: string; label: string };
      type ActionData = { updateUser: { row: User } };
      type ActionVariables = { input: { id: string; label: string } };
      type ExpectedWritePlanKeys = 'upsert' | 'update' | 'destroy' | 'invalidate';
      type ExactWritePlanKeys = [keyof WritePlan] extends [ExpectedWritePlanKeys]
        ? [ExpectedWritePlanKeys] extends [keyof WritePlan] ? true : false
        : false;
      const exactWritePlanKeys: ExactWritePlanKeys = true;
      void exactWritePlanKeys;

      const UserSchema = defineShape<User>()({ teamId: f.str(), label: f.str() });
      const TeamSchema = defineShape<Team>()({ name: f.str() });
      const result: 'updateUser' = 'updateUser';
      const kind: 'update' = 'update';
      const Teams = defineModel('write-plan-teams', { schema: TeamSchema });
      const Users = defineModel('write-plan-users', {
        schema: UserSchema,
        relations: { byTeam: { by: { teamId: 'teamId' } } }
      });
      declare const plan: WritePlan;
      const teamRows: readonly Team[] = [{ id: 'team-1', name: 'one' }];
      const userRelation = Users.byTeam({ teamId: 'team-1' });

      plan.upsert(Users, { id: 'user-1', teamId: 'team-1', label: 'one' });
      plan.upsert(Teams, teamRows);
      plan.update(Users, 'user-1', { label: 'updated' });
      plan.update(Teams, 'team-1', { name: 'updated' });
      plan.destroy(Users, 'user-1');
      plan.destroy(Teams, ['team-1', 'team-2']);
      plan.invalidate(userRelation);
      // @ts-expect-error upsert input follows the selected model build input
      plan.upsert(Users, { id: 'user-1', teamId: 'team-1', label: 1 });
      // @ts-expect-error update patch follows the selected stored model
      plan.update(Teams, 'team-1', { label: 'wrong' });
      // @ts-expect-error destroy accepts string ids only
      plan.destroy(Users, 1);

      declare const document: TypedDocumentNode<ActionData, ActionVariables>;
      defineModel('write-plan-action-users', {
        schema: UserSchema,
        actions: {
          update: gql.action(document, {
            result,
            variables: (input: ActionInput) => {
              return { input: { id: input.id, label: input.label } };
            },
            kind,
            id: input => input.id,
            select: data => data.updateUser.row,
            write: (context, actionPlan) => {
              const input: ActionInput = context.input;
              const data: ActionData = context.data;
              actionPlan.update(Teams, input.teamId, { name: data.updateUser.row.label });
            },
            before: (_input, context) => {
              void context.operationId;
              // @ts-expect-error before does not receive a write plan
              context.plan;
            },
            error: (_error, context) => {
              void context.input;
              // @ts-expect-error error does not receive a write plan
              context.plan;
            },
            track: context => {
              void context.data;
              // @ts-expect-error track does not receive a write plan
              context.plan;
            }
          })
        }
      });
    `);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('rejects removed public action callbacks', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f, gql } from '${entry}';

      type Row = { id: string; label: string };
      type Input = { id: string; label: string };
      type Data = { updateRow: { row: Row } };
      type Variables = { input: Input };
      declare const document: TypedDocumentNode<Data, Variables>;
      const result: 'updateRow' = 'updateRow';
      const kind: 'update' = 'update';
      const RowSchema = defineShape<Row>()({ label: f.str() });
      defineModel('removed-public-action-callbacks', {
        schema: RowSchema,
        actions: {
          withAfter: gql.action(document, {
            result,
            variables: (input: Input) => ({ input }),
            kind,
            id: input => input.id,
            select: data => data.updateRow.row,
            // @ts-expect-error public gql.action no longer accepts after
            after: (_context: { input: Input; data: Data }) => undefined
          }),
          withInvalidate: gql.action(document, {
            result,
            variables: (input: Input) => ({ input }),
            kind,
            id: input => input.id,
            select: data => data.updateRow.row,
            // @ts-expect-error public gql.action no longer accepts invalidate
            invalidate: (_context: { input: Input; data: Data }) => undefined
          }),
          withResume: gql.action(document, {
            result,
            variables: (input: Input) => ({ input }),
            kind,
            id: input => input.id,
            select: data => data.updateRow.row,
            // @ts-expect-error update actions do not accept the durable-only resume key
            resume: async () => 'orphaned'
          })
        }
      });
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
