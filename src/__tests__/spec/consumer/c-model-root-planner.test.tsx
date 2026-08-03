import path from 'node:path';
import ts from 'typescript';
import { act } from 'react';
import { compileModelRootPlan, configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted } from '../helpers/harness';

type Row = { id: string; label: string; count: number };
type InsertInput = { label: string; count: number };
type UpdateInput = { id: string; patch: Partial<Omit<Row, 'id'>> };
type BatchUpdateInput = { updates: UpdateInput[] };
type DestroyInput = { id: string };
type BatchDestroyInput = { ids: string[] };
type NoOpInput = { mode: 'null' | 'empty' };
type SaveData = { save: { row: Row } };
type SaveBatchData = { save: { rows: Row[] } };

type RootContext<TInput, TData> = { input: TInput; data: TData };

type OwnerGql = {
  single(document: unknown, options: Record<string, unknown>): unknown;
  list(document: unknown, options: Record<string, unknown>): unknown;
  connection(document: unknown, options: Record<string, unknown>): unknown;
  action(document: unknown, options: Record<string, unknown>): unknown;
  live(document: unknown, options: Record<string, unknown>): unknown;
};

type OwnerDeclaration = {
  key: string;
  build(input: unknown): Row;
  gql: OwnerGql;
};

type RuntimeAction = { run(input: unknown): Promise<unknown> };

type RuntimeModel = {
  find(id: string): Row | undefined;
  insert(row: Row): void;
  useFind(id: string): Row | undefined;
  actions: Record<string, RuntimeAction>;
};

type MemoryPlane = ReturnType<typeof createMemoryPlane>;

type WorkProbe = {
  assert(expected: { wal: number; commits: number; affectedTicks: readonly number[] }): void;
  unmount(): void;
};

type OwnerModelConfig = {
  schema: typeof RowSchema;
  relations?: (owner: OwnerDeclaration) => Record<string, unknown>;
  actions?: (owner: OwnerDeclaration) => Record<string, unknown>;
  events?: (owner: OwnerDeclaration) => Record<string, unknown>;
  maintenance?: { dropTempRowsAfterMs?: number };
};

const defineOwnerModel = defineModel as unknown as (key: string, config: OwnerModelConfig) => RuntimeModel;
const actionDocument = { kind: 'Document', definitions: [] };
const RowSchema = defineShape<Row>()({ label: f.str(), count: f.num() });

const insertRoot = <TInput,>(select: (context: RootContext<TInput, SaveData>) => Row | readonly Row[] | null) => ({
  insert: { select }
});

const unrelatedRow = { id: 'unrelated', label: 'unchanged', count: 0 };

const createWorkProbe = (
  model: RuntimeModel,
  unrelated: RuntimeModel,
  storage: MemoryPlane,
  affectedIds: readonly string[]
): WorkProbe => {
  const affectedReaders = affectedIds.map(id => renderCounted(() => model.useFind(id)));
  const unrelatedReader = renderCounted(() => unrelated.useFind(unrelatedRow.id));
  const baseline = {
    wal: storage.keys('dbl:journal:').length,
    commits: diagnostics().snapshot().commits,
    affectedTicks: affectedReaders.map(reader => reader.renders()),
    unrelatedTicks: unrelatedReader.renders()
  };

  return {
    assert(expected) {
      expect(storage.keys('dbl:journal:').length - baseline.wal).toBe(expected.wal);
      expect(diagnostics().snapshot().commits - baseline.commits).toBe(expected.commits);
      expect(affectedReaders.map((reader, index) => reader.renders() - baseline.affectedTicks[index]!)).toEqual(expected.affectedTicks);
      expect(unrelatedReader.renders() - baseline.unrelatedTicks).toBe(0);
      expect(unrelated.find(unrelatedRow.id)).toEqual(unrelatedRow);
    },
    unmount() {
      for (const reader of affectedReaders) reader.unmount();
      unrelatedReader.unmount();
    }
  };
};

