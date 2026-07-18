import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { PostModel, TodoModel, UserModel } from '../db/models';
import { USERS_SCOPE, usersQuery } from '../db/queries';

function UserRow({ user, navigation }: { user: { id: string; name: string; username: string }; navigation: any }) {
  const postCount = PostModel.use.count({ userId: user.id });
  const todoCount = TodoModel.use.count({ and: [{ userId: user.id }, { completed: true }] });
  return <Pressable style={styles.row} onPress={() => navigation.navigate('UserDetail', { userId: user.id })}><Text style={styles.name}>{user.name}</Text><Text>@{user.username}</Text><Text style={styles.counts}>{postCount} posts - {todoCount} completed todos</Text></Pressable>;
}

export function UsersScreen({ navigation }: { navigation: any }) {
  const result = usersQuery.use(USERS_SCOPE);
  const window = UserModel.scopes.list.useWindow(USERS_SCOPE, { pageSize: 10 });
  return <View style={styles.container}><Text style={styles.caption}>Complete coverage user list. Open a profile, toggle a todo, then return to see the reactive completed count.</Text>{result.error && <Text style={styles.error}>{result.error.message}</Text>}<FlatList data={window.rows} keyExtractor={item => item.id} renderItem={({ item }) => <UserRow user={item} navigation={navigation} />} /></View>;
}

const styles = StyleSheet.create({ container: { flex: 1, padding: 16 }, caption: { color: '#4b5563', marginBottom: 12 }, row: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#d1d5db', paddingVertical: 14 }, name: { fontSize: 17, fontWeight: '700' }, counts: { marginTop: 4, color: '#2563eb' }, error: { color: '#b91c1c' } });
