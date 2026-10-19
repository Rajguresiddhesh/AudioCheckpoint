import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { AppState } from 'react-native';
import { demoRouteThrough, simulateRoute } from '../engine/simulator';
import { normaliseBatchTimestamps } from '../engine/timestamps';
import { normaliseBeaconId } from '../engine/beacons';
import { distanceM } from '../engine/geo';
import type { BeaconObservation, LocationSample } from '../engine/types';
import type { Checkpoint } from '../data/models';
import { getServices } from '../tracking/runtime';
import { startBeaconScanning, stopBeaconScanning } from './bleScanner';
import { getLocationReadiness, toSample } from './expoLocation';

export const LOCATION_TASK = 'audio-checkpoint-location';

/**
 * Must be evaluated at app start (imported from index.ts) so Android can deliver
 * fixes to it after the JS runtime was restarted in the background.
 */
export function registerLocationTask(): void {
  if (TaskManager.isTaskDefined(LOCATION_TASK)) return;
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
    const services = await getServices();
    // Headless restart: beacon scanning must come back together with GPS.
    void installBeaconSync();
    if (error) {
      services.controller.reportError(`Location error: ${error.message}`);
      return;
    }
    const received = Date.now();
    const samples = normaliseBatchTimestamps((data?.locations ?? []).map((l) => toSample(l)), received);
    const result = await services.controller.handleSamples(samples);
    if (result === 'inactive') {
      // Session was stopped (or data deleted) but the OS kept delivering: shut the service down.
      await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => undefined);
    }
  });
}

export class TrackingStartError extends Error {}

// --- BLE scanning follows the session ------------------------------------------

let beaconSyncInstalled = false;
let beaconSyncChain: Promise<void> = Promise.resolve();
let beaconSyncKey = '';

/**
 * Keep BLE scanning in step with tracking: on only while a GPS session is
 * active and some enabled checkpoint is an indoor (beacon) checkpoint. Reacts
 * to session start/stop and checkpoint edits. Idempotent.
 */
export async function installBeaconSync(): Promise<void> {
  if (beaconSyncInstalled) return;
  beaconSyncInstalled = true;
  const { controller } = await getServices();
  const sync = () => {
    beaconSyncChain = beaconSyncChain
      .then(async () => {
        const st = controller.getStatus();
        const ids = controller.beaconIds();
        const want = st.active && st.source === 'gnss' && controller.needsBeaconScans();
        const eddystoneOnly = ids.length > 0 && ids.every((id) => id.toLowerCase().startsWith('eddystone:'));
        // Act only on changes, so a failure report (which republishes status) cannot loop.
        const key = want ? `on:${eddystoneOnly}` : 'off';
        if (key === beaconSyncKey) return;
        beaconSyncKey = key;
        if (!want) {
          await stopBeaconScanning();
          return;
        }
        const problem = await startBeaconScanning((scan) => void controller.handleBeaconScan(scan), { eddystoneOnly });
        if (problem) controller.reportError(`Indoor checkpoints cannot trigger: ${problem}`);
      })
      .catch(() => undefined);
  };
  controller.subscribe(sync);
  sync();
}

/** Forget the last scanning decision so the next status change retries (e.g. after enabling Bluetooth). */
export function retryBeaconScanning(): void {
  beaconSyncKey = '';
  void getServices().then((s) => s.controller.reloadCheckpoints());
}

/**
 * Start GNSS tracking through a location foreground service. With the
 * persistent notification, Android allows location access with the screen off
 * using only "while in use" permission (no ACCESS_BACKGROUND_LOCATION).
 * Must be called while the app is in the foreground.
 */
export async function startGnssTracking(): Promise<void> {
  const r = await getLocationReadiness();
  if (r.permission !== 'granted') throw new TrackingStartError('Location permission has not been granted.');
  if (!r.servicesEnabled) throw new TrackingStartError('Location services (GPS) are turned off.');
  if (AppState.currentState !== 'active') throw new TrackingStartError('Open the app to start tracking.');

  const { controller } = await getServices();
  stopSimulation();
  await controller.startSession('gnss');
  try {
    await startLocationService();
  } catch (e) {
    await controller.stopSession();
    throw new TrackingStartError(`Could not start location updates: ${e instanceof Error ? e.message : String(e)}`);
  }
  startTicker();
}

/**
 * (Re)registers the location task and its foreground service. Registering an
 * already-registered task restarts its updates, which is needed after a crash
 * or kill: the task registration survives in storage, so
 * hasStartedLocationUpdatesAsync() reports true, but nothing is requesting fixes.
 */
async function startLocationService(): Promise<void> {
  const { settings } = await getServices();
  const s = await settings.load();
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: s.locationIntervalMs,
    // 0 so stationary users still produce fixes (needed for dwell/confirmation).
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Fitness,
    foregroundService: {
      notificationTitle: 'Audio checkpoints active',
      notificationBody: 'Using GPS to play audio when you reach a checkpoint. Tap to open; stop in the app.',
      notificationColor: '#2563eb',
      killServiceOnDestroy: false,
    },
  });
}

