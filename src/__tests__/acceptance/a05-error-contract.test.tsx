import { act } from 'react-test-renderer'
import { defineIngest, defineModel, defineMutation, defineQuery, f, scope } from '../../index'
import { createAcceptanceTransport, renderCounted, setupAcceptanceRuntime } from './harness'

const document = { kind: `Document`, definitions: [] } as never

describe(`A05 error contract`, () => {
  it(`A05-1 contains a throwing ingest handler and processes the next event`, () => {
    const onSyncError = jest.fn()
    setupAcceptanceRuntime({ defaults: { onSyncError } })
    const model = defineModel({ id: `A05Ingest`, name: `A05Ingest`, fields: { title: f.str() } })
    const ingest = defineIngest(model, {
      bad: () => { throw new Error(`bad event`) },
      good: payload => ({ upsert: payload }),
    })
    expect(() => ingest.apply(`bad`, {})).not.toThrow()
    act(() => { ingest.apply(`good`, { id: `good`, title: `good` }) })
    expect(model.get(`good`)).toEqual({ id: `good`, title: `good` })
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ source: `ingest`, event: `bad`, model: `A05Ingest` }))
  })

  it(`A05-2 reports a query transport error`, async () => {
    const onSyncError = jest.fn()
    const transport = createAcceptanceTransport({ query: async () => Promise.reject(new Error(`query failed`)) })
    setupAcceptanceRuntime({ transport, defaults: { onSyncError } })
    const model = defineModel({ id: `A05Query`, name: `A05Query`, fields: { title: f.str() }, scopes: { feed: scope({}) } })
    const query = defineQuery({ document, key: `a05-query`, select: () => [], into: model.scopes.feed })
    await expect(query.fetch({})).rejects.toThrow(`query failed`)
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ source: `query`, model: `A05Query`, key: `a05-query` }))
  })

  it(`A05-3 reports mutation transport errors while rolling back`, async () => {
    const onSyncError = jest.fn()
    const transport = createAcceptanceTransport({ mutation: async () => Promise.reject(new Error(`mutation failed`)) })
    setupAcceptanceRuntime({ transport, defaults: { onSyncError } })
    const model = defineModel({ id: `A05Mutation`, name: `A05Mutation`, fields: { title: f.str() } })
    const mutation = defineMutation<{ save: { id: string; title: string } }, Record<string, never>, { id: string; title: string }, { id: string; title: string }>({ document, result: `save`, optimistic: { model, build: (_input, context) => ({ id: context.tempId!, title: `pending` }), selectServerNode: data => data.save } })
    await expect(mutation.run({})).rejects.toThrow(`mutation failed`)
    expect(model.getAll()).toEqual([])
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ source: `mutation`, model: `A05Mutation` }))
  })

  it(`A05-4 reports contained post-commit callback errors`, async () => {
    const onSyncError = jest.fn()
    const transport = createAcceptanceTransport({ mutation: async <TData,>() => ({ data: { save: { id: `server`, title: `server` } } as TData }) })
    setupAcceptanceRuntime({ transport, defaults: { onSyncError } })
    const model = defineModel({ id: `A05Commit`, name: `A05Commit`, fields: { title: f.str() } })
    const mutation = defineMutation<{ save: { id: string; title: string } }, Record<string, never>, { id: string; title: string }, { id: string; title: string }>({ document, result: `save`, optimistic: { model, build: (_input, context) => ({ id: context.tempId!, title: `pending` }), selectServerNode: data => data.save }, onCommit: () => { throw new Error(`commit failed`) } })
    await expect(mutation.run({})).resolves.toBeDefined()
    expect(model.get(`server`)).toEqual({ id: `server`, title: `server` })
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ source: `mutation` }))
  })

  it(`A05-5 contains onSyncError failures`, async () => {
    const transport = createAcceptanceTransport({ mutation: async () => Promise.reject(new Error(`mutation failed`)) })
    setupAcceptanceRuntime({ transport, defaults: { onSyncError: () => { throw new Error(`observer failed`) } } })
    const model = defineModel({ id: `A05Observer`, name: `A05Observer`, fields: { title: f.str() } })
    const mutation = defineMutation<{ save: { id: string; title: string } }, Record<string, never>, { id: string; title: string }, { id: string; title: string }>({ document, result: `save`, optimistic: { model, build: (_input, context) => ({ id: context.tempId!, title: `pending` }), selectServerNode: data => data.save } })
    await expect(mutation.run({})).rejects.toThrow(`mutation failed`)
    expect(model.getAll()).toEqual([])
  })
})
