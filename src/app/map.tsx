import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AppSettings } from '../config/settings';
import { SITE } from '../config/site';
import type { CheckpointState } from '../engine/types';
import {
  getLocationReadiness,
  promptEnableLocationServices,
  requestLocationPermission,
  requestNotificationPermission,
} from '../location/expoLocation';
import { getBleStatus, requestBlePermission, subscribeBleStatus, type BleStatus } from '../location/bleScanner';
import { retryBeaconScanning, startGnssTracking, startSimulation, stopTracking } from '../location/trackingService';
import { CheckpointMap } from '../map/CheckpointMap';
import { LeafletMap } from '../map/LeafletMap';
import { SchematicMap } from '../map/SchematicMap';
import { Banner, Button, Chip, Row, StatusRow, colors, styles } from '../ui/components';
import { accuracyTone, fmtAge, fmtMeters, POLICY_LABEL, QUALITY_TEXT, STATE_TEXT } from '../ui/format';
import { useCheckpoints, useInterval, useServices, useTrackingStatus, useUsableMapPackage } from '../ui/hooks';

type ViewMode = 'offline' | 'online' | 'schematic';

export default function UserMode() {
  const { services } = useServices();
  const status = useTrackingStatus(services);
  const { checkpoints } = useCheckpoints(services);
  const { pkg, checked } = useUsableMapPackage(services);
  const [mode, setMode] = useState<ViewMode | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useInterval(() => setNow(Date.now()), 1000);
  const [ble, setBle] = useState<BleStatus>(getBleStatus);
  useEffect(() => subscribeBleStatus(setBle), []);
  useEffect(() => {
    if (services) void services.settings.load().then(setSettings);
  }, [services]);
  const maxAccuracy = settings?.engine.maxAccuracyM ?? 25;

  // Online (Leaflet) by default; it falls back to the schematic view by itself when there is no internet.
  const effectiveMode: ViewMode = mode ?? 'online';

  const states = useMemo(() => {
    const m: Record<string, CheckpointState | undefined> = {};
    for (const c of status?.engine.checkpoints ?? []) m[c.id] = c.state;
    return m;
  }, [status]);

  const last = status?.engine.lastSample ?? null;
  const active = status?.engine.checkpoints.find((c) => c.id === status.engine.activeCheckpointId) ?? null;
  const nearest = [...(status?.engine.checkpoints ?? [])]
    .filter((c) => c.distanceM != null)
    .sort((a, b) => a.distanceM! - b.distanceM!)[0];

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      let r = await getLocationReadiness();
      if (r.permission !== 'granted') r = await requestLocationPermission();
      if (r.permission !== 'granted') {
        setError(
          r.canAskAgain
            ? 'Location permission is needed to detect checkpoints.'
            : 'Location permission was denied. Enable it in system settings.',
        );
        return;
      }
      if (!r.servicesEnabled && !(await promptEnableLocationServices())) {
        setError('Turn on location services (GPS) to start tracking.');
        return;
      }
      await requestNotificationPermission();
      // Indoor checkpoints need "Nearby devices" (Android 12+); ask while the app is in front.
      if (services?.controller.needsBeaconScans() && !(await requestBlePermission())) {
        setError('Bluetooth ("Nearby devices") permission was denied, so indoor beacon checkpoints cannot trigger.');
      }
      await startGnssTracking();
      if (!r.precise) {
        setError(
          'Only approximate location is allowed, so checkpoints cannot trigger. Allow “Precise” location for this app in system settings.',
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const simulate = async () => {
    setBusy(true);
    setError(null);
    try {
      await startSimulation();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await stopTracking();
    } finally {
      setBusy(false);
    }
  };

  const selectMode = (m: ViewMode) => {
    setMapFailed(false);
    setTilesFailed(false);
    setMode(m);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['bottom', 'left', 'right']}>
      <View style={s.mapBox}>
        {effectiveMode === 'online' && !mapFailed ? (
          <LeafletMap
            bounds={SITE.bounds}
            checkpoints={checkpoints}
            states={states}
            user={last}
            follow={!!status?.active}
            onFail={() => setMapFailed(true)}
            onTilesFailed={() => setTilesFailed(true)}
          />
        ) : effectiveMode === 'offline' && pkg?.styleUrl && !mapFailed ? (
          <CheckpointMap
            styleUrl={pkg.styleUrl}
            bounds={pkg.bounds}
            checkpoints={checkpoints}
            states={states}
            user={last}
            onFail={() => setMapFailed(true)}
          />
        ) : (
          <SchematicMap checkpoints={checkpoints} states={states} user={last} center={SITE.center} />
        )}
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Row>
          <Chip label="Online map" selected={effectiveMode === 'online'} onPress={() => selectMode('online')} />
          <Chip label="Offline map" selected={effectiveMode === 'offline'} onPress={() => selectMode('offline')} />
          <Chip label="Schematic" selected={effectiveMode === 'schematic'} onPress={() => selectMode('schematic')} />
        </Row>
        {effectiveMode === 'offline' && checked && !pkg ? (
          <Banner tone="warn">
            No verified offline map on this phone, so the schematic view is shown. Checkpoints and audio still work fully
            offline. Download the park area under Offline maps while you have internet.
          </Banner>
        ) : null}
        {effectiveMode === 'online' && mapFailed ? (
          <Banner tone="warn">
            The online map needs internet, so the schematic view is shown. Checkpoints and audio work fully offline.
          </Banner>
        ) : effectiveMode === 'online' && tilesFailed ? (
          <Banner tone="warn">Map tiles could not download (no internet?). Checkpoints and audio still work.</Banner>
        ) : null}
        {effectiveMode === 'offline' && mapFailed ? (
          <Banner tone="bad">The offline map could not load (no data for this area or a damaged package). Showing the schematic view.</Banner>
        ) : null}

        <View style={styles.card}>
          <StatusRow
            label="Tracking"
            value={status?.active ? `Active (${status.source})` : 'Stopped'}
            tone={status?.active ? 'good' : 'muted'}
          />
          <StatusRow
            label="GPS fix"
            value={
              last
                ? `±${fmtMeters(last.accuracyM)} · ${fmtAge(now - last.timestampMs)}`
                : status?.active
                  ? 'Waiting for first fix…'
                  : '–'
            }
            tone={last ? accuracyTone(last.accuracyM, maxAccuracy) : 'muted'}
          />
          {status?.engine.lastQuality ? (
            <StatusRow
              label="Signal"
              value={QUALITY_TEXT[status.engine.lastQuality]}
              tone={status.engine.lastQuality === 'good' ? 'good' : 'warn'}
            />
          ) : null}
          {last && status?.active && now - last.timestampMs > 20_000 ? (
            <Banner tone="warn">No recent GPS fix. Move into open sky; checkpoints will not trigger until the signal returns.</Banner>
          ) : null}
          <StatusRow
            label="Active checkpoint"
            value={active ? `${active.name} – ${STATE_TEXT[active.state]}` : 'None'}
            tone={active ? 'good' : 'muted'}
          />
          {nearest ? (
            <StatusRow
              label="Nearest"
              value={`${nearest.name}: ${fmtMeters(nearest.distanceM)} · ${STATE_TEXT[nearest.state]}`}
              tone={nearest.state === 'CANDIDATE' ? 'warn' : 'info'}
            />
          ) : null}
          <StatusRow
            label="Audio"
            value={status?.audio.current ? `${status.audio.status}: ${status.audio.current.label}` : 'Idle'}
            tone={status?.audio.status === 'playing' ? 'good' : 'muted'}
          />
          {status?.active
            ? status.engine.checkpoints
                .filter((c) => c.policy !== 'OUTDOOR_GPS')
                .map((c) => (
                  <StatusRow
                    key={c.id}
                    label={`${c.name} (${POLICY_LABEL[c.policy]})`}
                    value={c.waitingFor ?? STATE_TEXT[c.state]}
                    tone={c.waitingFor ? 'warn' : c.state === 'OUTSIDE' ? 'muted' : 'good'}
                  />
                ))
            : null}
          {status?.active && ble.kind !== 'stopped' ? (
            <StatusRow
              label="Beacons"
              value={
                ble.kind === 'unavailable'
                  ? ble.message
                  : `${ble.lastHeard ? `heard ${fmtAge(now - ble.lastHeard)}` : 'none heard yet'}${
                      status.engine.floorEstimate != null ? ` · floor ${status.engine.floorEstimate}` : ''
                    }`
              }
              tone={ble.kind === 'unavailable' ? 'bad' : ble.lastHeard ? 'good' : 'warn'}
            />
          ) : null}
          {status?.active && ble.kind === 'unavailable' ? (
            <Text style={[styles.hint, { color: colors.primary }]} onPress={retryBeaconScanning}>
              Retry Bluetooth
            </Text>
          ) : null}
          {status?.lastEventText ? <Text style={styles.hint}>{status.lastEventText}</Text> : null}
        </View>

        {status?.error ? <Banner tone="bad">{status.error}</Banner> : null}
        {error ? (
          <Banner tone="bad">
            {error}
            {error.includes('system settings') ? (
              <Text style={{ color: colors.primary }} onPress={() => void Linking.openSettings()}>
                {'  '}Open settings
              </Text>
            ) : null}
          </Banner>
        ) : null}

        <Row>
          {status?.active ? (
            <Button label="Stop tracking" variant="danger" onPress={stop} busy={busy} />
          ) : (
            <Button label="Start tracking" onPress={start} busy={busy} accessibilityHint="Starts GPS tracking with a persistent notification" />
          )}
        </Row>
        <Row>
          {status?.audio.status === 'playing' ? (
            <Button label="Pause audio" variant="secondary" onPress={() => services?.audio.pause()} />
          ) : status?.audio.status === 'paused' ? (
            <Button label="Resume audio" variant="secondary" onPress={() => services?.audio.resume()} />
          ) : null}
          {status?.audio.current ? (
            <Button label="Stop audio" variant="secondary" onPress={() => void services?.audio.stop()} />
          ) : null}
        </Row>
        {!status?.active ? (
          <Button label="Simulate a walk through all checkpoints" variant="secondary" onPress={simulate} busy={busy} />
        ) : null}
        <Button label="Permissions & status" variant="secondary" onPress={() => router.push('/status')} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  mapBox: { height: '45%', borderBottomWidth: 1, borderColor: colors.border },
});
