import { bootDb, configureDb, defineCommand, defineModel, f, flushPersistence, resetRuntime } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type Result = { action: { ok: true } };
type Input = { value: string };

const document = { kind: 'Document', definitions: [] } as never;
const response = { action: { ok: true as const } };

const createCommand = (suffix: string, transport: ReturnType<typeof createMockTransport>, options: { once?: boolean; dedupe?: false } = {}) => {
  configureDb({ storage: createMemoryPlane(), transport });
  return defineCommand<Result, Input>(`specDedupe${suffix}`, {
    document,
    result: 'action',
    ...options
  } as never);
};

const deferredMutation = () => {
  let resolve!: (value: { data: Result }) => void;
  const promise = new Promise<{ data: Result }>(nextResolve => {
    resolve = nextResolve;
  });
  const transport = createMockTransport({ mutation: async <TData,>() => (await promise) as { data: TData } });
  return { transport, resolve: () => resolve({ data: response }) };
};

describe('mutation dedupe semantics', () => {
  it('skips a second run while the same default key is pending', async () => {
    const deferred = deferredMutation();
    const command = createCommand('Pending', deferred.transport);

    const first = command.run({ value: 'same' });
    const second = await command.run({ value: 'same' });

    expect(second).toBeNull();
    expect(deferred.transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(1);
    deferred.resolve();
    await first;
  });

  test.failing('GATE-PENDING(G12): sends the same default key again after commit', async () => {
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) });
    const command = createCommand('AfterCommit', transport);

    const first = await command.run({ value: 'same' });
    const second = await command.run({ value: 'same' });

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
    const command = createCommand('AfterRollback', transport);

    await expect(command.run({ value: 'same' })).rejects.toThrow('failed');
    await expect(command.run({ value: 'same' })).resolves.not.toBeNull();
    expect(calls).toBe(2);
  });

  it('keeps a committed once key blocked until runtime reset', async () => {
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) });
    const command = createCommand('OnceReset', transport, { once: true });

    await command.run({ value: 'same' });
    expect(await command.run({ value: 'same' })).toBeNull();
    resetRuntime();
    expect(await command.run({ value: 'same' })).not.toBeNull();
    expect(transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(2);
  });

  it('keeps a committed once key blocked across configure and boot replay', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) });
    configureDb({ storage, transport });
    const firstCommand = defineCommand<Result, Input>('specDedupeOnceRestart', { document, result: 'action', once: true } as never);
    await firstCommand.run({ value: 'same' });
    flushPersistence();

    configureDb({ storage, transport });
    const restartedCommand = defineCommand<Result, Input>('specDedupeOnceRestart', { document, result: 'action', once: true } as never);
    await bootDb();

    expect(await restartedCommand.run({ value: 'same' })).toBeNull();
    expect(transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(1);
  });

  test.failing('GATE-PENDING(G12): rejects once with dedupe false at definition time', () => {
    const transport = createMockTransport();

    expect(() => createCommand('InvalidOnce', transport, { once: true, dedupe: false })).toThrow('once cannot be combined with dedupe: false');
  });

  it('emits no model-reader render when a duplicate run is skipped', async () => {
    const deferred = deferredMutation();
    const command = createCommand('RenderSilence', deferred.transport);
    const rows = defineModel({ id: 'SpecDedupeRenderRows', name: 'SpecDedupeRenderRows', fields: { value: f.str() } });
    rows.seed([{ id: 'row-1', value: 'kept' }]);
    const reader = renderCounted(() => rows.use.row('row-1'));
    const before = reader.renders();

    const first = command.run({ value: 'same' });
    expect(await command.run({ value: 'same' })).toBeNull();

    expect(reader.renders() - before).toBe(0);
    deferred.resolve();
    await first;
    reader.unmount();
  });

  test.failing('GATE-PENDING(G12): persists closed dedupe keys only for once operations', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) });
    configureDb({ storage, transport });
    const regular = defineCommand<Result, Input>('specDedupeStoredRegular', { document, result: 'action' });
    const once = defineCommand<Result, Input>('specDedupeStoredOnce', { document, result: 'action', once: true } as never);

    await regular.run({ value: 'regular' });
    await once.run({ value: 'once' });
    const records = Object.values(JSON.parse(storage.get('dbl:ops') ?? '{}') as Record<string, { once?: boolean; idempotencyKey?: string }>);
    const regularRecord = records.find(record => record.once !== true);
    const onceRecord = records.find(record => record.once === true);

    expect(regularRecord?.idempotencyKey).toBeUndefined();
    expect(onceRecord?.idempotencyKey).toBe('specDedupeStoredOnce:{"value":"once"}');
  });
});
