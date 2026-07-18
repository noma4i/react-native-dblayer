import { parse } from 'graphql';
import { defineFetch, defineQuery } from '@noma4i/react-native-dblayer';
import { CommentModel, PostModel, TodoModel, UserModel, type CommentNode, type PostNode, type TodoNode, type UserNode } from './models';

export const USERS_SCOPE = {};
export const FEED_SCOPE = {};

type ApiUser = { id: number; name: string; username: string; email: string };
type ApiPost = { id: number; title: string; body: string; user: ApiUser };
type ApiComment = { id: number; name: string; body: string; post: { id: number } };
type ApiTodo = { id: number; title: string; completed: boolean; user: { id: number } };

const toUser = (user: ApiUser): UserNode => ({ ...user, id: String(user.id) });
const toRelatedUser = (user: ApiUser): UserNode => UserModel.get(String(user.id)) ?? toUser(user);
const toPost = (post: ApiPost): PostNode => ({ id: String(post.id), userId: String(post.user.id), title: post.title, body: post.body });
const toComment = (comment: ApiComment): CommentNode => ({ id: String(comment.id), postId: String(comment.post.id), name: comment.name, body: comment.body });
const toTodo = (todo: ApiTodo): TodoNode => ({ id: String(todo.id), userId: String(todo.user.id), title: todo.title, completed: todo.completed });

const usersDocument = parse('query ExampleUsers { users(first: 10) { id name username email } }');
const postsDocument = parse('query ExamplePosts { posts(first: 100) { id title body user { id name username email } } }');
const commentsDocument = parse('query ExamplePostComments($postId: Int!) { comments(postId: $postId, first: 100) { id name body post { id } } }');
const userPostsDocument = parse('query ExampleUserPosts($userId: Int!) { posts(userId: $userId, first: 100) { id title body user { id name username email } } }');
const todosDocument = parse('query ExampleUserTodos($userId: Int!) { todos(userId: $userId, first: 100) { id title completed user { id } } }');
const statsDocument = parse('query ExampleStats { users(first: 100) { id } posts(first: 100) { id } }');

export const usersQuery = defineQuery<{ users: ApiUser[] }, Record<string, never>, typeof USERS_SCOPE, UserNode>({
  document: usersDocument, key: 'example-users', select: data => data.users.map(toRelatedUser), into: UserModel.scopes.list, coverage: 'complete',
});

export const postsFeedQuery = defineQuery<{ posts: ApiPost[] }, Record<string, never>, typeof FEED_SCOPE, PostNode>({
  document: postsDocument, key: 'example-post-feed', select: data => data.posts.map(toPost), into: PostModel.scopes.feed, coverage: 'complete',
  extract: ({ data }) => [{ into: UserModel, rows: data.posts.map(post => toRelatedUser(post.user)) }],
});

export const postCommentsQuery = defineQuery<{ comments: ApiComment[] }, { postId: number }, { postId: string }, CommentNode>({
  document: commentsDocument, key: 'example-post-comments', vars: scopeValue => ({ postId: Number(scopeValue.postId) }), select: data => data.comments.map(toComment), into: CommentModel.scopes.byPost, coverage: 'complete',
});

export const userPostsQuery = defineQuery<{ posts: ApiPost[] }, { userId: number }, { userId: string }, PostNode>({
  document: userPostsDocument, key: 'example-user-posts', vars: scopeValue => ({ userId: Number(scopeValue.userId) }), select: data => data.posts.map(toPost), into: PostModel.scopes.byUser, coverage: 'complete',
  extract: ({ data }) => [{ into: UserModel, rows: data.posts.map(post => toRelatedUser(post.user)) }],
});

export const userTodosQuery = defineQuery<{ todos: ApiTodo[] }, { userId: number }, { userId: string }, TodoNode>({
  document: todosDocument, key: 'example-user-todos', vars: scopeValue => ({ userId: Number(scopeValue.userId) }), select: data => data.todos.map(toTodo), into: TodoModel.scopes.byUser, coverage: 'complete',
});

export const statsFetch = defineFetch<{ users: Array<{ id: number }>; posts: Array<{ id: number }> }, void, { users: number; posts: number }>({
  document: statsDocument, key: 'example-stats', select: data => ({ users: data.users.length, posts: data.posts.length }), staleTime: 60_000,
});
