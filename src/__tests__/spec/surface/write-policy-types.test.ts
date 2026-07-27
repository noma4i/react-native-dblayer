import { defineModel, f } from '../../../index';

describe('write policy public types', () => {
  it('keeps consumer functions out of the closed write policy set', () => {
    expect(true).toBe(true);
  });
});

defineModel({
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

defineModel({
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
