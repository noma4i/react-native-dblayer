import { configureDb, createDbSubscriptionEffects, createDbSubscriptionRuntime } from '../../../index';
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
});
