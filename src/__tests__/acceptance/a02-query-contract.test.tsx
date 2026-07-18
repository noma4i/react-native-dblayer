import React from 'react'
import { act } from 'react-test-renderer'
import {
  defineModel,
  defineQuery,
  f,
  QueryClientProvider,
  scope,
} from '../../index'
import {
  createAcceptanceTransport,
  renderCounted,
  setupAcceptanceRuntime,
} from './harness'

const document = { kind: `Document`, definitions: [] } as never
const scopeValue = { feed: `acceptance` }

function page(nodes: Array<{ id: string; title: string }>, endCursor: string | null, hasNextPage: boolean) {
  return { conn: { nodes, pageInfo: { endCursor, hasNextPage } } }
}

function queryWrapper(queryClient: ReturnType<typeof setupAcceptanceRuntime>[`queryClient`]) {
  return (child: React.ReactElement) =>
    React.createElement(QueryClientProvider, { client: queryClient }, child)
}

describe(`A02 query contract`, () => {
  it(`A02-1 cursor pagination preserves server order`, async () => {
    const responses = [
      page([{ id: `b`, title: `b` }, { id: `a`, title: `a` }], `cursor-1`, true),
      page([{ id: `c`, title: `c` }], null, false),
    ]
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({ data: responses.shift() as TData }),
    })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = defineModel({
      id: `A02Cursor`,
      name: `A02Cursor`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) },
    })
    const query = defineQuery({
      document,
      key: `a02-cursor`,
      page: (data) => (data as ReturnType<typeof page>).conn,
      into: model.scopes.feed,
    })
    const result = renderCounted(() => query.use(scopeValue), queryWrapper(queryClient))
    const view = renderCounted(() => model.scopes.feed.use(scopeValue))

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(view.result().map((row) => row.id)).toEqual([`b`, `a`])
    act(() => {
      result.result().fetchNextPage()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(view.result().map((row) => row.id)).toEqual([`b`, `a`, `c`])
    expect(transport.calls).toHaveLength(2)
    expect((transport.calls[1]?.operation as { variables?: { after?: string } }).variables?.after).toBe(`cursor-1`)
    result.unmount()
    view.unmount()
  })

  it(`A02-2 complete coverage detaches membership without destroying entities`, async () => {
    const responses = [
      { items: [{ id: `x`, title: `x` }, { id: `y`, title: `y` }, { id: `z`, title: `z` }] },
      { items: [{ id: `x`, title: `x` }, { id: `z`, title: `z` }] },
    ]
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({ data: responses.shift() as TData }),
    })
    setupAcceptanceRuntime({ transport })
    const model = defineModel({
      id: `A02Complete`,
      name: `A02Complete`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) },
    })
    const query = defineQuery({
      document,
      key: `a02-complete`,
      select: (data) => (data as { items: Array<{ id: string; title: string }> }).items,
      into: model.scopes.feed,
      coverage: `complete`,
    })
    const view = renderCounted(() => model.scopes.feed.use(scopeValue))

    await act(async () => {
      await query.fetch(scopeValue)
      await query.fetch(scopeValue)
    })
    expect(view.result().map((row) => row.id)).toEqual([`x`, `z`])
    expect(model.get(`y`)).toEqual({ id: `y`, title: `y` })
    view.unmount()
  })

  it(`A02-3 page coverage retains absent members after a first-page refetch`, async () => {
    const responses = [
      page([{ id: `p1a`, title: `p1a` }, { id: `p1b`, title: `p1b` }], `cursor-1`, true),
      page([{ id: `p2a`, title: `p2a` }], null, false),
      page([{ id: `p1a`, title: `p1a refreshed` }], `cursor-1`, true),
    ]
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({ data: responses.shift() as TData }),
    })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = defineModel({
      id: `A02Page`,
      name: `A02Page`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) },
    })
    const query = defineQuery({
      document,
      key: `a02-page`,
      page: (data) => (data as ReturnType<typeof page>).conn,
      into: model.scopes.feed,
    })
    const result = renderCounted(() => query.use(scopeValue), queryWrapper(queryClient))
    const view = renderCounted(() => model.scopes.feed.use(scopeValue))

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    act(() => {
      result.result().fetchNextPage()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await result.result().refetch()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(view.result().map((row) => row.id)).toEqual([`p1a`, `p1b`, `p2a`])
    expect(model.get(`p1a`)).toMatchObject({ title: `p1a refreshed` })
    result.unmount()
    view.unmount()
  })

  it(`A02-4 invalidate triggers a refetch and renders updated rows`, async () => {
    const responses = [
      { items: [{ id: `row`, title: `before` }] },
      { items: [{ id: `row`, title: `after` }] },
    ]
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({ data: responses.shift() as TData }),
    })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = defineModel({
      id: `A02Invalidate`,
      name: `A02Invalidate`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) },
    })
    const query = defineQuery({
      document,
      key: `a02-invalidate`,
      select: (data) => (data as { items: Array<{ id: string; title: string }> }).items,
      into: model.scopes.feed,
    })
    const result = renderCounted(() => query.use(scopeValue), queryWrapper(queryClient))

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    query.invalidate(scopeValue)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(transport.calls).toHaveLength(2)
    expect(result.result().data).toMatchObject([{ id: `row`, title: `after` }])
    result.unmount()
  })

  it(`A02-5 loading state, error surfacing, and empty results stay public`, async () => {
    let resolveInitial!: (value: { data: unknown }) => void
    let call = 0
    const transport = createAcceptanceTransport({
      query: <TData,>() => {
        call += 1
        if (call === 1) {
          return new Promise<{ data: TData }>((resolve) => {
            resolveInitial = resolve as (value: { data: unknown }) => void
          })
        }
        return Promise.reject(new Error(`later failure`))
      },
    })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = defineModel({
      id: `A02Loading`,
      name: `A02Loading`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) },
    })
    const query = defineQuery({
      document,
      key: `a02-loading`,
      select: (data) => (data as { items: Array<{ id: string; title: string }> }).items,
      into: model.scopes.feed,
    })
    const result = renderCounted(() => query.use(scopeValue), queryWrapper(queryClient))

    expect(result.result().loadingState.phase).toBe(`initial_loading`)
    expect(result.result().loadingState.showSkeleton).toBe(true)
    await act(async () => {
      resolveInitial({ data: { items: [{ id: `row`, title: `ready` }] } })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.result().loadingState.phase).toBe(`ready`)
    expect(result.result().data).toMatchObject([{ id: `row`, title: `ready` }])
    await act(async () => {
      await result.result().refetch()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.result().error).toMatchObject({ message: `later failure` })
    expect(result.result().loadingState.phase).toBe(`error`)
    expect(result.result().data).toMatchObject([{ id: `row`, title: `ready` }])
    result.unmount()

    const emptyTransport = createAcceptanceTransport({
      query: async <TData,>() => ({ data: { items: [] } as TData }),
    })
    const { queryClient: emptyClient } = setupAcceptanceRuntime({ transport: emptyTransport })
    const emptyModel = defineModel({
      id: `A02Empty`,
      name: `A02Empty`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) },
    })
    const emptyQuery = defineQuery({
      document,
      key: `a02-empty`,
      select: (data) => (data as { items: Array<{ id: string; title: string }> }).items,
      into: emptyModel.scopes.feed,
    })
    const emptyResult = renderCounted(() => emptyQuery.use(scopeValue), queryWrapper(emptyClient))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(emptyResult.result().loadingState.phase).toBe(`ready`)
    expect(emptyResult.result().loadingState.showEmptyState).toBe(true)
    emptyResult.unmount()
  })

  it(`A02-6 useWindow grows locally before the query loads another page`, async () => {
    const responses = [
      page([{ id: `one`, title: `one` }, { id: `two`, title: `two` }, { id: `three`, title: `three` }], `cursor-1`, true),
      page([{ id: `four`, title: `four` }], null, false),
    ]
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({ data: responses.shift() as TData }),
    })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = defineModel({
      id: `A02Window`,
      name: `A02Window`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) },
    })
    const query = defineQuery({
      document,
      key: `a02-window`,
      page: (data) => (data as ReturnType<typeof page>).conn,
      into: model.scopes.feed,
    })
    const result = renderCounted(() => query.use(scopeValue), queryWrapper(queryClient))
    const window = renderCounted(() => model.scopes.feed.useWindow(scopeValue, { pageSize: 2 }))

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(window.result()).toMatchObject({ totalCount: 3, hasMore: true })
    expect(window.result().rows.map((row) => row.id)).toEqual([`one`, `two`])
    act(() => {
      window.result().fetchNextPage()
    })
    expect(window.result()).toMatchObject({ totalCount: 3, hasMore: false })
    expect(window.result().rows.map((row) => row.id)).toEqual([`one`, `two`, `three`])
    expect(result.result().hasNextPage).toBe(true)
    act(() => {
      result.result().fetchNextPage()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(window.result()).toMatchObject({ totalCount: 4, hasMore: false })
    expect(window.result().rows.map((row) => row.id)).toEqual([`one`, `two`, `three`, `four`])
    result.unmount()
    window.unmount()
  })

  it(`A02-7 extract sinks apply atomically with the primary scope page`, async () => {
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({
        data: {
          items: [{ id: `item`, title: `item` }],
          authors: [{ id: `author`, title: `author` }],
        } as TData,
      }),
    })
    setupAcceptanceRuntime({ transport })
    const items = defineModel({
      id: `A02ExtractItems`,
      name: `A02ExtractItems`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) },
    })
    const authors = defineModel({
      id: `A02ExtractAuthors`,
      name: `A02ExtractAuthors`,
      fields: { title: f.str() },
    })
    const query = defineQuery({
      document,
      key: `a02-extract`,
      select: (data) => (data as { items: Array<{ id: string; title: string }> }).items,
      into: items.scopes.feed,
      extract: ({ data }) => [{
        into: authors,
        rows: (data as { authors: Array<{ id: string; title: string }> }).authors,
      }],
    })
    const itemReader = renderCounted(() => items.scopes.feed.use(scopeValue))
    const authorReader = renderCounted(() => authors.use.row(`author`))
    const itemRenders = itemReader.renders()
    const authorRenders = authorReader.renders()

    await act(async () => {
      await query.fetch(scopeValue)
    })
    expect(itemReader.result()).toMatchObject([{ id: `item`, title: `item` }])
    expect(authorReader.result()).toMatchObject({ id: `author`, title: `author` })
    expect(itemReader.renders()).toBe(itemRenders + 1)
    expect(authorReader.renders()).toBe(authorRenders + 1)
    itemReader.unmount()
    authorReader.unmount()
  })

  it(`A02-8 disabled queries remain network-idle while local scope rows stay live`, () => {
    const transport = createAcceptanceTransport()
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = defineModel({
      id: `A02Disabled`,
      name: `A02Disabled`,
      fields: { feed: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { feed: `feed` }, sort: `server-order` }) },
    })
    act(() => {
      model.insertStored({ id: `local`, feed: `acceptance`, title: `local` })
    })
    const query = defineQuery({
      document,
      key: `a02-disabled`,
      select: (data) => (data as { items: Array<{ id: string; title: string }> }).items,
      into: model.scopes.feed,
    })
    const result = renderCounted(
      () => query.use(scopeValue, { enabled: false }),
      queryWrapper(queryClient),
    )

    expect(transport.calls).toHaveLength(0)
    expect(result.result().loadingState.phase).toBe(`ready`)
    expect(result.result().data).toMatchObject([{ id: `local`, title: `local` }])
    result.unmount()
  })
})
