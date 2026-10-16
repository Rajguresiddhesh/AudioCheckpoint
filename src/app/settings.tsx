import { OfflineManager } from '@maplibre/maplibre-react-native';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { deleteAllAudio } from '../audio/audioFiles';
import type { PlaybackPolicy } from '../audio/audioManager';
import { DEFAULT_SETTINGS, type AppSettings } from '../config/settings';
import { deleteAllData } from '../data/repositories';
import type { EngineConfig, OverlapPolicy } from '../engine/types';
import { stopTracking } from '../location/trackingService';
import { Banner, Button, Card, Chip, Field, Loading, Muted, Row, Screen, Toggle } from '../ui/components';
import { parseNumber } from '../ui/format';
import { useServices } from '../ui/hooks';

type NumKey = 'defaultRadiusM' | 'saveAccuracyThresholdM' | 'duplicateDistanceM' | 'locationIntervalMs';
type EngineNumKey = {
  [K in keyof EngineConfig]: EngineConfig[K] extends number ? K : never;
}[keyof EngineConfig];

const LIMITS: Record<string, [number, number]> = {
  defaultRadiusM: [3, 500],
  saveAccuracyThresholdM: [1, 100],
  duplicateDistanceM: [0, 50],
  locationIntervalMs: [500, 30_000],
  maxAccuracyM: [3, 200],
  entryConfirmSamples: [1, 20],
  entryDwellMs: [0, 120_000],
  exitHysteresisM: [0, 100],
  rearmOutsideSamples: [1, 20],
  rearmMinOutsideMs: [0, 3_600_000],
  cooldownMs: [0, 3_600_000],
  maxSampleAgeMs: [2000, 120_000],
  candidateTimeoutMs: [5000, 600_000],
};

