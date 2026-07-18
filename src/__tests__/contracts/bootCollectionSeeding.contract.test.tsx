import { act } from 'react-test-renderer';
import { belongsTo, bootDb, defineModel, f, flushPersistence, hasMany, scope } from '../../index';
import { collectionFor } from '../../core/tanstack/facade';
import { createAcceptanceTransport, createMemoryPlane, renderCounted, setupAcceptanceRuntime } from '../acceptance/harness';

describe(`boot collection seeding`, () => {
  it(`hydrates an eagerly registered model before its first new-session write and skips stale storage models`, async () => {
    const storage = createMemoryPlane();
    setupAcceptanceRuntime({ storage });
    const first = defineModel({
      id: `BootSeedKnown`,
      name: `BootSeedKnown`,
      fields: { group: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) },
      gc: `exempt`
    });
    act(() => {
      first.insertStored({ id: `hydrated`, group: `g`, title: `saved` });
      flushPersistence();
    });
    storage.set([{ key: `dbl:row:BootSeedStale:orphan`, value: JSON.stringify({ id: `orphan`, title: `stale` }) }]);

    const restarted = defineModel({
      id: `BootSeedKnown`,
      name: `BootSeedKnown`,
      fields: { group: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) },
      gc: `exempt`
    });

    await expect(bootDb({ storage, transport: createAcceptanceTransport() })).resolves.toEqual(expect.objectContaining({ replayed: expect.any(Number) }));

    expect(collectionFor(`BootSeedKnown`).get(`hydrated`)).toMatchObject({ id: `hydrated`, title: `saved` });
    const reader = renderCounted(() => restarted.scopes.feed.use({ group: `g` }));
    expect(reader.result()).toEqual([{ id: `hydrated`, group: `g`, title: `saved` }]);
    reader.unmount();
  });

  it(`seeds a persisted model that registers after stale-key boot`, async () => {
    const storage = createMemoryPlane();
    storage.set([{ key: `dbl:row:BootSeedLate:late`, value: JSON.stringify({ id: `late`, title: `persisted` }) }]);

    await expect(bootDb({ storage, transport: createAcceptanceTransport() })).resolves.toEqual(expect.objectContaining({ replayed: expect.any(Number) }));

    const late = defineModel({
      id: `BootSeedLate`,
      name: `BootSeedLate`,
      fields: { title: f.str() },
      gc: `exempt`
    });

    expect(late.get(`late`)).toEqual({ id: `late`, title: `persisted` });
    expect(collectionFor(`BootSeedLate`).get(`late`)).toMatchObject({ id: `late`, title: `persisted` });
  });

  it(`soft-fails stale temporary rows until example-shaped relation models register after boot`, async () => {
    const storage = createMemoryPlane();
    storage.set([
      { key: `dbl:row:example-users:user-1`, value: JSON.stringify({ id: `user-1`, name: `saved` }) },
      { key: `dbl:row:example-posts:post-1`, value: JSON.stringify({ id: `post-1`, userId: `user-1`, title: `saved` }) },
      { key: `dbl:row:example-comments:temp-comment-1`, value: JSON.stringify({ id: `temp-comment-1`, postId: `post-1`, name: `pending`, body: `saved` }) },
      { key: `dbl:row:example-todos:todo-1`, value: JSON.stringify({ id: `todo-1`, userId: `user-1`, title: `saved`, completed: true }) }
    ]);

    await expect(bootDb({ storage, transport: createAcceptanceTransport() })).resolves.toEqual(expect.objectContaining({ replayed: expect.any(Number) }));

    const users = defineModel({
      id: `example-users`,
      name: `ExampleUser`,
      fields: { name: f.str() },
      scopes: { list: scope({ sort: `server-order` }) }
    });
    let comments: ReturnType<typeof defineModel>;
    const posts = defineModel({
      id: `example-posts`,
      name: `ExamplePost`,
      fields: { userId: f.id(), title: f.str() },
      relations: () => ({ author: belongsTo(users, { foreignKey: `userId` }), comments: hasMany(comments, { foreignKey: `postId`, dependent: `destroy` }) })
    });
    comments = defineModel({
      id: `example-comments`,
      name: `ExampleComment`,
      fields: { postId: f.id(), name: f.str(), body: f.str() },
      scopes: { byPost: scope({ by: { postId: `postId` }, sort: `server-order` }) },
      relations: () => ({ post: belongsTo(posts, { foreignKey: `postId` }) })
    });
    const todos = defineModel({
      id: `example-todos`,
      name: `ExampleTodo`,
      fields: { userId: f.id(), title: f.str(), completed: f.bool() },
      scopes: { byUser: scope({ by: { userId: `userId` }, sort: `server-order` }) },
      relations: () => ({ user: belongsTo(users, { foreignKey: `userId` }) })
    });

    const userReader = renderCounted(() => users.scopes.list.use({}));
    const postReader = renderCounted(() => posts.use.related(`post-1`, `author`));
    const commentReader = renderCounted(() => comments.scopes.byPost.use({ postId: `post-1` }));
    const todoReader = renderCounted(() => todos.use.count({ userId: `user-1` }));
    expect(userReader.result()).toEqual(expect.any(Array));
    expect(postReader.result()).toEqual({ id: `user-1`, name: `saved` });
    expect(commentReader.result()).toEqual([]);
    expect(todoReader.result()).toBe(1);
    userReader.unmount();
    postReader.unmount();
    commentReader.unmount();
    todoReader.unmount();
  });
});
