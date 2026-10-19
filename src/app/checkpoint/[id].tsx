import * as Location from 'expo-location';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import type { AppSettings } from '../../config/settings';
import type { Checkpoint } from '../../data/models';
import { ValidationError } from '../../data/repositories';
import { BEACON_ID_HELP } from '../../engine/beacons';
import { POSITIONING_POLICIES, type AltitudeReference, type PositioningPolicy } from '../../engine/types';
import {
  DEFAULT_BEACON_OBSERVATIONS,
  DEFAULT_MAX_VERTICAL_DIFFERENCE_M,
  DEFAULT_MAX_VERTICAL_UNCERTAINTY_M,
  DEFAULT_MIN_BEACON_RSSI_DBM,
  validateCheckpointDraft,
} from '../../engine/validation';
import { scanNearbyBeacons } from '../../location/bleScanner';
import { DEVICE_ALTITUDE_REFERENCE, getCurrentFix, promptEnableLocationServices } from '../../location/expoLocation';
import { AudioPicker, type AudioChoice } from '../../ui/AudioPicker';
import { Banner, Button, Card, Chip, Field, Loading, Muted, Row, Screen, Toggle } from '../../ui/components';
import { ALTITUDE_REFERENCE_LABEL, fmtMeters, parseNumber, POLICY_HELP, POLICY_LABEL } from '../../ui/format';
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
  const [policy, setPolicy] = useState<PositioningPolicy>('OUTDOOR_GPS');
  const [maxHAcc, setMaxHAcc] = useState('');
  const [altRef, setAltRef] = useState<AltitudeReference | null>(params.alt ? DEVICE_ALTITUDE_REFERENCE : null);
  const [maxVDiff, setMaxVDiff] = useState(String(DEFAULT_MAX_VERTICAL_DIFFERENCE_M));
  const [maxVUnc, setMaxVUnc] = useState(String(DEFAULT_MAX_VERTICAL_UNCERTAINTY_M));
  const [beaconId, setBeaconId] = useState('');
  const [minRssi, setMinRssi] = useState(String(DEFAULT_MIN_BEACON_RSSI_DBM));
  const [reqObs, setReqObs] = useState(String(DEFAULT_BEACON_OBSERVATIONS));
  const [nearby, setNearby] = useState<{ id: string; rssiDbm: number }[] | null>(null);
  const [scanning, setScanning] = useState(false);
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
          setPolicy(cp.positioningPolicy);
          setMaxHAcc(cp.maxHorizontalAccuracyM != null ? String(cp.maxHorizontalAccuracyM) : '');
          setAltRef(cp.altitudeReference);
          if (cp.maxVerticalDifferenceM != null) setMaxVDiff(String(cp.maxVerticalDifferenceM));
          if (cp.maxVerticalUncertaintyM != null) setMaxVUnc(String(cp.maxVerticalUncertaintyM));
          setBeaconId(cp.expectedBeaconId ?? '');
          if (cp.minimumBeaconRssiDbm != null) setMinRssi(String(cp.minimumBeaconRssiDbm));
          if (cp.requiredBeaconObservations != null) setReqObs(String(cp.requiredBeaconObservations));
        }
      } else {
        setRadius(String(s.defaultRadiusM));
      }
      setLoaded(true);
    })();
  }, [services, isNew, params.id]);

  const ble = policy === 'INDOOR_BLE' || policy === 'INDOOR_BLE_FLOOR';
  const opt = (t: string) => (t.trim() === '' ? null : (parseNumber(t) ?? NaN));
  const floorValue = floor.trim() === '' ? null : parseNumber(floor);
  const floorInvalid = floor.trim() !== '' && (floorValue == null || !Number.isInteger(floorValue));
  const draft = {
    id: isNew ? undefined : params.id,
    name,
    positioningPolicy: policy,
    latitude: parseNumber(lat) ?? NaN,
    longitude: parseNumber(lon) ?? NaN,
    triggerRadiusM: parseNumber(radius) ?? NaN,
    priority: parseNumber(priority) ?? NaN,
    maxHorizontalAccuracyM: opt(maxHAcc),
    floor: floorValue,
    altitudeM: opt(altitude),
    altitudeReference: altRef,
    maxVerticalDifferenceM: opt(maxVDiff),
    maxVerticalUncertaintyM: opt(maxVUnc),
    expectedBeaconId: beaconId.trim() || null,
    minimumBeaconRssiDbm: opt(minRssi),
    requiredBeaconObservations: opt(reqObs),
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
    [settings, existing, name, lat, lon, radius, priority, allowNear, policy, maxHAcc, floor, altitude, altRef, maxVDiff,
      maxVUnc, beaconId, minRssi, reqObs],
  );

  const scanBeacons = async () => {
    setScanning(true);
    setMessage(null);
    try {
      setNearby(await scanNearbyBeacons());
    } catch (e) {
      setMessage(`Beacon scan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  const captureCurrent = async () => {
    setCapturing(true);
    setMessage(null);
    try {
      let perm = await Location.getForegroundPermissionsAsync();
      if (perm.status !== 'granted') perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        setMessage('Location permission is required.');
        return;
      }
      if (!(await Location.hasServicesEnabledAsync()) && !(await promptEnableLocationServices())) {
        setMessage('Turn on location services (GPS) to capture your position.');
        return;
      }
      const loc = await getCurrentFix();
      const threshold = settings?.saveAccuracyThresholdM ?? 15;
      const poor = loc.accuracyM == null || loc.accuracyM > threshold;
      setLat(loc.latitude.toFixed(7));
      setLon(loc.longitude.toFixed(7));
      if (loc.altitudeM != null && loc.altitudeReference != null) {
        setAltitude(loc.altitudeM.toFixed(1));
        setAltRef(loc.altitudeReference);
      }
      setCoordsTouched(true);
      setMessage(
        poor
          ? `Captured position, but accuracy ±${fmtMeters(loc.accuracyM)} is worse than ${threshold} m. Press again in open sky for a better fix.`
          : `Captured position (±${fmtMeters(loc.accuracyM)}).`,
      );
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
        <Toggle label="Enabled" value={enabled} onValueChange={setEnabled} />
      </Card>

      <Card title="How is this checkpoint detected?">
        <Row>
          {POSITIONING_POLICIES.map((p) => (
            <Chip key={p} label={POLICY_LABEL[p]} selected={policy === p} onPress={() => setPolicy(p)} />
          ))}
        </Row>
        <Muted>{POLICY_HELP[policy]}</Muted>

        {!ble ? (
          <Field
            label="Required GPS accuracy (m, optional)"
            value={maxHAcc}
            onChangeText={setMaxHAcc}
            keyboardType="numeric"
            hint={`Blank = Settings value (${settings?.engine.maxAccuracyM ?? 25} m).`}
          />
        ) : null}

        {policy === 'OUTDOOR_ELEVATION' ? (
          <>
            <Field
              label="Altitude (m)"
              value={altitude}
              onChangeText={setAltitude}
              keyboardType="numbers-and-punctuation"
              hint="“Use my current position” fills this from GPS together with its reference."
            />
            <Muted>Altitude measured from</Muted>
            <Row>
              {(['ELLIPSOID', 'MSL'] as AltitudeReference[]).map((r) => (
                <Chip key={r} label={ALTITUDE_REFERENCE_LABEL[r]} selected={altRef === r} onPress={() => setAltRef(r)} />
              ))}
            </Row>
            {altRef && altRef !== DEVICE_ALTITUDE_REFERENCE ? (
              <Banner tone="warn">
                This phone reports altitude from the {ALTITUDE_REFERENCE_LABEL[DEVICE_ALTITUDE_REFERENCE].toLowerCase()}.
                The two differ by tens of metres and are never mixed, so this checkpoint cannot trigger on this phone.
                Capture the altitude on site with “Use my current position” instead.
              </Banner>
            ) : null}
            <Field label="Allowed altitude difference (m)" value={maxVDiff} onChangeText={setMaxVDiff} keyboardType="numeric" />
            <Field
              label="Required vertical accuracy (m)"
              value={maxVUnc}
              onChangeText={setMaxVUnc}
              keyboardType="numeric"
              hint="Fixes with worse or unknown vertical accuracy never trigger this checkpoint."
            />
          </>
        ) : null}

        {ble ? (
          <>
            <Field
              label="Beacon id"
              value={beaconId}
              onChangeText={setBeaconId}
              autoCapitalize="none"
              placeholder="ibeacon:<uuid>:<major>:<minor>"
              hint={BEACON_ID_HELP}
            />
            <Button label="Scan for nearby beacons" variant="secondary" onPress={scanBeacons} busy={scanning} />
            {nearby && nearby.length === 0 ? <Muted>No beacons heard. Is Bluetooth on and the beacon powered?</Muted> : null}
            {nearby?.slice(0, 8).map((b) => (
              <Chip
                key={b.id}
                label={`${b.rssiDbm} dBm · ${b.id}`}
                selected={beaconId.trim().toLowerCase() === b.id}
                onPress={() => {
                  setBeaconId(b.id);
                  // Standing at the spot: accept a little weaker than what is heard here now.
                  setMinRssi(String(Math.max(-100, Math.round(b.rssiDbm - 8))));
                }}
              />
            ))}
            <Field
              label="Minimum signal (dBm)"
              value={minRssi}
              onChangeText={setMinRssi}
              keyboardType="numbers-and-punctuation"
              hint="Closer to 0 = you must stand closer. Picking a scanned beacon sets this to 8 dB below its signal here."
            />
            <Field
              label="Required observations"
              value={reqObs}
              onChangeText={setReqObs}
              keyboardType="numeric"
              hint="Consecutive 2-second scan windows with a strong signal before the audio plays."
            />
          </>
        ) : null}

        {ble || floor.trim() !== '' ? (
          <Field
            label={policy === 'INDOOR_BLE_FLOOR' ? 'Floor' : 'Floor (optional)'}
            value={floor}
            onChangeText={setFloor}
            keyboardType="numbers-and-punctuation"
            error={floorInvalid ? 'Floor must be a whole number.' : null}
            hint="Whole number, e.g. 0 = ground floor. Each beacon belongs to one floor."
          />
        ) : null}
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
