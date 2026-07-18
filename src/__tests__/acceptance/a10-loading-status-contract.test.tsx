import React from 'react'
import { act } from 'react-test-renderer'
import {
  defineModel,
  f,
  flushPersistence,
  QueryClientProvider,
  replayJournal,
  scope,
} from '../../index'
import { createAcceptanceTransport, createMemoryPlane, renderCounted, setupAcceptanceRuntime } from './harness'

const document = { kind: `Document`, definitions: [] } as never
const scopeValue = { group: `g` }
type Row = { id: string; group: string; title: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function wrapper(queryClient: ReturnType<typeof setupAcceptanceRuntime>[`queryClient`]) {
  return (child: React.ReactElement) => React.createElement(QueryClientProvider, { client: queryClient }, child)
}

function rowsModel(id: string) {
  return defineModel({
    id,
    name: id,
    fields: { group: f.str(), title: f.str() },
    scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) },
  })
}

function page(rows: Row[], endCursor: string | null, hasNextPage: boolean) {
  return { connection: { nodes: rows, pageInfo: { endCursor, hasNextPage } } }
}

const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe(`A10 loading and refresh status contract`, () => {
  it(`H-1 keeps an empty initial query in skeleton state until its first page lands`, async () => {
    const hold = deferred<{ data: { rows: Row[] } }>()
    const transport = createAcceptanceTransport({ query: <TData,>() => hold.promise as Promise<{ data: TData }> })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = rowsModel(`A10H1`)
    const query = model.query(`a10-h1`, { document, key: `a10-h1`, select: (data: { rows: Row[] }) => data.rows, into: model.scopes.feed })
    const result = renderCounted(() => query.use(scopeValue), wrapper(queryClient))
    const scopeReader = renderCounted(() => model.scopes.feed.use(scopeValue))

    expect(result.result().data).toEqual([])
    expect(result.result().loadingState).toEqual(expect.objectContaining({ phase: `initial_loading`, showSkeleton: true, showEmptyState: false, showData: false }))
    expect(scopeReader.renders()).toBe(1)
    await act(async () => {
      hold.resolve({ data: { rows: [{ id: `first`, group: `g`, title: `first` }] } })
      await Promise.resolve()
    })
    expect(result.result().data).toEqual([{ id: `first`, group: `g`, title: `first` }])
    expect(result.result().loadingState).toEqual(expect.objectContaining({ showSkeleton: false, showData: true }))
    expect(scopeReader.renders()).toBe(2)
    console.log(`A10-RESULT H1: scope-renders=${scopeReader.renders()}`)
    result.unmount()
    scopeReader.unmount()
  })

  it(`H-2 exposes stale rows and a refresh indicator until refetch data is applied`, async () => {
    const first = deferred<{ data: { rows: Row[] } }>()
    const second = deferred<{ data: { rows: Row[] } }>()
    let call = 0
    const transport = createAcceptanceTransport({ query: <TData,>() => (call++ === 0 ? first.promise : second.promise) as Promise<{ data: TData }> })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = rowsModel(`A10H2`)
    const query = model.query(`a10-h2`, { document, key: `a10-h2`, select: (data: { rows: Row[] }) => data.rows, into: model.scopes.feed })
    const result = renderCounted(() => query.use(scopeValue), wrapper(queryClient))
    await act(async () => {
      first.resolve({ data: { rows: [{ id: `row`, group: `g`, title: `before` }] } })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    let refresh!: Promise<void>
    act(() => {
      refresh = result.result().refetch()
    })
    await settle()
    expect(result.result().data).toEqual([{ id: `row`, group: `g`, title: `before` }])
    expect(result.result().loadingState).toEqual(expect.objectContaining({ phase: `refreshing`, showRefreshIndicator: true, showSkeleton: false, showData: true }))
    await act(async () => {
      second.resolve({ data: { rows: [{ id: `row`, group: `g`, title: `after` }] } })
      await refresh
    })
    expect(result.result().data).toEqual([{ id: `row`, group: `g`, title: `after` }])
    expect(result.result().loadingState).toEqual(expect.objectContaining({ showRefreshIndicator: false, showData: true }))
    result.unmount()
  })

  it(`H-3 separates pagination footer state from initial and refresh state`, async () => {
    const first = deferred<{ data: ReturnType<typeof page> }>()
    const second = deferred<{ data: ReturnType<typeof page> }>()
    let call = 0
    const transport = createAcceptanceTransport({ query: <TData,>() => (call++ === 0 ? first.promise : second.promise) as Promise<{ data: TData }> })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = rowsModel(`A10H3`)
    const query = model.query(`a10-h3`, { document, key: `a10-h3`, page: (data: ReturnType<typeof page>) => data.connection, into: model.scopes.feed })
    const result = renderCounted(() => query.use(scopeValue), wrapper(queryClient))
    await act(async () => {
      first.resolve({ data: page([{ id: `one`, group: `g`, title: `one` }], `cursor`, true) })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.result().hasNextPage).toBe(true)
    act(() => {
      result.result().fetchNextPage()
    })
    await settle()
    expect(result.result().isFetchingNextPage).toBe(true)
    expect(result.result().loadingState).toEqual(expect.objectContaining({ phase: `loading_more`, showFooterSpinner: true, showSkeleton: false, showRefreshIndicator: false }))
    await act(async () => {
      second.resolve({ data: page([{ id: `two`, group: `g`, title: `two` }], null, false) })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.result().hasNextPage).toBe(false)
    expect(result.result().isFetchingNextPage).toBe(false)
    const callsBefore = transport.calls.length
    act(() => {
      result.result().fetchNextPage()
    })
    await settle()
    expect(transport.calls).toHaveLength(callsBefore)
    result.unmount()
  })

  it(`H-4 transitions initial and refresh failures without losing prior rows`, async () => {
    const initialFailure = deferred<{ data: { rows: Row[] } }>()
    const success = deferred<{ data: { rows: Row[] } }>()
    const refreshFailure = deferred<{ data: { rows: Row[] } }>()
    const recovered = deferred<{ data: { rows: Row[] } }>()
    const responses = [initialFailure, success, refreshFailure, recovered]
    const transport = createAcceptanceTransport({ query: <TData,>() => responses.shift()!.promise as Promise<{ data: TData }> })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const initialModel = rowsModel(`A10H4Initial`)
    const initialQuery = initialModel.query(`a10-h4-initial`, { document, key: `a10-h4-initial`, select: (data: { rows: Row[] }) => data.rows, into: initialModel.scopes.feed })
    const initial = renderCounted(() => initialQuery.use(scopeValue), wrapper(queryClient))
    await act(async () => {
      initialFailure.reject(new Error(`initial failed`))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(initial.result().error).toMatchObject({ message: `initial failed` })
    expect(initial.result().loadingState).toEqual(expect.objectContaining({ phase: `error`, showErrorBanner: true, showSkeleton: false, showData: false }))
    initial.unmount()

    const model = rowsModel(`A10H4Refresh`)
    const query = model.query(`a10-h4-refresh`, { document, key: `a10-h4-refresh`, select: (data: { rows: Row[] }) => data.rows, into: model.scopes.feed })
    const result = renderCounted(() => query.use(scopeValue), wrapper(queryClient))
    await act(async () => {
      success.resolve({ data: { rows: [{ id: `row`, group: `g`, title: `before` }] } })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    let refresh!: Promise<void>
    act(() => {
      refresh = result.result().refetch()
    })
    await settle()
    await act(async () => {
      refreshFailure.reject(new Error(`refresh failed`))
      await refresh
    })
    await settle()
    expect(result.result().data).toEqual([{ id: `row`, group: `g`, title: `before` }])
    expect(result.result().error).toMatchObject({ message: `refresh failed` })
    expect(result.result().loadingState).toEqual(expect.objectContaining({ phase: `error`, showErrorBanner: true, showRefreshIndicator: false, showData: true }))
    const retry = result.result().refetch()
    await act(async () => {
      recovered.resolve({ data: { rows: [{ id: `row`, group: `g`, title: `recovered` }] } })
      await retry
    })
    expect(result.result().error).toBeNull()
    expect(result.result().data).toEqual([{ id: `row`, group: `g`, title: `recovered` }])
    result.unmount()
  })

  it(`H-5 starts warm persisted rows as refreshing rather than skeleton loading`, async () => {
    const storage = createMemoryPlane()
    const seedTransport = createAcceptanceTransport({ query: async <TData,>() => ({ data: { rows: [{ id: `row`, group: `g`, title: `persisted` }] } as TData }) })
    setupAcceptanceRuntime({ storage, transport: seedTransport })
    const seeded = rowsModel(`A10H5`)
    const seedQuery = seeded.query(`a10-h5`, { document, key: `a10-h5`, select: (data: { rows: Row[] }) => data.rows, into: seeded.scopes.feed })
    await seedQuery.fetch(scopeValue)
    flushPersistence()

    const hold = deferred<{ data: { rows: Row[] } }>()
    const transport = createAcceptanceTransport({ query: <TData,>() => hold.promise as Promise<{ data: TData }> })
    const { queryClient } = setupAcceptanceRuntime({ storage, transport })
    const hydrated = rowsModel(`A10H5`)
    replayJournal()
    const query = hydrated.query(`a10-h5`, { document, key: `a10-h5`, select: (data: { rows: Row[] }) => data.rows, into: hydrated.scopes.feed })
    const result = renderCounted(() => query.use(scopeValue), wrapper(queryClient))
    await settle()
    expect(result.result().data).toEqual([{ id: `row`, group: `g`, title: `persisted` }])
    expect(result.result().loadingState).toEqual(expect.objectContaining({ showSkeleton: false, showRefreshIndicator: true, showData: true }))
    await act(async () => {
      hold.resolve({ data: { rows: [{ id: `row`, group: `g`, title: `fresh` }] } })
      await Promise.resolve()
    })
    await settle()
    expect(result.result().data).toEqual([{ id: `row`, group: `g`, title: `fresh` }])
    expect(result.result().loadingState).toEqual(expect.objectContaining({ showSkeleton: false, showRefreshIndicator: false, showData: true }))
    result.unmount()
  })
})
