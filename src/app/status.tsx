import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import type { TriggerHistoryEntry } from '../data/models';
import {
  getLocationReadiness,
  promptEnableLocationServices,
  requestLocationPermission,
  requestNotificationPermission,
  type LocationReadiness,
} from '../location/expoLocation';
import { isGnssServiceRunning } from '../location/trackingService';
import { Body, Button, Card, Loading, Muted, Row, Screen, StatusRow, colors, styles } from '../ui/components';
import { fmtAge, fmtMeters, fmtTime, QUALITY_TEXT, STATE_TEXT } from '../ui/format';
import { useInterval, useServices, useTrackingStatus } from '../ui/hooks';

export default function StatusScreen() {
  const { services } = useServices();
  const status = useTrackingStatus(services);
  const [r, setR] = useState<LocationReadiness | null>(null);
  const [serviceRunning, setServiceRunning] = useState<boolean | null>(null);
  const [history, setHistory] = useState<TriggerHistoryEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    setR(await getLocationReadiness().catch(() => null));
    setServiceRunning(await isGnssServiceRunning());
    if (services) setHistory(await services.history.recent(30));
  }, [services]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  useInterval(() => {
    setNow(Date.now());
    void refresh();
  }, 3000);

  if (!services) return <Loading />;
  const last = status?.engine.lastSample;

  return (
    <Screen>
      <Card title="Permissions">
        <StatusRow
          label="Location"
          value={r ? (r.permission === 'granted' ? (r.precise ? 'Granted, precise' : 'Granted, approximate only') : r.permission) : '…'}
          tone={r?.permission === 'granted' && r.precise ? 'good' : 'bad'}
        />
        <Muted>
          Needed to detect checkpoints. Only “while using the app” is requested: during tracking a persistent notification keeps
          location working with the screen off. Precise location is required; approximate (~1–3 km) cannot detect a 20 m checkpoint.
        </Muted>
        {r?.permission !== 'granted' || !r.precise ? (
          <Row>
            {r?.canAskAgain !== false ? (
              <Button label="Grant location" onPress={() => void requestLocationPermission().then(setR)} />
            ) : null}
            <Button label="Open app settings" variant="secondary" onPress={() => void Linking.openSettings()} />
          </Row>
        ) : null}
        {r?.notificationsGranted != null ? (
          <>
            <StatusRow
              label="Notifications"
              value={r.notificationsGranted ? 'Allowed' : 'Not allowed'}
              tone={r.notificationsGranted ? 'good' : 'warn'}
            />
            {!r.notificationsGranted ? (
              <>
                <Muted>Without it, the tracking notification is hidden from the shade (tracking still works).</Muted>
                <Button label="Allow notifications" variant="secondary" onPress={() => void requestNotificationPermission().then(refresh)} />
              </>
            ) : null}
          </>
        ) : null}
      </Card>

      <Card title="GPS">
        <StatusRow label="Location services" value={r?.servicesEnabled ? 'On' : 'Off'} tone={r?.servicesEnabled ? 'good' : 'bad'} />
        {r?.gpsAvailable != null ? (
          <StatusRow label="GPS provider" value={r.gpsAvailable ? 'Available' : 'Unavailable'} tone={r.gpsAvailable ? 'good' : 'bad'} />
        ) : null}
        {!r?.servicesEnabled ? <Button label="Turn on location" onPress={() => void promptEnableLocationServices().then(refresh)} /> : null}
        <StatusRow
          label="Last fix"
          value={last ? `±${fmtMeters(last.accuracyM)}, ${fmtAge(now - last.timestampMs)}` : 'None'}
          tone={last ? 'info' : 'muted'}
        />
        {status?.engine.lastQuality ? (
          <StatusRow label="Last sample" value={QUALITY_TEXT[status.engine.lastQuality]} tone={status.engine.lastQuality === 'good' ? 'good' : 'warn'} />
        ) : null}
        <Body>Airplane mode: on most phones GPS keeps working; turn Location back on if the phone switched it off.</Body>
      </Card>

      <Card title="Tracking">
        <StatusRow label="Session" value={status?.active ? `Active (${status.source})` : 'Stopped'} tone={status?.active ? 'good' : 'muted'} />
        <StatusRow
          label="Location service"
          value={serviceRunning ? 'Running (notification shown)' : 'Not running'}
          tone={serviceRunning ? 'good' : 'muted'}
        />
        <StatusRow label="Samples this session" value={String(status?.samplesProcessed ?? 0)} />
        {status?.recoveredFromInterruption ? (
          <StatusRow label="Recovery" value="Resumed after interruption" tone="warn" />
        ) : null}
        <StatusRow
          label="Audio"
          value={status?.audio.current ? `${status.audio.status}: ${status.audio.current.label}` : 'Idle'}
          tone={status?.audio.status === 'playing' ? 'good' : 'muted'}
        />
        {status?.audio.lastError ? <Text style={styles.error}>{status.audio.lastError}</Text> : null}
        {status?.error ? <Text style={styles.error}>{status.error}</Text> : null}
        <Muted>
          Android cannot keep tracking after you force-stop the app, and some battery savers may stop it. If that happens the
          app restarts tracking the next time you open it.
        </Muted>
      </Card>

      <Card title="Checkpoint states">
        {(status?.engine.checkpoints ?? []).length === 0 ? <Muted>No enabled checkpoints.</Muted> : null}
        {status?.engine.checkpoints.map((c) => (
          <StatusRow
            key={c.id}
            label={c.name}
            value={`${STATE_TEXT[c.state]}${c.distanceM != null ? ` · ${fmtMeters(c.distanceM)}` : ''}`}
            tone={c.state === 'PLAYING' || c.state === 'TRIGGERED' ? 'good' : c.state === 'CANDIDATE' ? 'warn' : 'info'}
          />
        ))}
      </Card>

      <Card title="Trigger history (this phone only)">
        {history.length === 0 ? <Muted>No triggers yet.</Muted> : null}
        {history.map((h) => (
          <View key={h.id} style={{ borderTopWidth: 1, borderColor: colors.border, paddingVertical: 4 }}>
            <Text style={styles.body}>
              {h.checkpointName ?? 'Deleted checkpoint'} · {h.playbackStatus}
            </Text>
            <Muted>
              {fmtTime(h.triggeredAt)} · {fmtMeters(h.distanceM)} from centre · ±{fmtMeters(h.accuracyM)}
            </Muted>
          </View>
        ))}
        {history.length > 0 ? (
          <Button
            label="Clear history"
            variant="secondary"
            onPress={() => void services.history.clear().then(refresh)}
          />
        ) : null}
      </Card>
    </Screen>
  );
}
