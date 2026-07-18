import { createLiveQueryCollection, eq } from '@tanstack/db'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { configureDb } from '../../dsl/configure'
import { defineModel } from '../../dsl/defineModel'
import { scope } from '../../dsl/scope'
import { f } from '../../schema/f'
import { createMemoryStorage } from '../helpers/memoryStorage'
import { getScopeLiveReadRegistryStats } from '../../core/tanstack/liveScopeReads'
import {
  collectionFor,
  createModelCollection,
  hasWriter,
  resetCollectionRegistry,
  runInWriteBatch,
  type CollectionWriter,
  writerFor,
} from '../../core/tanstack/facade'

function writeOne(
  writer: CollectionWriter,
  change: Parameters<CollectionWriter[`write`]>[0],
): void {
  writer.begin()
  writer.write(change)
  writer.commit()
}

describe(`TanStack collection facade`, () => {
  afterEach(() => {
    resetCollectionRegistry()
  })

  it(`writes rows through the registered writer in one subscriber callback`, () => {
    const collection = createModelCollection(`facade-rows`)
    let callbacks = 0
    const subscription = collection.subscribeChanges(() => {
      callbacks += 1
    })
    const writer = writerFor(`facade-rows`)

    writer.begin()
    writer.write({ type: `insert`, value: { id: `1`, title: `first` } })
    writer.write({ type: `insert`, value: { id: `2`, title: `second` } })
    writer.commit()

    expect(collectionFor(`facade-rows`).get(`1`)).toMatchObject({
      id: `1`,
      title: `first`,
    })
    expect(collection.get(`2`)).toMatchObject({ id: `2`, title: `second` })
    expect(callbacks).toBe(1)

    subscription.unsubscribe()
  })

  it(`does not emit for an idempotent writer update`, () => {
    const collection = createModelCollection(`facade-idempotent`)
    let callbacks = 0
    const subscription = collection.subscribeChanges(() => {
      callbacks += 1
    })
    const writer = writerFor(`facade-idempotent`)
    writeOne(writer, {
      type: `insert`,
      value: { id: `1`, title: `unchanged` },
    })
    callbacks = 0

    writeOne(writer, {
      type: `update`,
      value: { id: `1`, title: `unchanged` },
    })

    expect(callbacks).toBe(0)
    subscription.unsubscribe()
  })

  it(`batches cross-collection live query recomputation`, () => {
    const entities = createModelCollection(`facade-entities`)
    const members = createModelCollection(`facade-members`)
    const joined = createLiveQueryCollection((query) =>
      query
        .from({ member: members })
        .join({ entity: entities }, ({ member, entity }) =>
          eq(member.rowId, entity.id),
        )
        .orderBy(({ member }) => member.order),
    )
    let callbacks = 0
    const subscription = joined.subscribeChanges(() => {
      callbacks += 1
    })
    writeOne(writerFor(`facade-entities`), {
      type: `insert`,
      value: { id: `entity-1`, title: `first` },
    })
    writeOne(writerFor(`facade-members`), {
      type: `insert`,
      value: { id: `member-1`, rowId: `entity-1`, order: 1 },
    })
    callbacks = 0

    runInWriteBatch(() => {
      writeOne(writerFor(`facade-entities`), {
        type: `insert`,
        value: { id: `entity-2`, title: `second` },
      })
      writeOne(writerFor(`facade-members`), {
        type: `insert`,
        value: { id: `member-2`, rowId: `entity-2`, order: 2 },
      })
    })

    expect(callbacks).toBe(1)
    subscription.unsubscribe()
  })

  it(`rejects missing writers after registry reset`, () => {
    expect(() => writerFor(`missing`)).toThrow(`Missing writer for missing`)

    const collection = createModelCollection(`facade-reset`)
    const subscription = collection.subscribeChanges(() => undefined)
    expect(hasWriter(`facade-reset`)).toBe(true)
    expect(writerFor(`facade-reset`)).toBeDefined()

    resetCollectionRegistry()

    expect(hasWriter(`facade-reset`)).toBe(false)
    expect(() => writerFor(`facade-reset`)).toThrow(
      `Missing writer for facade-reset`,
    )
    subscription.unsubscribe()
  })

  it(`shares one live scope entry between use and useWindow`, () => {
    const memory = createMemoryStorage()
    configureDb({
      storage: memory.storage,
      transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as never,
    })
    const model = defineModel({
      id: `facade-shared-scope`,
      name: `FacadeSharedScope`,
      fields: { group: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) },
    })
    const scopeValue = { group: `shared` }
    act(() => {
      model.scopes.feed.__apply?.(scopeValue, [{ id: `one`, group: `shared`, title: `one` }], `complete`)
    })

    const Reader = () => {
      model.scopes.feed.use(scopeValue)
      model.scopes.feed.useWindow(scopeValue, { pageSize: 1 })
      return null
    }
    let root!: TestRenderer.ReactTestRenderer
    act(() => {
      root = TestRenderer.create(React.createElement(Reader))
    })

    expect(getScopeLiveReadRegistryStats()).toEqual({ entryCount: 1, refCount: 2 })

    act(() => root.unmount())

    expect(getScopeLiveReadRegistryStats()).toEqual({ entryCount: 0, refCount: 0 })
  })
})
