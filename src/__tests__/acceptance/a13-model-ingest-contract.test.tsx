import { act } from 'react-test-renderer';
import { createDbSubscriptionEffects, createDbSubscriptionRuntime, defineModel, f, resetRuntime } from '../../index';
import { createAcceptanceTransport, renderCounted, setupAcceptanceRuntime } from './harness';

const document = { kind: `Document`, definitions: [] } as never;

describe(`A13 model ingest contract`, () => {
  it(`fuses subscription entries, guards, debounce, effects, custom handlers, and contained errors`, () => {
    jest.useFakeTimers();
    const errors: Array<{ source: string; event?: string }> = [];
    const subscribers: Array<{ next(data: unknown): void }> = [];
    const transport = createAcceptanceTransport({
      subscribe: (_options, handlers) => {
        subscribers.push(handlers);
        return () => {
          const index = subscribers.indexOf(handlers);
          if (index >= 0) subscribers.splice(index, 1);
        };
      }
    });
    setupAcceptanceRuntime({ transport, defaults: { onSyncError: (_error, context) => errors.push({ source: context.source, event: context.event }) } });
    const effects = createDbSubscriptionEffects({ before: (_payload: unknown) => {}, after: (_payload: unknown) => {} });
    const order: string[] = [];
    const rows = defineModel({ id: `A13Rows`, name: `Rows`, fields: { title: f.str(), key: f.str() } });
    const other = defineModel({ id: `A13Other`, name: `Other`, fields: { title: f.str() } });
    effects.configure({ before: () => order.push(rows.get(`one`) ? `visible` : `before`), after: () => order.push(rows.get(`one`) ? `after` : `missing`) });
    const entries = rows.ingest({
      created: { document, effect: { name: `before`, when: `before` } },
      deleted: { document, apply: `destroy` },
      changed: { document, guard: `existing` },
      echoed: { document, echoGuard: () => true },
      delayed: { document, debounce: { ms: 20, keyOf: payload => String((payload as { key: string }).key) } },
      after: { document, effect: { name: `after`, when: `after` } },
      custom: {
        document,
        apply: (payload, tools) => {
          tools.model.insertStored(payload as { id: string; title: string; key: string });
          tools.models.Other.insertStored({ id: `other`, title: `side` });
          tools.invalidate();
        }
      },
      broken: {
        document,
        apply: () => {
          throw new Error(`broken`);
        }
      },
      unknown: { document, effect: { name: `missing`, when: `before` } }
    });
    const runtime = createDbSubscriptionRuntime(entries.entries);
    runtime.setActive(true);
    expect(subscribers).toHaveLength(9);
    act(() => {
      subscribers[0]!.next({ created: { id: `one`, title: `created`, key: `a` } });
    });
    expect(rows.get(`one`)).toMatchObject({ title: `created` });
    expect(order).toEqual([`before`]);
    runtime.dispatch(`after`, { id: `one`, title: `after`, key: `a` });
    expect(order).toEqual([`before`, `after`]);
    runtime.dispatch(`changed`, { id: `missing`, title: `skipped`, key: `a` });
    expect(rows.get(`missing`)).toBeUndefined();
    runtime.dispatch(`changed`, { id: `one`, title: `changed`, key: `a` });
    expect(rows.get(`one`)).toMatchObject({ title: `changed` });
    runtime.dispatch(`echoed`, { id: `one`, title: `echo`, key: `a` });
    expect(rows.get(`one`)).toMatchObject({ title: `changed` });
    runtime.dispatch(`delayed`, { id: `first`, title: `first`, key: `a` });
    runtime.dispatch(`delayed`, { id: `second`, title: `second`, key: `a` });
    runtime.dispatch(`delayed`, { id: `third`, title: `third`, key: `b` });
    act(() => {
      jest.advanceTimersByTime(20);
    });
    expect(rows.get(`first`)).toBeUndefined();
    expect(rows.get(`second`)).toMatchObject({ title: `second` });
    expect(rows.get(`third`)).toMatchObject({ title: `third` });
    runtime.dispatch(`custom`, { id: `custom`, title: `custom`, key: `a` });
    expect(rows.get(`custom`)).toMatchObject({ title: `custom` });
    expect(other.get(`other`)).toMatchObject({ title: `side` });
    runtime.dispatch(`broken`, { id: `broken`, title: `broken`, key: `a` });
    runtime.dispatch(`unknown`, { id: `unknown`, title: `unknown`, key: `a` });
    expect(errors).toContainEqual({ source: `ingest`, event: `broken` });
    expect(errors).toContainEqual({ source: `ingest`, event: `unknown` });
    runtime.dispatch(`deleted`, { id: `one` });
    expect(rows.get(`one`)).toBeUndefined();
    runtime.stop();
    jest.useRealTimers();
  });

  it(`clears named effects on runtime reset and replaces them on recreation`, () => {
    const errors: string[] = [];
    setupAcceptanceRuntime({ defaults: { onSyncError: (_error, context) => errors.push(context.event ?? ``) } });
    const model = defineModel({ id: `A13Effects`, name: `Effects`, fields: { title: f.str() } });
    const stale = jest.fn();
    createDbSubscriptionEffects({ stale });
    const staleEntry = model.ingest({ stale: { document, effect: { name: `stale`, when: `before` } } }).entries[0]!;
    staleEntry.onData({ id: `one`, title: `one` });
    expect(stale).toHaveBeenCalledTimes(1);
    act(() => {
      resetRuntime();
    });
    staleEntry.onData({ id: `two`, title: `two` });
    expect(stale).toHaveBeenCalledTimes(1);
    expect(errors).toContain(`stale`);
    const fresh = jest.fn();
    createDbSubscriptionEffects({ fresh });
    const freshEntry = model.ingest({ fresh: { document, effect: { name: `fresh`, when: `before` } } }).entries[0]!;
    freshEntry.onData({ id: `three`, title: `three` });
    expect(fresh).toHaveBeenCalledTimes(1);
    staleEntry.onData({ id: `four`, title: `four` });
    expect(stale).toHaveBeenCalledTimes(1);
    expect(errors.filter(event => event === `stale`)).toHaveLength(2);
  });

  it(`keeps mounted reader identities stable for duplicate fused payloads`, () => {
    setupAcceptanceRuntime();
    const rows = defineModel({ id: `A13DuplicateRows`, name: `DuplicateRows`, fields: { title: f.str() } });
    const runtime = createDbSubscriptionRuntime(rows.ingest({ created: { document } }).entries);
    const reader = renderCounted(() => rows.use.where({}).rows());
    act(() => {
      runtime.dispatch(`created`, { id: `row`, title: `created` });
    });
    const initial = reader.result();
    const initialRow = initial[0];
    const beforeDuplicate = reader.renders();

    act(() => {
      runtime.dispatch(`created`, { id: `row`, title: `created` });
    });

    expect(reader.renders() - beforeDuplicate).toBe(0);
    expect(reader.result()).toBe(initial);
    expect(reader.result()[0]).toBe(initialRow);
    runtime.stop();
    reader.unmount();
  });

  it(`renders only the affected mounted reader for a fused entry`, () => {
    setupAcceptanceRuntime();
    const rows = defineModel({ id: `A13AffectedRows`, name: `AffectedRows`, fields: { title: f.str() } });
    const other = defineModel({ id: `A13AffectedOther`, name: `AffectedOther`, fields: { title: f.str() } });
    const runtime = createDbSubscriptionRuntime(rows.ingest({ created: { document } }).entries);
    const rowsReader = renderCounted(() => rows.use.where({}).rows());
    const otherReader = renderCounted(() => other.use.where({}).rows());
    const beforeRows = rowsReader.renders();
    const beforeOther = otherReader.renders();

    act(() => {
      runtime.dispatch(`created`, { id: `row`, title: `created` });
    });

    expect(rowsReader.renders() - beforeRows).toBe(1);
    expect(otherReader.renders() - beforeOther).toBe(0);
    runtime.stop();
    otherReader.unmount();
    rowsReader.unmount();
  });

  it(`does not apply a stale fused payload after runtime stop`, () => {
    const subscribers: Array<{ next(data: unknown): void }> = [];
    const transport = createAcceptanceTransport({
      subscribe: (_options, handlers) => {
        subscribers.push(handlers);
        return () => {};
      }
    });
    setupAcceptanceRuntime({ transport });
    const rows = defineModel({ id: `A13StoppedRows`, name: `StoppedRows`, fields: { title: f.str() } });
    const runtime = createDbSubscriptionRuntime(rows.ingest({ created: { document } }).entries);
    const reader = renderCounted(() => rows.use.where({}).rows());
    runtime.setActive(true);
    const staleSubscriber = subscribers[0]!;
    act(() => {
      staleSubscriber.next({ created: { id: `initial`, title: `initial` } });
    });
    const beforeStop = reader.result();
    const frozen = reader.renders();
    runtime.stop();

    act(() => {
      staleSubscriber.next({ created: { id: `late`, title: `late` } });
    });

    expect(reader.renders()).toBe(frozen);
    expect(reader.result()).toBe(beforeStop);
    expect(reader.result()).toEqual([{ id: `initial`, title: `initial` }]);
    reader.unmount();
  });

  it(`applies imperative fused payloads through the same echo guard as subscriptions`, () => {
    setupAcceptanceRuntime();
    const rows = defineModel({ id: `A13ImperativeIngest`, name: `ImperativeIngest`, fields: { title: f.str(), operationId: f.str().optional() } });
    const ingest = rows.ingest({ received: { document, echoGuard: payload => (payload as { operationId?: string }).operationId === `echo` } });
    ingest.apply(`received`, { id: `row`, title: `applied` });
    ingest.apply(`received`, { id: `echo`, title: `suppressed`, operationId: `echo` });
    expect(rows.get(`row`)).toMatchObject({ title: `applied` });
    expect(rows.get(`echo`)).toBeUndefined();
  });

  it(`applies one handler declaration atomically through imperative delivery`, () => {
    setupAcceptanceRuntime();
    const rows = defineModel({ id: `A13HandlerIngest`, name: `HandlerIngest`, fields: { title: f.str() } });
    rows.insertStored({ id: `old`, title: `old` });
    const reader = renderCounted(() => rows.use.where({}).rows());
    const ingest = rows.ingest({ batch: { handler: () => ({ upsert: [{ id: `one`, title: `one` }, { id: `two`, title: `two` }], destroy: `old` }) } });
    const before = reader.renders();
    act(() => { ingest.apply(`batch`, {}); });
    expect(reader.renders() - before).toBe(1);
    expect(reader.result().map(row => row.id)).toEqual([`one`, `two`]);
    reader.unmount();
  });
});
