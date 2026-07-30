import { configureDb, defineModelRuntime, f } from '../../testApi';
import { getOperationState, replayJournal } from '../../../dsl/configure';
import { attemptAsyncWithLastWriteFaulted, attemptWithLastWriteFaulted, createFaultStorage, failAfterSettledBatches, snapshotAfterBatches } from '../helpers/faultStorage';
import { createMockTransport } from '../helpers/harness';

// Same defect class as i-detached-operations.test.tsx (B1-B4): a ledger transition and the row
// mutation it describes must land in ONE persisted write. defineMutation.ts had four independent
// two-step gaps (commit-close, rollback-close, patch-begin-before-write, destroy-begin-after-write).
//
// Row content itself is checkpoint-deferred (no `dbl:row:*` key exists until an explicit/scheduled
// flush), so "was the row durably changed" is checked against the WAL (`dbl:journal:*`, which embeds
// the full row) via `journalHasOp`/`snapshotJournalHasOp`, never the model API or `replayJournal()` -
// the latter also runs the orphan-reconciliation sweep (kind === undefined mutation-tracked pending
// operations get auto-rolled-back on replay) that would mask the exact contradiction under test.

const document = { kind: 'Document', definitions: [] } as never;

type Row = { id: string; bucket: string; label: string };
type Input = { bucket: string; label: string };

const defineRows = (id: string) =>
  defineModelRuntime({
    id,
    name: id,
    fields: { bucket: f.str(), label: f.str() },
    scopes: { byBucket: ({ by: { bucket: 'bucket' } }) },
    maintenance: { dropTempRowsAfterMs: 60_000 }
  });

type JournalOpLike = { kind: string; model: string; rows?: Array<{ id: string; label?: string }>; ids?: string[] };

/**
 * Row-level persistence is checkpoint-deferred (no `dbl:row:*` key exists until an explicit/scheduled
 * flush) - the durable, replay-would-apply-this source of truth right after a commit is the WAL itself.
 * Scans every `dbl:journal:*` record for an op matching `predicate`, independent of `replayJournal()`
 * (which would also run the orphan-reconciliation sweep this file avoids - see file header).
 */
const journalHasOp = (storage: ReturnType<typeof createFaultStorage>, predicate: (op: JournalOpLike) => boolean): boolean =>
  storage.plane.keys('dbl:journal:').some(key => {
    const raw = storage.plane.get(key);
    if (!raw) return false;
    const record = JSON.parse(raw) as { payload: { ops: Array<{ payload: JournalOpLike }> } };
    return record.payload.ops.map(op => op.payload).some(predicate);
  });

/** Same scan as `journalHasOp`, over a captured `snapshotAfterBatches` reading instead of live storage. */
const snapshotJournalHasOp = (captured: Record<string, string | null>, predicate: (op: JournalOpLike) => boolean): boolean =>
  Object.entries(captured).some(([key, raw]) => {
    if (!key.startsWith('dbl:journal:') || !raw) return false;
    const record = JSON.parse(raw) as { payload: { ops: Array<{ payload: JournalOpLike }> } };
    return record.payload.ops.map(op => op.payload).some(predicate);
  });

