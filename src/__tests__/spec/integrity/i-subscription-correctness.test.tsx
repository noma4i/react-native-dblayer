import { configureDb, createDbSubscriptionEffects, createDbSubscriptionRuntime, resetRuntime } from '../../../index';
import { setFetchNetworkOnline } from '../../../core/fetch/networkState';
import * as networkState from '../../../core/fetch/networkState';
import { getDbSubscriptionEffect } from '../../../core/subscriptionRuntime';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

describe('subscription runtime correctness', () => {
  it('retries after a synchronous transport error and accepts data from the replacement subscription', () => {
    jest.useFakeTimers();
    try {
      let attempts = 0;
      let secondHandlers!: { next: (data: unknown) => void; error: (error: unknown) => void };
      const firstUnsubscribe = jest.fn();
      const transport = createMockTransport({
        subscribe: (_options, handlers) => {
          attempts += 1;
          if (attempts === 1) {
            handlers.error(new Error('synchronous subscription error'));
            return firstUnsubscribe;
          }
          secondHandlers = handlers;
          return jest.fn();
        }
      });
      configureDb({ storage: createMemoryPlane(), transport });
      const received: string[] = [];
      const runtime = createDbSubscriptionRuntime([{ key: 'event', query: document, onData: payload => received.push((payload as { id: string }).id) }]);

      runtime.setActive(true);
      jest.advanceTimersByTime(1000);
      secondHandlers.next({ event: { id: 'event-2' } });

      expect(attempts).toBe(2);
      expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
      expect(received).toEqual(['event-2']);
      runtime.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('holds subscription retries while offline and resubscribes once on reconnect', () => {
    jest.useFakeTimers();
    try {
      let attempts = 0;
      const transport = createMockTransport({
        subscribe: (_options, handlers) => {
          attempts += 1;
          if (attempts === 1) {
            handlers.error(new Error('connection dropped'));
            return jest.fn();
          }
          return jest.fn();
        }
      });
      configureDb({ storage: createMemoryPlane(), transport });
      setFetchNetworkOnline(false);
      const runtime = createDbSubscriptionRuntime([{ key: 'event', query: document, onData: () => {} }]);

      runtime.setActive(true);
      jest.advanceTimersByTime(120000);
      expect(attempts).toBe(1);

      setFetchNetworkOnline(true);
      jest.advanceTimersByTime(0);

      expect(attempts).toBe(2);
      runtime.stop();
    } finally {
      setFetchNetworkOnline(true);
      jest.useRealTimers();
    }
  });

  it('releases an offline retry listener during runtime reset', () => {
    const release = jest.fn();
    const subscribeNetwork = jest.spyOn(networkState, 'subscribeFetchNetwork').mockReturnValue(release);
    try {
      let handlers!: { next: (data: unknown) => void; error: (error: unknown) => void };
      const transport = createMockTransport({
        subscribe: (_options, nextHandlers) => {
          handlers = nextHandlers;
          return jest.fn();
        }
      });
      configureDb({ storage: createMemoryPlane(), transport });
      setFetchNetworkOnline(false);
      const runtime = createDbSubscriptionRuntime([{ key: 'event', query: document, onData: () => {} }]);
      runtime.setActive(true);
      handlers.error(new Error('connection dropped'));

      resetRuntime();

      expect(subscribeNetwork).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      runtime.stop();
    } finally {
      subscribeNetwork.mockRestore();
      setFetchNetworkOnline(true);
    }
  });

  it('debounces each bucket on its own trailing window and delivers only the latest payload', () => {
    jest.useFakeTimers();
    try {
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const received: string[] = [];
      const runtime = createDbSubscriptionRuntime([
        {
          key: 'event',
          query: document,
          debounce: { ms: 50, keyOf: payload => (payload as { bucket: string }).bucket },
          onData: payload => received.push((payload as { bucket: string; value: string }).value)
        }
      ]);

      runtime.dispatch('event', { bucket: 'first', value: 'first-v1' });
      runtime.dispatch('event', { bucket: 'second', value: 'second-v1' });
      jest.advanceTimersByTime(49);
      runtime.dispatch('event', { bucket: 'first', value: 'first-v2' });
      jest.advanceTimersByTime(1);
      expect(received).toEqual(['second-v1']);
      jest.advanceTimersByTime(48);
      expect(received).toEqual(['second-v1']);
      jest.advanceTimersByTime(1);
      expect(received).toEqual(['second-v1', 'first-v2']);
      runtime.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('merges partial payloads inside one debounce bucket without losing fields', () => {
    jest.useFakeTimers();
    try {
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const received: Array<Record<string, number>> = [];
      const runtime = createDbSubscriptionRuntime([
        {
          key: 'userCounters',
          query: document,
          debounce: {
            ms: 50,
            merge: (previous: Record<string, number>, incoming: Record<string, number>) => ({ ...previous, ...incoming })
          },
          onData: payload => received.push(payload as Record<string, number>)
        }
      ]);

      runtime.dispatch('userCounters', { unreadChatsCount: 2 });
      runtime.dispatch('userCounters', { secondaryChatsCount: 4 });
      runtime.dispatch('userCounters', { unreadChatsCount: 0 });
      jest.advanceTimersByTime(50);

      expect(received).toEqual([{ unreadChatsCount: 0, secondaryChatsCount: 4 }]);
      runtime.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs entry reconciliation after every successful subscribe attempt', () => {
    jest.useFakeTimers();
    try {
      let handlers!: { next: (data: unknown) => void; error: (error: unknown) => void };
      const transport = createMockTransport({
        subscribe: (_options, nextHandlers) => {
          handlers = nextHandlers;
          return jest.fn();
        }
      });
      configureDb({ storage: createMemoryPlane(), transport });
      const reconcile = jest.fn();
      const runtime = createDbSubscriptionRuntime([
        {
          key: 'userCounters',
          query: document,
          onSubscribe: reconcile,
          onData: () => {}
        }
      ]);

      runtime.setActive(true);
      expect(reconcile).toHaveBeenCalledTimes(1);
      handlers.error(new Error('connection dropped'));
      jest.advanceTimersByTime(1000);

      expect(reconcile).toHaveBeenCalledTimes(2);
      runtime.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rolls back earlier subscriptions when a later entry throws during activation', () => {
    let attempts = 0;
    let shouldThrow = true;
    const firstUnsubscribe = jest.fn();
    const transport = createMockTransport({
      subscribe: () => {
        attempts += 1;
        if (attempts === 2 && shouldThrow) throw new Error('second entry failed');
        return attempts === 1 ? firstUnsubscribe : jest.fn();
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const runtime = createDbSubscriptionRuntime([
      { key: 'first', query: document, onData: () => {} },
      { key: 'second', query: document, onData: () => {} }
    ]);

    expect(() => runtime.setActive(true)).toThrow('second entry failed');
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    expect(runtime.isActive()).toBe(false);
    expect(runtime.inspect().every(entry => !entry.active)).toBe(true);

    shouldThrow = false;
    runtime.setActive(true);
    expect(runtime.isActive()).toBe(true);
    expect(runtime.inspect().every(entry => entry.active)).toBe(true);
    runtime.stop();
  });

  it('does not count a delivery whose onData handler throws', () => {
    const transport = createMockTransport({ subscribe: () => jest.fn() });
    configureDb({ storage: createMemoryPlane(), transport });
    let calls = 0;
    const runtime = createDbSubscriptionRuntime([
      {
        key: 'event',
        query: document,
        onData: () => {
          calls += 1;
          throw new Error('onData exploded');
        }
      }
    ]);
    runtime.setActive(true);

    expect(() => runtime.dispatch('event', { id: 'row-1' })).toThrow('onData exploded');
    expect(calls).toBe(1);
    expect(runtime.inspect().find(entry => entry.key === 'event')?.eventCount).toBe(0);

    runtime.stop();
  });

  it('contains a throwing debounced onData delivery and reports it through onSyncError', () => {
    jest.useFakeTimers();
    try {
      const errors: string[] = [];
      configureDb({
        storage: createMemoryPlane(),
        transport: createMockTransport({ subscribe: () => jest.fn() }),
        defaults: {
          onSyncError: error => {
            errors.push(error.message);
          }
        }
      });
      const runtime = createDbSubscriptionRuntime([
        {
          key: 'event',
          query: document,
          debounce: { ms: 50 },
          onData: () => {
            throw new Error('debounced exploded');
          }
        }
      ]);
      runtime.setActive(true);
      runtime.dispatch('event', { id: 'row-1' });

      expect(() => jest.advanceTimersByTime(50)).not.toThrow();
      expect(errors).toEqual(['debounced exploded']);
      expect(runtime.inspect().find(entry => entry.key === 'event')?.errorCount).toBe(1);
      expect(runtime.inspect().find(entry => entry.key === 'event')?.eventCount).toBe(0);
      runtime.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recaptures its generation and keeps delivering after a runtime re-configuration', () => {
    const transport = createMockTransport({ subscribe: () => jest.fn() });
    configureDb({ storage: createMemoryPlane(), transport });
    const received: string[] = [];
    const runtime = createDbSubscriptionRuntime([{ key: 'event', query: document, onData: payload => received.push((payload as { id: string }).id) }]);
    runtime.setActive(true);
    runtime.dispatch('event', { id: 'first' });
    expect(received).toEqual(['first']);

    const transport2 = createMockTransport({ subscribe: () => jest.fn() });
    configureDb({ storage: createMemoryPlane(), transport: transport2 });
    runtime.setActive(true);
    runtime.dispatch('event', { id: 'second' });

    expect(received).toEqual(['first', 'second']);
    runtime.stop();
  });
});

describe('subscription effects registry', () => {
  it('keeps effect names from distinct channels and rejects a live duplicate', () => {
    const first = createDbSubscriptionEffects({ firstEffect: () => {} });
    const second = createDbSubscriptionEffects({ secondEffect: () => {} });

    expect(getDbSubscriptionEffect('firstEffect')).toBe(first.effects.firstEffect);
    expect(getDbSubscriptionEffect('secondEffect')).toBe(second.effects.secondEffect);
    expect(() => createDbSubscriptionEffects({ firstEffect: () => {} })).toThrow('subscription effect already registered: firstEffect');

    first.reset();
    second.reset();
  });

  it('allows a named effect to recreate after the runtime generation changes while rejecting a same-generation duplicate', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const first = createDbSubscriptionEffects({ refreshedEffect: () => {} });

    expect(() => createDbSubscriptionEffects({ refreshedEffect: () => {} })).toThrow('subscription effect already registered: refreshedEffect');

    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const recreated = createDbSubscriptionEffects({ refreshedEffect: () => {} });

    first.reset();
    recreated.reset();
  });
});

describe('subscription attempt races', () => {
  const document = { kind: 'Document', definitions: [] } as never;

  it('ignores a late payload from a superseded activation attempt', () => {
    const handlerSets: Array<{ next: (data: unknown) => void; error: (error: unknown) => void }> = [];
    const transport = createMockTransport({
      subscribe: (_options, handlers) => {
        handlerSets.push(handlers);
        return jest.fn();
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const received: string[] = [];
    const runtime = createDbSubscriptionRuntime([{ key: 'event', query: document, onData: payload => received.push((payload as { id: string }).id) }]);
    runtime.setActive(true);
    runtime.setActive(false);
    runtime.setActive(true);

    handlerSets[0]!.next({ event: { id: 'stale' } });
    handlerSets[1]!.next({ event: { id: 'live' } });

    expect(received).toEqual(['live']);
    runtime.stop();
  });

  it('cancels pending debounced deliveries when deactivated', () => {
    jest.useFakeTimers();
    try {
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ subscribe: () => jest.fn() }) });
      const received: string[] = [];
      const runtime = createDbSubscriptionRuntime([{ key: 'event', query: document, debounce: { ms: 50 }, onData: payload => received.push((payload as { id: string }).id) }]);
      runtime.setActive(true);
      runtime.dispatch('event', { id: 'buffered' });

      runtime.setActive(false);
      jest.advanceTimersByTime(200);

      expect(received).toEqual([]);
      runtime.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('resets the retry backoff after a successful delivery', () => {
    jest.useFakeTimers();
    try {
      let attempts = 0;
      let liveHandlers!: { next: (data: unknown) => void; error: (error: unknown) => void };
      const transport = createMockTransport({
        subscribe: (_options, handlers) => {
          attempts += 1;
          liveHandlers = handlers;
          return jest.fn();
        }
      });
      configureDb({ storage: createMemoryPlane(), transport });
      const runtime = createDbSubscriptionRuntime([{ key: 'event', query: document, onData: () => {} }]);
      runtime.setActive(true);
      expect(attempts).toBe(1);

      liveHandlers.error(new Error('first failure'));
      jest.advanceTimersByTime(1000);
      expect(attempts).toBe(2);

      liveHandlers.next({ event: { id: 'recovered' } });
      liveHandlers.error(new Error('second failure'));
      jest.advanceTimersByTime(1000);

      expect(attempts).toBe(3);
      runtime.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
