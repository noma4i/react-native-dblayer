import { belongsTo, defineModel, f, hasMany, scope } from '@noma4i/react-native-dblayer';

export type UserNode = { id: string; name: string; username: string; email: string };
export type PostNode = { id: string; userId: string; title: string; body: string };
export type CommentNode = { id: string; postId: string; name: string; body: string; pending?: boolean };
export type TodoNode = { id: string; userId: string; title: string; completed: boolean };

export const UserModel = defineModel({
  id: 'example-users',
  name: 'UserModel',
  fields: { id: f.id(), name: f.str(), username: f.str(), email: f.str() },
  scopes: { list: scope({ sort: 'server-order' }) },
});

export let PostModel: ReturnType<typeof defineModel>;
export let CommentModel: ReturnType<typeof defineModel>;

PostModel = defineModel({
  id: 'example-posts',
  name: 'PostModel',
  fields: { id: f.id(), userId: f.id(), title: f.str(), body: f.str() },
  scopes: {
    feed: scope({ sort: 'server-order' }),
    byUser: scope({ by: { userId: 'userId' }, sort: 'server-order' }),
  },
  relations: () => ({
    author: belongsTo(UserModel, { foreignKey: 'userId' }),
    comments: hasMany(CommentModel, { foreignKey: 'postId', dependent: 'destroy' }),
  }),
});

CommentModel = defineModel({
  id: 'example-comments',
  name: 'CommentModel',
  fields: { id: f.id(), postId: f.id(), name: f.str(), body: f.str(), pending: f.bool().optional() },
  scopes: { byPost: scope({ by: { postId: 'postId' }, sort: 'server-order' }) },
  relations: () => ({ post: belongsTo(PostModel, { foreignKey: 'postId' }) }),
});

export const TodoModel = defineModel({
  id: 'example-todos',
  name: 'TodoModel',
  fields: { id: f.id(), userId: f.id(), title: f.str(), completed: f.bool() },
  scopes: { byUser: scope({ by: { userId: 'userId' }, sort: 'server-order' }) },
  relations: () => ({ user: belongsTo(UserModel, { foreignKey: 'userId' }) }),
});

export const PerfModel = defineModel({
  id: 'example-perf',
  name: 'PerfModel',
  fields: { id: f.id(), label: f.str(), counter: f.num() },
  scopes: { all: scope({ sort: 'server-order' }) },
});