describe('mutation ledger/row persist atomicity', () => {
  it('M1 never persists a committed row replace with its operation still pending', async () => {
    const storage = createFaultStorage();
    const transport = createMockTransport({
      mutation: async <TData,>() => ({ data: { send: { message: { id: 'server-1', bucket: 'a', label: 'done' } } } as TData })
    });
    configureDb({ storage: storage.plane, transport });
    const rows = defineRows('MutationCommitAtomic');
    const send = rows.mutation<{ send: { message: Row } }, Input, Row, Row>('send', {
      document,
      result: 'send',
      optimistic: {
        model: rows,
        build: (input, { tempId }) => ({ id: tempId!, bucket: input.bucket, label: input.label }),
        selectServerNode: data => data.send.message
      }
    });

    const runPromise = send.run({ bucket: 'a', label: 'first' });
    const operationId = getOperationState().pending()[0]!.operationId;
    const threw = await attemptAsyncWithLastWriteFaulted(storage, 2, () => runPromise);

    const replaced = journalHasOp(storage, op => op.kind === 'upsert' && op.model === 'MutationCommitAtomic' && (op.rows ?? []).some(row => row.id === 'server-1'));
    configureDb({ storage: storage.plane, transport });
    const stillPending = getOperationState().get(operationId)?.status === 'pending';
    expect(replaced && stillPending).toBe(false);
    if (!threw) {
      expect(replaced).toBe(true);
      expect(stillPending).toBe(false);
    }
  });

  it('M2 never persists a rollback destroy with its operation still pending', async () => {
    const storage = createFaultStorage();
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    configureDb({ storage: storage.plane, transport });
    const rows = defineRows('MutationRollbackAtomic');
    const send = rows.mutation<{ send: { message: Row } }, Input, Row, Row>('send', {
      document,
      result: 'send',
      optimistic: {
        model: rows,
        build: (input, { tempId }) => ({ id: tempId!, bucket: input.bucket, label: input.label }),
        selectServerNode: data => data.send.message,
        failure: 'rollback'
      }
    });

    const runPromise = send.run({ bucket: 'a', label: 'first' });
    const operationId = getOperationState().pending()[0]!.operationId;
    const tempId = getOperationState().get(operationId)!.tempIds[0]!;
    // The mutation itself always rejects ('offline'), fault or not - `threw` here means the fault
    // ITSELF fired (overriding that rejection from inside the catch block's own rollback), not merely
    // that the promise rejected.
    failAfterSettledBatches(storage, 2);
    let threw = false;
    try {
      await runPromise;
    } catch (error) {
      threw = (error as Error).message === 'fault: set failed';
      if (!threw) expect((error as Error).message).toBe('offline');
    }
    storage.failNextSet(0);

    const destroyed = journalHasOp(storage, op => op.kind === 'destroy' && op.model === 'MutationRollbackAtomic' && (op.ids ?? []).includes(tempId));
    configureDb({ storage: storage.plane, transport });
    const stillPending = getOperationState().get(operationId)?.status === 'pending';
    expect(destroyed && stillPending).toBe(false);
    if (!threw) {
      expect(destroyed).toBe(true);
      expect(stillPending).toBe(false);
    }
  });

  // M3/M4 exercise the OPEN-side mirror gap: `runWithTempId` wraps its whole optimistic-write phase
  // in one try/catch, so a thrown storage fault is intercepted by that SAME catch's own rollback
  // logic instead of leaving the "killed here" contradiction to inspect (verified empirically: a
  // throw-based fault here gets self-healed by the catch before the promise ever settles). A
  // snapshot right after the first of the two writes - never throwing, never entering the catch -
  // captures the true "process died here" durable state instead.

  it('M3 never persists a ledger-begun patch while the row it describes was never actually rewritten', async () => {
    const storage = createFaultStorage();
    const transport = createMockTransport({ mutation: () => new Promise(() => {}) });
    configureDb({ storage: storage.plane, transport });
    const rows = defineRows('MutationPatchBeginAtomic');
    rows.insert({ id: 'row-1', bucket: 'a', label: 'before' });
    const patch = rows.mutation<{ send: unknown }, { id: string }, Row, never>('patch', {
      document,
      result: 'send',
      optimistic: {
        method: 'patch',
        model: rows,
        selectId: input => input.id,
        selectPatch: () => ({ label: 'after' })
      }
    });

    const snapshot = snapshotAfterBatches(storage, 1);
    void patch.run({ id: 'row-1' });
    const captured = snapshot();

    const ledgerRaw = captured['dbl:ops'];
    const ledgerOps = ledgerRaw
      ? (Object.values((JSON.parse(ledgerRaw) as { payload: Record<string, { status: string; intent: string; rowIds?: string[] }> }).payload) as Array<{
          status: string;
          intent: string;
          rowIds?: string[];
        }>)
      : [];
    const beginBegun = ledgerOps.some(op => op.status === 'pending' && op.intent === 'patch' && op.rowIds?.includes('row-1'));
    const patched = snapshotJournalHasOp(
      captured,
      op => op.kind === 'upsert' && op.model === 'MutationPatchBeginAtomic' && (op.rows ?? []).some(row => row.id === 'row-1' && row.label === 'after')
    );
    // Never: the ledger durably shows this patch begun (pending) while the row it describes was
    // never actually rewritten to match at the same instant.
    expect(beginBegun && !patched).toBe(false);
  });

  it('M4 never persists a destroyed row while its operation was never begun in the ledger at all', async () => {
    const storage = createFaultStorage();
    const transport = createMockTransport({ mutation: () => new Promise(() => {}) });
    configureDb({ storage: storage.plane, transport });
    const rows = defineRows('MutationDestroyBeginAtomic');
    rows.insert({ id: 'row-1', bucket: 'a', label: 'first' });
    const destroy = rows.mutation<{ send: unknown }, { id: string }, Row, never>('destroy', {
      document,
      result: 'send',
      optimistic: {
        method: 'destroy',
        model: rows,
        selectId: input => input.id
      }
    });

    const snapshot = snapshotAfterBatches(storage, 2);
    void destroy.run({ id: 'row-1' });
    const captured = snapshot();

    const destroyed = snapshotJournalHasOp(captured, op => op.kind === 'destroy' && op.model === 'MutationDestroyBeginAtomic' && (op.ids ?? []).includes('row-1'));
    const ledgerRaw = captured['dbl:ops'];
    const ledgerOps = ledgerRaw
      ? (Object.values((JSON.parse(ledgerRaw) as { payload: Record<string, { status: string; intent: string; rowIds?: string[] }> }).payload) as Array<{
          status: string;
          intent: string;
          rowIds?: string[];
        }>)
      : [];
    const trackedAtAll = ledgerOps.some(op => op.intent === 'destroy' && op.rowIds?.includes('row-1'));
    // Never: the row is already durably gone but there is no operation ledger record at all for it.
    expect(destroyed && !trackedAtAll).toBe(false);
  });

  it('M5 never leaves a boot-orphan destroyed with its operation still pending after replayJournal', () => {
    const storage = createFaultStorage();
    const transport = createMockTransport({ mutation: () => new Promise(() => {}) });
    configureDb({ storage: storage.plane, transport });
    const rows = defineRows('MutationOrphanReconcileAtomic');
    const send = rows.mutation<{ send: unknown }, Input, Row, Row>('send', {
      document,
      result: 'send',
      optimistic: {
        model: rows,
        build: (input, { tempId }) => ({ id: tempId!, bucket: input.bucket, label: input.label }),
        selectServerNode: () => null
      }
    });

    void send.run({ bucket: 'a', label: 'first' });
    const operationId = getOperationState().pending()[0]!.operationId;
    const tempId = getOperationState().get(operationId)!.tempIds[0]!;

    // Simulate a kill and restart: fresh runtime over the same storage, so the still-pending,
    // kind === undefined operation above hydrates as a boot orphan for replayJournal to reconcile.
    configureDb({ storage: storage.plane, transport });
    const threw = attemptWithLastWriteFaulted(storage, 2, () => {
      replayJournal();
    });

    const destroyed = journalHasOp(storage, op => op.kind === 'destroy' && op.model === 'MutationOrphanReconcileAtomic' && (op.ids ?? []).includes(tempId));
    configureDb({ storage: storage.plane, transport });
    const stillPending = getOperationState().get(operationId)?.status === 'pending';
    expect(destroyed && stillPending).toBe(false);
    if (!threw) {
      expect(destroyed).toBe(true);
      expect(stillPending).toBe(false);
    }
  });
});
