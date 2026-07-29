import { act } from 'react';
import { configureDb, defineModel, f, resetRuntime, scope } from '../../../index';
import { collectGarbage } from '../../../core/gc';
import { flushPersistence, getOperationState, replayJournal } from '../../../dsl/configure';
import { bootDb } from '../../../dsl/lifecycle';
import { DB_FORMAT_VERSION, computeSchemaFingerprint, writePersistenceManifest } from '../../../core/schemaManifest';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted } from '../helpers/harness';
import { attemptWithLastWriteFaulted, createFaultStorage } from '../helpers/faultStorage';

type Row = { id: string; bucket: string; label: string; state: 'pending' | 'failed' | 'complete'; createdAt: string };
type Input = { bucket: string; label: string };

const defineRows = (id: string, options: { gc?: 'exempt'; maxAgeMs?: number } = {}) =>
  defineModel({
    id,
    name: id,
    gc: options.gc,
    fields: { bucket: f.str(), label: f.str(), state: f.enum<Row['state']>(['pending', 'failed', 'complete']), createdAt: f.str() },
    scopes: { byBucket: scope<Row>({ by: { bucket: 'bucket' } }) },
    maintenance: { dropTempRowsAfterMs: options.maxAgeMs ?? 60_000 }
  });

const declare = (model: ReturnType<typeof defineRows>, kind: string, resume: (entry: { operationId: string; tempId: string; input: Input }) => Promise<'continue' | 'orphaned'>) =>
  model.detached<Input>(kind, {
    build: input => ({ bucket: input.bucket, label: input.label, state: 'pending', createdAt: new Date().toISOString() }),
    resume,
    failure: 'keep',
    onFailurePatch: () => ({ state: 'failed' })
  });

const writeManifest = () => writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: null });

