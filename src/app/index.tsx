import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text } from 'react-native';
import { SITE } from '../config/site';
import { getLocationReadiness, type LocationReadiness } from '../location/expoLocation';
import { Banner, Body, Button, Card, Muted, Screen, StatusRow, styles } from '../ui/components';
import { useCheckpoints, useServices, useTrackingStatus, useUsableMapPackage } from '../ui/hooks';
import { takeLaunchNotice } from '../ui/notices';

export default function Home() {
  const { services } = useServices();
  const status = useTrackingStatus(services);
  const { checkpoints } = useCheckpoints(services);
  const { pkg } = useUsableMapPackage(services);
  const [readiness, setReadiness] = useState<LocationReadiness | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void getLocationReadiness().then(setReadiness).catch(() => undefined);
      const n = takeLaunchNotice();
      if (n) setNotice(n);
    }, []),
  );

  const placeholders = checkpoints.filter((c) => !c.coordinatesVerified);
  const enabled = checkpoints.filter((c) => c.enabled).length;

  return (
    <Screen>
      <Card>
        <Text style={styles.cardTitle}>{SITE.name}</Text>
        <Muted>
          {checkpoints.length} checkpoint{checkpoints.length === 1 ? '' : 's'} ({enabled} enabled). Audio plays automatically
          when you reach one — no internet needed.
        </Muted>
      </Card>

      {notice ? <Banner tone="warn">{notice}</Banner> : null}

      {placeholders.length > 0 ? (
        <Banner tone="warn">
          {placeholders.map((p) => p.name).join(' and ')} use PLACEHOLDER coordinates (estimated from the park’s map pin).
          Go to each spot, open Creator Mode → the checkpoint → “Use my current position”, then save.
        </Banner>
      ) : null}

      <Card title="Status">
        <StatusRow
          label="Location permission"
          value={readiness ? (readiness.permission === 'granted' ? (readiness.precise ? 'Granted (precise)' : 'Approximate only') : 'Not granted') : '…'}
          tone={readiness?.permission === 'granted' && readiness.precise ? 'good' : 'bad'}
        />
        <StatusRow
          label="Location services"
          value={readiness ? (readiness.servicesEnabled ? 'On' : 'Off') : '…'}
          tone={readiness?.servicesEnabled ? 'good' : 'bad'}
        />
        <StatusRow
          label="Offline map"
          value={pkg ? `Available: ${pkg.name}` : 'Not downloaded (schematic view)'}
          tone={pkg ? 'good' : 'warn'}
        />
        <StatusRow
          label="Tracking"
          value={status?.active ? `Active (${status.source})` : 'Stopped'}
          tone={status?.active ? 'good' : 'muted'}
        />
        <StatusRow
          label="Audio"
          value={status?.audio.current ? `${status.audio.status}: ${status.audio.current.label}` : 'Idle'}
          tone={status?.audio.status === 'playing' ? 'good' : 'muted'}
        />
      </Card>

      <Button label="User Mode – map & tracking" onPress={() => router.push('/map')} />
      <Button label="Creator Mode – add checkpoints" variant="secondary" onPress={() => router.push('/creator')} />
      <Button label="Audio library" variant="secondary" onPress={() => router.push('/audio')} />
      <Button label="Offline maps" variant="secondary" onPress={() => router.push('/packages')} />
      <Button label="Permissions & status" variant="secondary" onPress={() => router.push('/status')} />
      <Button label="Settings" variant="secondary" onPress={() => router.push('/settings')} />

      <Card>
        <Body>
          Location stays on this phone. Nothing is uploaded; there are no analytics. Tracking runs only while you have it
          switched on, with a visible notification.
        </Body>
      </Card>
    </Screen>
  );
}
