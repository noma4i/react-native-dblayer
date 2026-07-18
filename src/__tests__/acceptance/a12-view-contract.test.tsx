import { act } from 'react-test-renderer'
import { belongsTo, defineModel, f, hasMany, references, resetRuntime, scope } from '../../index'
import { renderCounted, setupAcceptanceRuntime } from './harness'

const scopeValue = { feedId: `feed` }

describe(`A12 view contract`, () => {
  it(`joins declared and computed includes with stable pinpointed projections`, () => {
    setupAcceptanceRuntime()
    const author = defineModel({ id: `A12Author`, name: `A12Author`, fields: { name: f.str(), note: f.str() } })
    const comment = defineModel({ id: `A12Comment`, name: `A12Comment`, fields: { postId: f.str(), body: f.str() } })
    const post = defineModel({
      id: `A12Post`,
      name: `A12Post`,
      fields: { feedId: f.str(), authorId: f.str(), opponentId: f.str(), title: f.str(), detail: f.str() },
      scopes: { feed: scope({ by: { feedId: `feedId` }, sort: `server-order` }) },
      relations: () => ({ author: belongsTo(author, { foreignKey: `authorId`, touch: (row, parent) => ({ name: String((row as unknown as Record<string, unknown>).title) === `Updated` ? `${parent.name}:Updated` : parent.name }) }), comments: hasMany(comment, { foreignKey: `postId` }) })
    })
    const opponent = defineModel({ id: `A12Opponent`, name: `A12Opponent`, fields: { name: f.str() } })
    author.insertStored({ id: `author`, name: `Ada`, note: `first` })
    opponent.insertStored({ id: `opponent`, name: `Lin` })
    comment.insertStored({ id: `comment`, postId: `post`, body: `one` })
    post.insertStored({ id: `post`, feedId: `feed`, authorId: `author`, opponentId: `opponent`, title: `Hello`, detail: `hidden` })
    post.insertStored({ id: `other`, feedId: `other`, authorId: `missing`, opponentId: `opponent`, title: `Other`, detail: `hidden` })

    const view = post.view(`feed`, {
      source: `feed`,
      include: { author: `author`, comments: `comments`, opponent: [opponent, row => String(row.opponentId ?? ``)] },
      select: (row, included, ctx) => ({ id: row.id, title: row.title, detail: row.detail, author: included.author, comments: included.comments, opponent: included.opponent, index: ctx.index }),
      renderKeys: [`title`, `author`, `comments`, `opponent`]
    })
    const reader = renderCounted(() => view.use(scopeValue))
    expect(reader.result()).toHaveLength(1)
    expect(reader.result()[0]).toMatchObject({ title: `Hello`, author: { name: `Ada` }, comments: [{ body: `one` }], opponent: { name: `Lin` }, index: 0 })

    const initial = reader.result()[0]
    const beforeDetail = reader.renders()
    act(() => { post.patch(`post`, { detail: `changed` }) })
    expect(reader.result()[0]).toBe(initial)
    expect(reader.renders() - beforeDetail).toBe(0)

    const beforeAuthor = reader.renders()
    act(() => { author.patch(`author`, { name: `Grace` }) })
    expect(reader.result()[0]).not.toBe(initial)
    expect(reader.renders() - beforeAuthor).toBe(1)

    const beforeUnrelated = reader.renders()
    act(() => { post.patch(`other`, { title: `Ignored` }) })
    expect(reader.renders() - beforeUnrelated).toBe(0)

    const beforeUnrelatedComment = reader.renders()
    act(() => { comment.insertStored({ id: `unrelated`, postId: `other`, body: `ignored` }) })
    expect(reader.renders() - beforeUnrelatedComment).toBe(0)

    const beforeBatch = reader.renders()
    act(() => { post.insertStored({ id: `post`, feedId: `feed`, authorId: `author`, opponentId: `opponent`, title: `Updated`, detail: `changed` }) })
    expect(reader.renders() - beforeBatch).toBe(1)

    const window = renderCounted(() => view.useWindow(scopeValue, { pageSize: 1 }))
    expect(window.result()).toMatchObject({ totalCount: 1, hasMore: false })
    const windowRows = window.result().rows
    window.rerender()
    expect(window.result().rows).toBe(windowRows)
    window.unmount()
    reader.unmount()
    act(() => { resetRuntime() })
  })

  it(`rejects unsupported references includes while defining the view`, () => {
    setupAcceptanceRuntime()
    const target = defineModel({ id: `A12ReferenceTarget`, name: `ReferenceTarget`, fields: { title: f.str() } })
    const model = defineModel({ id: `A12ReferenceSource`, name: `ReferenceSource`, fields: { feedId: f.str(), targetId: f.str() }, scopes: { feed: scope({ by: { feedId: `feedId` }, sort: `server-order` }) }, relations: () => ({ target: references(target, { ids: row => (row as { targetId?: string }).targetId ?? null }) }) })
    expect(() => model.view(`invalid`, { source: `feed`, include: { target: `target` } })).toThrow(`Model.view does not support references includes`)
  })

  it(`keeps view reader identities and renders stable for an unrelated model write`, () => {
    setupAcceptanceRuntime()
    const post = defineModel({ id: `A12UseIrrelevantPost`, name: `UseIrrelevantPost`, fields: { feedId: f.str(), title: f.str() }, scopes: { feed: scope({ by: { feedId: `feedId` }, sort: `server-order` }) } })
    const unrelated = defineModel({ id: `A12UseIrrelevantOther`, name: `UseIrrelevantOther`, fields: { title: f.str() } })
    post.insertStoredMany([{ id: `one`, feedId: `feed`, title: `one` }, { id: `two`, feedId: `feed`, title: `two` }])
    const view = post.view(`irrelevant`, { source: `feed`, include: {}, select: row => ({ id: row.id, title: row.title }), renderKeys: [`title`] })
    const reader = renderCounted(() => view.use(scopeValue))
    const initial = reader.result()
    const initialItems = [...initial]
    const before = reader.renders()

    act(() => { unrelated.insertStored({ id: `other`, title: `ignored` }) })

    expect(reader.renders() - before).toBe(0)
    expect(reader.result()).toBe(initial)
    reader.result().forEach((row, index) => expect(row).toBe(initialItems[index]))
    reader.unmount()
  })

  it(`rebuilds mounted view projections from fresh source and relation state after reset`, () => {
    setupAcceptanceRuntime()
    const author = defineModel({ id: `A12UseResetAuthor`, name: `UseResetAuthor`, fields: { name: f.str() } })
    const post = defineModel({ id: `A12UseResetPost`, name: `UseResetPost`, fields: { feedId: f.str(), authorId: f.str(), title: f.str() }, scopes: { feed: scope({ by: { feedId: `feedId` }, sort: `server-order` }) }, relations: () => ({ author: belongsTo(author, { foreignKey: `authorId` }) }) })
    const view = post.view(`reset`, { source: `feed`, include: { author: `author` }, select: (row, included) => ({ id: row.id, title: row.title, author: included.author }), renderKeys: [`title`, `author`] })
    author.insertStored({ id: `author`, name: `stale` })
    post.insertStored({ id: `post`, feedId: `feed`, authorId: `author`, title: `stale` })
    const reader = renderCounted(() => view.use(scopeValue))
    const before = reader.renders()

    act(() => { resetRuntime() })
    act(() => {
      author.insertStored({ id: `author`, name: `fresh` })
      post.insertStored({ id: `post`, feedId: `feed`, authorId: `author`, title: `fresh` })
    })

    expect(reader.renders()).toBeGreaterThan(before)
    expect(reader.result()).toEqual([{ id: `post`, title: `fresh`, author: { id: `author`, name: `fresh` } }])
    reader.unmount()
  })

  it(`stops view reader renders after unmount`, () => {
    setupAcceptanceRuntime()
    const post = defineModel({ id: `A12UseUnmountPost`, name: `UseUnmountPost`, fields: { feedId: f.str(), title: f.str() }, scopes: { feed: scope({ by: { feedId: `feedId` }, sort: `server-order` }) } })
    const view = post.view(`unmount`, { source: `feed`, include: {}, select: row => ({ id: row.id, title: row.title }), renderKeys: [`title`] })
    post.insertStored({ id: `post`, feedId: `feed`, title: `before` })
    const reader = renderCounted(() => view.use(scopeValue))
    reader.unmount()
    const frozen = reader.renders()

    act(() => { post.patch(`post`, { title: `after` }) })

    expect(reader.renders()).toBe(frozen)
  })

  it(`renders windowed views only for visible source changes`, () => {
    setupAcceptanceRuntime()
    const post = defineModel({ id: `A12WindowVisibilityPost`, name: `WindowVisibilityPost`, fields: { feedId: f.str(), title: f.str() }, scopes: { feed: scope({ by: { feedId: `feedId` }, sort: `server-order` }) } })
    const unrelated = defineModel({ id: `A12WindowVisibilityOther`, name: `WindowVisibilityOther`, fields: { title: f.str() } })
    post.insertStoredMany([{ id: `visible`, feedId: `feed`, title: `visible` }, { id: `outside`, feedId: `feed`, title: `outside` }])
    const view = post.view(`window-visibility`, { source: `feed`, include: {}, select: row => ({ id: row.id, title: row.title }), renderKeys: [`title`] })
    const reader = renderCounted(() => view.useWindow(scopeValue, { pageSize: 1 }))
    const beforeVisible = reader.renders()
    act(() => { post.patch(`visible`, { title: `updated` }) })
    expect(reader.renders() - beforeVisible).toBe(1)
    const beforeOutside = reader.renders()
    act(() => { post.patch(`outside`, { title: `ignored` }) })
    expect(reader.renders() - beforeOutside).toBe(0)
    const beforeUnrelated = reader.renders()
    act(() => { unrelated.insertStored({ id: `other`, title: `ignored` }) })
    expect(reader.renders() - beforeUnrelated).toBe(0)
    reader.unmount()
  })

  it(`rehydrates mounted windowed views with fresh rows only after reset`, () => {
    setupAcceptanceRuntime()
    const post = defineModel({ id: `A12WindowResetPost`, name: `WindowResetPost`, fields: { feedId: f.str(), title: f.str() }, scopes: { feed: scope({ by: { feedId: `feedId` }, sort: `server-order` }) } })
    const view = post.view(`window-reset`, { source: `feed`, include: {}, select: row => ({ id: row.id, title: row.title }), renderKeys: [`title`] })
    post.insertStored({ id: `stale`, feedId: `feed`, title: `stale` })
    const reader = renderCounted(() => view.useWindow(scopeValue, { pageSize: 2 }))

    act(() => { resetRuntime() })
    act(() => { post.insertStored({ id: `fresh`, feedId: `feed`, title: `fresh` }) })

    expect(reader.result().rows).toEqual([{ id: `fresh`, title: `fresh` }])
    reader.unmount()
  })

  it(`releases windowed view subscriptions after unmount`, () => {
    setupAcceptanceRuntime()
    const post = defineModel({ id: `A12WindowUnmountPost`, name: `WindowUnmountPost`, fields: { feedId: f.str(), title: f.str() }, scopes: { feed: scope({ by: { feedId: `feedId` }, sort: `server-order` }) } })
    const view = post.view(`window-unmount`, { source: `feed`, include: {}, select: row => ({ id: row.id, title: row.title }), renderKeys: [`title`] })
    post.insertStored({ id: `post`, feedId: `feed`, title: `before` })
    const reader = renderCounted(() => view.useWindow(scopeValue, { pageSize: 1 }))
    reader.unmount()
    const frozen = reader.renders()

    act(() => { post.patch(`post`, { title: `after` }) })

    expect(reader.renders()).toBe(frozen)
  })
})
