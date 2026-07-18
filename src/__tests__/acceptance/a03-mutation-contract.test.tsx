import { act } from 'react-test-renderer'
import {
  defineModel,
  f,
  hasMany,
  isTempId,
  scope,
} from '../../index'
import {
  createAcceptanceTransport,
  renderCounted,
  setupAcceptanceRuntime,
} from './harness'

type Row = { id: string; group?: string; title: string; localUri?: string; extra?: string }

const document = { kind: `Document`, definitions: [] } as never
const scopeValue = { group: `scope-1` }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function scopedModel(id: string) {
  return defineModel({
    id,
    name: id,
    fields: { group: f.str(), title: f.str(), localUri: f.str(), extra: f.str() },
    scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) },
  })
}

describe(`A03 mutation contract`, () => {
  it(`A03-1 swaps a temp row for a server row in one scope render`, async () => {
    const hold = deferred<{ data: { save: Row } }>()
    const transport = createAcceptanceTransport({
      mutation: <TData,>() => hold.promise as Promise<{ data: TData }>,
    })
    setupAcceptanceRuntime({ transport })
    const model = scopedModel(`A03Swap`)
    const mutation = model.mutation<{ save: Row }, { title: string }, Row, Row>(`swap`, { dedupe: false,
      document,
      result: `save`,
      optimistic: {
        model,
        build: (input, context) => ({ id: context.tempId!, group: `scope-1`, title: input.title }),
        selectServerNode: (data) => data.save,
      },
    })
    const transitions: string[][] = []
    const reader = renderCounted(() => {
      const rows = model.scopes.feed.use(scopeValue)
      transitions.push(rows.map((row) => row.id))
      return rows
    })
    let pending!: Promise<{ save: Row } | null>

    act(() => {
      pending = mutation.run({ title: `draft` })
    })
    const tempRow = reader.result()[0]
    expect(tempRow).toMatchObject({ group: `scope-1`, title: `draft` })
    expect(isTempId(tempRow!.id)).toBe(true)
    expect(reader.renders()).toBe(2)
    await act(async () => {
      hold.resolve({ data: { save: { id: `server-1`, group: `scope-1`, title: `draft` } } })
      await pending
    })
    expect(reader.result().map((row) => row.id)).toEqual([`server-1`])
    expect(isTempId(reader.result()[0]!.id)).toBe(false)
    expect(reader.renders()).toBe(3)
    expect(transitions).toHaveLength(3)
    expect(transitions[1]).toHaveLength(1)
    expect(transitions[2]).toEqual([`server-1`])
    console.log(
      `A03-RESULT 1: renders=${reader.renders()},transitions=${transitions.map((rows) => rows.join(`,`)).join(`>`)}`,
    )
    reader.unmount()
  })

  it(`A03-2 renders concurrent ingest rows while an optimistic insert is pending`, async () => {
    const hold = deferred<{ data: { save: Row } }>()
    const transport = createAcceptanceTransport({
      mutation: <TData,>() => hold.promise as Promise<{ data: TData }>,
    })
    setupAcceptanceRuntime({ transport })
    const model = scopedModel(`A03Concurrent`)
    const mutation = model.mutation<{ save: Row }, { title: string }, Row, Row>(`concurrent`, { dedupe: false,
      document,
      result: `save`,
      optimistic: {
        model,
        build: (input, context) => ({ id: context.tempId!, group: `scope-1`, title: input.title }),
        selectServerNode: (data) => data.save,
      },
    })
    const ingest = model.ingest({
      received: { handler: (payload) => ({ upsert: payload }) },
    })
    const transitions: string[][] = []
    const reader = renderCounted(() => {
      const rows = model.scopes.feed.use(scopeValue)
      transitions.push(rows.map((row) => row.id))
      return rows
    })
    let pending!: Promise<{ save: Row } | null>

    act(() => {
      pending = mutation.run({ title: `draft` })
    })
    act(() => {
      ingest.apply(`received`, { id: `unrelated`, group: `scope-1`, title: `event` })
    })
    expect(reader.result()).toHaveLength(2)
    expect(isTempId(reader.result()[0]!.id)).toBe(true)
    expect(reader.result()[1]).toMatchObject({ id: `unrelated`, title: `event` })
    expect(reader.renders()).toBe(3)
    await act(async () => {
      hold.resolve({ data: { save: { id: `server-1`, group: `scope-1`, title: `draft` } } })
      await pending
    })
    expect(reader.result().map((row) => row.id)).toEqual([`server-1`, `unrelated`])
    expect(reader.renders()).toBe(4)
    console.log(
      `A03-RESULT 2: renders=${reader.renders()},transitions=${transitions.map((rows) => rows.join(`,`)).join(`>`)}`,
    )
    reader.unmount()
  })

  it(`A03-3 insert rollback restores the exact pre-state`, async () => {
    const transport = createAcceptanceTransport({
      mutation: async () => Promise.reject(new Error(`insert failed`)),
    })
    setupAcceptanceRuntime({ transport })
    const model = scopedModel(`A03InsertRollback`)
    const mutation = model.mutation<{ save: Row }, { title: string }, Row, Row>(`rollback`, { dedupe: false,
      document,
      result: `save`,
      optimistic: {
        model,
        build: (input, context) => ({ id: context.tempId!, group: `scope-1`, title: input.title }),
        selectServerNode: (data) => data.save,
      },
    })
    const reader = renderCounted(() => model.scopes.feed.use(scopeValue))
    const baseline = JSON.stringify(model.getAll())
    let pending!: Promise<{ save: Row } | null>

    act(() => {
      pending = mutation.run({ title: `draft` })
    })
    const rejection = expect(pending).rejects.toThrow(`insert failed`)
    expect(reader.result()).toHaveLength(1)
    await act(async () => {
      await rejection
    })
    expect(reader.result()).toEqual([])
    expect(JSON.stringify(model.getAll())).toBe(baseline)
    reader.unmount()
  })

  it(`A03-4 patch rollback restores changed fields and removes added keys`, async () => {
    const transport = createAcceptanceTransport({
      mutation: async () => Promise.reject(new Error(`patch failed`)),
    })
    setupAcceptanceRuntime({ transport })
    const model = scopedModel(`A03PatchRollback`)
    act(() => {
      model.insertStored({ id: `row`, group: `scope-1`, title: `original` })
    })
    const mutation = model.mutation<{ save: Row }, { id: string }, Row, Row>(`patch`, { dedupe: false,
      document,
      result: `save`,
      optimistic: {
        method: `patch`,
        model,
        selectId: (input) => input.id,
        selectPatch: () => ({ title: `edited`, extra: `added` }),
      },
    })

    const pending = mutation.run({ id: `row` })
    const rejection = expect(pending).rejects.toThrow(`patch failed`)
    expect(model.get(`row`)).toMatchObject({ title: `edited`, extra: `added` })
    await act(async () => {
      await rejection
    })
    expect(model.get(`row`)).toEqual({ id: `row`, group: `scope-1`, title: `original` })
  })

  it(`A03-5 destroy rollback restores original server order`, async () => {
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({
        data: { items: [{ id: `r1`, title: `r1` }, { id: `r2`, title: `r2` }, { id: `r3`, title: `r3` }] } as TData,
      }),
      mutation: async () => Promise.reject(new Error(`destroy failed`)),
    })
    setupAcceptanceRuntime({ transport })
    const model = defineModel({
      id: `A03DestroyRollback`,
      name: `A03DestroyRollback`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) },
    })
    const query = model.query(`destroy-seed`, {
      document,
      select: (data) => (data as { items: Array<{ id: string; title: string }> }).items,
      into: model.scopes.feed,
    })
    await act(async () => {
      await query.fetch(scopeValue)
    })
    const reader = renderCounted(() => model.scopes.feed.use(scopeValue))
    const mutation = model.mutation<{ destroy: { id: string } }, { id: string }, Row, Row>(`destroy`, { dedupe: false,
      document,
      result: `destroy`,
      optimistic: { method: `destroy`, model, selectId: (input) => input.id },
    })

    let pending!: Promise<{ destroy: { id: string } } | null>
    act(() => {
      pending = mutation.run({ id: `r2` })
    })
    const rejection = expect(pending).rejects.toThrow(`destroy failed`)
    expect(reader.result().map((row) => row.id)).toEqual([`r1`, `r3`])
    await act(async () => {
      await rejection
    })
    expect(reader.result().map((row) => row.id)).toEqual([`r1`, `r2`, `r3`])
    reader.unmount()
  })

  it(`A03-6 dedupe skips pending and committed duplicate keys`, async () => {
    const hold = deferred<{ data: { save: Row } }>()
    const transport = createAcceptanceTransport({
      mutation: <TData,>() => hold.promise as Promise<{ data: TData }>,
    })
    setupAcceptanceRuntime({ transport })
    const model = scopedModel(`A03Dedupe`)
    const mutation = model.mutation<{ save: Row }, { key: string }, Row, Row>(`dedupe`, {
      document,
      result: `save`,
      dedupe: { key: (input) => input.key },
      optimistic: {
        model,
        build: (_input, context) => ({ id: context.tempId!, group: `scope-1`, title: `draft` }),
        selectServerNode: (data) => data.save,
      },
    })

    const first = mutation.run({ key: `same` })
    await expect(mutation.run({ key: `same` })).resolves.toBeNull()
    expect(transport.calls.filter((call) => call.kind === `mutation`)).toHaveLength(1)
    hold.resolve({ data: { save: { id: `server-1`, group: `scope-1`, title: `saved` } } })
    await expect(first).resolves.toEqual({ save: { id: `server-1`, group: `scope-1`, title: `saved` } })
    await expect(mutation.run({ key: `same` })).resolves.toBeNull()
    expect(transport.calls.filter((call) => call.kind === `mutation`)).toHaveLength(1)
  })

  it(`A03-7 preserveOnCommit retains client-only fields`, async () => {
    const transport = createAcceptanceTransport({
      mutation: async <TData,>() => ({
        data: { save: { id: `server-1`, group: `scope-1`, title: `server` } } as TData,
      }),
    })
    setupAcceptanceRuntime({ transport })
    const model = scopedModel(`A03Preserve`)
    const mutation = model.mutation<{ save: Row }, Record<string, never>, Row, Row>(`failure`, { dedupe: false,
      document,
      result: `save`,
      optimistic: {
        model,
        build: (_input, context) => ({
          id: context.tempId!,
          group: `scope-1`,
          title: `draft`,
          localUri: `file://local`,
        }),
        selectServerNode: (data) => data.save,
        preserveOnCommit: [`localUri`],
      },
    })

    await act(async () => {
      await mutation.run({})
    })
    expect(model.get(`server-1`)).toEqual({
      id: `server-1`,
      group: `scope-1`,
      title: `server`,
      localUri: `file://local`,
    })
  })

  it(`A03-8 extract sinks commit atomically with the optimistic replacement`, async () => {
    const transport = createAcceptanceTransport({
      mutation: async <TData,>() => ({
        data: {
          save: { id: `server-1`, group: `scope-1`, title: `server` },
          authors: [{ id: `author`, title: `author` }],
        } as TData,
      }),
    })
    setupAcceptanceRuntime({ transport })
    const model = scopedModel(`A03ExtractMain`)
    const authors = defineModel({
      id: `A03ExtractAuthors`,
      name: `A03ExtractAuthors`,
      fields: { title: f.str() },
    })
    const mutation = model.mutation<{ save: Row; authors: Array<{ id: string; title: string }> }, Record<string, never>, Row, Row>(`extract`, { dedupe: false,
      document,
      result: `save`,
      optimistic: {
        model,
        build: (_input, context) => ({ id: context.tempId!, group: `scope-1`, title: `draft` }),
        selectServerNode: (data) => data.save,
      },
      extract: ({ data }) => [{ into: authors, rows: data.authors }],
    })
    const authorReader = renderCounted(() => authors.use.row(`author`))
    const rendersBefore = authorReader.renders()

    await act(async () => {
      await mutation.run({})
    })
    expect(authorReader.result()).toMatchObject({ id: `author`, title: `author` })
    expect(authorReader.renders()).toBe(rendersBefore + 1)
    authorReader.unmount()
  })

  it(`A03-9 rejects optimistic destroy on dependent cascade models before transport`, async () => {
    const transport = createAcceptanceTransport()
    setupAcceptanceRuntime({ transport })
    const child = defineModel({
      id: `A03CascadeChild`,
      name: `A03CascadeChild`,
      fields: { parentId: f.id() },
    })
    const parent = defineModel({
      id: `A03CascadeParent`,
      name: `A03CascadeParent`,
      fields: { title: f.str() },
      relations: () => ({ children: hasMany(child, { foreignKey: `parentId`, dependent: `destroy` }) }),
    })
    act(() => {
      parent.insertStored({ id: `parent`, title: `parent` })
      child.insertStored({ id: `child`, parentId: `parent` })
    })
    const mutation = parent.mutation<{ destroy: { id: string } }, { id: string }, Row, Row>(`cascade-destroy`, { dedupe: false,
      document,
      result: `destroy`,
      optimistic: { method: `destroy`, model: parent, selectId: (input) => input.id },
    })

    await expect(mutation.run({ id: `parent` })).rejects.toThrow(`dependent cascades`)
    expect(transport.calls).toHaveLength(0)
    expect(parent.get(`parent`)).toBeDefined()
    expect(child.get(`child`)).toBeDefined()
  })

  it(`A03-10 prepends an optimistic insert into server order without replacing existing rows`, async () => {
    const hold = deferred<{ data: { save: Row } }>()
    setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: <TData,>() => hold.promise as Promise<{ data: TData }> }) })
    const model = scopedModel(`A03Prepend`)
    act(() => { model.insertStored({ id: `first`, group: `scope-1`, title: `first` }); model.insertStored({ id: `second`, group: `scope-1`, title: `second` }) })
    const reader = renderCounted(() => model.scopes.feed.use(scopeValue))
    const existing = reader.result()[0]
    const mutation = model.mutation<{ save: Row }, { title: string }, Row, Row>(`prepend`, { dedupe: false, document, result: `save`, optimistic: { model, build: (input, context) => ({ id: context.tempId!, title: input.title }), selectServerNode: data => data.save, prependTo: { scope: model.scopes.feed, value: () => scopeValue } } })
    act(() => { void mutation.run({ title: `draft` }) })
    expect(reader.result()[0]).toMatchObject({ title: `draft` })
    expect(reader.result()[1]).toBe(existing)
    expect(reader.renders()).toBe(2)
    reader.unmount()
  })

  it(`A03-11 appends an optimistic insert to the end of server order`, async () => {
    const hold = deferred<{ data: { save: Row } }>()
    setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: <TData,>() => hold.promise as Promise<{ data: TData }> }) })
    const model = scopedModel(`A03Append`)
    act(() => { model.insertStored({ id: `first`, group: `scope-1`, title: `first` }); model.insertStored({ id: `second`, group: `scope-1`, title: `second` }) })
    const reader = renderCounted(() => model.scopes.feed.use(scopeValue))
    const mutation = model.mutation<{ save: Row }, { title: string }, Row, Row>(`append`, { dedupe: false, document, result: `save`, optimistic: { model, build: (input, context) => ({ id: context.tempId!, title: input.title }), selectServerNode: data => data.save, appendTo: { scope: model.scopes.feed, value: () => scopeValue } } })
    act(() => { void mutation.run({ title: `draft` }) })
    expect(reader.result().at(-1)).toMatchObject({ title: `draft` })
    expect(reader.renders()).toBe(2)
    reader.unmount()
  })

  it(`A03-12 preserves prepend position through the temp to server swap`, async () => {
    const hold = deferred<{ data: { save: Row } }>()
    setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: <TData,>() => hold.promise as Promise<{ data: TData }> }) })
    const model = scopedModel(`A03PrependSwap`)
    act(() => { model.insertStored({ id: `first`, group: `scope-1`, title: `first` }); model.insertStored({ id: `second`, group: `scope-1`, title: `second` }) })
    const transitions: string[][] = []
    const reader = renderCounted(() => { const rows = model.scopes.feed.use(scopeValue); transitions.push(rows.map(row => row.id)); return rows })
    const mutation = model.mutation<{ save: Row }, { title: string }, Row, Row>(`swap-prepend`, { dedupe: false, document, result: `save`, optimistic: { model, build: (input, context) => ({ id: context.tempId!, title: input.title }), selectServerNode: data => data.save, prependTo: { scope: model.scopes.feed, value: () => scopeValue } } })
    let pending!: Promise<{ save: Row } | null>
    act(() => { pending = mutation.run({ title: `draft` }) })
    await act(async () => { hold.resolve({ data: { save: { id: `server`, group: `scope-1`, title: `draft` } } }); await pending })
    expect(reader.result().map(row => row.id)).toEqual([`server`, `first`, `second`])
    expect(reader.renders()).toBe(3)
    expect(transitions).toHaveLength(3)
    expect(transitions[2]).toEqual([`server`, `first`, `second`])
    reader.unmount()
  })

  it(`A03-13 rollback restores the exact server-order sequence after prepend`, async () => {
    setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: async () => Promise.reject(new Error(`prepend failed`)) }) })
    const model = scopedModel(`A03PrependRollback`)
    act(() => { model.insertStored({ id: `first`, group: `scope-1`, title: `first` }); model.insertStored({ id: `second`, group: `scope-1`, title: `second` }) })
    const reader = renderCounted(() => model.scopes.feed.use(scopeValue))
    const before = reader.result().map(row => row.id)
    const previousRows = reader.result()
    const mutation = model.mutation<{ save: Row }, { title: string }, Row, Row>(`rollback-prepend`, { dedupe: false, document, result: `save`, optimistic: { model, build: (input, context) => ({ id: context.tempId!, title: input.title }), selectServerNode: data => data.save, prependTo: { scope: model.scopes.feed, value: () => scopeValue } } })
    const pending = mutation.run({ title: `draft` })
    await expect(pending).rejects.toThrow(`prepend failed`)
    expect(reader.result().map(row => row.id)).toEqual(before)
    expect(reader.result()).toEqual(previousRows)
    reader.unmount()
  })

  it(`A03-14 rejects placement into a field-sorted scope at definition`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({ id: `A03SortedReject`, name: `A03SortedReject`, fields: { title: f.str() }, scopes: { feed: scope({ sort: { field: `title`, dir: `asc` } }) } })
    expect(() => model.mutation<{ save: Row }, { title: string }, Row, Row>(`reject-placement`, { dedupe: false, document, result: `save`, optimistic: { model, build: (input, context) => ({ id: context.tempId!, title: input.title }), selectServerNode: data => data.save, prependTo: { scope: model.scopes.feed, value: () => ({}) } } })).toThrow(`server-order`)
  })

  it(`A03-15 leaves unrelated readers untouched through prepend and commit`, async () => {
    const hold = deferred<{ data: { save: Row } }>()
    setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: <TData,>() => hold.promise as Promise<{ data: TData }> }) })
    const model = scopedModel(`A03PrependIsolation`)
    const other = defineModel({ id: `A03PrependOther`, name: `A03PrependOther`, fields: { title: f.str() } })
    const otherReader = renderCounted(() => other.use.row(`other`))
    const before = otherReader.renders()
    const mutation = model.mutation<{ save: Row }, { title: string }, Row, Row>(`isolation-prepend`, { dedupe: false, document, result: `save`, optimistic: { model, build: (input, context) => ({ id: context.tempId!, title: input.title }), selectServerNode: data => data.save, prependTo: { scope: model.scopes.feed, value: () => scopeValue } } })
    let pending!: Promise<{ save: Row } | null>
    act(() => { pending = mutation.run({ title: `draft` }) })
    await act(async () => { hold.resolve({ data: { save: { id: `server`, group: `scope-1`, title: `draft` } } }); await pending })
    expect(otherReader.renders()).toBe(before)
    otherReader.unmount()
  })
})
