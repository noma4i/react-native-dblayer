import { act } from 'react-test-renderer'
import { defineModel, f } from '../../index'
import { renderCounted, setupAcceptanceRuntime } from './harness'

describe(`A14 chainable reads`, () => {
  it(`filters, orders, limits, preserves identity, and supports snapshot reads`, () => {
    setupAcceptanceRuntime()
    const model = defineModel({ id: `A14Rows`, name: `Rows`, fields: { group: f.str(), rank: f.num(), tie: f.str(), title: f.str(), optional: f.str() } })
    model.insertStoredMany([
      { id: `a`, group: `feed`, rank: 2, tie: `a`, title: `a` },
      { id: `b`, group: `feed`, rank: 1, tie: `b`, title: `b` },
      { id: `c`, group: `feed`, rank: 1, tie: `a`, title: `c` },
      { id: `d`, group: `feed`, rank: 1, title: `d` },
      { id: `outside`, group: `outside`, rank: 0, title: `outside` }
    ])
    const reader = renderCounted(() => model.use.where({ group: `feed` }).orderBy(`rank`).orderBy(`tie`).rows())
    expect(reader.result().map(row => row.id)).toEqual([`c`, `b`, `d`, `a`])
    expect(model.use.where({ group: `feed` }).orderBy(`rank`).limit(2).read().map(row => row.id)).toEqual([`b`, `c`])
    const original = reader.result()
    const unchanged = original[1]
    const beforeOutside = reader.renders()
    act(() => { model.patch(`outside`, { title: `ignored` }) })
    expect(reader.renders() - beforeOutside).toBe(0)
    expect(reader.result()).toBe(original)
    const beforeMatching = reader.renders()
    act(() => { model.patch(`a`, { title: `updated` }) })
    expect(reader.renders() - beforeMatching).toBe(1)
    expect(reader.result()[1]).toBe(unchanged)
    const afterMatching = reader.result()
    const beforeRebuild = reader.renders()
    reader.rerender()
    expect(reader.renders() - beforeRebuild).toBe(1)
    expect(reader.result()).toBe(afterMatching)
    reader.unmount()
  })
})
