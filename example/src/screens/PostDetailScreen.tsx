import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CommentModel, PostModel } from '../db/models';
import { addComment, deletePost } from '../db/mutations';
import { postCommentsQuery } from '../db/queries';

// Showcases Model.use.pending: a row belongs to an open optimistic operation (the temp insert from
// addComment below, before the server commit swaps it for the real id) until commit or rollback.
function CommentRow({ comment }: { comment: { id: string; name: string; body: string } }) {
  const pending = CommentModel.use.pending(comment.id);
  return <View style={styles.comment}><Text style={styles.commentName}>{comment.name} {pending ? '(pending)' : ''}</Text><Text>{comment.body}</Text></View>;
}

export function PostDetailScreen({ route, navigation }: { route: any; navigation: any }) {
  const postId = route.params.postId as string;
  const post = PostModel.use.row(postId);
  const [body, setBody] = useState('A local-first comment');
  postCommentsQuery.use({ postId });
  const window = CommentModel.scopes.byPost.useWindow({ postId }, { pageSize: 20 });
  const add = addComment.use();
  const remove = deletePost.use();
  if (!post) return <View style={styles.container}><Text>Post was deleted.</Text></View>;
  return <FlatList style={styles.container} data={window.rows} keyExtractor={item => item.id} ListHeaderComponent={<><Text style={styles.title}>{post.title}</Text><Text>{post.body}</Text><Text style={styles.section}>Comments</Text><TextInput accessibilityLabel="Comment body" value={body} onChangeText={setBody} style={styles.input} /><Pressable style={styles.button} onPress={() => add.mutate({ postId, userId: post.userId, name: 'Showcase user', body })}><Text style={styles.buttonText}>{add.isPending ? 'Adding...' : 'Add comment'}</Text></Pressable><Pressable style={styles.delete} onPress={() => remove.mutate({ id: postId }, { onSuccess: () => navigation.goBack() })}><Text style={styles.buttonText}>{remove.isPending ? 'Deleting...' : 'Delete post and cascade comments'}</Text></Pressable></>} renderItem={({ item }) => <CommentRow comment={item} />} />;
}

const styles = StyleSheet.create({ container: { flex: 1, padding: 16 }, title: { fontSize: 21, fontWeight: '700' }, section: { fontSize: 18, fontWeight: '700', marginTop: 20, marginBottom: 8 }, input: { borderWidth: 1, borderColor: '#9ca3af', borderRadius: 6, marginBottom: 8, padding: 9 }, button: { backgroundColor: '#2563eb', borderRadius: 6, padding: 10, marginBottom: 8 }, delete: { backgroundColor: '#b91c1c', borderRadius: 6, padding: 10 }, buttonText: { color: '#fff', fontWeight: '700', textAlign: 'center' }, comment: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#d1d5db', paddingVertical: 12 }, commentName: { fontWeight: '700' } });
