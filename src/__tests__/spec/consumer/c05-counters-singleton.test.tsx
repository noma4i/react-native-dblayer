import { act } from 'react-test-renderer';
import { createSingletonStatics, defineModel, f, pickPresent, resetRuntime } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

// Mirrors yupi_v2 src/db/models/UserCountersModel.ts: a single-record singleton built on
// createSingletonStatics, with a pickPresent-style merge and a clamped decrement.

type CountersRow = { id: string; unreadChatsCount: number; unreadSecondaryChatsCount: number };

const RECORD_ID = 'counters';
const DEFAULTS: CountersRow = { id: RECORD_ID, unreadChatsCount: 0, unreadSecondaryChatsCount: 0 };
const mergeFields = ['unreadChatsCount', 'unreadSecondaryChatsCount'] as const;

const createCounters = (suffix: string) =>
  defineModel({
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
        upsertCurrent: singleton.upsertCurrent,
        mergeCurrent: (updates: Partial<CountersRow>) => {
          singleton.upsertCurrent(pickPresent(updates, mergeFields));
        },
        decrementUnreadSecondaryChats: (count: number): void => {
          if (count <= 0) return;
          singleton.patchClamped('unreadSecondaryChatsCount', -count);
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

  it('clamps decrementUnreadSecondaryChats at zero when the delta overshoots', () => {
    setupSpecRuntime();
    const counters = createCounters('Clamp');
    counters.upsertCurrent({ unreadSecondaryChatsCount: 3 });

    counters.decrementUnreadSecondaryChats(10);

    expect(counters.current()?.unreadSecondaryChatsCount).toBe(0);
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
});
