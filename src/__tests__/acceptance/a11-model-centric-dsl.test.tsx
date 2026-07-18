import { act } from 'react-test-renderer'
import React from 'react'
import { defineCommand, defineModel, f, QueryClientProvider, resetRuntime, scope } from '../../index'
import { createAcceptanceTransport, renderCounted, setupAcceptanceRuntime } from './harness'

const document = { kind: `Document`, definitions: [] } as never

describe(`A11 model-centric DSL`, () => {
  it(`delegates query conventions, pagination knobs, mutation forms, command, and fetch`, async () => {
    let mutationCalls = 0
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({ data: { rows: [{ id: `one`, group: `g`, title: `one` }], page: { nodes: [{ id: `two`, group: `g`, title: `two` }], pageInfo: { hasPreviousPage: true, startCursor: `2` } }, value: `ephemeral` } as TData }),
      mutation: async <TData,>() => { mutationCalls += 1; return { data: { save: { id: `one`, group: `g`, title: `saved` }, command: { ok: true } } as TData } }
    })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const first = defineModel({ id: `A11First`, name: `A11First`, fields: { group: f.str(), title: f.str() }, scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) } })
    const second = defineModel({ id: `A11Second`, name: `A11Second`, fields: { title: f.str() } })
    const query = first.query<{ rows: Array<{ id: string; group: string; title: string }> }, Record<string, never>, { group: string }, { id: string; group: string; title: string }>(`rows`, { document, select: data => data.rows })
    await query.fetch({ group: `g` })
    expect(first.get(`one`)).toMatchObject({ title: `one` })
    const scoped = first.query<{ page: { nodes: Array<{ id: string; group: string; title: string }>; pageInfo: { hasPreviousPage: boolean; startCursor: string } } }, { before?: number }, { group: string }, { id: string; group: string; title: string }>(`page`, { document, into: first.scopes.feed, page: data => data.page, direction: `backward`, cursorVar: `before`, getCursor: page => page.pageInfo?.startCursor ?? null, mapCursor: cursor => Number(cursor) })
    await scoped.fetch({ group: `g` })
    expect(first.scopes.feed.read({ group: `g` })).toHaveLength(1)
    const other = second.query<{ rows: Array<{ id: string; title: string }> }, Record<string, never>, Record<string, never>, { id: string; title: string }>(`rows`, { document, select: data => data.rows, key: `override` })
    await other.fetch({})
    expect(second.get(`one`)).toMatchObject({ title: `one` })
    const mutation = first.mutation<{ save: { id: string; group: string; title: string } }, { id: string; title: string }, { id: string; group: string; title: string }, { id: string; group: string; title: string }>(`save`, { document, result: `save`, optimistic: { method: `patch`, model: first, selectId: input => input.id, selectPatch: input => ({ title: input.title }) }, extract: ({ data }) => [{ into: second, rows: [data.save] }], onCommit: (_data, context) => first.patch(context.input.id, { title: context.input.title }) })
    first.insertStored({ id: `one`, group: `g`, title: `before` })
    await Promise.all([mutation.run({ id: `one`, title: `optimistic` }), mutation.run({ id: `one`, title: `optimistic` })])
    expect(mutationCalls).toBe(1)
    expect(first.get(`one`)).toMatchObject({ title: `optimistic` })
    const noDedupe = first.mutation<{ save: { id: string } }, { id: string }, { id: string }, { id: string }>(`no-dedupe`, { document, result: `save`, dedupe: false })
    await noDedupe.run({ id: `one` })
    await noDedupe.run({ id: `one` })
    expect(mutationCalls).toBe(3)
    const command = defineCommand<{ command: { ok: boolean } }, { id: string }, { id: string }, { id: string }>(`command`, { document, result: `command` })
    await Promise.all([command.run({ id: `one` }), command.run({ id: `one` })])
    expect(mutationCalls).toBe(4)
    const fetch = first.fetch<{ value: string }, Record<string, never>, string>(`value`, { document, select: data => data.value })
    expect(await fetch.fetch({})).toBe(`ephemeral`)
    const reader = renderCounted(() => fetch.use({}), child => React.createElement(QueryClientProvider, { client: queryClient }, child))
    await act(async () => { await Promise.resolve() })
    expect(reader.result().loadingState).not.toBe(`loading`)
    reader.unmount()
  })

  it(`keeps affected reader identities stable after an identical model query refetch`, async () => {
    const transport = createAcceptanceTransport({ query: async <TData,>() => ({ data: { rows: [{ id: `row`, title: `same` }] } as TData }) })
    setupAcceptanceRuntime({ transport })
    const model = defineModel({ id: `A11QueryIdentity`, name: `QueryIdentity`, fields: { title: f.str() } })
    const query = model.query<{ rows: Array<{ id: string; title: string }> }, Record<string, never>, Record<string, never>, { id: string; title: string }>(`rows`, { document, select: data => data.rows })
    const reader = renderCounted(() => model.use.where({}).rows())
    await act(async () => { await query.fetch({}) })
    const initial = reader.result()
    const initialRow = initial[0]
    const before = reader.renders()
    await act(async () => { await query.fetch({}) })
    expect(reader.renders() - before).toBe(0)
    expect(reader.result()).toBe(initial)
    expect(reader.result()[0]).toBe(initialRow)
    reader.unmount()
  })

  it(`stops query result reader renders after unmount`, async () => {
    const transport = createAcceptanceTransport({ query: async <TData,>() => ({ data: { rows: [{ id: `row`, title: `fresh` }] } as TData }) })
    setupAcceptanceRuntime({ transport })
    const model = defineModel({ id: `A11QueryUnmount`, name: `QueryUnmount`, fields: { title: f.str() } })
    const query = model.query<{ rows: Array<{ id: string; title: string }> }, Record<string, never>, Record<string, never>, { id: string; title: string }>(`rows`, { document, select: data => data.rows })
    const reader = renderCounted(() => model.use.where({}).rows())
    reader.unmount()
    const frozen = reader.renders()
    await act(async () => { await query.fetch({}) })
    expect(reader.renders()).toBe(frozen)
  })

  it(`keeps unchanged model fetch data stable across consumer rerenders`, async () => {
    const transport = createAcceptanceTransport({ query: async <TData,>() => ({ data: { value: `stable` } as TData }) })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = defineModel({ id: `A11FetchIdentity`, name: `FetchIdentity`, fields: { title: f.str() } })
    const fetch = model.fetch<{ value: string }, Record<string, never>, string>(`value`, { document, select: data => data.value })
    const reader = renderCounted(() => fetch.use({}), child => React.createElement(QueryClientProvider, { client: queryClient }, child))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const initial = reader.result()
    reader.rerender()
    expect(reader.result()).toBe(initial)
    reader.unmount()
  })

  it(`renders model fetch lifecycle once per transition and ignores unrelated writes`, async () => {
    let resolveQuery!: (value: { data: { value: string } }) => void
    const transport = createAcceptanceTransport({ query: <TData,>() => new Promise<{ data: TData }>(resolve => { resolveQuery = resolve as unknown as (value: { data: { value: string } }) => void }) })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = defineModel({ id: `A11FetchLifecycle`, name: `FetchLifecycle`, fields: { title: f.str() } })
    const other = defineModel({ id: `A11FetchLifecycleOther`, name: `FetchLifecycleOther`, fields: { title: f.str() } })
    const fetch = model.fetch<{ value: string }, Record<string, never>, string>(`value`, { document, select: data => data.value })
    const reader = renderCounted(() => fetch.use({}), child => React.createElement(QueryClientProvider, { client: queryClient }, child))
    expect(reader.result().loadingState.phase).toBe(`initial_loading`)
    const beforeResolve = reader.renders()
    await act(async () => { resolveQuery({ data: { value: `ready` } }); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(reader.result().data).toBe(`ready`)
    expect(reader.renders() - beforeResolve).toBe(1)
    const beforeOther = reader.renders()
    act(() => { other.insertStored({ id: `other`, title: `ignored` }) })
    expect(reader.renders() - beforeOther).toBe(0)
    reader.unmount()
  })

  it(`drops an in-flight model fetch after runtime reset`, async () => {
    let resolveQuery!: (value: { data: { value: string } }) => void
    const transport = createAcceptanceTransport({ query: <TData,>() => new Promise<{ data: TData }>(resolve => { resolveQuery = resolve as unknown as (value: { data: { value: string } }) => void }) })
    setupAcceptanceRuntime({ transport })
    const model = defineModel({ id: `A11FetchReset`, name: `FetchReset`, fields: { title: f.str() } })
    const fetch = model.fetch<{ value: string }, Record<string, never>, string>(`value`, { document, select: data => data.value })
    const pending = fetch.fetch({})
    act(() => { resetRuntime() })
    resolveQuery({ data: { value: `stale` } })
    await expect(pending).rejects.toThrow(`defineFetch response dropped - runtime was reset before it resolved`)
    expect(model.getAll()).toEqual([])
  })

  it(`does not render an unmounted model fetch after its request resolves`, async () => {
    let resolveQuery!: (value: { data: { value: string } }) => void
    const transport = createAcceptanceTransport({ query: <TData,>() => new Promise<{ data: TData }>(resolve => { resolveQuery = resolve as unknown as (value: { data: { value: string } }) => void }) })
    const { queryClient } = setupAcceptanceRuntime({ transport })
    const model = defineModel({ id: `A11FetchUnmount`, name: `FetchUnmount`, fields: { title: f.str() } })
    const fetch = model.fetch<{ value: string }, Record<string, never>, string>(`value`, { document, select: data => data.value })
    const reader = renderCounted(() => fetch.use({}), child => React.createElement(QueryClientProvider, { client: queryClient }, child))
    reader.unmount()
    const frozen = reader.renders()
    await act(async () => { resolveQuery({ data: { value: `late` } }); await Promise.resolve() })
    expect(reader.renders()).toBe(frozen)
  })

  it(`drops an in-flight command after runtime reset`, async () => {
    let resolveMutation!: (value: { data: { command: { ok: boolean } } }) => void
    const transport = createAcceptanceTransport({ mutation: <TData,>() => new Promise<{ data: TData }>(resolve => { resolveMutation = resolve as unknown as (value: { data: { command: { ok: boolean } } }) => void }) })
    setupAcceptanceRuntime({ transport })
    const target = defineModel({ id: `A11CommandResetTarget`, name: `CommandResetTarget`, fields: { title: f.str() } })
    const command = defineCommand<{ command: { ok: boolean } }, Record<string, never>, { id: string; title: string }, { ok: boolean }>(`reset-command`, { document, result: `command`, extract: () => [{ into: target, rows: [{ id: `stale`, title: `stale` }] }] })
    const pending = command.run({})
    act(() => { resetRuntime() })
    resolveMutation({ data: { command: { ok: true } } })
    await expect(pending).resolves.toBeNull()
    expect(target.getAll()).toEqual([])
  })
})
