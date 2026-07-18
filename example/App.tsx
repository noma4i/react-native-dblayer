import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { QueryClient, QueryClientProvider, bootDb, suspendDb } from '@noma4i/react-native-dblayer';
import { exampleStorage, exampleTransport } from './src/db/transport';
import './src/db/models';
import { DevScreen } from './src/screens/DevScreen';
import { FeedScreen } from './src/screens/FeedScreen';
import { PostDetailScreen } from './src/screens/PostDetailScreen';
import { UserDetailScreen } from './src/screens/UserDetailScreen';
import { UsersScreen } from './src/screens/UsersScreen';

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

function TabsNavigator() {
  return (
    <Tabs.Navigator>
      <Tabs.Screen name="Users" component={UsersScreen} />
      <Tabs.Screen name="Feed" component={FeedScreen} />
      <Tabs.Screen name="Dev" component={DevScreen} />
    </Tabs.Navigator>
  );
}

function App() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const [bootError, setBootError] = useState<Error | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    const bootStart = Date.now();
    void bootDb({ transport: exampleTransport, storage: exampleStorage, queryClient, defaults: { pageSize: 20 } })
      .then(() => {
        (globalThis as { dblBootMs?: number }).dblBootMs = Date.now() - bootStart;
        mounted && setReady(true);
      })
      .catch(error => mounted && setBootError(error as Error));
    return () => {
      mounted = false;
      suspendDb();
    };
  }, [queryClient]);

  if (bootError) return <SafeAreaView style={styles.center}><Text>{bootError.message}</Text></SafeAreaView>;
  if (!ready) return <SafeAreaView style={styles.center}><ActivityIndicator /><Text style={styles.loading}>Booting local-first runtime...</Text></SafeAreaView>;

  return (
    <QueryClientProvider client={queryClient}>
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="Showcase" component={TabsNavigator} options={{ headerShown: false }} />
          <Stack.Screen name="UserDetail" component={UserDetailScreen} options={{ title: 'User profile' }} />
          <Stack.Screen name="PostDetail" component={PostDetailScreen} options={{ title: 'Post detail' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({ center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }, loading: { color: '#4b5563' } });

export default App;
