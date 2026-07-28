import { act } from 'react';
import { configureDb, defineModel, f } from '../../../index';
import { collectGarbage } from '../../../core/gc';
import { clearFailedOptimisticMutation } from '../../../dsl/mutationRuntime';
import { runPendingTempRowMaintenance } from '../../../dsl/maintenanceRegistry';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

type Row = { id: string; body: string };

/**
 * A failed-but-retryable optimistic insert is UNRESOLVED work: its temp row stays protected from
 * both the TTL sweep and GC for as long as the ledger operation stays open. Discarding the
 * operation is the one move that releases the row to normal maintenance.
 */
describe('durable temp row protection', () => {
  const buildFailedInsert = async (tag: string) => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async () => {
          throw new Error('send rejected');
        }
      })
    });
    const rows = defineModel({
      id: `SpecDurableTemp${tag}`,
      name: `SpecDurableTemp${tag}`,
      fields: { body: f.str() },
      maintenance: { dropTempRowsAfterMs: 0 }
    });
    const send = rows.mutation<{ send: { row: Row } }, { body: string }, Row, Row>('send', {
      document: { kind: 'Document', definitions: [] } as never,
      result: 'send',
      optimistic: {
        model: rows,
        tempIdPrefix: 'tmp',
        build: (input, { tempId }) => ({ id: tempId!, body: input.body }),
        selectServerNode: data => data.send.row
      }
    });
    let tempId = '';
    await act(async () => {
      await send.run({ body: 'not sent yet' }).catch(() => {});
    });
    tempId = rows.where({})[0]!.id;
    expect(tempId.startsWith('temp-')).toBe(true);
    return { rows, tempId };
  };

  it('keeps a failed retryable temp row across the TTL sweep', async () => {
    const { rows, tempId } = await buildFailedInsert('Ttl');
    diagnostics().reset();

    runPendingTempRowMaintenance();

    expect(rows.find(tempId)).toMatchObject({ body: 'not sent yet' });
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });

  it('keeps a failed retryable temp row across a GC sweep', async () => {
    const { rows, tempId } = await buildFailedInsert('Gc');

    collectGarbage();

    expect(rows.find(tempId)).toMatchObject({ body: 'not sent yet' });
  });

  it('releases the row to the TTL sweep once the operation is discarded', async () => {
    const { rows, tempId } = await buildFailedInsert('Discard');

    clearFailedOptimisticMutation(rows.modelId, tempId);
    runPendingTempRowMaintenance();

    expect(rows.find(tempId)).toBeUndefined();
  });
});
