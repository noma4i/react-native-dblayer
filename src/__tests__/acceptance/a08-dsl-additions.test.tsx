import React from 'react'
import { act } from 'react-test-renderer'
import {
  belongsTo,
  bootDb,
  defineFetch,
  defineModel,
  f,
  flushPersistence,
  QueryClientProvider,
  scope,
  suspendDb,
} from '../../index'
import {
  createAcceptanceTransport,
  createMemoryPlane,
  renderCounted,
  setupAcceptanceRuntime,
} from './harness'

const document = { kind: `Document`, definitions: [] } as never

function queryWrapper(queryClient: ReturnType<typeof setupAcceptanceRuntime>[`queryClient`]) {
  return (child: React.ReactElement) =>
    React.createElement(QueryClientProvider, { client: queryClient }, child)
}

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error(`condition did not settle`)
}

describe(`A08 DSL additions`, () => {
  it(`A08-1 defineFetch happy path is ephemeral and refetchable`, async () => {
    const responses = [
      { countries: [{ code: `AU`, name: `Australia` }] },
      { countries: [{ code: `AU`, name: `Australia (refetched)` }] },
    ]
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({ data: responses.shift() as TData }),
    })
    const { storage, queryClient } = setupAcceptanceRuntime({ transport })
    const countries = defineFetch({
      document,
      key: `a08-countries`,
      select: (data: { countries: Array<{ code: string; name: string }> }) => data.countries,
    })
    const reader = renderCounted(() => countries.use(undefined), queryWrapper(queryClient))

    expect(reader.result().loadingState.phase).toBe(`initial_loading`)
    await waitFor(() => reader.result().loadingState.phase === `ready`)
    expect(reader.result().data).toEqual([{ code: `AU`, name: `Australia` }])

    act(() => {
      reader.result().refetch()
    })
    await waitFor(() => reader.result().data?.[0]?.name === `Australia (refetched)`)
    expect(reader.result().data).toEqual([{ code: `AU`, name: `Australia (refetched)` }])
    expect(transport.calls).toHaveLength(2)

    flushPersistence()
    expect(storage.snapshotKeys().filter((key) => key.startsWith(`dbl:`))).toEqual([])
    reader.unmount()
  })

  it(`A08-2 defineFetch reports transport errors and honors enabled:false`, async () => {
    const onSyncError = jest.fn()
    const transport = createAcceptanceTransport({
      query: async () => Promise.reject(new Error(`pricing failed`)),
    })
    const { queryClient } = setupAcceptanceRuntime({ transport, defaults: { onSyncError } })
    const pricing = defineFetch({
      document,
      key: `a08-pricing`,
      select: (data: { price: number }) => data.price,
    })
    const reader = renderCounted(() => pricing.use(undefined), queryWrapper(queryClient))

    await waitFor(() => reader.result().error != null)
    expect(reader.result().error).toBeTruthy()
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ source: `query` }))
    reader.unmount()
  })

  it(`A08-2b defineFetch enabled:false makes zero transport calls`, async () => {
    const transport = createAcceptanceTransport()
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const sku = defineFetch({
      document,
      key: `a08-sku`,
      select: (data: { sku: string }) => data.sku,
      enabled: () => false,
    })
    const reader = renderCounted(() => sku.use(undefined), queryWrapper(queryClient))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(transport.calls).toHaveLength(0)
    reader.unmount()
  })

  it(`A08-3 bootDb replays journal rows and purges foreign keys on a fresh runtime`, async () => {
    const storage = createMemoryPlane()
    storage.set([{ key: `v5:legacy`, value: `foreign` }])
    setupAcceptanceRuntime({ storage })
    const first = defineModel({ id: `A08Boot`, name: `A08Boot`, fields: { title: f.str() }, gc: `exempt` })
    act(() => {
      first.insertStored({ id: `row-1`, title: `one` })
      flushPersistence()
    })

    const transport = createAcceptanceTransport()
    const result = await bootDb({ storage, transport })
    const restarted = defineModel({ id: `A08Boot`, name: `A08Boot`, fields: { title: f.str() }, gc: `exempt` })

    expect(restarted.get(`row-1`)).toEqual({ id: `row-1`, title: `one` })
    expect(typeof result.replayed).toBe(`number`)
    expect(result.gc).toEqual(expect.objectContaining({ evicted: expect.any(Object), scopesRemoved: expect.any(Object) }))
    expect(storage.get(`v5:legacy`)).toBeUndefined()
  })

  it(`A08-4 suspendDb flushes pending writes and evicts an orphan row`, () => {
    const storage = createMemoryPlane()
    setupAcceptanceRuntime({ storage, defaults: { persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } } })
    const model = defineModel({
      id: `A08Suspend`,
      name: `A08Suspend`,
      fields: { group: f.str().nullable(), title: f.str() },
      scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) },
    })
    act(() => {
      // `kept` joins the `feed` scope automatically (declarative `by` membership) so GC roots it.
      model.insertStored({ id: `kept`, group: `g1`, title: `kept` })
      // `orphan` has a null `by`-mapped field, so it never joins any scope - unreachable from birth.
      model.insertStored({ id: `orphan`, group: null, title: `orphan` })
    })
    const reader = renderCounted(() => model.use.row(`orphan`))
    expect(reader.result()).toBeDefined()
    expect(storage.get(`dbl:row:A08Suspend:kept`)).toBeUndefined()

    const renders = reader.renders()
    act(() => {
      suspendDb()
    })

    expect(storage.get(`dbl:row:A08Suspend:kept`)).toBeDefined()
    expect(reader.result()).toBeUndefined()
    expect(reader.renders()).toBe(renders + 1)
    reader.unmount()
  })

  it(`A08-4b suspendDb is safe to call repeatedly and before configuration`, () => {
    expect(() => suspendDb()).not.toThrow()
    expect(() => suspendDb()).not.toThrow()
  })

  it(`A08-5 insertStoredMany writes a batch in one render and stays idempotent`, () => {
    setupAcceptanceRuntime()
    const parent = defineModel({ id: `A08BatchParent`, name: `A08BatchParent`, fields: { count: f.num() } })
    const child = defineModel({
      id: `A08BatchChild`,
      name: `A08BatchChild`,
      fields: { parentId: f.id(), title: f.str() },
      relations: () => ({ parent: belongsTo(parent, { foreignKey: `parentId`, counterCache: { field: `count` } }) }),
      scopes: { feed: scope({ by: { parentId: `parentId` }, sort: `server-order` }) },
    })
    act(() => {
      parent.insertStored({ id: `parent`, count: 0 })
    })
    const rows = Array.from({ length: 100 }, (_, index) => ({ id: `row-${index}`, parentId: `parent`, title: `row-${index}` }))
    const reader = renderCounted(() => child.scopes.feed.use({ parentId: `parent` }))
    const before = reader.renders()

    act(() => {
      child.insertStoredMany(rows)
    })

    expect(reader.renders()).toBe(before + 1)
    expect(reader.result()).toHaveLength(100)
    expect(parent.get(`parent`)).toEqual({ id: `parent`, count: 100 })

    const afterFirstBatch = reader.renders()
    act(() => {
      child.insertStoredMany(rows)
    })
    expect(reader.renders()).toBe(afterFirstBatch)
    expect(parent.get(`parent`)).toEqual({ id: `parent`, count: 100 })
    reader.unmount()
  })
})
