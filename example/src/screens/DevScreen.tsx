import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { collectGarbage, resetRuntime, suspendDb } from '@noma4i/react-native-dblayer';
import { exampleStorage } from '../db/transport';
import { statsFetch } from '../db/queries';

export function DevScreen() {
  const [message, setMessage] = useState('Ready');
  const stats = statsFetch.use(undefined);
  const keyCount = exampleStorage.keys('dbl:').length;
  return <View style={styles.container}><Text style={styles.title}>Runtime controls</Text><Text>Storage keys: {keyCount}</Text><Text>Ephemeral stats: {stats.data ? `${stats.data.users} users, ${stats.data.posts} posts` : 'loading...'}</Text><Pressable style={styles.button} onPress={() => { resetRuntime(); setMessage('Runtime reset. Reload a tab to fetch again.'); }}><Text style={styles.buttonText}>resetRuntime</Text></Pressable><Pressable style={styles.button} onPress={() => { const report = collectGarbage(); const removed = Object.values(report.evicted).reduce((total, count) => total + count, 0); setMessage(`GC removed ${removed} rows`); }}><Text style={styles.buttonText}>collectGarbage</Text></Pressable><Pressable style={styles.button} onPress={() => { suspendDb(); setMessage('Persistence flushed and runtime suspended.'); }}><Text style={styles.buttonText}>suspendDb</Text></Pressable><Text style={styles.message}>{message}</Text></View>;
}

const styles = StyleSheet.create({ container: { flex: 1, gap: 12, padding: 16 }, title: { fontSize: 22, fontWeight: '700' }, button: { backgroundColor: '#374151', borderRadius: 6, padding: 12, marginTop: 4 }, buttonText: { color: '#fff', textAlign: 'center', fontWeight: '700' }, message: { color: '#2563eb', marginTop: 8 } });
