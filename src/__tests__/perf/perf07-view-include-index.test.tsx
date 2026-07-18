import { act } from 'react-test-renderer'
import { defineModel, f, hasOne, scope } from '../../index'
import { renderCounted, setupAcceptanceRuntime } from '../acceptance/harness'

const RUNS = 5

const median = (samples: number[]): number => [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]!

const sample = (relatedCount: number, run: number): number => {
  setupAcceptanceRuntime()
  const messages = defineModel({ id: `P07Messages${relatedCount}-${run}`, name: `P07Messages${relatedCount}-${run}`, fields: { chatId: f.str(), rank: f.num(), body: f.str() } })
  const chats = defineModel({
    id: `P07Chats${relatedCount}-${run}`,
    name: `P07Chats${relatedCount}-${run}`,
    fields: { feedId: f.str(), chatId: f.str(), title: f.str() },
    scopes: { feed: scope({ by: { feedId: `feedId` }, sort: `server-order` }) },
    relations: () => ({ lastMessage: hasOne(messages, { foreignKey: `chatId`, comparator: (left, right) => Number(right.rank) - Number(left.rank) }) })
  })
  chats.insertStoredMany(Array.from({ length: 200 }, (_, index) => ({ id: `chat-${index}`, feedId: `feed`, chatId: `chat-${index}`, title: `chat` })))
  messages.insertStoredMany(Array.from({ length: relatedCount }, (_, index) => ({ id: `message-${index}`, chatId: `chat-${index % 200}`, rank: index, body: `body` })))
  const view = chats.view(`feed`, { source: `feed`, include: { lastMessage: `lastMessage` } })
  const started = performance.now()
  const reader = renderCounted(() => view.use({ feedId: `feed` }))
  act(() => { messages.patch(`message-0`, { body: `changed` }) })
  const elapsed = performance.now() - started
  reader.unmount()
  return elapsed
}

describe(`perf 07: view relation index scaling`, () => {
  it(`keeps 200-row hasOne views bounded across related-model sizes`, () => {
    const small = median(Array.from({ length: RUNS }, (_, run) => sample(500, run)))
    const large = median(Array.from({ length: RUNS }, (_, run) => sample(5_000, run)))
    const ratio = large / Math.max(small, 0.1)
    console.info(`perf P7 view 500=${small.toFixed(3)}ms 5000=${large.toFixed(3)}ms ratio=${ratio.toFixed(2)}`)
    expect(ratio).toBeLessThan(12)
    expect(Math.max(small, large)).toBeLessThan(250)
  })
})
