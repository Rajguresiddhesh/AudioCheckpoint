import * as Location from 'expo-location';
import { PermissionsAndroid, Platform } from 'react-native';
import type { AltitudeReference, LocationSample } from '../engine/types';

/**
 * Datum of the altitude the platform reports: Android's Location.getAltitude()
 * is height above the WGS84 ellipsoid; iOS reports height above mean sea level.
 */
export const DEVICE_ALTITUDE_REFERENCE: AltitudeReference = Platform.OS === 'ios' ? 'MSL' : 'ELLIPSOID';

export function toSample(loc: Location.LocationObject, source = 'gnss'): LocationSample {
  const c = loc.coords;
  // Android reports altitude 0 and vertical accuracy 0 when the fix has no altitude
  // (hasAltitude()/hasVerticalAccuracy() false), which would look like a perfect fix.
  const hasAltitude = c.altitude != null && c.altitudeAccuracy != null && c.altitudeAccuracy > 0;
  return {
    latitude: c.latitude,
    longitude: c.longitude,
    accuracyM: c.accuracy ?? null,
    timestampMs: loc.timestamp,
    speedMps: c.speed != null && c.speed >= 0 ? c.speed : null,
    altitudeM: hasAltitude ? c.altitude : null,
    altitudeAccuracyM: hasAltitude ? c.altitudeAccuracy : null,
    altitudeReference: hasAltitude ? DEVICE_ALTITUDE_REFERENCE : null,
    mocked: loc.mocked ?? false,
    source,
  };
}

export interface LocationReadiness {
  permission: 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
  /** Precise (fine) location granted, not just approximate. */
  precise: boolean;
  servicesEnabled: boolean;
  gpsAvailable: boolean | null;
  notificationsGranted: boolean | null;
}

export async function getLocationReadiness(): Promise<LocationReadiness> {
  const [perm, enabled, provider] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.hasServicesEnabledAsync().catch(() => false),
    Location.getProviderStatusAsync().catch(() => null),
  ]);
  let notificationsGranted: boolean | null = null;
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    notificationsGranted = await PermissionsAndroid.check('android.permission.POST_NOTIFICATIONS');
  }
  return {
    permission: perm.status,
    canAskAgain: perm.canAskAgain,
    precise: perm.android?.accuracy === 'fine' || perm.android == null,
    servicesEnabled: enabled,
    gpsAvailable: provider?.gpsAvailable ?? null,
    notificationsGranted,
  };
}

export async function requestLocationPermission(): Promise<LocationReadiness> {
  await Location.requestForegroundPermissionsAsync();
  return getLocationReadiness();
}

/** Android 13+: needed for the tracking notification to be visible in the shade. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
  const r = await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS');
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

/** Shows the system dialog asking the user to turn on location services. */
export async function promptEnableLocationServices(): Promise<boolean> {
  try {
    await Location.enableNetworkProviderAsync();
    return true;
  } catch {
    return false;
  }
}

/**
 * Foreground-only watcher used by Creator Mode (stops when the screen loses focus).
 * Emits the last known fix and a quick network-assisted fix first, so a position
 * shows up within seconds even indoors, then keeps refining with high-accuracy GPS.
 * `receivedAtMs` is the phone time the fix arrived; use it for freshness, since
 * the fix's own timestamp is GNSS time and can disagree with a skewed phone clock.
 */
export async function watchForeground(
  onSample: (s: LocationSample, receivedAtMs: number) => void,
  onError: (msg: string) => void,
): Promise<{ remove(): void }> {
  let removed = false;
  let gotLive = false;
  const emit = (loc: Location.LocationObject | null, live: boolean) => {
    if (removed || !loc) return;
    if (!live && gotLive) return;
    if (live) gotLive = true;
    onSample(toSample(loc), live ? Date.now() : loc.timestamp);
  };

  Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 })
    .then((loc) => emit(loc, false))
    .catch(() => undefined);
  Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
    .then((loc) => emit(loc, true))
    .catch(() => undefined);

  const sub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
    (loc) => emit(loc, true),
    (reason) => onError(String(reason)),
  );
  return {
    remove() {
      removed = true;
      sub.remove();
    },
  };
}

/** One-shot fix for "use my current position": high accuracy with a timeout, then a coarser fallback. */
export async function getCurrentFix(timeoutMs = 15_000): Promise<LocationSample> {
  const withTimeout = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs))]);
  try {
    return toSample(await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })));
  } catch {
    const loc =
      (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null)) ??
      (await Location.getLastKnownPositionAsync().catch(() => null));
    if (!loc) throw new Error('No GPS fix. Move into open sky and make sure location is on.');
    return toSample(loc);
  }
}
