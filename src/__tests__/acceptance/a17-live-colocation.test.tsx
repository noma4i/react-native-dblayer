import { act } from 'react-test-renderer';
import React from 'react';
import { QueryClientProvider, defineModel, f, resetRuntime, scope } from '../../index';
import { createAcceptanceTransport, measureCpuMs, renderCounted, setupAcceptanceRuntime } from './harness';

const document = { kind: 'Document', definitions: [] } as never;
const value = { group: 'g' };
const make = (id: string) => defineModel({ id, name: id, fields: { group: f.str(), title: f.str() }, scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) } });

describe('A17 live colocation', () => {
  it('delivers a live event to a mounted reader once', () => {
    const subscribers: Array<{ next(data: unknown): void }> = [];
    const { queryClient } = setupAcceptanceRuntime({
      transport: createAcceptanceTransport({
        subscribe: (_options, handlers) => {
          subscribers.push(handlers);
          return () => {};
        }
      })
    });
    const model = make('A17Delivery');
    const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } });
    const reader = renderCounted(
      () => list.use(value).data,
      child => React.createElement(QueryClientProvider, { client: queryClient }, child)
    );
    act(() => {
      subscribers[0]!.next({ created: { id: 'one', group: 'g', title: 'one' } });
    });
    expect(model.get('one')).toMatchObject({ title: 'one' });
    expect(reader.renders()).toBe(2);
    reader.unmount();
  });
  it('uses one subscription for overlapping readers and stops on last unmount', () => {
    let active = 0;
    const { queryClient } = setupAcceptanceRuntime({
      transport: createAcceptanceTransport({
        subscribe: (_options, _handlers) => {
          active += 1;
          return () => {
            active -= 1;
          };
        }
      })
    });
    const model = make('A17Life');
    const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } });
    expect(active).toBe(0);
    const wrap = (child: React.ReactElement) => React.createElement(QueryClientProvider, { client: queryClient }, child);
    const a = renderCounted(() => list.use(value).data, wrap);
    const b = renderCounted(() => list.use(value).data, wrap);
    expect(active).toBe(1);
    a.unmount();
    expect(active).toBe(1);
    b.unmount();
    expect(active).toBe(0);
  });
  it('matches imperative ingest delivery', () => {
    setupAcceptanceRuntime();
    const model = make('A17Parity');
    const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } });
    const payload = { id: 'one', group: 'g', title: 'one' };
    list.live.apply('created', payload);
    const first = model.get('one');
    model.destroy('one');
    model.ingest({ created: { document, handler: value => ({ upsert: value }) } }).apply('created', payload);
    expect(model.get('one')).toEqual(first);
  });
  it('stops unmounted live runtime and reactivates mounted readers across reset', () => {
    const subscribers: Array<{ next(data: unknown): void }> = [];
    const { queryClient } = setupAcceptanceRuntime({
      transport: createAcceptanceTransport({
        subscribe: (_options, handlers) => {
          subscribers.push(handlers);
          return () => {};
        }
      })
    });
    const model = make('A17Reset');
    const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } });
    const wrap = (child: React.ReactElement) => React.createElement(QueryClientProvider, { client: queryClient }, child);
    const reader = renderCounted(() => list.use(value).data, wrap);
    reader.unmount();
    resetRuntime();
    subscribers[0]?.next({ created: { id: 'late', group: 'g', title: 'late' } });
    expect(model.get('late')).toBeUndefined();
    const mounted = renderCounted(() => list.use(value).data, wrap);
    resetRuntime();
    subscribers.at(-1)?.next({ created: { id: 'fresh', group: 'g', title: 'fresh' } });
    expect(model.get('fresh')).toMatchObject({ title: 'fresh' });
    mounted.unmount();
  });
  it('does not activate live subscriptions for fetch alone', async () => {
    let calls = 0;
    setupAcceptanceRuntime({
      transport: createAcceptanceTransport({
        query: async <TData,>() => ({ data: [] as TData }),
        subscribe: () => {
          calls += 1;
          return () => {};
        }
      })
    });
    const model = make('A17Fetch');
    const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } });
    await list.fetch(value);
    expect(calls).toBe(0);
  });

  it('makes duplicate live events idempotent while preserving scope identity', () => {
    const subscribers: Array<{ next(data: unknown): void }> = [];
    const { queryClient } = setupAcceptanceRuntime({
      transport: createAcceptanceTransport({
        subscribe: (_options, handlers) => {
          subscribers.push(handlers);
          return () => {};
        }
      })
    });
    const model = make('A17Duplicate');
    const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } });
    const reader = renderCounted(
      () => list.use(value).data,
      child => React.createElement(QueryClientProvider, { client: queryClient }, child)
    );
    const scopeReader = renderCounted(() => model.scopes.feed.use(value));
    const payload = { created: { id: 'one', group: 'g', title: 'one' } };
    act(() => {
      subscribers[0]!.next(payload);
    });
    const firstRows = scopeReader.result();
    const firstRow = firstRows[0];
    const rendersBeforeDuplicate = reader.renders();
    act(() => {
      subscribers[0]!.next(payload);
    });
    expect(model.getAll()).toHaveLength(1);
    expect(reader.renders()).toBe(rendersBeforeDuplicate);
    expect(scopeReader.result()).toBe(firstRows);
    expect(scopeReader.result()[0]).toBe(firstRow);
    reader.unmount();
    scopeReader.unmount();
  });

  it('keeps unrelated readers at zero renders on live delivery', () => {
    const subscribers: Array<{ next(data: unknown): void }> = [];
    const { queryClient } = setupAcceptanceRuntime({
      transport: createAcceptanceTransport({
        subscribe: (_options, handlers) => {
          subscribers.push(handlers);
          return () => {};
        }
      })
    });
    const model = make('A17Pinpoint');
    const other = defineModel({ id: 'A17PinpointOther', name: 'A17PinpointOther', fields: { title: f.str() } });
    const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } });
    const wrap = (child: React.ReactElement) => React.createElement(QueryClientProvider, { client: queryClient }, child);
    const listReader = renderCounted(() => list.use(value).data, wrap);
    const rowReader = renderCounted(() => model.use.row('unrelated'));
    const scopeReader = renderCounted(() => model.scopes.feed.use({ group: 'other' }));
    const modelReader = renderCounted(() => other.use.row('other'));
    const before = [listReader.renders(), rowReader.renders(), scopeReader.renders(), modelReader.renders()];
    act(() => {
      subscribers[0]!.next({ created: { id: 'one', group: 'g', title: 'one' } });
    });
    expect(listReader.renders()).toBe(before[0]! + 1);
    expect(rowReader.renders()).toBe(before[1]);
    expect(scopeReader.renders()).toBe(before[2]);
    expect(modelReader.renders()).toBe(before[3]);
    listReader.unmount();
    rowReader.unmount();
    scopeReader.unmount();
    modelReader.unmount();
  });

  it('clears colocated debounce and retry timers after the last unmount', () => {
    jest.useFakeTimers();
    try {
      const subscribers: Array<{ next(data: unknown): void; error(error: unknown): void }> = [];
      const transport = createAcceptanceTransport({
        subscribe: (_options, handlers) => {
          subscribers.push(handlers);
          return () => {};
        }
      });
      const { queryClient } = setupAcceptanceRuntime({ transport });
      const model = make('A17Timers');
      const list = model.query('list', {
        document,
        select: () => [],
        into: model.scopes.feed,
        live: { created: { document, debounce: { ms: 20 }, handler: payload => ({ upsert: payload }) } }
      });
      const wrap = (child: React.ReactElement) => React.createElement(QueryClientProvider, { client: queryClient }, child);
      const debounced = renderCounted(() => list.use(value).data, wrap);
      subscribers[0]!.next({ created: { id: 'debounced', group: 'g', title: 'debounced' } });
      debounced.unmount();
      act(() => {
        jest.advanceTimersByTime(20);
      });
      expect(model.get('debounced')).toBeUndefined();
      const retrying = renderCounted(() => list.use(value).data, wrap);
      const subscribeCallsBeforeError = transport.calls.filter(call => call.kind === 'subscribe').length;
      subscribers.at(-1)!.error(new Error('retry'));
      retrying.unmount();
      act(() => {
        jest.advanceTimersByTime(1_000);
      });
      expect(transport.calls.filter(call => call.kind === 'subscribe')).toHaveLength(subscribeCallsBeforeError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps colocated live delivery scaling bounded at 1k and 20k rows', () => {
    const median = (samples: number[]) => [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]!;
    const sample = (count: number) => {
      const subscribers: Array<{ next(data: unknown): void }> = [];
      const { queryClient } = setupAcceptanceRuntime({
        transport: createAcceptanceTransport({
          subscribe: (_options, handlers) => {
            subscribers.push(handlers);
            return () => {};
          }
        })
      });
      const model = make(`A17Scale${count}`);
      let deliveries = 0;
      const list = model.query('list', {
        document,
        select: () => [],
        into: model.scopes.feed,
        live: {
          created: {
            document,
            handler: payload => {
              deliveries += 1;
              return { upsert: payload };
            }
          }
        }
      });
      model.scopes.feed.__apply?.(
        value,
        Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, group: 'g', title: `title-${index}` })),
        'complete'
      );
      const reader = renderCounted(
        () => list.use(value).data,
        child => React.createElement(QueryClientProvider, { client: queryClient }, child)
      );
      const measure = (index: number) =>
        measureCpuMs(() => {
          act(() => {
            subscribers[0]!.next({ created: { id: 'row-0', group: 'g', title: `changed-${index}` } });
          });
        });
      measure(-1);
      const elapsed = median(Array.from({ length: 25 }, (_, index) => measure(index)));
      expect(deliveries).toBe(26);
      reader.unmount();
      return elapsed;
    };
    const small = sample(1_000);
    const large = sample(20_000);
    const ratio = large / Math.max(small, 0.001);
    console.log(`A17-RESULT scale: small=${small},large=${large},ratio=${ratio}`);
    expect(ratio).toBeLessThan(12);
  });
});
