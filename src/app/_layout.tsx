import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { reconcileTrackingOnLaunch } from '../location/trackingService';
import { verifyAll } from '../map/offlineMaps';
import { Button, Loading, colors, styles } from '../ui/components';
import { useServices } from '../ui/hooks';
import { setLaunchNotice } from '../ui/notices';

export default function RootLayout() {
  const { services, error, retry } = useServices();

  useEffect(() => {
    if (!services) return;
    void reconcileTrackingOnLaunch()
      .then((msg) => setLaunchNotice(msg))
      .catch(() => undefined);
    void services.settings
      .load()
      .then((s) => verifyAll(services.mapPackages, s.mapStyleUrl))
      .catch(() => undefined);
  }, [services]);

  let body;
  if (error) {
    body = (
      <View style={styles.center}>
        <Text style={[styles.cardTitle, { color: colors.bad }]}>Could not open local data</Text>
        <Text style={[styles.body, { marginVertical: 12, textAlign: 'center' }]}>{error}</Text>
        <Button label="Try again" onPress={retry} />
      </View>
    );
  } else if (!services) {
    body = <Loading label="Opening local data…" />;
  } else {
    body = (
      <Stack screenOptions={{ headerStyle: { backgroundColor: '#fff' }, headerTitleStyle: { fontWeight: '700' } }}>
        <Stack.Screen name="index" options={{ title: 'Audio Checkpoints' }} />
        <Stack.Screen name="map" options={{ title: 'User Mode' }} />
        <Stack.Screen name="creator" options={{ title: 'Creator Mode' }} />
        <Stack.Screen name="checkpoint/[id]" options={{ title: 'Checkpoint' }} />
        <Stack.Screen name="audio" options={{ title: 'Audio' }} />
        <Stack.Screen name="packages" options={{ title: 'Offline Maps' }} />
        <Stack.Screen name="status" options={{ title: 'Permissions & Status' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {body}
    </SafeAreaProvider>
  );
}