describe('detached operations', () => {
  it('P1 starts its temp row and durable operation together', () => {
    const storage = createMemoryPlane();
    const set = storage.set;
    const batches: Array<Array<{ key: string; value: string | null }>> = [];
    storage.set = entries => {
      batches.push(entries);
      set(entries);
    };
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineRows('DetachedAtomic');
    const handle = declare(rows, 'atomic', async () => 'continue');

    const entry = handle.start({ bucket: 'a', label: 'first' });

    expect(rows.find(entry.tempId)).toMatchObject({ label: 'first', state: 'pending' });
    expect(getOperationState().get(entry.operationId)).toMatchObject({ kind: 'atomic', tempIds: [entry.tempId], status: 'pending' });
    expect(batches).toContainEqual(expect.arrayContaining([expect.objectContaining({ key: 'dbl:ops' }), expect.objectContaining({ key: expect.stringMatching(/^dbl:journal:/) })]));
  });

  it('P2 completes through identity replacement without losing scope membership', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('DetachedReplace');
    const handle = declare(rows, 'replace', async () => 'continue');
    const entry = handle.start({ bucket: 'a', label: 'first' });

    handle.complete(entry.operationId, { id: 'server-1', bucket: 'a', label: 'done', state: 'complete', createdAt: new Date().toISOString() });

    expect(rows.find(entry.tempId)).toBeUndefined();
    expect(rows.scopes.byBucket.read({ bucket: 'a' }).map(row => row.id)).toEqual(['server-1']);
  });

  it('P3 hydrates an open operation and its temp row after restart', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineRows('DetachedRestart');
    const handle = declare(rows, 'restart', async () => 'continue');
    const entry = handle.start({ bucket: 'a', label: 'first' });
    writeManifest();
    flushPersistence();

    configureDb({ storage, transport: createMockTransport() });
    const restartedRows = defineRows('DetachedRestart');
    declare(restartedRows, 'restart', async () => 'continue');
    writeManifest();
    await bootDb();

    expect(restartedRows.find(entry.tempId)).toMatchObject({ label: 'first' });
    expect(getOperationState().get(entry.operationId)).toMatchObject({ status: 'pending', kind: 'restart' });
  });

  it('protects an open temp id only inside its owning model during orphan recovery', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const owner = defineRows('DetachedSharedTempOwner', { gc: 'exempt' });
    const other = defineRows('DetachedSharedTempOther', { gc: 'exempt' });
    const handle = declare(owner, 'shared-temp', async () => 'continue');
    const entry = handle.start({ bucket: 'a', label: 'owned' });
    other.insert({ id: entry.tempId, bucket: 'b', label: 'orphan', state: 'pending', createdAt: new Date().toISOString() });
    writeManifest();
    flushPersistence();

    configureDb({ storage, transport: createMockTransport() });
    const restartedOwner = defineRows('DetachedSharedTempOwner', { gc: 'exempt' });
    const restartedOther = defineRows('DetachedSharedTempOther', { gc: 'exempt' });
    declare(restartedOwner, 'shared-temp', async () => 'continue');
    writeManifest();
    await bootDb();

    expect(restartedOwner.find(entry.tempId)).toMatchObject({ label: 'owned' });
    expect(restartedOther.find(entry.tempId)).toBeUndefined();
  });

  it('P4 resumes every hydrated detached operation once', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineRows('DetachedResumeOnce');
    const handle = declare(rows, 'resume-once', async () => 'continue');
    handle.start({ bucket: 'a', label: 'first' });
    writeManifest();
    flushPersistence();
    const resume = jest.fn(async () => 'continue' as const);

    configureDb({ storage, transport: createMockTransport() });
    const restartedRows = defineRows('DetachedResumeOnce');
    declare(restartedRows, 'resume-once', resume);
    writeManifest();
    await bootDb();

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('P5 turns an orphaned resume into the declaration failure policy', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineRows('DetachedOrphaned');
    const handle = declare(rows, 'orphaned', async () => 'continue');
    const entry = handle.start({ bucket: 'a', label: 'first' });
    writeManifest();
    flushPersistence();

    configureDb({ storage, transport: createMockTransport() });
    const restartedRows = defineRows('DetachedOrphaned');
    declare(restartedRows, 'orphaned', async () => 'orphaned');
    writeManifest();
    await bootDb();

    expect(restartedRows.find(entry.tempId)).toMatchObject({ state: 'failed' });
    expect(getOperationState().get(entry.operationId)).toMatchObject({ status: 'failed' });
  });

  it('P6 records a data-loss event when resume throws and applies failure', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineRows('DetachedResumeError');
    const handle = declare(rows, 'resume-error', async () => 'continue');
    const entry = handle.start({ bucket: 'a', label: 'first' });
    writeManifest();
    flushPersistence();
    diagnostics().reset();

    configureDb({ storage, transport: createMockTransport() });
    const restartedRows = defineRows('DetachedResumeError');
    declare(restartedRows, 'resume-error', async () => {
      throw new Error('executor missing');
    });
    writeManifest();
    await bootDb();

    expect(restartedRows.find(entry.tempId)).toMatchObject({ state: 'failed' });
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'detached-resume-error', model: 'DetachedResumeError', count: 1 });
  });

  it('keeps a detached definition usable when configureDb advances the runtime generation', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineRows('DetachedDefinitionSurvives');
    const resume = jest.fn(async () => 'orphaned' as const);
    const handle = declare(rows, 'definition-survives', resume);
    const entry = handle.start({ bucket: 'a', label: 'old' });
    writeManifest();
    flushPersistence();

    configureDb({ storage, transport: createMockTransport() });
    writeManifest();
    await bootDb();

    expect(resume).toHaveBeenCalledTimes(1);
    expect(rows.find(entry.tempId)).toMatchObject({ state: 'failed' });
  });

  it('rejects boot and blocks stale detached failure writes when reset crosses resume', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineRows('DetachedResetFence');
    const handle = rows.detached<Input>('reset-fence', {
      build: input => ({ bucket: input.bucket, label: input.label, state: 'pending', createdAt: new Date().toISOString() }),
      resume: async () => 'continue',
      failure: 'rollback'
    });
    const entry = handle.start({ bucket: 'a', label: 'old' });
    writeManifest();
    flushPersistence();

    let resolveResume!: (outcome: 'continue' | 'orphaned') => void;
    configureDb({ storage, transport: createMockTransport() });
    const restartedRows = defineRows('DetachedResetFence');
    restartedRows.detached<Input>('reset-fence', {
      build: input => ({ bucket: input.bucket, label: input.label, state: 'pending', createdAt: new Date().toISOString() }),
      resume: () =>
        new Promise(resolve => {
          resolveResume = resolve;
        }),
      failure: 'rollback'
    });
    writeManifest();
    const boot = bootDb();
    await Promise.resolve();

    resetRuntime();
    await expect(boot).rejects.toThrow('runtime generation changed during boot');
    restartedRows.insert({ id: entry.tempId, bucket: 'fresh', label: 'fresh', state: 'complete', createdAt: new Date().toISOString() });
    resolveResume('orphaned');

    await Promise.resolve();
    expect(restartedRows.find(entry.tempId)).toMatchObject({ label: 'fresh', state: 'complete' });
  });

  it('P7 protects an open temp row from pending TTL and garbage collection', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('DetachedProtected', { maxAgeMs: 0 });
    const handle = declare(rows, 'protected', async () => 'continue');
    const entry = handle.start({ bucket: 'a', label: 'first' });
    rows.update(entry.tempId, { createdAt: new Date(0).toISOString() });

    collectGarbage();

    expect(rows.find(entry.tempId)).toBeDefined();
  });

  it('P8 retries a persisted failed operation with its saved input', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineRows('DetachedRetry');
    const handle = declare(rows, 'retry', async () => 'continue');
    let entry!: { operationId: string; tempId: string };
    act(() => {
      entry = handle.start({ bucket: 'a', label: 'first' });
    });
    handle.fail(entry.operationId, new Error('offline'));
    writeManifest();
    flushPersistence();
    const resume = jest.fn(async () => 'continue' as const);

    configureDb({ storage, transport: createMockTransport() });
    const restartedRows = defineRows('DetachedRetry');
    const restarted = declare(restartedRows, 'retry', resume);
    writeManifest();
    await bootDb();
    await restarted.retry(entry.operationId);

    expect(resume).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: entry.operationId, tempId: entry.tempId, input: { bucket: 'a', label: 'first' } }));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('P9 ignores a repeated complete after terminal commit', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('DetachedIdempotent');
    const handle = declare(rows, 'idempotent', async () => 'continue');
    const entry = handle.start({ bucket: 'a', label: 'first' });
    const node = { id: 'server-1', bucket: 'a', label: 'done', state: 'complete' as const, createdAt: new Date().toISOString() };

    handle.complete(entry.operationId, node);
    expect(() => handle.complete(entry.operationId, { ...node, label: 'changed' })).not.toThrow();

    expect(rows.find('server-1')).toMatchObject({ label: 'done' });
  });

  it('P10 rejects duplicate operation kinds in one runtime generation', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('DetachedDuplicate');
    declare(rows, 'duplicate', async () => 'continue');

    expect(() => declare(rows, 'duplicate', async () => 'continue')).toThrow();
  });

  it('I1 records each explicit lossy detached terminal path', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('DetachedLoss');
    const rollback = rows.detached<Input>('rollback-loss', {
      build: input => ({ bucket: input.bucket, label: input.label, state: 'pending', createdAt: new Date().toISOString() }),
      resume: async () => 'continue',
      failure: 'rollback'
    });
    const discard = declare(rows, 'discard-loss', async () => 'continue');
    diagnostics().reset();
    const rolledBack = rollback.start({ bucket: 'a', label: 'first' });
    const discarded = discard.start({ bucket: 'a', label: 'second' });

    rollback.fail(rolledBack.operationId, new Error('rejected'));
    discard.discard(discarded.operationId);

    expect(diagnostics().snapshot().dataLossEvents).toEqual(expect.arrayContaining([
      { mechanism: 'detached-operation-rollback', model: 'DetachedLoss', count: 1 },
      { mechanism: 'detached-operation-discard', model: 'DetachedLoss', count: 1 }
    ]));
  });

  it('I2 records dropped nonserializable input and refuses retry', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('DetachedUnserializable');
    const handle = rows.detached<Input & { callback: () => void }>('unserializable', {
      build: input => ({ bucket: input.bucket, label: input.label, state: 'pending', createdAt: new Date().toISOString() }),
      resume: async () => 'continue',
      failure: 'keep'
    });
    diagnostics().reset();
    const entry = handle.start({ bucket: 'a', label: 'first', callback: () => undefined });
    handle.fail(entry.operationId, new Error('offline'));

    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'failed-input-unserializable', model: 'DetachedUnserializable', count: 1 });
    await expect(handle.retry(entry.operationId)).resolves.toBeNull();
  });

  it('R1 renders the scoped reader once for start and once for complete without waking an unrelated reader', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('DetachedRenders');
    const handle = declare(rows, 'renders', async () => 'continue');
    const relevant = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'a' }));
    const unrelated = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'b' }));
    let entry!: { operationId: string; tempId: string };
    act(() => {
      entry = handle.start({ bucket: 'a', label: 'first' });
    });

    expect(relevant.renders()).toBe(2);
    expect(unrelated.renders()).toBe(1);
    act(() => handle.complete(entry.operationId, { id: 'server-1', bucket: 'a', label: 'done', state: 'complete', createdAt: new Date().toISOString() }));
    expect(relevant.renders()).toBe(3);
    expect(unrelated.renders()).toBe(1);
    relevant.unmount();
    unrelated.unmount();
  });

  it('S1 keeps detached start and complete commit deltas constant across model sizes', () => {
    const run = (count: number) => {
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const rows = defineRows(`DetachedScale${count}`);
      for (let index = 0; index < count; index += 1) rows.insert({ id: `row-${index}`, bucket: 'a', label: String(index), state: 'complete', createdAt: new Date().toISOString() });
      const handle = declare(rows, `scale-${count}`, async () => 'continue');
      diagnostics().reset();
      const entry = handle.start({ bucket: 'a', label: 'first' });
      const afterStart = diagnostics().snapshot().commits;
      handle.complete(entry.operationId, { id: `server-${count}`, bucket: 'a', label: 'done', state: 'complete', createdAt: new Date().toISOString() });
      return { start: afterStart, complete: diagnostics().snapshot().commits - afterStart };
    };

    expect(run(1)).toEqual(run(200));
  });

  it('B1 never persists a replaced row with its operation still pending', () => {
    const storage = createFaultStorage();
    configureDb({ storage: storage.plane, transport: createMockTransport() });
    const rows = defineRows('DetachedCompleteAtomic');
    const handle = declare(rows, 'complete-atomic', async () => 'continue');
    const entry = handle.start({ bucket: 'a', label: 'first' });
    writeManifest();

    const threw = attemptWithLastWriteFaulted(storage, 2, () =>
      handle.complete(entry.operationId, { id: 'server-1', bucket: 'a', label: 'done', state: 'complete', createdAt: new Date().toISOString() })
    );

    configureDb({ storage: storage.plane, transport: createMockTransport() });
    const restartedRows = defineRows('DetachedCompleteAtomic');
    declare(restartedRows, 'complete-atomic', async () => 'continue');
    replayJournal();

    const replaced = restartedRows.find('server-1') !== undefined;
    const stillPending = getOperationState().get(entry.operationId)?.status === 'pending';
    expect(replaced && stillPending).toBe(false);
    if (!threw) {
      expect(replaced).toBe(true);
      expect(stillPending).toBe(false);
    }
  });

  it('B2 never persists a rollback destroy with its operation still pending', () => {
    const storage = createFaultStorage();
    configureDb({ storage: storage.plane, transport: createMockTransport() });
    const rows = defineRows('DetachedRollbackAtomic');
    const declareRollback = (model: ReturnType<typeof defineRows>) =>
      model.detached<Input>('rollback-atomic', {
        build: input => ({ bucket: input.bucket, label: input.label, state: 'pending', createdAt: new Date().toISOString() }),
        resume: async () => 'continue',
        failure: 'rollback'
      });
    const handle = declareRollback(rows);
    const entry = handle.start({ bucket: 'a', label: 'first' });
    writeManifest();

    const threw = attemptWithLastWriteFaulted(storage, 2, () => handle.fail(entry.operationId, new Error('offline')));

    configureDb({ storage: storage.plane, transport: createMockTransport() });
    const restartedRows = defineRows('DetachedRollbackAtomic');
    declareRollback(restartedRows);
    replayJournal();

    const destroyed = restartedRows.find(entry.tempId) === undefined;
    const stillPending = getOperationState().get(entry.operationId)?.status === 'pending';
    expect(destroyed && stillPending).toBe(false);
    if (!threw) {
      expect(destroyed).toBe(true);
      expect(stillPending).toBe(false);
    }
  });

  it('B3 never persists a keep-failure patch with its operation still pending', () => {
    const storage = createFaultStorage();
    configureDb({ storage: storage.plane, transport: createMockTransport() });
    const rows = defineRows('DetachedFailKeepAtomic');
    const handle = declare(rows, 'fail-keep-atomic', async () => 'continue');
    const entry = handle.start({ bucket: 'a', label: 'first' });
    writeManifest();

    const threw = attemptWithLastWriteFaulted(storage, 2, () => handle.fail(entry.operationId, new Error('offline')));

    configureDb({ storage: storage.plane, transport: createMockTransport() });
    const restartedRows = defineRows('DetachedFailKeepAtomic');
    declare(restartedRows, 'fail-keep-atomic', async () => 'continue');
    replayJournal();

    const patched = restartedRows.find(entry.tempId)?.state === 'failed';
    const stillPending = getOperationState().get(entry.operationId)?.status === 'pending';
    expect(patched && stillPending).toBe(false);
    if (!threw) {
      expect(patched).toBe(true);
      expect(stillPending).toBe(false);
    }
  });

  it('B4 never persists a discard destroy with its operation still tracked as pending', () => {
    const storage = createFaultStorage();
    configureDb({ storage: storage.plane, transport: createMockTransport() });
    const rows = defineRows('DetachedDiscardAtomic');
    const handle = declare(rows, 'discard-atomic', async () => 'continue');
    const entry = handle.start({ bucket: 'a', label: 'first' });
    writeManifest();

    const threw = attemptWithLastWriteFaulted(storage, 2, () => handle.discard(entry.operationId));

    configureDb({ storage: storage.plane, transport: createMockTransport() });
    const restartedRows = defineRows('DetachedDiscardAtomic');
    declare(restartedRows, 'discard-atomic', async () => 'continue');
    replayJournal();

    const destroyed = restartedRows.find(entry.tempId) === undefined;
    const stillTracked = getOperationState().get(entry.operationId) !== undefined;
    expect(destroyed && stillTracked).toBe(false);
    if (!threw) {
      expect(destroyed).toBe(true);
      expect(stillTracked).toBe(false);
    }
  });
});
