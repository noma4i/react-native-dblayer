import { act } from 'react-test-renderer'
import { createDbSubscriptionEffects, createDbSubscriptionRuntime, defineModel, f, resetRuntime } from '../../index'
import { createAcceptanceTransport, setupAcceptanceRuntime } from './harness'

const document = { kind: `Document`, definitions: [] } as never

describe(`A13 model ingest contract`, () => {
  it(`fuses subscription entries, guards, debounce, effects, custom handlers, and contained errors`, () => {
    jest.useFakeTimers()
    const errors: Array<{ source: string; event?: string }> = []
    const subscribers: Array<{ next(data: unknown): void }> = []
    const transport = createAcceptanceTransport({ subscribe: (_options, handlers) => { subscribers.push(handlers); return () => { const index = subscribers.indexOf(handlers); if (index >= 0) subscribers.splice(index, 1) } } })
    setupAcceptanceRuntime({ transport, defaults: { onSyncError: (_error, context) => errors.push({ source: context.source, event: context.event }) } })
    const effects = createDbSubscriptionEffects({ before: (_payload: unknown) => {}, after: (_payload: unknown) => {} })
    const order: string[] = []
    const rows = defineModel({ id: `A13Rows`, name: `Rows`, fields: { title: f.str(), key: f.str() } })
    const other = defineModel({ id: `A13Other`, name: `Other`, fields: { title: f.str() } })
    effects.configure({ before: () => order.push(rows.get(`one`) ? `visible` : `before`), after: () => order.push(rows.get(`one`) ? `after` : `missing`) })
    const entries = rows.ingest({
      created: { document, effect: { name: `before`, when: `before` } },
      deleted: { document, apply: `destroy` },
      changed: { document, guard: `existing` },
      echoed: { document, echoGuard: () => true },
      delayed: { document, debounce: { ms: 20, keyOf: payload => String((payload as { key: string }).key) } },
      after: { document, effect: { name: `after`, when: `after` } },
      custom: { document, apply: (payload, tools) => { tools.model.insertStored(payload as { id: string; title: string; key: string }); tools.models.Other.insertStored({ id: `other`, title: `side` }); tools.invalidate() } },
      broken: { document, apply: () => { throw new Error(`broken`) } },
      unknown: { document, effect: { name: `missing`, when: `before` } }
    })
    const runtime = createDbSubscriptionRuntime(entries)
    runtime.setActive(true)
    expect(subscribers).toHaveLength(9)
    act(() => { subscribers[0]!.next({ created: { id: `one`, title: `created`, key: `a` } }) })
    expect(rows.get(`one`)).toMatchObject({ title: `created` })
    expect(order).toEqual([`before`])
    runtime.dispatch(`after`, { id: `one`, title: `after`, key: `a` })
    expect(order).toEqual([`before`, `after`])
    runtime.dispatch(`changed`, { id: `missing`, title: `skipped`, key: `a` })
    expect(rows.get(`missing`)).toBeUndefined()
    runtime.dispatch(`changed`, { id: `one`, title: `changed`, key: `a` })
    expect(rows.get(`one`)).toMatchObject({ title: `changed` })
    runtime.dispatch(`echoed`, { id: `one`, title: `echo`, key: `a` })
    expect(rows.get(`one`)).toMatchObject({ title: `changed` })
    runtime.dispatch(`delayed`, { id: `first`, title: `first`, key: `a` })
    runtime.dispatch(`delayed`, { id: `second`, title: `second`, key: `a` })
    runtime.dispatch(`delayed`, { id: `third`, title: `third`, key: `b` })
    act(() => { jest.advanceTimersByTime(20) })
    expect(rows.get(`first`)).toBeUndefined()
    expect(rows.get(`second`)).toMatchObject({ title: `second` })
    expect(rows.get(`third`)).toMatchObject({ title: `third` })
    runtime.dispatch(`custom`, { id: `custom`, title: `custom`, key: `a` })
    expect(rows.get(`custom`)).toMatchObject({ title: `custom` })
    expect(other.get(`other`)).toMatchObject({ title: `side` })
    runtime.dispatch(`broken`, { id: `broken`, title: `broken`, key: `a` })
    runtime.dispatch(`unknown`, { id: `unknown`, title: `unknown`, key: `a` })
    expect(errors).toContainEqual({ source: `ingest`, event: `broken` })
    expect(errors).toContainEqual({ source: `ingest`, event: `unknown` })
    runtime.dispatch(`deleted`, { id: `one` })
    expect(rows.get(`one`)).toBeUndefined()
    runtime.stop()
    jest.useRealTimers()
  })

  it(`clears named effects on runtime reset and replaces them on recreation`, () => {
    const errors: string[] = []
    setupAcceptanceRuntime({ defaults: { onSyncError: (_error, context) => errors.push(context.event ?? ``) } })
    const model = defineModel({ id: `A13Effects`, name: `Effects`, fields: { title: f.str() } })
    const stale = jest.fn()
    createDbSubscriptionEffects({ stale })
    const staleEntry = model.ingest({ stale: { document, effect: { name: `stale`, when: `before` } } })[0]!
    staleEntry.onData({ id: `one`, title: `one` })
    expect(stale).toHaveBeenCalledTimes(1)
    act(() => { resetRuntime() })
    staleEntry.onData({ id: `two`, title: `two` })
    expect(stale).toHaveBeenCalledTimes(1)
    expect(errors).toContain(`stale`)
    const fresh = jest.fn()
    createDbSubscriptionEffects({ fresh })
    const freshEntry = model.ingest({ fresh: { document, effect: { name: `fresh`, when: `before` } } })[0]!
    freshEntry.onData({ id: `three`, title: `three` })
    expect(fresh).toHaveBeenCalledTimes(1)
    staleEntry.onData({ id: `four`, title: `four` })
    expect(stale).toHaveBeenCalledTimes(1)
    expect(errors.filter(event => event === `stale`)).toHaveLength(2)
  })
})