const defineActionModel = (key: string, response: unknown, root: unknown, extra: Record<string, unknown> = {}) => {
  const storage = createMemoryPlane();
  const transport = createMockTransport({
    mutation: async <TData,>() => ({ data: response as TData })
  });
  configureDb({ storage, transport });
  const unrelated = defineOwnerModel(`${key}Unrelated`, { schema: RowSchema });
  unrelated.insert(unrelatedRow);
  const model = defineOwnerModel(key, {
    schema: RowSchema,
    actions: owner => ({
      run: owner.gql.action(actionDocument, {
        result: 'save',
        variables: (input: unknown) => ({ input }),
        root,
        ...extra
      })
    })
  });
  return { model, transport, storage, unrelated };
};

const expectNoResponseWrite = async (
  model: RuntimeModel,
  unrelated: RuntimeModel,
  storage: MemoryPlane,
  input: unknown,
  expected: Row,
  error: string,
  absentIds: readonly string[]
): Promise<void> => {
  const work = createWorkProbe(model, unrelated, storage, [expected.id, ...absentIds]);

  await act(async () => {
    await expect(model.actions.run.run(input)).rejects.toThrow(error);
  });

  expect(model.find(expected.id)).toEqual(expected);
  for (const id of absentIds) expect(model.find(id)).toBeUndefined();
  work.assert({ wal: 0, commits: 0, affectedTicks: Array.from({ length: absentIds.length + 1 }, () => 0) });
  work.unmount();
};