export default function SettingsScreen() {
  const { services } = useServices();
  const [s, setS] = useState<AppSettings | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const load = (v: AppSettings) => {
    setS(v);
    const t: Record<string, string> = {};
    for (const k of ['defaultRadiusM', 'saveAccuracyThresholdM', 'duplicateDistanceM', 'locationIntervalMs'] as NumKey[]) t[k] = String(v[k]);
    for (const k of Object.keys(LIMITS)) if (k in v.engine) t[k] = String(v.engine[k as EngineNumKey]);
    t.altitudeToleranceM = v.engine.altitudeToleranceM == null ? '' : String(v.engine.altitudeToleranceM);
    setText(t);
  };

  useEffect(() => {
    if (services) void services.settings.load().then(load);
  }, [services]);

  if (!services || !s) return <Loading />;

  const num = (key: string, label: string, hint?: string) => (
    <Field
      key={key}
      label={label}
      hint={hint}
      value={text[key] ?? ''}
      onChangeText={(v) => setText((t) => ({ ...t, [key]: v }))}
      keyboardType="numeric"
    />
  );

  const save = async () => {
    const next: AppSettings = { ...s, engine: { ...s.engine } };
    for (const [key, [lo, hi]] of Object.entries(LIMITS)) {
      const v = parseNumber(text[key] ?? '');
      if (v == null || v < lo || v > hi) {
        setMessage({ tone: 'bad', text: `${key} must be between ${lo} and ${hi}.` });
        return;
      }
      if (key in next.engine) (next.engine as unknown as Record<string, number>)[key] = v;
      else (next as unknown as Record<string, number>)[key] = v;
    }
    const alt = text.altitudeToleranceM?.trim() ?? '';
    next.engine.altitudeToleranceM = alt === '' ? null : parseNumber(alt);
    if (alt !== '' && (next.engine.altitudeToleranceM == null || next.engine.altitudeToleranceM < 0)) {
      setMessage({ tone: 'bad', text: 'Altitude tolerance must be blank or a positive number.' });
      return;
    }
    await services.settings.save(next);
    await services.controller.reloadCheckpoints(); // also reloads engine config + playback policy
    load(next);
    setMessage({ tone: 'good', text: 'Saved. Restart tracking for a new GPS interval to take effect.' });
  };

  const resetDefaults = async () => {
    await services.settings.save(DEFAULT_SETTINGS);
    await services.controller.reloadCheckpoints();
    load(DEFAULT_SETTINGS);
    setMessage({ tone: 'good', text: 'Defaults restored.' });
  };

  const deleteEverything = () =>
    Alert.alert(
      'Delete all local data',
      'This stops tracking and deletes all checkpoints, trigger history, imported audio, offline maps and settings from this phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete everything',
          style: 'destructive',
          onPress: async () => {
            await stopTracking().catch(() => undefined);
            await deleteAllData(services.db);
            try {
              deleteAllAudio();
            } catch {
              // ignore
            }
            await OfflineManager.resetDatabase().catch(() => undefined);
            await services.controller.reloadCheckpoints();
            router.replace('/');
          },
        },
      ],
    );

  return (
    <Screen>
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}

      <Card title="Creator Mode">
        {num('defaultRadiusM', 'Default trigger radius (m)')}
        <Toggle
          label="Only save when accuracy is good"
          value={s.requireAccuracyForSave}
          onValueChange={(v) => setS({ ...s, requireAccuracyForSave: v })}
        />
        {num('saveAccuracyThresholdM', 'Acceptable accuracy for saving (m)')}
        {num('duplicateDistanceM', 'Duplicate warning distance (m)', 'Saving closer than this to another checkpoint needs confirmation.')}
      </Card>

      <Card title="Detection">
        {num('maxAccuracyM', 'Max accuracy to trigger (m)', 'Fixes worse than this never trigger audio (shown as low confidence).')}
        {num('entryConfirmSamples', 'Consecutive fixes inside to trigger')}
        {num('entryDwellMs', 'Minimum dwell before trigger (ms)')}
        {num('exitHysteresisM', 'Exit hysteresis (m)', 'You must be this far beyond the radius to count as having left.')}
        {num('rearmOutsideSamples', 'Consecutive fixes outside to rearm')}
        {num('rearmMinOutsideMs', 'Minimum time outside to rearm (ms)')}
        {num('cooldownMs', 'Cooldown after a trigger (ms)')}
        {num('maxSampleAgeMs', 'Reject fixes older than (ms)')}
        {num('candidateTimeoutMs', 'Forget partial entry after GPS loss (ms)')}
        {num('locationIntervalMs', 'GPS interval while tracking (ms)', 'Shorter = more responsive, more battery.')}
        <Field
          label="Altitude tolerance (m, blank = off)"
          hint="Only for checkpoints with an altitude. GPS altitude is rough; never use it to separate floors."
          value={text.altitudeToleranceM ?? ''}
          onChangeText={(v) => setText((t) => ({ ...t, altitudeToleranceM: v }))}
          keyboardType="numeric"
        />
        <Toggle
          label="Accept mock locations"
          hint="Needed for location-spoofing test apps; turn off for real visits."
          value={s.engine.allowMockLocations}
          onValueChange={(v) => setS({ ...s, engine: { ...s.engine, allowMockLocations: v } })}
        />
      </Card>

      <Card title="Overlapping checkpoints">
        <Row>
          {(['exclusive', 'independent'] as OverlapPolicy[]).map((p) => (
            <Chip key={p} label={p === 'exclusive' ? 'One at a time' : 'Independent'} selected={s.engine.overlapPolicy === p}
              onPress={() => setS({ ...s, engine: { ...s.engine, overlapPolicy: p } })} />
          ))}
        </Row>
        <Muted>
          One at a time: the highest-priority checkpoint plays; others wait and play afterwards if you are still there.
          Independent: each triggers on its own and the audio policy below decides.
        </Muted>
      </Card>

      <Card title="Audio">
        <Row>
          {(['queue', 'interrupt', 'ignore'] as PlaybackPolicy[]).map((p) => (
            <Chip key={p} label={{ queue: 'Queue', interrupt: 'Interrupt', ignore: 'Ignore while playing' }[p]}
              selected={s.playbackPolicy === p} onPress={() => setS({ ...s, playbackPolicy: p })} />
          ))}
        </Row>
        <Toggle
          label="Stop audio when I leave the checkpoint"
          value={s.stopAudioOnExit}
          onValueChange={(v) => setS({ ...s, stopAudioOnExit: v })}
        />
      </Card>

      <Card title="Map">
        <Field
          label="Map style URL"
          value={s.mapStyleUrl}
          onChangeText={(v) => setS({ ...s, mapStyleUrl: v.trim() })}
          autoCapitalize="none"
          hint="Used for online viewing and new offline downloads."
        />
      </Card>

      <Button label="Save settings" onPress={() => void save()} />
      <Button label="Restore defaults" variant="secondary" onPress={() => void resetDefaults()} />

      <Card title="Privacy">
        <Muted>All data stays on this phone. Nothing is uploaded.</Muted>
        <Button label="Delete all local data" variant="danger" onPress={deleteEverything} />
      </Card>
    </Screen>
  );
}