export async function stopTracking(): Promise<void> {
  stopSimulation();
  stopTicker();
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => undefined);
  }
  const { controller } = await getServices();
  await controller.stopSession();
}

export async function isGnssServiceRunning(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
}

/**
 * Called when the UI starts. If the DB says a GNSS session is open but the OS
 * service is gone (force-stop, reboot, OS kill), restart it now that the app is
 * in the foreground; a stale simulated session is simply closed.
 */
export async function reconcileTrackingOnLaunch(): Promise<string | null> {
  const { controller } = await getServices();
  const st = controller.getStatus();
  if (!st.active) return null;
  if (st.source === 'simulated') {
    await controller.stopSession();
    return 'Simulation ended when the app was closed.';
  }
  const wasRunning = await isGnssServiceRunning();
  try {
    // Always re-register: keeps the open session and its engine state, and
    // revives updates that a crash or kill silently stopped.
    const r = await getLocationReadiness();
    if (r.permission !== 'granted') throw new TrackingStartError('Location permission has not been granted.');
    if (AppState.currentState !== 'active') throw new TrackingStartError('Open the app to start tracking.');
    await startLocationService();
    startTicker();
    return wasRunning ? null : 'Tracking was interrupted by the system and has been restarted.';
  } catch (e) {
    await controller.stopSession();
    return `Tracking was interrupted and could not restart: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// --- GPS-loss ticker (foreground only; the engine also handles timeouts on each fix) ---

let ticker: ReturnType<typeof setInterval> | null = null;

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    void getServices().then((s) => s.controller.tick());
  }, 5000);
}

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

// --- Simulation ------------------------------------------------------------

let simTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Walk a synthetic route through all enabled checkpoints (approach, dwell, leave,
 * return to the first) feeding the real controller + real audio. Foreground only.
 */
export async function startSimulation(options: { speedMps?: number; accuracyM?: number } = {}): Promise<void> {
  const { controller, checkpoints } = await getServices();
  if (await isGnssServiceRunning()) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  stopSimulation();
  const list = (await checkpoints.list()).filter((c) => c.enabled);
  if (list.length === 0) throw new TrackingStartError('There are no enabled checkpoints to simulate.');
  const route = demoRouteThrough(list.map((c) => ({ latitude: c.latitude, longitude: c.longitude, radiusM: c.triggerRadiusM })));
  const fixes = simulateRoute(route, {
    startMs: 0,
    speedMps: options.speedMps ?? 2.5,
    accuracyM: options.accuracyM ?? 6,
    jitterM: 3,
    seed: Date.now() % 100000,
  });
  await controller.startSession('simulated');
  let i = 0;
  simTimer = setInterval(() => {
    if (i >= fixes.length) {
      stopSimulation();
      void controller.stopSession();
      return;
    }
    const now = Date.now();
    const f = { ...fixes[i++], timestampMs: now };
    void controller.handleSamples([withSimulatedAltitude(f, list)]);
    if (list.some(isBleCheckpoint)) {
      void controller.handleBeaconScan({ timestampMs: now, beacons: simulatedBeacons(f, list), source: 'simulated' });
    }
  }, 1000);
  startTicker();
}

const isBleCheckpoint = (c: Checkpoint) =>
  c.positioningPolicy === 'INDOOR_BLE' || c.positioningPolicy === 'INDOOR_BLE_FLOOR';

/**
 * Demo only: near an elevation checkpoint, report that checkpoint's altitude
 * (same datum, ±3 m) so the walk exercises the vertical check. Elsewhere the
 * fix has no altitude, exactly like a real fix without vertical data.
 */
function withSimulatedAltitude(f: LocationSample, list: Checkpoint[]): LocationSample {
  const near = list.find(
    (c) =>
      c.positioningPolicy === 'OUTDOOR_ELEVATION' &&
      c.altitudeM != null &&
      c.altitudeReference != null &&
      distanceM(c, f) <= c.triggerRadiusM * 2,
  );
  if (!near) return { ...f, altitudeM: null, altitudeAccuracyM: null, altitudeReference: null };
  return { ...f, altitudeM: near.altitudeM, altitudeAccuracyM: 3, altitudeReference: near.altitudeReference };
}

/** Demo only: a BLE checkpoint's beacon is heard while the simulated walker is inside its radius. */
function simulatedBeacons(f: LocationSample, list: Checkpoint[]): BeaconObservation[] {
  const out: BeaconObservation[] = [];
  for (const c of list) {
    if (!isBleCheckpoint(c) || !c.expectedBeaconId) continue;
    const id = normaliseBeaconId(c.expectedBeaconId);
    const d = distanceM(c, f);
    if (!id || d > c.triggerRadiusM) continue;
    out.push({ id, rssiDbm: Math.round((c.minimumBeaconRssiDbm ?? -75) + 10 - d / 2) });
  }
  return out;
}

export function stopSimulation(): void {
  if (simTimer) clearInterval(simTimer);
  simTimer = null;
}

export function isSimulating(): boolean {
  return simTimer != null;
}