describe('model root planner', () => {
  it('rejects every malformed runtime root and normalizes numeric destroy ids', () => {
    const owner = {
      modelId: 'SpecModelRootPlannerRuntimeEdges',
      planRows: () => []
    };

    expect(() => compileModelRootPlan(owner, null as never, undefined)).toThrow('must contain exactly one root form');
    expect(() => compileModelRootPlan(owner, { insert: undefined } as never, undefined)).toThrow('must contain exactly one root form');
    expect(() => compileModelRootPlan(owner, { update: undefined } as never, undefined)).toThrow('must contain exactly one root form');
    expect(() => compileModelRootPlan(owner, { destroy: undefined } as never, undefined)).toThrow('must contain exactly one root form');
    expect(() =>
      compileModelRootPlan(owner, { update: { select: () => ({ id: false, patch: {} }) } } as never, undefined)
    ).toThrow('update requires a non-empty id');
    expect(compileModelRootPlan(owner, { update: { select: () => null } } as never, undefined)).toEqual([]);
    expect(compileModelRootPlan(owner, { update: { select: () => [] } } as never, undefined)).toEqual([]);
    expect(compileModelRootPlan(owner, { destroy: { select: () => null } } as never, undefined)).toEqual([]);
    expect(compileModelRootPlan(owner, { destroy: { select: () => [] } } as never, undefined)).toEqual([]);
    expect(compileModelRootPlan(owner, { destroy: { select: () => 7 } } as never, undefined)).toEqual([
      { kind: 'destroy', model: owner.modelId, ids: ['7'] }
    ]);

    const disappearingDestroy = new Proxy(
      { destroy: { select: () => 'row-1' } },
      {
        ownKeys: () => ['destroy'],
        has: () => false
      }
    );
    expect(() => compileModelRootPlan(owner, disappearingDestroy as never, undefined)).toThrow('must contain exactly one root form');
  });

  it('routes empty insert through the optional owner empty planner', () => {
    const calls: string[] = [];
    const emptyOwner = {
      modelId: 'SpecModelRootPlannerEmptyOwner',
      planRows: () => {
        calls.push('rows');
        return [];
      },
      planEmpty: () => {
        calls.push('empty');
        return [];
      }
    };

    expect(
      compileModelRootPlan(
        emptyOwner,
        { insert: { select: () => [] as readonly Row[] } },
        undefined
      )
    ).toEqual([]);
    expect(calls).toEqual(['empty']);
    calls.length = 0;

    expect(
      compileModelRootPlan(
        emptyOwner,
        { insert: { select: () => null } },
        undefined
      )
    ).toEqual([]);
    expect(calls).toEqual([]);

    const ownerWithoutEmpty = {
      modelId: 'SpecModelRootPlannerFallbackOwner',
      planRows: () => {
        calls.push('rows');
        return [];
      }
    };

    expect(
      compileModelRootPlan(
        ownerWithoutEmpty,
        { insert: { select: () => [] as readonly Row[] } },
        undefined
      )
    ).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('lands an insert root for one owner row', async () => {
    const row = { id: 'insert-single', label: 'single', count: 1 };
    const { model, unrelated, storage } = defineActionModel(
      'SpecModelRootPlannerInsertSingle',
      { save: { row } },
      insertRoot(({ data }: RootContext<InsertInput, SaveData>) => data.save.row)
    );

    const work = createWorkProbe(model, unrelated, storage, [row.id]);
    await act(async () => {
      await model.actions.run.run({ label: row.label, count: row.count });
    });

    expect(model.find(row.id)).toEqual(row);
    work.assert({ wal: 1, commits: 1, affectedTicks: [1] });
    work.unmount();
  });

  it('lands an insert root for readonly owner rows', async () => {
    const rows = [
      { id: 'insert-batch-1', label: 'first', count: 1 },
      { id: 'insert-batch-2', label: 'second', count: 2 }
    ];
    const { model, unrelated, storage } = defineActionModel(
      'SpecModelRootPlannerInsertBatch',
      { save: { rows } },
      {
        insert: {
          select: ({ data }: RootContext<InsertInput[], SaveBatchData>) => data.save.rows as readonly Row[]
        }
      }
    );

    const work = createWorkProbe(model, unrelated, storage, rows.map(row => row.id));
    await act(async () => {
      await model.actions.run.run(rows.map(({ label, count }) => ({ label, count })));
    });

    expect(model.find(rows[0]!.id)).toEqual(rows[0]);
    expect(model.find(rows[1]!.id)).toEqual(rows[1]);
    work.assert({ wal: 1, commits: 1, affectedTicks: [1, 1] });
    work.unmount();
  });

  it('lands an update root for one partial patch', async () => {
    const existing = { id: 'update-single', label: 'before', count: 1 };
    const { model, unrelated, storage } = defineActionModel(
      'SpecModelRootPlannerUpdateSingle',
      { save: { row: existing } },
      {
        update: {
          select: ({ input }: RootContext<UpdateInput, SaveData>) => ({ id: input.id, patch: input.patch })
        }
      }
    );
    model.insert(existing);

    const work = createWorkProbe(model, unrelated, storage, [existing.id]);
    await act(async () => {
      await model.actions.run.run({ id: existing.id, patch: { label: 'after' } });
    });

    expect(model.find(existing.id)).toEqual({ ...existing, label: 'after' });
    work.assert({ wal: 1, commits: 1, affectedTicks: [1] });
    work.unmount();
  });

  it('lands update roots for readonly partial patches in order', async () => {
    const rows = [
      { id: 'update-batch-1', label: 'first', count: 1 },
      { id: 'update-batch-2', label: 'second', count: 2 }
    ];
    const { model, unrelated, storage } = defineActionModel(
      'SpecModelRootPlannerUpdateBatch',
      { save: { row: rows[0] } },
      {
        update: {
          select: ({ input }: RootContext<BatchUpdateInput, SaveData>) => input.updates
        }
      }
    );
    model.insert(rows[0]!);
    model.insert(rows[1]!);

    const work = createWorkProbe(model, unrelated, storage, rows.map(row => row.id));
    await act(async () => {
      await model.actions.run.run({
        updates: [
          { id: rows[0]!.id, patch: { label: 'first-updated' } },
          { id: rows[1]!.id, patch: { count: 20 } }
        ]
      });
    });

    expect(model.find(rows[0]!.id)).toEqual({ ...rows[0], label: 'first-updated' });
    expect(model.find(rows[1]!.id)).toEqual({ ...rows[1], count: 20 });
    work.assert({ wal: 1, commits: 1, affectedTicks: [1, 1] });
    work.unmount();
  });

  it('lands a destroy root for one id', async () => {
    const existing = { id: 'destroy-single', label: 'before', count: 1 };
    const { model, unrelated, storage } = defineActionModel(
      'SpecModelRootPlannerDestroySingle',
      { save: { row: existing } },
      { destroy: { select: ({ input }: RootContext<DestroyInput, SaveData>) => input.id } }
    );
    model.insert(existing);

    const work = createWorkProbe(model, unrelated, storage, [existing.id]);
    await act(async () => {
      await model.actions.run.run({ id: existing.id });
    });

    expect(model.find(existing.id)).toBeUndefined();
    work.assert({ wal: 1, commits: 1, affectedTicks: [1] });
    work.unmount();
  });

  it('lands a destroy root for readonly ids', async () => {
    const rows = [
      { id: 'destroy-batch-1', label: 'first', count: 1 },
      { id: 'destroy-batch-2', label: 'second', count: 2 }
    ];
    const { model, unrelated, storage } = defineActionModel(
      'SpecModelRootPlannerDestroyBatch',
      { save: { row: rows[0] } },
      { destroy: { select: ({ input }: RootContext<BatchDestroyInput, SaveData>) => input.ids } }
    );
    model.insert(rows[0]!);
    model.insert(rows[1]!);

    const work = createWorkProbe(model, unrelated, storage, rows.map(row => row.id));
    await act(async () => {
      await model.actions.run.run({ ids: rows.map(row => row.id) });
    });

    expect(model.find(rows[0]!.id)).toBeUndefined();
    expect(model.find(rows[1]!.id)).toBeUndefined();
    work.assert({ wal: 1, commits: 1, affectedTicks: [1, 1] });
    work.unmount();
  });

  it('keeps null and empty roots as zero-work no-ops', async () => {
    const existing = { id: 'root-no-op', label: 'before', count: 1 };
    const responseRow = { id: 'root-no-op-response', label: 'response', count: 2 };
    const { model, unrelated, storage } = defineActionModel(
      'SpecModelRootPlannerNoOp',
      { save: { row: responseRow } },
      {
        insert: {
          select: ({ input }: RootContext<NoOpInput, SaveData>) => (input.mode === 'null' ? null : [])
        }
      }
    );
    model.insert(existing);
    const work = createWorkProbe(model, unrelated, storage, [existing.id, responseRow.id]);

    await act(async () => {
      await model.actions.run.run({ mode: 'null' });
      await model.actions.run.run({ mode: 'empty' });
    });

    expect(model.find(existing.id)).toEqual(existing);
    expect(model.find(responseRow.id)).toBeUndefined();
    work.assert({ wal: 0, commits: 0, affectedTicks: [0, 0] });
    work.unmount();
  });

  it('commits root and cross-model intents in one envelope with isolated reactive ticks', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({
        data: { save: { row: { id: 'root-envelope', label: 'root', count: 1 } } } as TData
      })
    });
    const storage = createMemoryPlane();
    configureDb({ storage, transport });
    const Sibling = defineOwnerModel('SpecModelRootPlannerSibling', { schema: RowSchema });
    const Unrelated = defineOwnerModel('SpecModelRootPlannerUnrelated', { schema: RowSchema });
    const Root = defineOwnerModel('SpecModelRootPlannerEnvelope', {
      schema: RowSchema,
      actions: owner => ({
        run: owner.gql.action(actionDocument, {
          result: 'save',
          variables: (input: unknown) => ({ input }),
          root: insertRoot(({ data }: RootContext<InsertInput, SaveData>) => data.save.row),
          write: (_context: unknown, plan: { upsert(model: unknown, row: unknown): void }) => {
            plan.upsert(Sibling, { id: 'sibling-envelope', label: 'sibling', count: 2 });
          }
        })
      })
    });
    const rootReader = renderCounted(() => Root.useFind('root-envelope'));
    const siblingReader = renderCounted(() => Sibling.useFind('sibling-envelope'));
    const unrelatedReader = renderCounted(() => Unrelated.useFind('unrelated-envelope'));
    const before = {
      root: rootReader.renders(),
      sibling: siblingReader.renders(),
      unrelated: unrelatedReader.renders(),
      commits: diagnostics().snapshot().commits,
      wal: storage.keys('dbl:journal:').length
    };

    await act(async () => {
      await Root.actions.run.run({ label: 'root', count: 1 });
    });

    expect(rootReader.renders() - before.root).toBe(1);
    expect(siblingReader.renders() - before.sibling).toBe(1);
    expect(unrelatedReader.renders() - before.unrelated).toBe(0);
    expect(diagnostics().snapshot().commits - before.commits).toBe(1);
    expect(storage.keys('dbl:journal:').length - before.wal).toBe(1);
    expect(Root.find('root-envelope')).toEqual({ id: 'root-envelope', label: 'root', count: 1 });
    expect(Sibling.find('sibling-envelope')).toEqual({ id: 'sibling-envelope', label: 'sibling', count: 2 });

    rootReader.unmount();
    siblingReader.unmount();
    unrelatedReader.unmount();
  });

  it('rejects a root object containing more than one root form before mutation', async () => {
    const existing = { id: 'exclusive-root', label: 'before', count: 1 };
    const responseRow = { id: 'exclusive-root-response', label: 'response', count: 2 };
    const { model, unrelated, storage } = defineActionModel(
      'SpecModelRootPlannerExclusiveRoot',
      { save: { row: responseRow } },
      {
        insert: { select: ({ data }: RootContext<InsertInput, SaveData>) => data.save.row },
        update: { select: () => ({ id: existing.id, patch: { label: 'invalid' } }) }
      }
    );
    model.insert(existing);

    await expectNoResponseWrite(
      model,
      unrelated,
      storage,
      { label: 'invalid', count: 1 },
      existing,
      'ModelRootPlan must contain exactly one root form',
      [responseRow.id]
    );
  });

  const expectInvalidUpdate = async (caseName: string, update: unknown, error: string, absentIds: readonly string[] = []): Promise<void> => {
    const existing = { id: 'invalid-input', label: 'before', count: 1 };
    const responseRow = { id: `invalid-response-${caseName}`, label: 'response', count: 2 };
    const { model, unrelated, storage } = defineActionModel(
      `SpecModelRootPlannerInvalid${caseName}`,
      { save: { row: responseRow } },
      {
        update: {
          select: () => update
        }
      }
    );
    model.insert(existing);

    await expectNoResponseWrite(model, unrelated, storage, {}, existing, error, [responseRow.id, ...absentIds]);
  };

  it('rejects an invalid update id before response mutation', async () => {
    await expectInvalidUpdate('Id', { id: '', patch: { label: 'invalid' } }, 'ModelRootPlan update requires a non-empty id');
  });

  it('rejects an undefined update field before response mutation', async () => {
    await expectInvalidUpdate(
      'UndefinedField',
      { id: 'invalid-input', patch: { label: undefined } },
      'ModelRootPlan update patch field "label" cannot be undefined'
    );
  });

  it('rejects a non-object update patch before response mutation', async () => {
    await expectInvalidUpdate('NonObjectPatch', { id: 'invalid-input', patch: 'invalid' }, 'ModelRootPlan update requires a plain object patch');
  });

  it('rejects id inside an update patch before response mutation', async () => {
    await expectInvalidUpdate(
      'IdInsidePatch',
      { id: 'invalid-input', patch: { id: 'forbidden', label: 'invalid' } },
      'ModelRootPlan update patch cannot contain id',
      ['forbidden']
    );
  });

  it('rejects a same-owner WritePlan target before mutation', async () => {
    const existing = { id: 'same-owner', label: 'before', count: 1 };
    const responseRow = { id: 'same-owner-response', label: 'response', count: 2 };
    let ownerTarget: OwnerDeclaration | undefined;
    const transport = createMockTransport({
      mutation: async <TData,>() => ({ data: { save: { row: responseRow } } as TData })
    });
    const storage = createMemoryPlane();
    configureDb({ storage, transport });
    const unrelated = defineOwnerModel('SpecModelRootPlannerSameOwnerUnrelated', { schema: RowSchema });
    unrelated.insert(unrelatedRow);
    const model = defineOwnerModel('SpecModelRootPlannerSameOwner', {
      schema: RowSchema,
      actions: owner => {
        ownerTarget = owner;
        return {
          run: owner.gql.action(actionDocument, {
            result: 'save',
            variables: (input: unknown) => ({ input }),
            root: insertRoot(({ data }: RootContext<InsertInput, SaveData>) => data.save.row),
            write: (_context: unknown, plan: { upsert(model: unknown, row: unknown): void }) => {
              plan.upsert(ownerTarget, { id: 'same-owner-write', label: 'forbidden', count: 1 });
            }
          })
        };
      }
    });
    model.insert(existing);

    await expectNoResponseWrite(
      model,
      unrelated,
      storage,
      { label: 'input', count: 1 },
      existing,
      'WritePlan cannot target its owner model',
      [responseRow.id, 'same-owner-write']
    );
  });
});

