import * as Location from 'expo-location';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import type { AppSettings } from '../../config/settings';
import type { Checkpoint } from '../../data/models';
import { ValidationError } from '../../data/repositories';
import { validateCheckpointDraft } from '../../engine/validation';
import { toSample } from '../../location/expoLocation';
import { AudioPicker, type AudioChoice } from '../../ui/AudioPicker';
import { Banner, Button, Card, Field, Loading, Muted, Row, Screen, Toggle } from '../../ui/components';
import { fmtMeters, parseNumber } from '../../ui/format';
import { useServices } from '../../ui/hooks';

export default function EditCheckpoint() {
  const params = useLocalSearchParams<{ id: string; lat?: string; lon?: string; acc?: string; alt?: string }>();
  const isNew = params.id === 'new';
  const { services } = useServices();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [existing, setExisting] = useState<Checkpoint[]>([]);
  const [original, setOriginal] = useState<Checkpoint | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [name, setName] = useState('');
  const [lat, setLat] = useState(params.lat ?? '');
  const [lon, setLon] = useState(params.lon ?? '');
  const [radius, setRadius] = useState('');
  const [priority, setPriority] = useState('0');
  const [floor, setFloor] = useState('');
  const [altitude, setAltitude] = useState(params.alt ?? '');
  const [enabled, setEnabled] = useState(true);
  const [audio, setAudio] = useState<AudioChoice>({ uri: 'melody:chime', label: 'Chime (rising)' });
  const [coordsTouched, setCoordsTouched] = useState(isNew);
  const [allowNear, setAllowNear] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!services) return;
    void (async () => {
      const s = await services.settings.load();
      setSettings(s);
      const all = await services.checkpoints.list();
      setExisting(all);
      if (!isNew) {
        const cp = all.find((c) => c.id === params.id) ?? null;
        setOriginal(cp);
        if (cp) {
          setName(cp.name);
          setLat(String(cp.latitude));
          setLon(String(cp.longitude));
          setRadius(String(cp.triggerRadiusM));
          setPriority(String(cp.priority));
          setFloor(cp.floor != null ? String(cp.floor) : '');
          setAltitude(cp.altitudeM != null ? String(cp.altitudeM) : '');
          setEnabled(cp.enabled);
          setAudio({ uri: cp.audioUri, label: cp.audioLabel });
        }
      } else {
        setRadius(String(s.defaultRadiusM));
      }
      setLoaded(true);
    })();
  }, [services, isNew, params.id]);

  const draft = {
    id: isNew ? undefined : params.id,
    name,
    latitude: parseNumber(lat) ?? NaN,
    longitude: parseNumber(lon) ?? NaN,
    triggerRadiusM: parseNumber(radius) ?? NaN,
    priority: parseNumber(priority) ?? NaN,
  };

  const validation = useMemo(
    () =>
      settings
        ? validateCheckpointDraft(draft, existing, {
            duplicateDistanceM: settings.duplicateDistanceM,
            exitHysteresisM: settings.engine.exitHysteresisM,
            allowNearDuplicate: allowNear,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, existing, name, lat, lon, radius, priority, allowNear],
  );

  const floorValue = floor.trim() === '' ? null : parseNumber(floor);
  const floorInvalid = floor.trim() !== '' && (floorValue == null || !Number.isInteger(floorValue));

  const captureCurrent = async () => {
    setCapturing(true);
    setMessage(null);
    try {
      const perm = await Location.getForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        setMessage('Location permission is required.');
        return;
      }
      const loc = toSample(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation }));
      const threshold = settings?.saveAccuracyThresholdM ?? 15;
      if (settings?.requireAccuracyForSave && (loc.accuracyM == null || loc.accuracyM > threshold)) {
        setMessage(`Accuracy ±${fmtMeters(loc.accuracyM)} is worse than ${threshold} m. Try again in a few seconds.`);
        return;
      }
      setLat(loc.latitude.toFixed(7));
      setLon(loc.longitude.toFixed(7));
      if (loc.altitudeM != null) setAltitude(loc.altitudeM.toFixed(1));
      setCoordsTouched(true);
      setMessage(`Captured position (±${fmtMeters(loc.accuracyM)}).`);
    } catch (e) {
      setMessage(`Could not get a GPS fix: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCapturing(false);
    }
  };

  const save = async () => {
    if (!services || !settings || !validation?.ok || floorInvalid) return;
    setSaving(true);
    try {
      await services.checkpoints.save(
        {
          ...draft,
          audioUri: audio.uri,
          audioLabel: audio.label,
          enabled,
          floor: floorValue,
          altitudeM: altitude.trim() === '' ? null : parseNumber(altitude),
          coordinatesVerified: coordsTouched || (original?.coordinatesVerified ?? true),
        },
        {
          duplicateDistanceM: settings.duplicateDistanceM,
          exitHysteresisM: settings.engine.exitHysteresisM,
          allowNearDuplicate: allowNear,
        },
      );
      await services.controller.reloadCheckpoints();
      router.back();
    } catch (e) {
      setMessage(e instanceof ValidationError ? e.message : `Could not save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!original) return;
    Alert.alert('Delete checkpoint', `Delete "${original.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await services?.checkpoints.delete(original.id);
          await services?.controller.reloadCheckpoints();
          router.back();
        },
      },
    ]);
  };

  if (!services || !loaded) return <Loading />;
  if (!isNew && !original) {
    return (
      <Screen>
        <Banner tone="bad">This checkpoint no longer exists.</Banner>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: isNew ? 'New checkpoint' : `Edit ${original?.name}` }} />
      {original && !original.coordinatesVerified && !coordsTouched ? (
        <Banner tone="warn">
          These coordinates are a placeholder. Stand at the real spot and press “Use my current position”.
        </Banner>
      ) : null}
      {params.acc ? <Muted>Captured with GPS accuracy ±{fmtMeters(Number(params.acc))}.</Muted> : null}

      <Card title="Details">
        <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Swing" maxLength={60} autoFocus={isNew} />
        <Row>
          <Button label="Use my current position" variant="secondary" onPress={captureCurrent} busy={capturing} />
        </Row>
        <Field
          label="Latitude"
          value={lat}
          onChangeText={(t) => {
            setLat(t);
            setCoordsTouched(true);
          }}
          keyboardType="numeric"
        />
        <Field
          label="Longitude"
          value={lon}
          onChangeText={(t) => {
            setLon(t);
            setCoordsTouched(true);
          }}
          keyboardType="numeric"
        />
        <Field
          label="Trigger radius (m)"
          value={radius}
          onChangeText={setRadius}
          keyboardType="numeric"
          hint="Default 20 m. Phone GPS is typically accurate to 5–15 m outdoors."
        />
        <Field
          label="Priority"
          value={priority}
          onChangeText={setPriority}
          keyboardType="numbers-and-punctuation"
          hint="Higher plays first when two checkpoints qualify at the same time."
        />
        <Field
          label="Floor (optional)"
          value={floor}
          onChangeText={setFloor}
          keyboardType="numbers-and-punctuation"
          error={floorInvalid ? 'Floor must be a whole number.' : null}
          hint="For future indoor (BLE) positioning. GPS cannot tell floors apart, so GPS fixes ignore this."
        />
        <Field
          label="Altitude (m, optional)"
          value={altitude}
          onChangeText={setAltitude}
          keyboardType="numbers-and-punctuation"
          hint="Only used when altitude gating is enabled in Settings."
        />
        <Toggle label="Enabled" value={enabled} onValueChange={setEnabled} />
      </Card>

      <Card>
        <AudioPicker services={services} value={audio} onChange={setAudio} />
      </Card>

      {validation?.errors.map((e) => (
        <Banner key={e} tone="bad">
          {e}
        </Banner>
      ))}
      {validation?.nearDuplicateOf || allowNear ? (
        <Toggle
          label="Save anyway"
          hint="I really want two checkpoints this close together."
          value={allowNear}
          onValueChange={setAllowNear}
        />
      ) : null}
      {validation?.warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}
      {message ? <Banner tone="info">{message}</Banner> : null}

      <Button label="Save checkpoint" onPress={save} busy={saving} disabled={!validation?.ok || floorInvalid} />
      {!isNew ? <Button label="Delete checkpoint" variant="danger" onPress={remove} /> : null}
    </Screen>
  );
}
