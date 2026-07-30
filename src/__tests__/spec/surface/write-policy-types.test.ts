import { defineModelRuntime, f } from '../../testApi';

describe('write policy public types', () => {
  it('keeps consumer functions out of the closed write policy set', () => {
    expect(true).toBe(true);
  });
});

defineModelRuntime({
  id: 'ClosedWritePolicyMerge',
  name: 'ClosedWritePolicyMerge',
  fields: { body: f.str() },
  write: {
    groups: [
      {
        fields: ['body'] as const,
        // @ts-expect-error Write policies cannot accept consumer merge functions.
        policy: { merge: () => 'body' }
      }
    ]
  }
});

defineModelRuntime({
  id: 'ClosedWritePolicyAccept',
  name: 'ClosedWritePolicyAccept',
  fields: { body: f.str() },
  write: {
    groups: [
      {
        fields: ['body'] as const,
        // @ts-expect-error Write policies cannot accept consumer predicates.
        policy: { accept: () => true }
      }
    ]
  }
});
