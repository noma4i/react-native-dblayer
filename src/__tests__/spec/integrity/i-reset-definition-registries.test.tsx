import { act } from 'react';
import { configureDb, createDbSubscriptionEffects, defineFetch, resetRuntime } from '../../legacyTestApi';
import { registerBootValidation, runBootValidations } from '../../../dsl/bootValidations';
import { getDbSubscriptionEffect } from '../../../core/subscriptionRuntime';
import { setFetchNetworkOnline } from '../../../core/fetch/networkState';
import { invalidateModel, registerModelInvalidation } from '../../../core/invalidationRegistry';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

/**
 * Definitions (fetch/query handles, subscription-effect channels, boot validations) are created
 * once at app-module load and OUTLIVE `resetRuntime`. Definition registries therefore survive the
 * kill-switch, while per-definition MUTABLE state (offline pause) belongs to one runtime
 * generation and must not leak into the next.
 */
describe('reset and definition registries', () => {
  it('starts the next generation unpaused after an offline pause and a reset', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    setFetchNetworkOnline(false);
    const offline = defineFetch<{ ok: boolean }>({
      key: 'reset-pause-probe',
      fetcher: async () => {
        throw new Error('offline');
      },
      select: data => data,
      /** No mount refetch: the paused flag is the only thing a reader would see. */
      enabled: () => false
    });
    await offline.fetch();
    const paused = renderCounted(() => offline.use(undefined));
    expect(paused.result().loadingState.isOffline).toBe(true);
    paused.unmount();

    setFetchNetworkOnline(true);
    act(() => {
      resetRuntime();
    });
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });

    const reader = renderCounted(() => offline.use(undefined));
    expect(reader.result().loadingState.isOffline).toBe(false);
    reader.unmount();
  });

  it('keeps subscription effects resolvable across a reset', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const channel = createDbSubscriptionEffects({ resetProbePing: (payload: string) => void payload });
    channel.configure({ resetProbePing: () => {} });

    act(() => {
      resetRuntime();
    });

    expect(typeof getDbSubscriptionEffect('resetProbePing')).toBe('function');
  });

  it('replaces the invalidation callback when the same definition registers again', () => {
    const calls: string[] = [];
    registerModelInvalidation('SpecResetInvalidation', 'probe-query', () => void calls.push('first'));
    registerModelInvalidation('SpecResetInvalidation', 'probe-query', () => void calls.push('second'));

    invalidateModel('SpecResetInvalidation');

    expect(calls).toEqual(['second']);
  });

  it('runs boot validations declared before a reset on the next boot', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    let ran = 0;
    registerBootValidation('reset-probe', () => {
      ran += 1;
    });

    act(() => {
      resetRuntime();
    });
    runBootValidations();

    expect(ran).toBe(1);
  });
});
