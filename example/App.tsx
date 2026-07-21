import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { DbProvider, configureDb } from '@noma4i/react-native-dblayer';
import { exampleTransport } from './src/db/transport';
import './src/db/models';
import { DevScreen } from './src/screens/DevScreen';
import { FeedScreen } from './src/screens/FeedScreen';
import { PostDetailScreen } from './src/screens/PostDetailScreen';
import { UserDetailScreen } from './src/screens/UserDetailScreen';
import { UsersScreen } from './src/screens/UsersScreen';

// Register every model module (above) before configuring, then configure once, before DbProvider mounts.
configureDb({ transport: exampleTransport, defaults: { pageSize: 20 } });

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
  return (
    <DbProvider bootOptions={{ wipe: false }}>
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="Showcase" component={TabsNavigator} options={{ headerShown: false }} />
          <Stack.Screen name="UserDetail" component={UserDetailScreen} options={{ title: 'User profile' }} />
          <Stack.Screen name="PostDetail" component={PostDetailScreen} options={{ title: 'Post detail' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </DbProvider>
  );
}

export default App;
