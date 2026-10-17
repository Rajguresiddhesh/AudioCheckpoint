import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, Switch, Text, View } from 'react-native';
import MapView, { Circle, Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { describeAudioRef } from '../audio/audioValidation';
import type { AppSettings } from '../config/settings';
import { distanceM } from '../engine/geo';
import type { LocationSample } from '../engine/types';
import { validateCheckpointDraft } from '../engine/validation';
import { SITE } from '../config/site';
import {
  getLocationReadiness,
  promptEnableLocationServices,
  requestLocationPermission,
  watchForeground,
} from '../location/expoLocation';
import { checkpointColor } from '../map/geojson';
import { googleMapsConfigured } from '../map/GoogleCheckpointMap';
import { Banner, Button, Card, Muted, Row, Screen, StatusRow, colors, styles } from '../ui/components';
import { accuracyTone, fmtAge, fmtMeters } from '../ui/format';
import { useCheckpoints, useInterval, useServices } from '../ui/hooks';

export default function CreatorMode() {
  const { services } = useServices();
  const { checkpoints, reload } = useCheckpoints(services);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [fix, setFix] = useState<LocationSample | null>(null);
  const [fixReceivedAt, setFixReceivedAt] = useState(0);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [approximateOnly, setApproximateOnly] = useState(false);
  const [watchAttempt, setWatchAttempt] = useState(0);
  const mapRef = useRef<MapView>(null);
  const mapCentred = useRef(false);

  // Centre the map on the first fix only, so the user can pan freely afterwards.
  useEffect(() => {
    if (!fix || mapCentred.current || !mapRef.current) return;
    mapCentred.current = true;
    mapRef.current.animateToRegion(
      { latitude: fix.latitude, longitude: fix.longitude, latitudeDelta: 0.003, longitudeDelta: 0.003 },
      500,
    );
  }, [fix]);
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 1000);

  useEffect(() => {
    if (services) void services.settings.load().then(setSettings);
  }, [services]);

  // Watch GPS only while this screen is focused (battery).
  useFocusEffect(
    useCallback(() => {
      let sub: { remove(): void } | null = null;
      let cancelled = false;
      void (async () => {
        try {
          let r = await getLocationReadiness();
          if (r.permission !== 'granted') r = await requestLocationPermission();
          if (cancelled) return;
          if (r.permission !== 'granted') {
            setGpsError(
              r.canAskAgain
                ? 'Location permission is required to capture checkpoints at your position.'
                : 'Location permission was denied. Enable it in system settings.',
            );
            return;
          }
          setApproximateOnly(!r.precise);
          if (!r.servicesEnabled && !(await promptEnableLocationServices())) {
            if (!cancelled) setGpsError('Location services are off. Turn on GPS to capture positions.');
            return;
          }
          if (cancelled) return;
          setGpsError(null);
          const s = await watchForeground(
            (sample, receivedAt) => {
              setFix(sample);
              setFixReceivedAt(receivedAt);
            },
            (msg) => setGpsError(msg),
          );
          if (cancelled) s.remove();
          else sub = s;
        } catch (e) {
          if (!cancelled) setGpsError(`Could not read your location: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
      return () => {
        cancelled = true;
        sub?.remove();
      };
      // watchAttempt is a deliberate re-run trigger for "Refresh location".
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [watchAttempt]),
  );

  const threshold = settings?.saveAccuracyThresholdM ?? 15;
  const requireAccuracy = settings?.requireAccuracyForSave ?? true;
  const fixAge = now - fixReceivedAt;
  const fresh = fix != null && fixAge < 10_000;
  const accurate = fix?.accuracyM != null && fix.accuracyM <= threshold;
  const canSave = fresh && (!requireAccuracy || accurate);

  const overlaps: string[] = [];
  if (settings) {
    for (let i = 0; i < checkpoints.length; i++) {
      for (let j = i + 1; j < checkpoints.length; j++) {
        const a = checkpoints[i];
        const b = checkpoints[j];
        if (distanceM(a, b) < a.triggerRadiusM + b.triggerRadiusM) {
          overlaps.push(`"${a.name}" and "${b.name}" overlap (${fmtMeters(distanceM(a, b))} apart).`);
        }
      }
    }
  }

  // Warn before saving here if the spot duplicates or overlaps an existing checkpoint.
  const preview =
    fix && settings
      ? validateCheckpointDraft(
          { name: 'new', latitude: fix.latitude, longitude: fix.longitude, triggerRadiusM: settings.defaultRadiusM, priority: 0 },
          checkpoints,
          { duplicateDistanceM: settings.duplicateDistanceM, exitHysteresisM: settings.engine.exitHysteresisM, allowNearDuplicate: true },
        )
      : null;

  const openNew = (p: { latitude: number; longitude: number; accuracyM?: number | null; altitudeM?: number | null }) =>
    router.push({
      pathname: '/checkpoint/[id]',
      params: {
        id: 'new',
        lat: String(p.latitude),
        lon: String(p.longitude),
        acc: p.accuracyM != null ? String(p.accuracyM) : '',
        alt: p.altitudeM != null ? String(p.altitudeM) : '',
      },
    });

  const saveHere = () => {
    if (!fix) return;
    if (canSave) {
      openNew(fix);
      return;
    }
    // Do not dead-end the user: explain and let them decide.
    Alert.alert(
      fresh ? 'Low GPS accuracy' : 'Old position',
      fresh
        ? `Accuracy is ±${fmtMeters(fix.accuracyM)}, worse than ${threshold} m. The checkpoint may be placed off the real spot. Wait for a better fix, or save anyway and correct it later.`
        : `This position is ${fmtAge(fixAge)} old. Wait for a fresh fix, or save it anyway and correct it later.`,
      [
        { text: 'Wait', style: 'cancel' },
        { text: 'Save anyway', onPress: () => openNew(fix) },
      ],
    );
  };

  const confirmDelete = (id: string, name: string) => {
    Alert.alert('Delete checkpoint', `Delete "${name}" and its trigger history? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await services?.checkpoints.delete(id);
          await services?.controller.reloadCheckpoints();
          await reload();
        },
      },
    ]);
  };

  return (
    <Screen>
      {googleMapsConfigured ? (
        <View style={{ height: 260, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: colors.border }}>
          <MapView
            style={{ flex: 1 }}
            provider={PROVIDER_GOOGLE}
            initialRegion={{ ...SITE.center, latitudeDelta: 0.006, longitudeDelta: 0.006 }}
            ref={mapRef}
            onLongPress={(e) => openNew(e.nativeEvent.coordinate)}
            toolbarEnabled={false}
          >
            {checkpoints.map((c) => (
              <Circle
                key={c.id}
                center={{ latitude: c.latitude, longitude: c.longitude }}
                radius={c.triggerRadiusM}
                strokeColor={checkpointColor(c, undefined)}
                fillColor={checkpointColor(c, undefined) + '2e'}
                strokeWidth={2}
              />
            ))}
            {checkpoints.map((c) => (
              <Marker key={`m-${c.id}`} coordinate={{ latitude: c.latitude, longitude: c.longitude }} title={c.name} />
            ))}
            {fix?.accuracyM ? (
              <Circle
                center={{ latitude: fix.latitude, longitude: fix.longitude }}
                radius={fix.accuracyM}
                strokeColor="rgba(37,99,235,0.5)"
                fillColor="rgba(37,99,235,0.12)"
              />
            ) : null}
            {fix ? (
              <Marker coordinate={{ latitude: fix.latitude, longitude: fix.longitude }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
                <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: '#2563eb', borderWidth: 3, borderColor: '#fff' }} />
              </Marker>
            ) : null}
          </MapView>
        </View>
      ) : null}
      {googleMapsConfigured ? <Muted>Long-press the map to add a checkpoint at that point.</Muted> : null}
      <Card title="Your position">
        {gpsError ? (
          <Banner tone="bad">
            {gpsError}
            {gpsError.includes('system settings') ? (
              <Text style={{ color: colors.primary }} onPress={() => void Linking.openSettings()}>
                {'  '}Open settings
              </Text>
            ) : null}
          </Banner>
        ) : null}
        {approximateOnly ? (
          <Banner tone="warn">
            Only approximate location is allowed. Allow “Precise” location for this app in system settings to place checkpoints accurately.
          </Banner>
        ) : null}
        {fix ? (
          <>
            <StatusRow label="Latitude" value={fix.latitude.toFixed(6)} tone="info" />
            <StatusRow label="Longitude" value={fix.longitude.toFixed(6)} tone="info" />
            <StatusRow
              label="Accuracy"
              value={`±${fmtMeters(fix.accuracyM)} (need ≤ ${threshold} m)`}
              tone={accuracyTone(fix.accuracyM, threshold)}
            />
            <StatusRow label="Fix age" value={fmtAge(fixAge)} tone={fresh ? 'good' : 'bad'} />
            {fix.altitudeM != null ? (
              <StatusRow label="GPS altitude" value={`${fix.altitudeM.toFixed(0)} m (rough)`} tone="muted" />
            ) : null}
          </>
        ) : !gpsError ? (
          <Muted>Waiting for GPS… stand in open sky for the best fix.</Muted>
        ) : null}
        {fix && !canSave ? (
          <Banner tone="warn">
            {!fresh
              ? 'Showing your last known position; waiting for a fresh GPS fix.'
              : `Accuracy ±${fmtMeters(fix.accuracyM)} is worse than ${threshold} m. Wait a few seconds or move away from buildings/trees (you can still save anyway).`}
          </Banner>
        ) : null}
        {preview?.nearDuplicateOf ? (
          <Banner tone="warn">You are within {settings?.duplicateDistanceM} m of “{preview.nearDuplicateOf.name}”.</Banner>
        ) : preview && preview.overlaps.some((o) => o.kind === 'overlap') ? (
          <Banner tone="info">A {settings?.defaultRadiusM} m checkpoint here would overlap {preview.overlaps.map((o) => `“${o.name}”`).join(', ')}.</Banner>
        ) : null}
        <Button label="Save checkpoint here" onPress={saveHere} disabled={!fix} />
        {gpsError || !fix ? (
          <Button
            label="Refresh location"
            variant="secondary"
            onPress={() => {
              setGpsError(null);
              setWatchAttempt((a) => a + 1);
            }}
          />
        ) : null}
        <Button
          label="Add by typing coordinates"
          variant="secondary"
          onPress={() => router.push({ pathname: '/checkpoint/[id]', params: { id: 'new' } })}
        />
      </Card>

      {overlaps.map((o) => (
        <Banner key={o} tone="warn">
          {o} Both may qualify at once; the priority setting decides which plays first.
        </Banner>
      ))}

      <Card title={`Checkpoints (${checkpoints.length})`}>
        {checkpoints.length === 0 ? <Muted>None yet. Walk to a spot and press “Save checkpoint here”.</Muted> : null}
        {checkpoints.map((c) => (
          <View key={c.id} style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 8, gap: 4 }}>
            <Row>
              <Pressable
                style={{ flex: 1 }}
                onPress={() => router.push({ pathname: '/checkpoint/[id]', params: { id: c.id } })}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${c.name}`}
              >
                <Text style={[styles.cardTitle, { color: c.enabled ? colors.text : colors.muted }]}>{c.name}</Text>
                <Muted>
                  r = {c.triggerRadiusM} m · priority {c.priority} · {describeAudioRef(c.audioUri, c.audioLabel)}
                  {fix ? ` · ${fmtMeters(distanceM(fix, c))} from you` : ''}
                </Muted>
                {!c.coordinatesVerified ? (
                  <Text style={[styles.hint, { color: colors.warn }]}>Placeholder position – re-capture on site</Text>
                ) : null}
              </Pressable>
              <Switch
                value={c.enabled}
                accessibilityLabel={`${c.name} enabled`}
                onValueChange={async (v) => {
                  await services?.checkpoints.setEnabled(c.id, v);
                  await services?.controller.reloadCheckpoints();
                  await reload();
                }}
              />
            </Row>
            <Row>
              <Button
                label="Edit"
                variant="secondary"
                onPress={() => router.push({ pathname: '/checkpoint/[id]', params: { id: c.id } })}
              />
              <Button label="Delete" variant="danger" onPress={() => confirmDelete(c.id, c.name)} />
            </Row>
          </View>
        ))}
      </Card>
    </Screen>
  );
}
