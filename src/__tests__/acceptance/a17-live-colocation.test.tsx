import { act } from 'react-test-renderer';
import React from 'react';
import { QueryClientProvider, defineModel, f, resetRuntime, scope } from '../../index';
import { createAcceptanceTransport, renderCounted, setupAcceptanceRuntime } from './harness';

const document = { kind: 'Document', definitions: [] } as never;
const value = { group: 'g' };
const make = (id: string) => defineModel({ id, name: id, fields: { group: f.str(), title: f.str() }, scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) } });

describe('A17 live colocation', () => {
  it('delivers a live event to a mounted reader once', () => {
    const subscribers: Array<{ next(data: unknown): void }> = [];
    const { queryClient } = setupAcceptanceRuntime({ transport: createAcceptanceTransport({ subscribe: (_options, handlers) => { subscribers.push(handlers); return () => {}; } }) });
    const model = make('A17Delivery'); const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } });
    const reader = renderCounted(() => list.use(value).data, child => React.createElement(QueryClientProvider, { client: queryClient }, child)); act(() => { subscribers[0]!.next({ created: { id: 'one', group: 'g', title: 'one' } }); });
    expect(model.get('one')).toMatchObject({ title: 'one' }); expect(reader.renders()).toBe(2); reader.unmount();
  });
  it('uses one subscription for overlapping readers and stops on last unmount', () => {
    let active = 0; const { queryClient } = setupAcceptanceRuntime({ transport: createAcceptanceTransport({ subscribe: (_options, _handlers) => { active += 1; return () => { active -= 1; }; } }) }); const model = make('A17Life'); const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } });
    expect(active).toBe(0); const wrap = (child: React.ReactElement) => React.createElement(QueryClientProvider, { client: queryClient }, child); const a = renderCounted(() => list.use(value).data, wrap); const b = renderCounted(() => list.use(value).data, wrap); expect(active).toBe(1); a.unmount(); expect(active).toBe(1); b.unmount(); expect(active).toBe(0);
  });
  it('matches imperative ingest delivery', () => {
    setupAcceptanceRuntime(); const model = make('A17Parity'); const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } }); const payload = { id: 'one', group: 'g', title: 'one' }; list.live.apply('created', payload); const first = model.get('one'); model.destroy('one'); model.ingest({ created: { document, handler: value => ({ upsert: value }) } }).apply('created', payload); expect(model.get('one')).toEqual(first);
  });
  it('stops unmounted live runtime across reset', () => {
    const subscribers: Array<{ next(data: unknown): void }> = []; const { queryClient } = setupAcceptanceRuntime({ transport: createAcceptanceTransport({ subscribe: (_options, handlers) => { subscribers.push(handlers); return () => {}; } }) }); const model = make('A17Reset'); const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } }); const reader = renderCounted(() => list.use(value).data, child => React.createElement(QueryClientProvider, { client: queryClient }, child)); reader.unmount(); resetRuntime(); subscribers[0]?.next({ created: { id: 'late', group: 'g', title: 'late' } }); expect(model.get('late')).toBeUndefined();
  });
  it('does not activate live subscriptions for fetch alone', async () => {
    let calls = 0; setupAcceptanceRuntime({ transport: createAcceptanceTransport({ query: async <TData,>() => ({ data: [] as TData }), subscribe: () => { calls += 1; return () => {}; } }) }); const model = make('A17Fetch'); const list = model.query('list', { document, select: () => [], into: model.scopes.feed, live: { created: { document, handler: payload => ({ upsert: payload }) } } }); await list.fetch(value); expect(calls).toBe(0);
  });
});
