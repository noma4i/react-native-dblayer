import {
  compileWritePolicies,
  createCommitBus,
  createUpsertResolver,
  diffTopLevelFields,
  isSerializedNoop,
  retryDelayMs
} from '../../legacyTestApi';

describe('core edge helpers', () => {
  it('diffs deleted fields and rejects a serialized value change', () => {
    expect(diffTopLevelFields({ id: 'row-1', removed: true }, { id: 'row-1' })).toEqual(['removed']);
    expect(isSerializedNoop({ id: 'row-1', value: { count: 1 } }, { id: 'row-1', value: { count: 2 } }, ['value'])).toBe(false);
  });

  it('coerces ids, preserves row identity, and overlays only owned fields that exist', () => {
    const resolver = createUpsertResolver({
      applyWriteGate: (_previous, incoming) => incoming,
      ownedFields: () => new Set(['missing', 'owned'])
    });
    const numeric = resolver.previewUpsert({ id: 7 as never, owned: 'incoming' }, { previous: undefined });
    expect(numeric.row).toEqual({ id: '7', owned: 'incoming' });

    const same = { id: 'same', owned: 'value' };
    expect(resolver.previewUpsert(same, { previous: same })).toEqual({ row: same, changedFields: [] });

    const overlaid = resolver.previewUpsert(
      { id: 'row-1', owned: 'incoming' },
      { previous: { id: 'row-1', owned: 'current' } }
    );
    expect(overlaid.row).toEqual({ id: 'row-1', owned: 'current' });

    const noMatchingOwnedField = resolver.previewUpsert(
      { id: 'row-2', label: 'incoming' },
      { previous: { id: 'row-2', label: 'current' } }
    );
    expect(noMatchingOwnedField.row).toEqual({ id: 'row-2', label: 'incoming' });
  });

  it('covers server, nested-path, null tuple, and codepoint tuple policies', () => {
    const server = compileWritePolicies([{ fields: ['label'], policy: 'server' }], 'PolicyServer');
    expect(server({ id: 'row-1', label: 'old' }, { id: 'row-1', label: 'new' }, { origin: 'snapshot' })).toMatchObject({ label: 'new' });

    const nested = compileWritePolicies([{ fields: ['meta'], policy: { monotonic: { present: 'meta.value' } } }], 'PolicyNested');
    expect(nested({ id: 'row-1', meta: { value: 1 } }, { id: 'row-1', meta: [] }, { origin: 'snapshot' })).toMatchObject({
      meta: { value: 1 }
    });

    const tuple = compileWritePolicies(
      [{ fields: ['sequence'], policy: { monotonic: { tuple: ['sequence'] } } }],
      'PolicyTuple'
    );
    expect(tuple({ id: 'row-1', sequence: null }, { id: 'row-1', sequence: 1 }, { origin: 'snapshot' })).toMatchObject({ sequence: 1 });
    expect(tuple({ id: 'row-1', sequence: 'a' }, { id: 'row-1', sequence: 'b' }, { origin: 'snapshot' })).toMatchObject({ sequence: 'b' });
    expect(tuple({ id: 'row-1', sequence: null }, { id: 'row-1', sequence: null }, { origin: 'snapshot' })).toMatchObject({ sequence: null });

    const nestedContinuity = compileWritePolicies(
      [{ fields: ['meta'], policy: { keys: { value: 'continuity' } } }],
      'PolicyNestedContinuity'
    );
    expect(
      nestedContinuity(
        { id: 'row-1', meta: { value: 'old' } },
        { id: 'row-1', meta: { value: 'new' } },
        { origin: 'snapshot' }
      )
    ).toMatchObject({ meta: { value: 'new' } });
  });

  it('uses default retry delays and exercises idempotent commit-bus teardown', () => {
    const policy = { classify: () => 'network' as const, budgets: { network: 1 } };
    expect(retryDelayMs(policy, new Error('offline'), 0)).toBe(1000);

    const bus = createCommitBus();
    const subscription = bus.subscribe(() => undefined, [{ kind: 'row', model: 'CoreEdgeRows', id: 'row-1' }]);
    expect(bus.subscriberCount()).toBe(1);
    subscription.unsubscribe();
    subscription.unsubscribe();
    expect(bus.subscriberCount()).toBe(0);
  });
});
