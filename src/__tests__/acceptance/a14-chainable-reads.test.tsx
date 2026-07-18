import { act } from 'react-test-renderer'
import { defineModel, f, resetRuntime } from '../../index'
import { renderCounted, setupAcceptanceRuntime } from './harness'

describe(`A14 chainable reads`, () => {
  it(`moves matching rows in and out with one render per write`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({ id: `A14Movement`, name: `Movement`, fields: { group: f.str(), title: f.str() } })
    model.insertStoredMany([
      { id: `keep`, group: `feed`, title: `keep` },
      { id: `leave`, group: `feed`, title: `leave` },
    ])
    const reader = renderCounted(() => model.use.where({ group: `feed` }).rows())

    const beforeInsert = reader.renders()
    act(() => { model.insertStored({ id: `join`, group: `feed`, title: `join` }) })
    expect(reader.renders() - beforeInsert).toBe(1)
    expect(reader.result().map(row => row.id)).toEqual([`keep`, `leave`, `join`])

    const beforeMoveOut = reader.renders()
    act(() => { model.patch(`leave`, { group: `outside` }) })
    expect(reader.renders() - beforeMoveOut).toBe(1)
    expect(reader.result().map(row => row.id)).toEqual([`keep`, `join`])

    const beforeDestroy = reader.renders()
    act(() => { model.destroy(`join`) })
    expect(reader.renders() - beforeDestroy).toBe(1)
    expect(reader.result().map(row => row.id)).toEqual([`keep`])
    reader.unmount()
  })

  it(`orders by multiple keys with NULLS LAST and deterministic missing values`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({ id: `A14Ordering`, name: `Ordering`, fields: { group: f.str(), rank: f.num().nullable().optional(), tie: f.str().nullable().optional(), title: f.str() } })
    model.insertStoredMany([
      { id: `a`, group: `feed`, rank: 2, tie: `a`, title: `a` },
      { id: `b`, group: `feed`, rank: 1, tie: `b`, title: `b` },
      { id: `c`, group: `feed`, rank: 1, tie: `a`, title: `c` },
      { id: `d`, group: `feed`, rank: 1, title: `d` },
      { id: `missing-undefined`, group: `feed`, title: `undefined` },
      { id: `missing-null`, group: `feed`, rank: null, title: `null` },
    ])

    expect(model.use.where({ group: `feed` }).orderBy(`rank`).orderBy(`tie`).read().map(row => row.id)).toEqual([
      `c`, `b`, `d`, `a`, `missing-null`, `missing-undefined`,
    ])

    setupAcceptanceRuntime()
    const reversed = defineModel({ id: `A14OrderingReversed`, name: `OrderingReversed`, fields: { rank: f.num().nullable().optional(), title: f.str() } })
    reversed.insertStoredMany([
      { id: `missing-null`, rank: null, title: `null` },
      { id: `missing-undefined`, title: `undefined` },
      { id: `present`, rank: 1, title: `present` },
    ])
    expect(reversed.use.where({}).orderBy(`rank`).read().map(row => row.id)).toEqual([`present`, `missing-null`, `missing-undefined`])
  })

  it(`windows reactive ordered rows and preserves hidden window identity`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({ id: `A14Limit`, name: `Limit`, fields: { group: f.str(), rank: f.num(), title: f.str() } })
    model.insertStoredMany([
      { id: `one`, group: `feed`, rank: 1, title: `one` },
      { id: `two`, group: `feed`, rank: 2, title: `two` },
      { id: `three`, group: `feed`, rank: 3, title: `three` },
    ])
    const reader = renderCounted(() => model.use.where({ group: `feed` }).orderBy(`rank`).limit(2).rows())

    const beforeDisplace = reader.renders()
    act(() => { model.insertStored({ id: `zero`, group: `feed`, rank: 0, title: `zero` }) })
    expect(reader.renders() - beforeDisplace).toBe(1)
    expect(reader.result().map(row => row.id)).toEqual([`zero`, `one`])

    const original = reader.result()
    const beforeHiddenWrite = reader.renders()
    act(() => { model.patch(`three`, { title: `still-hidden` }) })
    expect(reader.renders() - beforeHiddenWrite).toBe(0)
    expect(reader.result()).toBe(original)
    reader.unmount()
  })

  it(`preserves identity for irrelevant and unchanged visible rows`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({ id: `A14Identity`, name: `Identity`, fields: { group: f.str(), rank: f.num(), title: f.str() } })
    model.insertStoredMany([
      { id: `a`, group: `feed`, rank: 2, title: `a` },
      { id: `b`, group: `feed`, rank: 1, title: `b` },
      { id: `outside`, group: `outside`, rank: 0, title: `outside` },
    ])
    const reader = renderCounted(() => model.use.where({ group: `feed` }).orderBy(`rank`).rows())
    const original = reader.result()
    const unchanged = original[0]

    const beforeOutside = reader.renders()
    act(() => { model.patch(`outside`, { title: `ignored` }) })
    expect(reader.renders() - beforeOutside).toBe(0)
    expect(reader.result()).toBe(original)

    const beforeMatching = reader.renders()
    act(() => { model.patch(`a`, { title: `updated` }) })
    expect(reader.renders() - beforeMatching).toBe(1)
    expect(reader.result()[0]).toBe(unchanged)
    reader.unmount()
  })

  it(`keeps builder reconstruction stable`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({ id: `A14Reconstruction`, name: `Reconstruction`, fields: { group: f.str(), rank: f.num() } })
    model.insertStored({ id: `row`, group: `feed`, rank: 1 })
    const reader = renderCounted(() => model.use.where({ group: `feed` }).orderBy(`rank`).rows())
    const original = reader.result()
    const beforeRebuild = reader.renders()
    reader.rerender()
    expect(reader.renders() - beforeRebuild).toBe(1)
    expect(reader.result()).toBe(original)
    reader.unmount()
  })

  it(`uses natural order without orderBy and keeps read snapshots non-reactive`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({ id: `A14Snapshots`, name: `Snapshots`, fields: { group: f.str(), rank: f.num(), title: f.str() } })
    model.insertStoredMany([
      { id: `z`, group: `feed`, rank: 1, title: `z` },
      { id: `a`, group: `feed`, rank: 2, title: `a` },
    ])
    const reader = renderCounted(() => model.use.where({ group: `feed` }).read())
    expect(reader.result().map(row => row.id)).toEqual([`z`, `a`])
    const beforeWrite = reader.renders()
    act(() => { model.patch(`z`, { title: `updated` }) })
    expect(reader.renders() - beforeWrite).toBe(0)
    expect(model.use.where({ group: `feed` }).read().find(row => row.id === `z`)?.title).toBe(`updated`)
    reader.unmount()
  })

  it(`rehydrates mounted builder rows with fresh matching data after reset`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({ id: `A14ResetRows`, name: `ResetRows`, fields: { group: f.str(), title: f.str() } })
    model.insertStored({ id: `stale`, group: `feed`, title: `stale` })
    const reader = renderCounted(() => model.use.where({ group: `feed` }).rows())
    const before = reader.renders()
    act(() => { resetRuntime() })
    act(() => { model.insertStored({ id: `fresh`, group: `feed`, title: `fresh` }) })
    expect(reader.renders()).toBeGreaterThan(before)
    expect(reader.result()).toEqual([{ id: `fresh`, group: `feed`, title: `fresh` }])
    reader.unmount()
  })

  it(`stops builder row renders after unmount`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({ id: `A14UnmountRows`, name: `UnmountRows`, fields: { group: f.str(), title: f.str() } })
    const reader = renderCounted(() => model.use.where({ group: `feed` }).rows())
    reader.unmount()
    const frozen = reader.renders()
    act(() => { model.insertStored({ id: `fresh`, group: `feed`, title: `fresh` }) })
    expect(reader.renders()).toBe(frozen)
  })
})
