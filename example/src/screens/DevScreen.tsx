import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { collectGarbage, flushPersistence, resetRuntime } from '@noma4i/react-native-dblayer';
import { PerfModel } from '../db/models';
import { statsFetch } from '../db/queries';

declare const performance: { now(): number };

const median = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

export function DevScreen() {
  const [message, setMessage] = useState('Ready');
  const stats = statsFetch.use(undefined);
  const perfRow = PerfModel.use.row('p-0', { select: row => ({ counter: row.counter }) });
  return <View style={styles.container}><Text style={styles.title}>Runtime controls</Text><Text>Ephemeral stats: {stats.data ? `${stats.data.users} users, ${stats.data.posts} posts` : 'loading...'}</Text><Text>Perf p-0 counter: {perfRow?.counter ?? '-'}</Text><Pressable style={styles.button} onPress={() => { resetRuntime(); setMessage('Runtime reset. Reload a tab to fetch again.'); }}><Text style={styles.buttonText}>resetRuntime</Text></Pressable><Pressable style={styles.button} onPress={() => { const report = collectGarbage(); const removed = Object.values(report.evicted).reduce((total, count) => total + count, 0); setMessage(`GC removed ${removed} rows`); }}><Text style={styles.buttonText}>collectGarbage</Text></Pressable><Pressable style={styles.button} onPress={() => { flushPersistence(); setMessage('Persistence flushed.'); }}><Text style={styles.buttonText}>flushPersistence</Text></Pressable><Pressable style={styles.button} onPress={() => { const t0 = Date.now(); PerfModel.seed(Array.from({ length: 1000 }, (_, i) => ({ id: 'p-' + i, label: 'row ' + i, counter: 0 }))); flushPersistence(); setMessage(`Seeded 1000 + flushed in ${Date.now() - t0}ms`); }}><Text style={styles.buttonText}>Seed 1k perf</Text></Pressable><Pressable style={styles.button} onPress={() => { const t0 = Date.now(); PerfModel.seed(Array.from({ length: 20000 }, (_, i) => ({ id: 'p-' + i, label: 'row ' + i, counter: 0 }))); flushPersistence(); setMessage(`Seeded 20000 + flushed in ${Date.now() - t0}ms`); }}><Text style={styles.buttonText}>Seed 20k perf</Text></Pressable><Pressable style={styles.button} onPress={() => { const samples: number[] = []; for (let k = 0; k < 15; k += 1) { const s = performance.now(); PerfModel.patch('p-0', { counter: k }); samples.push(performance.now() - s); } setMessage(`patch median ${median(samples).toFixed(3)}ms over 15 at ${PerfModel.getAll().length} rows`); }}><Text style={styles.buttonText}>Patch median x15</Text></Pressable><Pressable style={styles.button} onPress={() => { const ids = PerfModel.getAll().map(row => row.id); PerfModel.destroyMany(ids); setMessage(`Cleared ${ids.length} perf rows`); }}><Text style={styles.buttonText}>Clear perf</Text></Pressable><Text style={styles.message}>{message}</Text></View>;
}

const styles = StyleSheet.create({ container: { flex: 1, gap: 12, padding: 16 }, title: { fontSize: 22, fontWeight: '700' }, button: { backgroundColor: '#374151', borderRadius: 6, padding: 12, marginTop: 4 }, buttonText: { color: '#fff', textAlign: 'center', fontWeight: '700' }, message: { color: '#2563eb', marginTop: 8 } });
