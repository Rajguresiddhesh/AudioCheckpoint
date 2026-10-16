import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, Switch, Text, View } from 'react-native';
import { describeAudioRef } from '../audio/audioValidation';
import type { AppSettings } from '../config/settings';
import { distanceM } from '../engine/geo';
import type { LocationSample } from '../engine/types';
import { validateCheckpointDraft } from '../engine/validation';
import { getLocationReadiness, requestLocationPermission, watchForeground } from '../location/expoLocation';
import { Banner, Button, Card, Muted, Row, Screen, StatusRow, colors, styles } from '../ui/components';
import { accuracyTone, fmtAge, fmtMeters } from '../ui/format';
import { useCheckpoints, useInterval, useServices } from '../ui/hooks';

export default function CreatorMode() {
  const { services } = useServices();
  const { checkpoints, reload } = useCheckpoints(services);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [fix, setFix] = useState<LocationSample | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
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
        let r = await getLocationReadiness();
        if (r.permission !== 'granted') r = await requestLocationPermission();
        if (r.permission !== 'granted') {
          setGpsError('Location permission is required to capture checkpoints at your position.');
          return;
        }
        if (!r.servicesEnabled) {
          setGpsError('Location services are off. Turn on GPS to capture positions.');
          return;
        }
        setGpsError(null);
        const s = await watchForeground(
          (sample) => setFix(sample),
          (msg) => setGpsError(msg),
        );
        if (cancelled) s.remove();
        else sub = s;
      })();
      return () => {
        cancelled = true;
        sub?.remove();
      };
    }, []),
  );

  const threshold = settings?.saveAccuracyThresholdM ?? 15;
  const requireAccuracy = settings?.requireAccuracyForSave ?? true;
  const fresh = fix != null && now - fix.timestampMs < 10_000;
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

  const saveHere = () => {
    if (!fix) return;
    router.push({
      pathname: '/checkpoint/[id]',
      params: {
        id: 'new',
        lat: String(fix.latitude),
        lon: String(fix.longitude),
        acc: fix.accuracyM != null ? String(fix.accuracyM) : '',
        alt: fix.altitudeM != null ? String(fix.altitudeM) : '',
      },
    });
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
      <Card title="Your position">
        {gpsError ? <Banner tone="bad">{gpsError}</Banner> : null}
        {fix ? (
          <>
            <StatusRow label="Latitude" value={fix.latitude.toFixed(6)} tone="info" />
            <StatusRow label="Longitude" value={fix.longitude.toFixed(6)} tone="info" />
            <StatusRow
              label="Accuracy"
              value={`±${fmtMeters(fix.accuracyM)} (need ≤ ${threshold} m)`}
              tone={accuracyTone(fix.accuracyM, threshold)}
            />
            <StatusRow label="Fix age" value={fmtAge(now - fix.timestampMs)} tone={fresh ? 'good' : 'bad'} />
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
              ? 'No fresh GPS fix yet.'
              : `Accuracy ±${fmtMeters(fix.accuracyM)} is worse than ${threshold} m. Wait a few seconds or move away from buildings/trees.`}
          </Banner>
        ) : null}
        {preview?.nearDuplicateOf ? (
          <Banner tone="warn">You are within {settings?.duplicateDistanceM} m of “{preview.nearDuplicateOf.name}”.</Banner>
        ) : preview && preview.overlaps.some((o) => o.kind === 'overlap') ? (
          <Banner tone="info">A {settings?.defaultRadiusM} m checkpoint here would overlap {preview.overlaps.map((o) => `“${o.name}”`).join(', ')}.</Banner>
        ) : null}
        <Button label="Save checkpoint here" onPress={saveHere} disabled={!canSave} />
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
