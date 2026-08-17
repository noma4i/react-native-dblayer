import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { bootDb, configureDb, defineModel, defineShape, f, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

type Row = { id: string; label: string };
type SaveData = { save: { row: Row } };
type Input = { key: string; label: string };
type Variables = { input: Input };

const document: TypedDocumentNode<SaveData, Variables> = { kind: Kind.DOCUMENT, definitions: [] };
const RowSchema = defineShape<Row>()({ label: f.str() });

/**
 * The persisted once-keys are the restart-proof dedupe set of committed `once` mutations. A manifest
 * cold reset must carry them through, and a corrupt persisted source must surface both as a
 * data-loss event and as the observable consequence for the app: the same logical input either
 * stays deduped or becomes sendable again.
 */
describe('once keys across a manifest cold reset', () => {
  let suffix = 0;

  const rebootScenario = async (tamper: (disk: ReturnType<typeof createMemoryPlane>) => void) => {
    const storage = createMemoryPlane();
    let calls = 0;
    const configure = (plane: ReturnType<typeof createMemoryPlane>) =>
      configureDb({
        storage: plane,
        transport: createMockTransport({
          mutation: async <TData,>() => {
            calls += 1;
            return { data: { save: { row: { id: `server-${calls}`, label: 'saved' } } } as TData };
          }
        })
      });
    configure(storage);
    const rows = defineModel(`SpecOnceKeysReset${(suffix += 1)}`, {
      schema: RowSchema,
      maintenance: { dropTempRowsAfterMs: 1000 },
      actions: owner => ({
        save: owner.gql.action(document, {
          mode: 'request',
          result: 'save',
          variables: (input: Input) => ({ input }),
          dedupe: { key: (input: Input) => input.key },
          once: true,
          optimistic: { root: { insert: { select: ({ input, tempId }) => ({ id: tempId, label: input.label }) } } },
          root: { insert: { select: ({ data }) => data.save.row } }
        })
      })
    });
    await bootDb();
    await rows.actions.save.run({ key: 'gift-1', label: 'first' });
    // resetRuntime wipes the live plane, so the reboot runs over a copied disk image.
    const disk = createMemoryPlane();
    for (const key of storage.keys('')) disk.set(key, storage.get(key)!);
    // An unreadable manifest forces the next boot through the cold reset that carries once-keys.
    disk.set('dbl:manifest', '{corrupt-manifest');
    tamper(disk);
    resetRuntime();
    configure(disk);
    diagnostics().reset();
    await bootDb();
    await rows.actions.save.run({ key: 'gift-1', label: 'repeat' });
    return { calls: () => calls, lossEvents: () => diagnostics().snapshot().dataLossEvents };
  };

  it('carries intact once-keys through the cold reset and keeps the repeat run deduped', async () => {
    const scenario = await rebootScenario(() => {});

    expect(scenario.calls()).toBe(1);
    expect(scenario.lossEvents()).not.toContainEqual(expect.objectContaining({ mechanism: 'corrupt-once-keys' }));
  });

  it('keeps the repeat run deduped from the ledger when the standalone once-keys record is corrupt, counting the loss', async () => {
    const scenario = await rebootScenario(storage => storage.set('dbl:ops-once', '{corrupt-json'));

    expect(scenario.calls()).toBe(1);
    expect(scenario.lossEvents()).toContainEqual({ mechanism: 'corrupt-once-keys', model: '__operations__', count: 1 });
  });

  it('reports the loss and lets the repeat run send again when the persisted ledger is unreadable', async () => {
    const scenario = await rebootScenario(storage => storage.set('dbl:ops', '{corrupt-ledger'));

    expect(scenario.calls()).toBe(2);
    expect(scenario.lossEvents()).toContainEqual(expect.objectContaining({ mechanism: 'corrupt-once-keys', model: '__operations__' }));
  });
});
