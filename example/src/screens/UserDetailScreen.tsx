import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { PostModel, TodoModel, UserModel } from '../db/models';
import { renameUser, toggleTodo } from '../db/mutations';
import { userPostsQuery, userTodosQuery } from '../db/queries';

export function UserDetailScreen({ route, navigation }: { route: any; navigation: any }) {
  const userId = route.params.userId as string;
  const user = UserModel.use.row(userId);
  const [name, setName] = useState(user?.name ?? '');
  userPostsQuery.use({ userId });
  userTodosQuery.use({ userId });
  const posts = PostModel.scopes.byUser.use({ userId });
  const todos = TodoModel.scopes.byUser.use({ userId });
  const rename = renameUser.use();
  const toggle = toggleTodo.use();
  if (!user) return <View style={styles.container}><Text>User not loaded.</Text></View>;
  return <FlatList style={styles.container} data={todos} keyExtractor={item => item.id} ListHeaderComponent={<><Text accessibilityLabel="Profile name" style={styles.name}>{user.name}</Text><Text>{user.email}</Text><View style={styles.rename}><TextInput accessibilityLabel="User name" value={name} onChangeText={setName} style={styles.input} /><Pressable style={styles.button} onPress={() => rename.mutate({ id: user.id, name })}><Text style={styles.buttonText}>{rename.isPending ? 'Saving...' : 'Rename user'}</Text></Pressable></View>{rename.error && <Text style={styles.error}>{rename.error.message}</Text>}<Text style={styles.section}>Posts</Text>{posts.map(post => <Pressable key={post.id} onPress={() => navigation.navigate('PostDetail', { postId: post.id })}><Text style={styles.post}>{post.title}</Text></Pressable>)}<Text style={styles.section}>Todos</Text></>} renderItem={({ item }) => <Pressable style={styles.todo} onPress={() => toggle.mutate({ id: item.id, completed: !item.completed })}><Text>{item.completed ? 'Done' : 'Open'} - {item.title}</Text></Pressable>} />;
}

const styles = StyleSheet.create({ container: { flex: 1, padding: 16 }, name: { fontSize: 22, fontWeight: '700' }, rename: { flexDirection: 'row', gap: 8, marginTop: 16 }, input: { flex: 1, borderWidth: 1, borderColor: '#9ca3af', borderRadius: 6, padding: 8 }, button: { backgroundColor: '#2563eb', borderRadius: 6, justifyContent: 'center', paddingHorizontal: 10 }, buttonText: { color: '#fff', fontWeight: '700' }, error: { color: '#b91c1c', marginTop: 8 }, section: { fontSize: 17, fontWeight: '700', marginTop: 20, marginBottom: 8 }, post: { color: '#1d4ed8', marginVertical: 5 }, todo: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#d1d5db', paddingVertical: 10 } });
