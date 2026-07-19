import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { PostModel } from '../db/models';
import { createPost } from '../db/mutations';
import { FEED_SCOPE, postsFeedQuery } from '../db/queries';

function FeedRow({ post, navigation }: { post: { id: string; userId: string; title: string; body: string }; navigation: any }) {
  const author = PostModel.use.related(post.id, 'author', { renderKeys: ['name'] }) as { name?: string } | undefined;
  return <View style={styles.row}><Pressable onPress={() => navigation.navigate('UserDetail', { userId: post.userId })}><Text style={styles.author}>{author?.name ?? 'Loading author...'}</Text></Pressable><Pressable onPress={() => navigation.navigate('PostDetail', { postId: post.id })}><Text style={styles.title}>{post.title}</Text><Text numberOfLines={2}>{post.body}</Text></Pressable></View>;
}

export function FeedScreen({ navigation }: { navigation: any }) {
  const result = postsFeedQuery.use(FEED_SCOPE);
  const window = PostModel.scopes.feed.useWindow(FEED_SCOPE, { pageSize: 20 });
  return <View style={styles.container}><Text style={styles.caption}>Server-order feed. Author names are reactive belongsTo reads.</Text><Pressable style={styles.button} onPress={() => createPost.run({ userId: '1', title: 'Optimistic post', body: 'Created via respond + prependTo' })}><Text style={styles.buttonText}>Add post</Text></Pressable>{result.error && <Text style={styles.error}>{result.error.message}</Text>}{result.loadingState.showSkeleton && <Text style={styles.caption}>Loading feed...</Text>}{result.loadingState.showEmptyState && <Text style={styles.caption}>No posts yet.</Text>}{result.loadingState.showRefreshIndicator && <ActivityIndicator />}{result.loadingState.showData && <FlatList data={window.rows} keyExtractor={item => item.id} renderItem={({ item }) => <FeedRow post={item} navigation={navigation} />} onEndReached={() => window.fetchNextPage()} />}</View>;
}

const styles = StyleSheet.create({ container: { flex: 1, padding: 16 }, caption: { color: '#4b5563', marginBottom: 12 }, button: { backgroundColor: '#2563eb', borderRadius: 6, padding: 10, marginBottom: 12 }, buttonText: { color: '#fff', fontWeight: '700', textAlign: 'center' }, row: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#d1d5db', paddingVertical: 14 }, author: { color: '#2563eb', fontWeight: '700' }, title: { fontSize: 16, fontWeight: '700', marginVertical: 4 }, error: { color: '#b91c1c' } });
