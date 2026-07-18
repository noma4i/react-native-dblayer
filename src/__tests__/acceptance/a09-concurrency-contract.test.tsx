import { act } from 'react-test-renderer'
import {
  belongsTo,
  defineModel,
  f,
  isIncomingNewer,
  resetRuntime,
  scope,
} from '../../index'
import { createAcceptanceTransport, renderCounted, setupAcceptanceRuntime } from './harness'

const document = { kind: `Document`, definitions: [] } as never
const feed = { group: `g` }

type Row = { id: string; group: string; title: string; body?: string; updatedAt?: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function model(id: string) {
  return defineModel({
    id,
    name: id,
    fields: { group: f.str(), title: f.str(), body: f.str(), updatedAt: f.str() },
    scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) },
    merge: { shouldOverwrite: (existing, incoming) => isIncomingNewer((existing as Row).updatedAt, (incoming as Row).updatedAt) },
  })
}

describe(`A09 concurrency and anti-storm contracts`, () => {
  it(`G-1 arbitrates reverse-resolved overlapping fetches without render amplification`, async () => {
    const first = deferred<{ data: { rows: Row[] } }>()
    const second = deferred<{ data: { rows: Row[] } }>()
    let call = 0
    const transport = createAcceptanceTransport({
      query: <TData,>() => (call++ === 0 ? first.promise : second.promise) as Promise<{ data: TData }>,
    })
    setupAcceptanceRuntime({ transport })
    const rows = model(`A09G1`)
    const older = rows.query(`a09-g1-old`, { document, key: `a09-g1-old`, select: (data: { rows: Row[] }) => data.rows, into: rows.scopes.feed })
    const newer = rows.query(`a09-g1-new`, { document, key: `a09-g1-new`, select: (data: { rows: Row[] }) => data.rows, into: rows.scopes.feed })
    const reader = renderCounted(() => rows.scopes.feed.use(feed))
    const before = reader.renders()
    const pendingOld = older.fetch(feed)
    const pendingNew = newer.fetch(feed)

    await act(async () => {
      second.resolve({ data: { rows: [{ id: `shared`, group: `g`, title: `new`, updatedAt: `2026-01-02T00:00:00.000Z` }] } })
      await pendingNew
      first.resolve({ data: { rows: [{ id: `shared`, group: `g`, title: `old`, updatedAt: `2026-01-01T00:00:00.000Z` }] } })
      await pendingOld
    })

    expect(reader.result()).toEqual([{ id: `shared`, group: `g`, title: `new`, updatedAt: `2026-01-02T00:00:00.000Z` }])
    expect(reader.renders() - before).toBeLessThanOrEqual(2)
    reader.unmount()
  })

  it(`G-2 reconciles a pending insert with a complete snapshot of its server row`, async () => {
    const mutationHold = deferred<{ data: { save: Row } }>()
    const queryHold = deferred<{ data: { rows: Row[] } }>()
    const transport = createAcceptanceTransport({
      mutation: <TData,>() => mutationHold.promise as Promise<{ data: TData }>,
      query: <TData,>() => queryHold.promise as Promise<{ data: TData }>,
    })
    setupAcceptanceRuntime({ transport })
    const rows = model(`A09G2`)
    const mutation = rows.mutation<{ save: Row }, { title: string }, Row, Row>(`reconcile`, {
      document,
      result: `save`,
      dedupe: false,
      optimistic: {
        model: rows,
        build: (input, context) => ({ id: context.tempId!, group: `g`, title: input.title, updatedAt: `2026-01-01T00:00:00.000Z` }),
        selectServerNode: data => data.save,
      },
    })
    const query = rows.query(`a09-g2`, { document, key: `a09-g2`, select: (data: { rows: Row[] }) => data.rows, into: rows.scopes.feed, coverage: `complete` })
    const reader = renderCounted(() => rows.scopes.feed.use(feed))
    let pending!: Promise<{ save: Row } | null>
    act(() => {
      pending = mutation.run({ title: `draft` })
    })
    const snapshot = query.fetch(feed)
    await act(async () => {
      queryHold.resolve({ data: { rows: [{ id: `server`, group: `g`, title: `snapshot`, updatedAt: `2026-01-02T00:00:00.000Z` }] } })
      await snapshot
      mutationHold.resolve({ data: { save: { id: `server`, group: `g`, title: `saved`, updatedAt: `2026-01-03T00:00:00.000Z` } } })
      await pending
    })
    expect(reader.result()).toEqual([{ id: `server`, group: `g`, title: `saved`, updatedAt: `2026-01-03T00:00:00.000Z` }])
    reader.unmount()
  })

  it(`G-3 deterministically keeps the newer ingest winner while a mutation commits`, async () => {
    const hold = deferred<{ data: { save: Row } }>()
    const transport = createAcceptanceTransport({ mutation: <TData,>() => hold.promise as Promise<{ data: TData }> })
    setupAcceptanceRuntime({ transport })
    const rows = model(`A09G3`)
    const mutation = rows.mutation<{ save: Row }, Record<string, never>, Row, Row>(`ingest-winner`, {
      document,
      result: `save`,
      dedupe: false,
      optimistic: {
        model: rows,
        build: (_input, context) => ({ id: context.tempId!, group: `g`, title: `draft`, updatedAt: `2026-01-01T00:00:00.000Z` }),
        selectServerNode: data => data.save,
      },
    })
    const ingest = rows.ingest({ received: { handler: payload => ({ upsert: payload }) } })
    const reader = renderCounted(() => rows.scopes.feed.use(feed))
    const before = reader.renders()
    let pending!: Promise<{ save: Row } | null>
    act(() => {
      pending = mutation.run({})
    })
    await act(async () => {
      hold.resolve({ data: { save: { id: `server`, group: `g`, title: `commit`, updatedAt: `2026-01-02T00:00:00.000Z` } } })
      ingest.apply(`received`, { id: `server`, group: `g`, title: `ingest`, updatedAt: `2026-01-03T00:00:00.000Z` })
      await pending
    })
    expect(reader.result()).toEqual([{ id: `server`, group: `g`, title: `ingest`, updatedAt: `2026-01-03T00:00:00.000Z` }])
    expect(reader.renders() - before).toBeLessThanOrEqual(2)
    reader.unmount()
  })

  it(`G-4 fences stale query and mutation resolutions across resetRuntime`, async () => {
    const mutationHold = deferred<{ data: { save: Row } }>()
    const queryHolds = [deferred<{ data: { rows: Row[] } }>(), deferred<{ data: { rows: Row[] } }>()]
    let queryCall = 0
    const transport = createAcceptanceTransport({
      mutation: <TData,>() => mutationHold.promise as Promise<{ data: TData }>,
      query: <TData,>() => queryHolds[queryCall++]!.promise as Promise<{ data: TData }>,
    })
    setupAcceptanceRuntime({ transport })
    const rows = model(`A09G4`)
    const mutation = rows.mutation<{ save: Row }, Record<string, never>, Row, Row>(`reset`, {
      document,
      result: `save`,
      dedupe: false,
      optimistic: { model: rows, build: (_input, context) => ({ id: context.tempId!, group: `g`, title: `temp` }), selectServerNode: data => data.save },
    })
    const query = rows.query(`a09-g4`, { document, key: `a09-g4`, select: (data: { rows: Row[] }) => data.rows, into: rows.scopes.feed })
    const reader = renderCounted(() => rows.scopes.feed.use(feed))
    const pendingMutation = mutation.run({})
    const pendingQuery = query.fetch(feed)
    expect(transport.calls.filter(call => call.kind === `query`)).toHaveLength(1)
    act(() => {
      resetRuntime()
    })
    await act(async () => {
      mutationHold.resolve({ data: { save: { id: `ghost-mutation`, group: `g`, title: `ghost` } } })
      queryHolds[0]!.resolve({ data: { rows: [{ id: `ghost-query`, group: `g`, title: `ghost` }] } })
      await Promise.all([pendingMutation, pendingQuery])
    })
    expect(reader.result()).toEqual([])
    const fresh = query.fetch(feed)
    expect(transport.calls.filter(call => call.kind === `query`)).toHaveLength(2)
    await act(async () => {
      queryHolds[1]!.resolve({ data: { rows: [{ id: `fresh`, group: `g`, title: `fresh` }] } })
      await fresh
    })
    expect(reader.result()).toEqual([{ id: `fresh`, group: `g`, title: `fresh` }])
    reader.unmount()
  })

  it(`G-5 batches relation, extract, sequential-write, and seeded-fuzz notifications`, () => {
    setupAcceptanceRuntime()
    const parent = defineModel({ id: `A09G5Parent`, name: `A09G5Parent`, fields: { count: f.num(), title: f.str() } })
    const child = defineModel({
      id: `A09G5Child`,
      name: `A09G5Child`,
      fields: { parentId: f.id(), group: f.str(), title: f.str() },
      relations: () => ({ parent: belongsTo(parent, { foreignKey: `parentId`, counterCache: { field: `count` } }) }),
      scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) },
    })
    const extracted = defineModel({ id: `A09G5Extract`, name: `A09G5Extract`, fields: { title: f.str() } })
    act(() => {
      parent.insertStored({ id: `parent`, count: 0, title: `parent` })
    })
    const ingest = child.ingest({ page: { handler: payload => ({ upsert: (payload as { rows: Row[]; side: { id: string; title: string }[] }).rows, extract: [{ into: extracted, rows: (payload as { rows: Row[]; side: { id: string; title: string }[] }).side }] }) } })
    const scopeReader = renderCounted(() => child.scopes.feed.use(feed))
    const parentReader = renderCounted(() => parent.use.row(`parent`))
    const extractReader = renderCounted(() => extracted.use.row(`side`))
    const untouched = renderCounted(() => child.use.row(`untouched`))
    const before = [scopeReader.renders(), parentReader.renders(), extractReader.renders(), untouched.renders()]
    act(() => {
      ingest.apply(`page`, { rows: Array.from({ length: 20 }, (_, index) => ({ id: `batch-${index}`, parentId: `parent`, group: `g`, title: `batch-${index}` })), side: [{ id: `side`, title: `side` }] })
    })
    const afterBatch = [scopeReader.renders() - before[0]!, parentReader.renders() - before[1]!, extractReader.renders() - before[2]!, untouched.renders() - before[3]!]
    expect(afterBatch).toEqual([1, 1, 1, 0])

    const patchBefore = scopeReader.renders()
    act(() => {
      for (let index = 0; index < 20; index += 1) child.patch(`batch-${index}`, { title: `patch-${index}` })
    })
    const patchRenders = scopeReader.renders() - patchBefore
    expect(patchRenders).toBeLessThanOrEqual(20)
    const idempotentBefore = scopeReader.renders()
    act(() => {
      child.patch(`batch-19`, { title: `patch-19` })
    })
    const idempotentRenders = scopeReader.renders() - idempotentBefore
    expect(idempotentRenders).toBe(0)

    const SEED = 0xDB1A0E5
    let state = SEED >>> 0
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state
    }
    const expected = new Map(scopeReader.result().map(row => [row.id, row.title]))
    const fuzzBefore = scopeReader.renders()
    let logicalChanges = 0
    act(() => {
      for (let index = 0; index < 50; index += 1) {
        const id = `fuzz-${next() % 10}`
        const value = `v-${next() % 1000}`
        const operation = next() % 4
        if (operation === 0) {
          child.destroy(id)
          if (expected.delete(id)) logicalChanges += 1
        } else if (operation === 1) {
          if (expected.has(id) && expected.get(id) !== value) {
            child.patch(id, { title: value })
            expected.set(id, value)
            logicalChanges += 1
          }
        } else if (operation === 2) {
          if (expected.get(id) !== value) {
            ingest.apply(`page`, { rows: [{ id, parentId: `parent`, group: `g`, title: value }], side: [] })
            expected.set(id, value)
            logicalChanges += 1
          }
        } else {
          const previous = expected.get(id)
          if (previous !== value) {
            child.insertStored({ id, parentId: `parent`, group: `g`, title: value })
            expected.set(id, value)
            logicalChanges += 1
          }
        }
      }
    })
    expect(new Map(scopeReader.result().map(row => [row.id, row.title]))).toEqual(expected)
    const fuzzRenders = scopeReader.renders() - fuzzBefore
    expect(fuzzRenders).toBeLessThanOrEqual(logicalChanges)
    console.log(`A09-RESULT G5: batch scope=${afterBatch[0]},parent=${afterBatch[1]},extract=${afterBatch[2]},untouched=${afterBatch[3]}; patches=${patchRenders}; idempotent=${idempotentRenders}; fuzz=${fuzzRenders}/${logicalChanges}`)
    ;[scopeReader, parentReader, extractReader, untouched].forEach(reader => reader.unmount())
  })

  it(`G-6 preserves non-conflicting optimistic fields from reverse-resolved mutations`, async () => {
    const first = deferred<{ data: { save: { id: string } } }>()
    const second = deferred<{ data: { save: { id: string } } }>()
    let call = 0
    const transport = createAcceptanceTransport({ mutation: <TData,>() => (call++ === 0 ? first.promise : second.promise) as Promise<{ data: TData }> })
    setupAcceptanceRuntime({ transport })
    const rows = model(`A09G6`)
    act(() => {
      rows.insertStored({ id: `row`, group: `g`, title: `before`, body: `before` })
    })
    const title = rows.mutation<{ save: { id: string } }, { title: string }, Row, Row>(`title`, { document, result: `save`, dedupe: false, optimistic: { method: `patch`, model: rows, selectId: () => `row`, selectPatch: input => ({ title: input.title }) } })
    const body = rows.mutation<{ save: { id: string } }, { body: string }, Row, Row>(`body`, { document, result: `save`, dedupe: false, optimistic: { method: `patch`, model: rows, selectId: () => `row`, selectPatch: input => ({ body: input.body }) } })
    const reader = renderCounted(() => rows.use.row(`row`))
    const left = title.run({ title: `title` })
    const right = body.run({ body: `body` })
    await act(async () => {
      second.resolve({ data: { save: { id: `row` } } })
      await right
      first.resolve({ data: { save: { id: `row` } } })
      await left
    })
    expect(reader.result()).toMatchObject({ id: `row`, group: `g`, title: `title`, body: `body` })
    reader.unmount()
  })
})
