import { act } from 'react-test-renderer'
import { belongsTo, defineModel, f, hasMany, resetRuntime, scope } from '../../index'
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

    const beforeBatch = reader.renders()
    act(() => { post.insertStored({ id: `post`, feedId: `feed`, authorId: `author`, opponentId: `opponent`, title: `Updated`, detail: `changed` }) })
    expect(reader.renders() - beforeBatch).toBe(1)

    const window = renderCounted(() => view.useWindow(scopeValue, { pageSize: 1 }))
    expect(window.result()).toMatchObject({ totalCount: 1, hasMore: false })
    window.unmount()
    reader.unmount()
    act(() => { resetRuntime() })
  })
})
