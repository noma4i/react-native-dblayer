import { act } from 'react-test-renderer'
import React from 'react'
import { defineCommand, defineModel, f, QueryClientProvider, scope } from '../../index'
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
})
