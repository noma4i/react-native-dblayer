import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { bootDb, compositeKey, configureDb, computeSchemaFingerprints, DB_FORMAT_VERSION, defineModel, defineShape, f, flushPersistence, resetRuntime, stableSerialize, writePersistenceManifest } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type Result = { action: { ok: true } };
type Input = { value: string };
type Row = { id: string; value: string };

const document: TypedDocumentNode<Result, Input> = { kind: Kind.DOCUMENT, definitions: [] };
const response = { action: { ok: true as const } };
const RowSchema = defineShape<Row>()({ value: f.str() });

const defineAction = (suffix: string, options: { once?: boolean; dedupe?: false } = {}) => {
  const actionKey = `specDedupe${suffix}`;
  const model = defineModel(`SpecDedupeModel${suffix}`, {
    schema: RowSchema,
    actions: owner => ({
      run: owner.gql.action(document, {
        mode: 'request',
        result: 'action',
        variables: (input: Input) => input,
        dedupe: options.dedupe === false ? false : { key: input => compositeKey(actionKey, stableSerialize(input)) },
        ...(options.once === undefined ? {} : { once: options.once }),
        root: { insert: { select: () => null } }
      })
    })
  });
  return model.actions.run;
};

const createAction = (suffix: string, transport: ReturnType<typeof createMockTransport>, options: { once?: boolean; dedupe?: false } = {}) => {
  configureDb({ storage: createMemoryPlane(), transport });
  return defineAction(suffix, options);
};

const deferredMutation = () => {
  let resolve!: (value: { data: Result }) => void;
  const promise = new Promise<{ data: Result }>(nextResolve => {
    resolve = nextResolve;
  });
  const transport = createMockTransport({ mutation: async <TData>() => (await promise) as { data: TData } });
  return { transport, resolve: () => resolve({ data: response }) };
};

describe('mutation dedupe semantics', () => {
  it('skips a second run while the same default key is pending', async () => {
    const deferred = deferredMutation();
    const action = createAction('Pending', deferred.transport);

    const first = action.run({ value: 'same' });
    const second = await action.run({ value: 'same' });

    expect(second).toBeNull();
    expect(deferred.transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(1);
    deferred.resolve();
    await first;
  });

  it('sends the same default key again after commit', async () => {
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) });
    const action = createAction('AfterCommit', transport);

    const first = await action.run({ value: 'same' });
    const second = await action.run({ value: 'same' });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(2);
  });

  it('sends the same default key again after rollback', async () => {
    let calls = 0;
    const transport = createMockTransport({
      mutation: async <TData,>() => {
        calls += 1;
        if (calls === 1) throw new Error('failed');
        return { data: response as TData };
      }
    });
    const action = createAction('AfterRollback', transport);

    await expect(action.run({ value: 'same' })).rejects.toThrow('failed');
    await expect(action.run({ value: 'same' })).resolves.not.toBeNull();
    expect(calls).toBe(2);
  });

  it('keeps a committed once key blocked until runtime reset', async () => {
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) });
    const action = createAction('OnceReset', transport, { once: true });

    await action.run({ value: 'same' });
    expect(await action.run({ value: 'same' })).toBeNull();
    resetRuntime();
    expect(await action.run({ value: 'same' })).not.toBeNull();
    expect(transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(2);
  });

  it('keeps a committed once key blocked across configure and boot replay', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) });
    configureDb({ storage, transport });
    const firstAction = defineAction('OnceRestart', { once: true });
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await firstAction.run({ value: 'same' });
    flushPersistence();

    const restartTime = Date.now() + 2 * 60 * 60 * 1000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(restartTime);
    try {
      configureDb({ storage, transport });
      const restartedAction = defineAction('OnceRestart', { once: true });
      await bootDb();

      expect(await restartedAction.run({ value: 'same' })).toBeNull();
      expect(transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it('rejects once with dedupe false at definition time', () => {
    expect(() => defineAction('InvalidOnce', { once: true, dedupe: false })).toThrow('once cannot be combined with dedupe: false');
  });

  it('emits no model-reader render when a duplicate run is skipped', async () => {
    const deferred = deferredMutation();
    const action = createAction('RenderSilence', deferred.transport);
    const rows = defineModel('SpecDedupeRenderRows', { schema: RowSchema });
    rows.insert({ id: 'row-1', value: 'kept' });
    const reader = renderCounted(() => rows.useFind('row-1'));
    const before = reader.renders();

    const first = action.run({ value: 'same' });
    expect(await action.run({ value: 'same' })).toBeNull();

    expect(reader.renders() - before).toBe(0);
    deferred.resolve();
    await first;
    reader.unmount();
  });

  it('persists closed dedupe keys only for once operations', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) });
    configureDb({ storage, transport });
    const regular = defineAction('StoredRegular');
    const once = defineAction('StoredOnce', { once: true });

    await regular.run({ value: 'regular' });
    await once.run({ value: 'once' });
    const persisted = JSON.parse(storage.get('dbl:ops') ?? '{}') as {
      payload?: Record<string, { once?: boolean; idempotencyKey?: string }>;
    };
    const records = Object.values(persisted.payload ?? {});
    const regularRecord = records.find(record => record.once !== true);
    const onceRecord = records.find(record => record.once === true);

    expect(regularRecord?.idempotencyKey).toBeUndefined();
    expect(onceRecord?.idempotencyKey).toBe(compositeKey('specDedupeStoredOnce', '{"value":"once"}'));
  });
});
