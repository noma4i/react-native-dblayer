import { parse } from 'graphql';
import { CommentModel, PostModel, TodoModel, UserModel, type CommentNode } from './models';

const updateDocument = parse('mutation ExampleUpdate($input: UpdatePostInput!) { updatePost(postId: 1, post: $input) { id title body user { id } } }');
const createDocument = parse('mutation ExampleCreate($input: CreatePostInput!) { createPost(post: $input) { id title body user { id } } }');
const deleteDocument = parse('mutation ExampleDelete { deletePost(postId: 1) }');

export const renameUser = UserModel.mutation<{ updatePost: { id: number } }, { id: string; name: string }, { id: string; name: string; username: string; email: string }, { id: number }>('rename', {
  document: updateDocument, result: 'updatePost', mapInput: input => ({ title: input.name }),
  optimistic: { method: 'patch', model: UserModel, selectId: input => input.id, selectPatch: input => ({ name: input.name }) }, onCommit: (_data, context) => UserModel.patch(context.input.id, { name: context.input.name }),
});

// dedupe: false - toggling cycles between the same two { id, completed } inputs, which the mutation-level
// input-sensitive dedupe would otherwise treat as a duplicate resubmission after the first round trip.
export const toggleTodo = TodoModel.mutation<{ updatePost: { id: number } }, { id: string; completed: boolean }, { id: string; userId: string; title: string; completed: boolean }, { id: number }>('toggle', {
  dedupe: false,
  document: updateDocument, result: 'updatePost', mapInput: input => ({ title: input.completed ? 'completed' : 'active' }),
  optimistic: { method: 'patch', model: TodoModel, selectId: input => input.id, selectPatch: input => ({ completed: input.completed }) }, onCommit: (_data, context) => TodoModel.patch(context.input.id, { completed: context.input.completed }),
});

export const addComment = CommentModel.mutation<{ createPost: { id: number } }, { postId: string; userId: string; name: string; body: string }, CommentNode, CommentNode>('add', {
  document: createDocument, result: 'createPost', mapInput: input => ({ title: input.name, body: input.body, userId: Number(input.userId) }),
  optimistic: {
    model: CommentModel, tempIdPrefix: 'comment', build: input => ({ id: '', postId: input.postId, name: input.name, body: input.body }),
    selectServerNode: data => ({ id: String(data.createPost.id), postId: '', name: '', body: '' }), preserveOnCommit: ['postId', 'name', 'body'],
    prependTo: { scope: CommentModel.scopes.byPost, value: input => ({ postId: input.postId }) },
  },
});

const createPostDocument = parse('mutation ExampleCreatePost($input: CreatePostInput!) { createPost(post: $input) { id title body user { id } } }');

export const createPost = PostModel.mutation<
  { createPost: { id: number | string; title: string; body: string; user?: { id: number | string } } },
  { userId: string; title: string; body: string },
  { id: string; userId: string; title: string; body: string },
  { id: string; userId: string; title: string; body: string }
>('create', {
  document: createPostDocument, result: 'createPost',
  mapInput: input => ({ title: input.title, body: input.body, userId: Number(input.userId) }),
  optimistic: {
    model: PostModel,
    respond: input => ({ createPost: { id: '', title: input.title, body: input.body, user: { id: input.userId } } }),
    selectServerNode: data => ({ id: String(data.createPost.id), userId: String(data.createPost.user?.id ?? ''), title: data.createPost.title, body: data.createPost.body }),
    prependTo: { scope: PostModel.scopes.feed, value: () => ({}) },
  },
});

export const deletePost = PostModel.mutation<{ deletePost: string }, { id: string }, { id: string; userId: string; title: string; body: string }, string>('delete', {
  document: deleteDocument, result: 'deletePost', mapInput: () => ({}), onCommit: (_data, context) => PostModel.destroy(context.input.id),
});
