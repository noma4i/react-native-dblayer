import { parse } from 'graphql';
import { defineMutation } from '@noma4i/react-native-dblayer';
import { CommentModel, PostModel, TodoModel, UserModel, type CommentNode } from './models';

const updateDocument = parse('mutation ExampleUpdate($input: UpdatePostInput!) { updatePost(postId: 1, post: $input) { id title body user { id } } }');
const createDocument = parse('mutation ExampleCreate($input: CreatePostInput!) { createPost(post: $input) { id title body user { id } } }');
const deleteDocument = parse('mutation ExampleDelete { deletePost(postId: 1) }');

export const renameUser = defineMutation<{ updatePost: { id: number } }, { id: string; name: string }, { id: string; name: string; username: string; email: string }, { id: number }>({
  document: updateDocument, result: 'updatePost', mapInput: input => ({ title: input.name }),
  optimistic: { method: 'patch', model: UserModel, selectId: input => input.id, selectPatch: input => ({ name: input.name }) }, onCommit: (_data, context) => UserModel.patch(context.input.id, { name: context.input.name }),
});

export const toggleTodo = defineMutation<{ updatePost: { id: number } }, { id: string; completed: boolean }, { id: string; userId: string; title: string; completed: boolean }, { id: number }>({
  document: updateDocument, result: 'updatePost', mapInput: input => ({ title: input.completed ? 'completed' : 'active' }),
  optimistic: { method: 'patch', model: TodoModel, selectId: input => input.id, selectPatch: input => ({ completed: input.completed }) }, onCommit: (_data, context) => TodoModel.patch(context.input.id, { completed: context.input.completed }),
});

export const addComment = defineMutation<{ createPost: { id: number } }, { postId: string; userId: string; name: string; body: string }, CommentNode, CommentNode>({
  document: createDocument, result: 'createPost', mapInput: input => ({ title: input.name, body: input.body, userId: Number(input.userId) }),
  optimistic: {
    model: CommentModel, tempIdPrefix: 'comment', build: input => ({ id: '', postId: input.postId, name: input.name, body: input.body, pending: true }),
    selectServerNode: data => ({ id: String(data.createPost.id), postId: '', name: '', body: '', pending: false }), preserveOnCommit: ['postId', 'name', 'body'],
  },
});

export const deletePost = defineMutation<{ deletePost: string }, { id: string }, { id: string; userId: string; title: string; body: string }, string>({
  document: deleteDocument, result: 'deletePost', mapInput: () => ({}), onCommit: (_data, context) => PostModel.destroy(context.input.id),
});
