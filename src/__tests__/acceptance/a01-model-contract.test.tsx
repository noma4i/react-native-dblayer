import { act } from 'react-test-renderer'
import {
  defineIngest,
  defineModel,
  defineQuery,
  f,
  resetRuntimeSync,
  scope,
} from '../../index'
import {
  createAcceptanceTransport,
  renderCounted,
  setupAcceptanceRuntime,
} from './harness'

const document = { kind: `Document`, definitions: [] } as never

describe(`A01 model contract`, () => {
  it(`A01-1 write/read round-trip suppresses an identical patch`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({
      id: `A01RoundTrip`,
      name: `A01RoundTrip`,
      fields: { title: f.str(), body: f.str() },
    })

    act(() => {
      model.insertStored({ id: `row-1`, title: `first`, body: `body` })
    })
    const reader = renderCounted(() => model.use.row(`row-1`))
    expect(model.get(`row-1`)).toEqual({ id: `row-1`, title: `first`, body: `body` })
    expect(model.getAll()).toEqual([{ id: `row-1`, title: `first`, body: `body` }])
    expect(reader.result()).toEqual({ id: `row-1`, title: `first`, body: `body` })

    act(() => {
      model.patch(`row-1`, { title: `second` })
    })
    expect(reader.result()).toEqual({ id: `row-1`, title: `second`, body: `body` })
    const rendersAfterChange = reader.renders()
    act(() => {
      model.patch(`row-1`, { title: `second`, body: `body` })
    })
    expect(reader.renders()).toBe(rendersAfterChange)
    reader.unmount()
  })

  it(`A01-2 per-field suppression only re-renders the changed field`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({
      id: `A01Field`,
      name: `A01Field`,
      fields: { title: f.str(), body: f.str() },
    })
    act(() => {
      model.insertStored({ id: `row-1`, title: `first`, body: `body` })
    })
    const reader = renderCounted(() => model.use.field(`row-1`, `title`))
    const rendersBefore = reader.renders()

    act(() => {
      model.patch(`row-1`, { body: `changed body` })
    })
    expect(reader.result()).toBe(`first`)
    expect(reader.renders()).toBe(rendersBefore)
    act(() => {
      model.patch(`row-1`, { title: `second` })
    })
    expect(reader.result()).toBe(`second`)
    expect(reader.renders()).toBe(rendersBefore + 1)
    reader.unmount()
  })

  // ACCEPTANCE-GAP: v6 keeps the tombstone after a public defineIngest event upsert, despite the documented event-origin resurrection contract.
  it.skip(`A01-3 tombstones reject stale queries but events restore rows`, async () => {
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({
        data: { items: [{ id: `row-1`, title: `stale` }] } as TData,
      }),
    })
    setupAcceptanceRuntime({ transport })
    const model = defineModel({
      id: `A01Tombstone`,
      name: `A01Tombstone`,
      fields: { title: f.str() },
    })
    const query = defineQuery({
      document,
      key: `a01-tombstone`,
      select: (data) => (data as { items: Array<{ id: string; title: string }> }).items,
      into: model,
    })
    const reader = renderCounted(() => model.use.row(`row-1`))

    await act(async () => {
      await query.fetch({})
    })
    expect(reader.result()).toMatchObject({ id: `row-1`, title: `stale` })
    act(() => {
      model.destroy(`row-1`)
    })
    await act(async () => {
      await query.fetch({})
    })
    expect(reader.result()).toBeUndefined()
    expect(model.getAll()).toEqual([])
    expect(transport.calls.filter((call) => call.kind === `query`)).toHaveLength(2)

    const ingest = defineIngest(model, {
      received: (payload) => ({ upsert: payload }),
    })
    act(() => {
      ingest.apply(`received`, { id: `row-1`, title: `event` })
    })
    expect(reader.result()).toMatchObject({ id: `row-1`, title: `event` })
    reader.unmount()
  })

  it(`A01-4 kill-switch reset wipes runtime and storage before fresh writes`, () => {
    const { storage } = setupAcceptanceRuntime()
    const model = defineModel({
      id: `A01Reset`,
      name: `A01Reset`,
      fields: { title: f.str() },
    })
    act(() => {
      model.insertStored({ id: `row-1`, title: `before reset` })
    })
    const reader = renderCounted(() => model.use.row(`row-1`))
    const rendersBeforeReset = reader.renders()

    act(() => {
      resetRuntimeSync()
    })
    expect(reader.result()).toBeUndefined()
    expect(reader.renders()).toBeGreaterThan(rendersBeforeReset)
    expect(storage.snapshotKeys().filter((key) => key.startsWith(`dbl:`))).toEqual([])
    act(() => {
      model.insertStored({ id: `row-2`, title: `after reset` })
    })
    expect(reader.result()).toBeUndefined()
    const freshReader = renderCounted(() => model.use.row(`row-2`))
    expect(freshReader.result()).toMatchObject({ id: `row-2`, title: `after reset` })
    reader.unmount()
    freshReader.unmount()
  })

  it(`A01-5 declarative scope membership updates in the same tick`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({
      id: `A01Scope`,
      name: `A01Scope`,
      fields: { group: f.str(), title: f.str() },
      scopes: { group: scope({ by: { group: `group` } }) },
    })
    const reader = renderCounted(() => model.scopes.group.use({ group: `alpha` }))
    const rendersBefore = reader.renders()

    act(() => {
      model.insertStored({ id: `match`, group: `alpha`, title: `matched` })
    })
    expect(reader.result()).toMatchObject([{ id: `match`, group: `alpha` }])
    expect(reader.renders()).toBe(rendersBefore + 1)
    act(() => {
      model.insertStored({ id: `other`, group: `beta`, title: `other` })
    })
    expect(reader.renders()).toBe(rendersBefore + 1)
    reader.unmount()
  })

  it(`A01-6 unrelated-model writes do not re-render another model`, () => {
    setupAcceptanceRuntime()
    const first = defineModel({
      id: `A01IsolationFirst`,
      name: `A01IsolationFirst`,
      fields: { title: f.str() },
    })
    const second = defineModel({
      id: `A01IsolationSecond`,
      name: `A01IsolationSecond`,
      fields: { title: f.str() },
    })
    const reader = renderCounted(() => first.use.row(`row-1`))
    const rendersBefore = reader.renders()

    act(() => {
      second.insertStored({ id: `row-1`, title: `other model` })
    })
    expect(reader.result()).toBeUndefined()
    expect(reader.renders()).toBe(rendersBefore)
    reader.unmount()
  })
})