const packageRoot = path.resolve(__dirname, '../../../..');
const fixtureName = path.join(packageRoot, 'model-root-planner.fixture.ts');
const entry = path.join(packageRoot, 'src/index.ts').split(path.sep).join('/');
const compilerOptions: ts.CompilerOptions = {
  strict: true,
  exactOptionalPropertyTypes: true,
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
const compilerHost = ts.createCompilerHost(compilerOptions);
const readPackageFile = compilerHost.getSourceFile.bind(compilerHost);
compilerHost.fileExists = fileName => fileName === fixtureName || ts.sys.fileExists(fileName);
compilerHost.readFile = fileName => (fileName === fixtureName ? fixtureSource : ts.sys.readFile(fileName));
compilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
  if (fileName === fixtureName) return ts.createSourceFile(fileName, fixtureSource, languageVersion, true);
  if (!packageFiles.has(fileName)) packageFiles.set(fileName, readPackageFile(fileName, languageVersion, onError, shouldCreateNewSourceFile));
  return packageFiles.get(fileName);
};

const compileFixture = (source: string): readonly ts.Diagnostic[] => {
  fixtureSource = source;
  const program = ts.createProgram([fixtureName], compilerOptions, compilerHost, previousProgram);
  previousProgram = program;
  return ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.file?.fileName === fixtureName);
};

