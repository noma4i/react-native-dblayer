import {
  belongsTo,
  collectGarbage,
  defineIngest,
  defineModel,
  defineQuery,
  f,
  flushPersistence,
  replayJournal,
  resetRuntime,
} from '../../index'
import { collectionFor, ensureModelCollection } from '../../core/tanstack/facade'
import { createContractScenario } from '../helpers/contractScenario'
import { createMemoryStorage } from '../helpers/memoryStorage'

const document = { kind: `Document`, definitions: [] } as never

describe(`collection mirror`, () => {
  afterEach(() => {
    resetRuntime()
  })

  it(`mirrors insertStored and insertStoredMany`, () => {
    createContractScenario()
    const model = defineModel({
      id: `MirrorInsert`,
      name: `MirrorInsert`,
      fields: { title: f.str() },
    })

    model.insertStored({ id: `one`, title: `one` })
    model.insertStoredMany([
      { id: `two`, title: `two` },
      { id: `three`, title: `three` },
    ])

    expect(
      collectionFor(`MirrorInsert`).toArray
        .map((row) => model.get(row.id))
        .sort((left, right) => left!.id.localeCompare(right!.id)),
    ).toEqual(
      model.getAll().sort((left, right) => left.id.localeCompare(right.id)),
    )
  })

  it(`mirrors patches without emitting for an idempotent patch`, () => {
    createContractScenario()
    const model = defineModel({
      id: `MirrorPatch`,
      name: `MirrorPatch`,
      fields: { title: f.str() },
    })
    model.insertStored({ id: `row`, title: `before` })
    const collection = collectionFor(`MirrorPatch`)
    let callbacks = 0
    const subscription = collection.subscribeChanges(() => {
      callbacks += 1
    })

    model.patch(`row`, { title: `after` })
    expect(collection.get(`row`)).toMatchObject({ id: `row`, title: `after` })
    expect(callbacks).toBe(1)

    callbacks = 0
    model.patch(`row`, { title: `after` })
    expect(collection.get(`row`)).toMatchObject({ id: `row`, title: `after` })
    expect(callbacks).toBe(0)
    subscription.unsubscribe()
  })

  it(`removes destroyed rows from the mirror`, () => {
    createContractScenario()
    const model = defineModel({
      id: `MirrorDestroy`,
      name: `MirrorDestroy`,
      fields: { title: f.str() },
    })
    model.insertStored({ id: `row`, title: `present` })

    model.destroy(`row`)

    expect(collectionFor(`MirrorDestroy`).get(`row`)).toBeUndefined()
  })

  it(`mirrors query apply replacements and ingest events`, async () => {
    const storage = createContractScenario({
      transport: {
        query: async <TData,>() => ({
          data: { rows: [{ id: `query`, title: `query` }] } as TData,
        }),
      },
    })
    const model = defineModel({
      id: `MirrorNetwork`,
      name: `MirrorNetwork`,
      fields: { title: f.str() },
    })
    const query = defineQuery({
      document,
      key: `mirror-network`,
      select: (data) => (data as { rows: Array<{ id: string; title: string }> }).rows,
      into: model,
    })
    const ingest = defineIngest(model, {
      received: (payload) => ({ upsert: payload }),
    })

    await query.fetch({})
    ingest.apply(`received`, { id: `event`, title: `event` })

    expect(
      collectionFor(`MirrorNetwork`).toArray
        .map((row) => model.get(row.id))
        .sort((left, right) => left!.id.localeCompare(right!.id)),
    ).toEqual(
      model.getAll().sort((left, right) => left.id.localeCompare(right.id)),
    )
    expect(storage.values.size).toBeGreaterThan(0)
  })

  it(`mirrors counter cache updates from relations`, () => {
    createContractScenario()
    const parent = defineModel({
      id: `MirrorCounterParent`,
      name: `MirrorCounterParent`,
      fields: { count: f.num() },
    })
    const child = defineModel({
      id: `MirrorCounterChild`,
      name: `MirrorCounterChild`,
      fields: { parentId: f.id() },
      relations: () => ({
        parent: belongsTo(parent, {
          foreignKey: `parentId`,
          counterCache: { field: `count` },
        }),
      }),
    })
    parent.insertStored({ id: `parent`, count: 0 })

    child.insertStored({ id: `child`, parentId: `parent` })

    expect(collectionFor(`MirrorCounterParent`).get(`parent`)).toMatchObject({
      id: `parent`,
      count: 1,
    })
  })

  it(`mirrors maintenance garbage collection evictions`, () => {
    createContractScenario()
    const model = defineModel({
      id: `MirrorGc`,
      name: `MirrorGc`,
      fields: { title: f.str() },
    })
    model.insertStored({ id: `orphan`, title: `orphan` })
    expect(collectionFor(`MirrorGc`).get(`orphan`)).toBeDefined()

    collectGarbage()

    expect(model.get(`orphan`)).toBeUndefined()
    expect(collectionFor(`MirrorGc`).get(`orphan`)).toBeUndefined()
  })

  it(`clears collections on reset and mirrors subsequent writes`, () => {
    createContractScenario()
    const model = defineModel({
      id: `MirrorReset`,
      name: `MirrorReset`,
      fields: { title: f.str() },
    })
    model.insertStored({ id: `before`, title: `before` })

    resetRuntime()

    expect(ensureModelCollection(`MirrorReset`).toArray).toEqual([])
    model.insertStored({ id: `after`, title: `after` })
    expect(collectionFor(`MirrorReset`).get(`after`)).toMatchObject({
      id: `after`,
      title: `after`,
    })
  })

  it(`seeds hydrated rows before replaying journal-only rows after restart`, () => {
    const memory = createMemoryStorage()
    createContractScenario({
      storage: memory,
      persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 },
    })
    const first = defineModel({
      id: `MirrorRestart`,
      name: `MirrorRestart`,
      fields: { title: f.str() },
    })
    first.insertStored({ id: `hydrated`, title: `hydrated` })
    flushPersistence()
    first.insertStored({ id: `journal`, title: `journal` })

    createContractScenario({
      storage: memory,
      persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 },
    })
    const restarted = defineModel({
      id: `MirrorRestart`,
      name: `MirrorRestart`,
      fields: { title: f.str() },
    })

    replayJournal()

    expect(
      collectionFor(`MirrorRestart`).toArray
        .map((row) => restarted.get(row.id))
        .sort((left, right) => left!.id.localeCompare(right!.id)),
    ).toEqual(
      restarted.getAll().sort((left, right) => left.id.localeCompare(right.id)),
    )
    expect(restarted.getAll().map((row) => row.id).sort()).toEqual([
      `hydrated`,
      `journal`,
    ])
  })
})
