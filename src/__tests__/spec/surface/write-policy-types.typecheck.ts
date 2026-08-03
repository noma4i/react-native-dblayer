import { defineModelRuntime, f } from '../../testApi';

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
