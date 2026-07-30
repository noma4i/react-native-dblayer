import { act } from 'react';
import { createSingletonStatics, defineModelRuntime, f, pickPresent, resetRuntime } from '../../testApi';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

// Mirrors yupi_v2 src/db/models/UserCountersModel.ts: a single-record singleton built on
// createSingletonStatics with a pickPresent-style authoritative merge.

type CountersRow = { id: string; unreadChatsCount: number; unreadSecondaryChatsCount: number };

const RECORD_ID = 'counters';
const DEFAULTS: CountersRow = { id: RECORD_ID, unreadChatsCount: 0, unreadSecondaryChatsCount: 0 };
const mergeFields = ['unreadChatsCount', 'unreadSecondaryChatsCount'] as const;

const createCounters = (suffix: string) =>
  defineModelRuntime({
    id: `SpecConsumerCounters${suffix}`,
    name: `SpecConsumerCounters${suffix}`,
    fields: { id: f.str(), unreadChatsCount: f.num(), unreadSecondaryChatsCount: f.num() },
    statics: model => {
      const singleton = createSingletonStatics<CountersRow>(model, RECORD_ID, DEFAULTS);
      return {
        recordId: singleton.recordId,
        defaults: singleton.defaults,
        current: singleton.current,
        useCurrent: singleton.useCurrent,
        useCurrentField: singleton.useCurrentField,
        upsertCurrent: singleton.upsertCurrent,
        updateClamped: singleton.updateClamped,
        mergeCurrent: (updates: Partial<CountersRow>) => {
          singleton.upsertCurrent(pickPresent(updates, mergeFields));
        }
      };
    }
  });

describe('counters singleton consumer contracts', () => {
  it('merges only present fields and rerenders once per real change, zero on an idempotent merge', () => {
    setupSpecRuntime();
    const counters = createCounters('Merge');
    counters.upsertCurrent({ unreadChatsCount: 2, unreadSecondaryChatsCount: 5 });

    const reader = renderCounted(() => counters.useCurrent());
    const beforeRealChange = reader.renders();

    act(() => {
      counters.mergeCurrent({ unreadChatsCount: 9 });
    });

    expect(reader.renders() - beforeRealChange).toBe(1);
    expect(reader.result().unreadChatsCount).toBe(9);
    expect(reader.result().unreadSecondaryChatsCount).toBe(5);

    const beforeIdempotent = reader.renders();
    act(() => {
      counters.mergeCurrent({ unreadChatsCount: 9 });
    });

    expect(reader.renders() - beforeIdempotent).toBe(0);
    reader.unmount();
  });

  it('rerenders useCurrentField only for the selected field and falls back to defaults', () => {
    setupSpecRuntime();
    const counters = createCounters('Field');
    const emptyReader = renderCounted(() => counters.useCurrentField('unreadChatsCount'));
    expect(emptyReader.result()).toBe(0);
    emptyReader.unmount();
    counters.upsertCurrent({ unreadChatsCount: 2, unreadSecondaryChatsCount: 5 });

    const reader = renderCounted(() => counters.useCurrentField('unreadChatsCount'));
    const beforeOtherField = reader.renders();
    act(() => {
      counters.mergeCurrent({ unreadSecondaryChatsCount: 9 });
    });
    expect(reader.renders()).toBe(beforeOtherField);
    const beforeSelectedField = reader.renders();
    act(() => {
      counters.mergeCurrent({ unreadChatsCount: 7 });
    });

    expect(reader.renders() - beforeSelectedField).toBe(1);
    expect(reader.result()).toBe(7);
    reader.unmount();
  });

  it('reads empty after resetRuntime and re-hydrates cleanly on the same handle', () => {
    setupSpecRuntime();
    const counters = createCounters('Reset');
    counters.upsertCurrent({ unreadChatsCount: 4, unreadSecondaryChatsCount: 1 });
    expect(counters.current()?.unreadChatsCount).toBe(4);

    resetRuntime();

    expect(counters.current()).toBeUndefined();
    const reader = renderCounted(() => counters.useCurrent());
    expect(reader.result()).toEqual(DEFAULTS);

    act(() => {
      counters.upsertCurrent({ unreadChatsCount: 7, unreadSecondaryChatsCount: 2 });
    });

    expect(reader.result().unreadChatsCount).toBe(7);
    expect(reader.result().unreadSecondaryChatsCount).toBe(2);
    reader.unmount();
  });

  it('applies bounded numeric deltas only to an existing singleton row', () => {
    setupSpecRuntime();
    const counters = createCounters('Clamped');

    expect(counters.updateClamped('unreadChatsCount', 1)).toBe(false);
    counters.upsertCurrent({ id: 'ignored', unreadChatsCount: 2 });
    expect(counters.current()?.id).toBe(RECORD_ID);
    expect(counters.updateClamped('unreadChatsCount', 0)).toBe(false);
    expect(counters.updateClamped('unreadChatsCount', -5, 1)).toBe(true);
    expect(counters.current()?.unreadChatsCount).toBe(1);
    expect(counters.updateClamped('unreadChatsCount', 4)).toBe(true);
    expect(counters.current()?.unreadChatsCount).toBe(5);
  });

  it('treats a malformed stored numeric value as zero before clamping', () => {
    let row = { id: RECORD_ID, unreadChatsCount: 'bad', unreadSecondaryChatsCount: 0 } as unknown as CountersRow;
    const update = jest.fn((_id: string, patch: Partial<CountersRow>) => {
      row = { ...row, ...patch };
    });
    const singleton = createSingletonStatics<CountersRow>(
      {
        find: () => row,
        use: { find: () => row, field: (_id, field) => row[field] },
        insert: next => {
          row = next;
        },
        update
      },
      RECORD_ID,
      DEFAULTS
    );

    expect(singleton.updateClamped('unreadChatsCount', 2)).toBe(true);
    expect(update).toHaveBeenCalledWith(RECORD_ID, { unreadChatsCount: 2 });
  });
});