const diagnosticMessages = (diagnostics: readonly ts.Diagnostic[]): string[] =>
  diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));

type ExpectedDiagnostic = {
  anchor: string;
  code: number;
  message: RegExp;
};

const expectFixtureDiagnostic = (source: string, expected: ExpectedDiagnostic): void => {
  const diagnostics = compileFixture(source);
  const diagnostic = diagnostics[0];
  const expectedStart = source.indexOf(expected.anchor);

  expect(expectedStart).toBeGreaterThanOrEqual(0);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostic?.file?.fileName).toBe(fixtureName);
  expect(diagnostic?.start).toBe(expectedStart);
  expect(diagnostic?.code).toBe(expected.code);
  expect(ts.flattenDiagnosticMessageText(diagnostic?.messageText ?? '', '\n')).toMatch(expected.message);
};

describe('model root planner type surface', () => {
  it('accepts owner-bound relation, action and live declarations without diagnostics', () => {
    const diagnostics = compileFixture(`
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f } from '${entry}';

      type Row = { id: string; label: string };
      type Variables = { bucket: string };
      type QueryData = { row: Row };
      type ListData = { rows: Row[] };
      type ConnectionData = { rows: { nodes: Row[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      type ActionData = { save: { row: Row } };
      type EventData = { changed: { row: Row } };
      declare const queryDocument: TypedDocumentNode<QueryData, Variables>;
      declare const listDocument: TypedDocumentNode<ListData, Variables>;
      declare const connectionDocument: TypedDocumentNode<ConnectionData, Variables & { after?: string | null }>;
      declare const actionDocument: TypedDocumentNode<ActionData, { input: { label: string } }>;
      declare const eventDocument: TypedDocumentNode<EventData, Record<string, never>>;
      const RowSchema = defineShape<Row>()({ label: f.str() });

      const rows = defineModel('owner-bound', {
        schema: RowSchema,
        relations: owner => ({
          detail: {
            remote: owner.gql.single(queryDocument, {
              variables: (params: Variables) => params,
              select: data => data.row
            })
          },
          listing: {
            remote: owner.gql.list(listDocument, {
              variables: (params: Variables) => params,
              select: data => data.rows
            })
          },
          scrolling: {
            remote: owner.gql.connection(connectionDocument, {
              variables: (params: Variables) => params,
              connection: data => data.rows
            })
          }
        }),
        actions: owner => ({
          save: owner.gql.action(actionDocument, {
            result: 'save',
            variables: input => ({ input }),
            root: { insert: { select: context => context.data.save.row } }
          })
        }),
        events: owner => ({
          changed: owner.gql.live(eventDocument, {
            variables: {},
            root: { insert: { select: context => context.payload.row } }
          })
        })
      });
      void rows;
    `);

    expect(diagnosticMessages(diagnostics)).toEqual([]);
  });

  it('rejects the removed top-level gql builder', () => {
    const source = `
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f, gql } from '${entry}';
      type Row = { id: string; label: string };
      type Data = { save: { row: Row } };
      declare const document: TypedDocumentNode<Data, { input: { label: string } }>;
      const RowSchema = defineShape<Row>()({ label: f.str() });
      defineModel('top-level-gql', { schema: RowSchema, actions: owner => ({
        save: owner.gql.action(document, { result: 'save', variables: input => ({ input }), root: { insert: { select: context => context.data.save.row } } })
      }) });
      void gql;
    `;
    expectFixtureDiagnostic(source, {
      anchor: 'gql }',
      code: 2305,
      message: /^Module '.+' has no exported member 'gql'\.$/
    });
  });

  it('rejects runtime Model.gql access', () => {
    const source = `
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; label: string };
      const RowSchema = defineShape<Row>()({ label: f.str() });
      const rows = defineModel('runtime-gql', { schema: RowSchema });
      rows.gql;
    `;
    expectFixtureDiagnostic(source, {
      anchor: 'gql;',
      code: 2339,
      message: /^Property 'gql' does not exist on type '.+'\.$/
    });
  });

  it.each(['relations', 'actions', 'events'] as const)('rejects object-form %s configuration at its property', property => {
    const source = `
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; label: string };
      const RowSchema = defineShape<Row>()({ label: f.str() });
      defineModel('object-form-${property}', {
        schema: RowSchema,
        ${property}: {}
      });
    `;
    expectFixtureDiagnostic(source, {
      anchor: `${property}:`,
      code: 2322,
      message: /^Type '\{\}' is not assignable to type '\(.+\) => .+'\.[\s\S]+provides no match for the signature/
    });
  });

  it('rejects same-owner WritePlan targets', () => {
    const source = `
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; label: string };
      type Data = { save: { row: Row } };
      declare const document: TypedDocumentNode<Data, { input: { label: string } }>;
      const RowSchema = defineShape<Row>()({ label: f.str() });
      defineModel('same-owner-plan', {
        schema: RowSchema,
        actions: owner => ({
          save: owner.gql.action(document, {
            result: 'save',
            variables: input => ({ input }),
            root: { insert: { select: context => context.data.save.row } },
            write: (_context, plan) => plan.upsert(owner, { id: 'same', label: 'same' })
          })
        })
      });
    `;
    expectFixtureDiagnostic(source, {
      anchor: "owner, { id: 'same'",
      code: 2345,
      message: /^Argument of type '.+' is not assignable to parameter of type 'never'\.$/
    });
  });

  it('rejects a root object with multiple forms', () => {
    const source = `
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; label: string };
      type Data = { save: { row: Row } };
      declare const document: TypedDocumentNode<Data, { input: { label: string } }>;
      const RowSchema = defineShape<Row>()({ label: f.str() });
      defineModel('invalid-root', {
        schema: RowSchema,
        actions: owner => ({
          save: owner.gql.action(document, {
            result: 'save',
            variables: input => ({ input }),
            root: {
              insert: { select: context => context.data.save.row },
              destroy: { select: () => 'row-1' }
            }
          })
        })
      });
    `;
    expectFixtureDiagnostic(source, {
      anchor: 'root:',
      code: 2769,
      message: /^No overload matches this call\.[\s\S]+(?:undefined|never)/
    });
  });

  it('rejects a non-string update id', () => {
    const source = `
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; label: string };
      type Data = { save: { row: Row } };
      declare const document: TypedDocumentNode<Data, Record<string, never>>;
      const RowSchema = defineShape<Row>()({ label: f.str() });
      defineModel('root-invalid-id', {
        schema: RowSchema,
        actions: owner => ({
          save: owner.gql.action(document, {
            result: 'save',
            variables: () => ({}),
            root: { update: { select: () => ({ id: 1, patch: { label: 'next' } }) } }
          })
        })
      });
    `;
    expectFixtureDiagnostic(source, {
      anchor: 'id: 1',
      code: 2769,
      message: /^No overload matches this call\.[\s\S]+Type 'number' is not assignable to type 'string'/
    });
  });

  it('rejects a non-object update patch', () => {
    const source = `
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; label: string };
      type Data = { save: { row: Row } };
      declare const document: TypedDocumentNode<Data, Record<string, never>>;
      const RowSchema = defineShape<Row>()({ label: f.str() });
      defineModel('root-non-object-patch', {
        schema: RowSchema,
        actions: owner => ({
          save: owner.gql.action(document, {
            result: 'save',
            variables: () => ({}),
            root: { update: { select: () => ({ id: 'row-1', patch: 'invalid' }) } }
          })
        })
      });
    `;
    expectFixtureDiagnostic(source, {
      anchor: "patch: 'invalid'",
      code: 2769,
      message: /^No overload matches this call\.[\s\S]+Type 'string' has no properties in common with type 'Partial<Omit<.+, "id">>'/
    });
  });

  it('rejects id inside an update patch', () => {
    const source = `
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; label: string };
      type Data = { save: { row: Row } };
      declare const document: TypedDocumentNode<Data, { input: { id: string } }>;
      const RowSchema = defineShape<Row>()({ label: f.str() });
      defineModel('root-patch-id', {
        schema: RowSchema,
        actions: owner => ({
          save: owner.gql.action(document, {
            result: 'save',
            variables: input => ({ input }),
            root: { update: { select: context => ({ id: context.input.id, patch: { id: 'forbidden' } }) } }
          })
        })
      });
    `;
    expectFixtureDiagnostic(source, {
      anchor: "id: 'forbidden'",
      code: 2769,
      message: /^No overload matches this call\.[\s\S]+'id' does not exist in type 'Partial<Omit<.+, "id">>'/
    });
  });

  it('rejects an explicit undefined update field', () => {
    const source = `
      import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
      import { defineModel, defineShape, f } from '${entry}';
      type Row = { id: string; label: string };
      type Data = { save: { row: Row } };
      declare const document: TypedDocumentNode<Data, { input: { id: string } }>;
      const RowSchema = defineShape<Row>()({ label: f.str() });
      defineModel('root-patch-undefined', {
        schema: RowSchema,
        actions: owner => ({
          save: owner.gql.action(document, {
            result: 'save',
            variables: input => ({ input }),
            root: { update: { select: context => ({ id: context.input.id, patch: { label: undefined } }) } }
          })
        })
      });
    `;
    expectFixtureDiagnostic(source, {
      anchor: 'patch: { label: undefined }',
      code: 2769,
      message: /^No overload matches this call\.[\s\S]+Type 'undefined' is not assignable to type 'string'/
    });
  });
});
