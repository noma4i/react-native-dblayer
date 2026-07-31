import { bootDb, configureDb, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

type Row = { id: string; bucket: string; label: string };
type SaveData = { save: { row: Row } };
type Input = { key: string; label: string };

/**
 * Idempotency lives in the client ledger: a `once` operation that committed must never send a
 * second request for the same logical input, and that fact outlives the process. A plain dedupe key
 * is weaker on purpose - it only collapses concurrent sends, so a repeat after the commit is a new
 * operation. A failed attempt keeps neither: the user may send again.
 */
describe('once and dedupe idempotency', () => {
  let suffix = 0;
  const build = (options: { once: boolean; storage?: ReturnType<typeof createMemoryPlane>; fail?: boolean }) => {
    const storage = options.storage ?? createMemoryPlane();
    let calls = 0;
    configureDb({
      storage,
      transport: createMockTransport({
        mutation: async <TData,>() => {
          calls += 1;
          if (options.fail) throw new Error('transport refused');
          return { data: { save: { row: { id: `server-${calls}`, bucket: 'a', label: 'saved' } } } as TData };
        }
      })
    });
    const modelId = `SpecOnce${++suffix}`;
    const rows = defineModelRuntime({
      id: modelId,
      name: modelId,
      fields: { bucket: f.str(), label: f.str() },
      maintenance: { dropTempRowsAfterMs: 1000 }
    });
    const save = rows.mutation<SaveData, Input, never, Row>('save', {
      document,
      result: 'save',
      dedupe: { key: (input: Input) => input.key },
      ...(options.once ? { once: true as const } : {}),
      optimistic: {
        model: rows,
        respond: (input: Input, context: { tempId: string }) => ({ save: { row: { id: context.tempId, bucket: 'a', label: input.label } } }),
        selectServerNode: (data: SaveData) => data.save.row
      }
    });
    return { storage, rows, save, callCount: () => calls };
  };

  it('sends a committed once operation exactly once for the same key', async () => {
    const { save, callCount } = build({ once: true });

    await save.run({ key: 'gift-1', label: 'first' });
    expect(callCount()).toBe(1);

    await save.run({ key: 'gift-1', label: 'second attempt' });

    expect(callCount()).toBe(1);
  });

  it('sends a different key of the same once operation', async () => {
    const { save, callCount } = build({ once: true });

    await save.run({ key: 'gift-1', label: 'first' });
    await save.run({ key: 'gift-2', label: 'second' });

    expect(callCount()).toBe(2);
  });

  it('lets a plain dedupe key send again once the first send committed', async () => {
    const { save, callCount } = build({ once: false });

    await save.run({ key: 'draft-1', label: 'first' });
    await save.run({ key: 'draft-1', label: 'again' });

    // Dedupe collapses concurrent sends only: a committed operation no longer blocks the key.
    expect(callCount()).toBe(2);
  });

  it('collapses a concurrent repeat of the same key into one request', async () => {
    const pending: Array<() => void> = [];
    const storage = createMemoryPlane();
    let calls = 0;
    configureDb({
      storage,
      transport: createMockTransport({
        mutation: <TData,>() =>
          new Promise<{ data: TData }>(resolve => {
            calls += 1;
            pending.push(() => resolve({ data: { save: { row: { id: `server-${calls}`, bucket: 'a', label: 'saved' } } } as TData }));
          })
      })
    });
    const modelId = `SpecOnceConcurrent${++suffix}`;
    const rows = defineModelRuntime({ id: modelId, name: modelId, fields: { bucket: f.str(), label: f.str() }, maintenance: { dropTempRowsAfterMs: 1000 } });
    const save = rows.mutation<SaveData, Input, never, Row>('save', {
      document,
      result: 'save',
      dedupe: { key: (input: Input) => input.key },
      optimistic: {
        model: rows,
        respond: (input: Input, context: { tempId: string }) => ({ save: { row: { id: context.tempId, bucket: 'a', label: input.label } } }),
        selectServerNode: (data: SaveData) => data.save.row
      }
    });

    const first = save.run({ key: 'draft-1', label: 'first' });
    const second = await save.run({ key: 'draft-1', label: 'duplicate' });

    expect(second).toBeNull();
    expect(calls).toBe(1);
    pending[0]!();
    await first;
  });

  it('remembers a committed once key across a process restart', async () => {
    const storage = createMemoryPlane();
    const first = build({ once: true, storage });
    await first.save.run({ key: 'gift-1', label: 'first' });
    expect(first.callCount()).toBe(1);

    // New runtime generation over the same storage: the safety record is what survives, not the data.
    const second = build({ once: true, storage });
    await bootDb();
    await second.save.run({ key: 'gift-1', label: 'after restart' });

    expect(second.callCount()).toBe(0);
  });

  it('lets a failed once operation be sent again', async () => {
    const storage = createMemoryPlane();
    const failing = build({ once: true, storage, fail: true });
    await expect(failing.save.run({ key: 'gift-1', label: 'first' })).rejects.toThrow('transport refused');
    expect(failing.callCount()).toBe(1);

    const retry = build({ once: true, storage });
    await bootDb();
    await retry.save.run({ key: 'gift-1', label: 'retry' });

    // Only a COMMIT closes a once key; a failure leaves the user free to send again.
    expect(retry.callCount()).toBe(1);
  });
});
