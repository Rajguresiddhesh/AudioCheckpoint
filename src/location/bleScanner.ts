import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, ScanMode, State, type Device } from 'react-native-ble-plx';
import { beaconIdsFromAdvertisement } from '../engine/beacons';
import type { BeaconScan } from '../engine/types';

/**
 * Indoor positioning source: BLE beacon scanning. Advertisements are
 * aggregated into fixed windows (strongest RSSI per beacon id) so that a
 * window in which a beacon was NOT heard is evidence too (the user left).
 * Interpretation (thresholds, floors) happens in the pure engine.
 */

export const SCAN_WINDOW_MS = 2000;

export type BleStatus =
  | { kind: 'stopped' }
  | { kind: 'scanning'; windows: number; lastHeard: number }
  | { kind: 'unavailable'; message: string };

let manager: BleManager | null = null;
let windowTimer: ReturnType<typeof setInterval> | null = null;
let current = new Map<string, number>();
let status: BleStatus = { kind: 'stopped' };
const listeners = new Set<(s: BleStatus) => void>();

function getManager(): BleManager {
  manager ??= new BleManager();
  return manager;
}

function setStatus(s: BleStatus) {
  status = s;
  for (const l of listeners) l(s);
}

export function getBleStatus(): BleStatus {
  return status;
}

export function subscribeBleStatus(fn: (s: BleStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Android 12+ needs BLUETOOTH_SCAN at runtime; older versions use the location permission. */
export async function requestBlePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Number(Platform.Version) < 31) return true;
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

async function checkBlePermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return true;
  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
}

function record(device: Device) {
  if (device.rssi == null) return;
  const ids = beaconIdsFromAdvertisement({
    address: device.id,
    manufacturerData: device.manufacturerData,
    serviceData: device.serviceData,
  });
  for (const id of ids) current.set(id, Math.max(current.get(id) ?? -Infinity, device.rssi));
}

async function startRawScan(eddystoneOnly: boolean): Promise<string | null> {
  const ble = getManager();
  if (!(await checkBlePermission())) return 'Bluetooth permission ("Nearby devices") not granted.';
  const state = await ble.state();
  if (state === State.PoweredOff) return 'Bluetooth is off.';
  if (state === State.Unauthorized) return 'Bluetooth permission not granted.';
  if (state === State.Unsupported) return 'This phone does not support Bluetooth LE.';
  // Android stops delivering unfiltered scan results while the screen is off; a
  // service-UUID filter keeps Eddystone beacons working in the pocket.
  await ble.startDeviceScan(
    eddystoneOnly ? ['0000feaa-0000-1000-8000-00805f9b34fb'] : null,
    { allowDuplicates: true, scanMode: ScanMode.LowLatency },
    (error, device) => {
      if (error) {
        setStatus({ kind: 'unavailable', message: `Bluetooth scan failed: ${error.message}` });
        return;
      }
      if (device) record(device);
    },
  );
  return null;
}

/**
 * Start continuous scanning; `onScan` receives one BeaconScan per window.
 * Returns an error message when scanning cannot start (permission, Bluetooth off).
 */
export async function startBeaconScanning(
  onScan: (scan: BeaconScan) => void,
  options: { eddystoneOnly: boolean },
): Promise<string | null> {
  await stopBeaconScanning();
  const problem = await startRawScan(options.eddystoneOnly);
  if (problem) {
    setStatus({ kind: 'unavailable', message: problem });
    return problem;
  }
  current = new Map();
  let windows = 0;
  let lastHeard = 0;
  setStatus({ kind: 'scanning', windows, lastHeard });
  windowTimer = setInterval(() => {
    const beacons = [...current.entries()].map(([id, rssiDbm]) => ({ id, rssiDbm }));
    current = new Map();
    windows++;
    if (beacons.length) lastHeard = Date.now();
    if (status.kind !== 'unavailable') setStatus({ kind: 'scanning', windows, lastHeard });
    onScan({ timestampMs: Date.now(), beacons, source: 'ble' });
  }, SCAN_WINDOW_MS);
  return null;
}

export async function stopBeaconScanning(): Promise<void> {
  if (windowTimer) clearInterval(windowTimer);
  windowTimer = null;
  if (manager) await manager.stopDeviceScan().catch(() => undefined);
  setStatus({ kind: 'stopped' });
}

export function isBeaconScanning(): boolean {
  return windowTimer != null;
}

/** One-off scan for the checkpoint editor: every beacon id heard, strongest RSSI first. */
export async function scanNearbyBeacons(durationMs = 6000): Promise<{ id: string; rssiDbm: number }[]> {
  if (!(await requestBlePermission())) throw new Error('Bluetooth permission ("Nearby devices") is required.');
  if (isBeaconScanning()) {
    // Tracking already owns the radio; sample its windows instead of restarting the scan.
    const seen = new Map<string, number>();
    const started = Date.now();
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        for (const [id, r] of current) seen.set(id, Math.max(seen.get(id) ?? -Infinity, r));
        if (Date.now() - started >= durationMs) {
          clearInterval(t);
          resolve();
        }
      }, 250);
    });
    return [...seen.entries()].map(([id, rssiDbm]) => ({ id, rssiDbm })).sort((a, b) => b.rssiDbm - a.rssiDbm);
  }
  current = new Map();
  const problem = await startRawScan(false);
  if (problem) throw new Error(problem);
  await new Promise((r) => setTimeout(r, durationMs));
  await getManager().stopDeviceScan().catch(() => undefined);
  const result = [...current.entries()].map(([id, rssiDbm]) => ({ id, rssiDbm }));
  current = new Map();
  return result.sort((a, b) => b.rssiDbm - a.rssiDbm);
}
