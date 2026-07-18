import {
  defineModel,
  defineQuery,
  f,
  flushPersistence,
  replayJournal,
  resetRuntime,
  scope,
} from '../../index'
import {
  ensureMembershipCollection,
  membershipCollectionFor,
} from '../../core/tanstack/facade'
import { createContractScenario } from '../helpers/contractScenario'
import { createMemoryStorage } from '../helpers/memoryStorage'

const document = { kind: `Document`, definitions: [] } as never
const feed = { feed: `main` }

describe(`membership collection mirror`, () => {
  afterEach(() => resetRuntime())

  it(`mirrors page append and complete detach in server order`, async () => {
    const pages = [
      [{ id: `a`, title: `a` }, { id: `b`, title: `b` }],
      [{ id: `c`, title: `c` }],
      [{ id: `b`, title: `b` }, { id: `c`, title: `c` }],
    ]
    createContractScenario({
      transport: { query: async <TData,>() => ({ data: { rows: pages.shift() } as TData }) },
    })
    const model = defineModel({
      id: `MembershipPage`,
      name: `MembershipPage`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) },
    })
    const page = defineQuery({ document, key: `membership-page`, select: (data) => (data as { rows: unknown[] }).rows, into: model.scopes.feed, coverage: `page` })
    await page.fetch(feed)
    await page.fetch(feed)
    expect(membershipCollectionFor(`MembershipPage`).toArray.filter((row) => row.scopeKey.includes(`feed`)).sort((left, right) => left.order - right.order).map((row) => row.rowId)).toEqual(model.scopes.feed.read(feed).map((row) => row.id))

    const complete = defineQuery({ document, key: `membership-complete`, select: (data) => (data as { rows: unknown[] }).rows, into: model.scopes.feed, coverage: `complete` })
    await complete.fetch(feed)
    expect(membershipCollectionFor(`MembershipPage`).toArray.filter((row) => row.scopeKey.includes(`feed`)).sort((left, right) => left.order - right.order).map((row) => row.rowId)).toEqual([`b`, `c`])
  })

  it(`clears memberships on reset and repopulates after a query apply`, async () => {
    createContractScenario({ transport: { query: async <TData,>() => ({ data: { rows: [{ id: `a`, title: `a` }] } as TData }) } })
    const model = defineModel({ id: `MembershipReset`, name: `MembershipReset`, fields: { title: f.str() }, scopes: { feed: scope({ sort: `server-order` }) } })
    const query = defineQuery({ document, key: `membership-reset`, select: (data) => (data as { rows: unknown[] }).rows, into: model.scopes.feed, coverage: `complete` })
    await query.fetch(feed)
    resetRuntime()
    expect(ensureMembershipCollection(`MembershipReset`).toArray).toEqual([])
    await query.fetch(feed)
    expect(membershipCollectionFor(`MembershipReset`).toArray).toHaveLength(1)
  })

  it(`seeds memberships before replay after restart`, async () => {
    const memory = createMemoryStorage()
    createContractScenario({ storage: memory, transport: { query: async <TData,>() => ({ data: { rows: [{ id: `a`, title: `a` }] } as TData }) } })
    const first = defineModel({ id: `MembershipRestart`, name: `MembershipRestart`, fields: { title: f.str() }, scopes: { feed: scope({ sort: `server-order` }) } })
    const query = defineQuery({ document, key: `membership-restart`, select: (data) => (data as { rows: unknown[] }).rows, into: first.scopes.feed, coverage: `complete` })
    await query.fetch(feed)
    flushPersistence()
    createContractScenario({ storage: memory })
    const restarted = defineModel({ id: `MembershipRestart`, name: `MembershipRestart`, fields: { title: f.str() }, scopes: { feed: scope({ sort: `server-order` }) } })
    replayJournal()
    expect(membershipCollectionFor(`MembershipRestart`).toArray.map((row) => row.rowId)).toEqual(restarted.scopes.feed.read(feed).map((row) => row.id))
  })
})
