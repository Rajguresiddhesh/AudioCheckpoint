import * as Location from 'expo-location';
import { PermissionsAndroid, Platform } from 'react-native';
import type { LocationSample } from '../engine/types';

export function toSample(loc: Location.LocationObject, source = 'gnss'): LocationSample {
  const c = loc.coords;
  return {
    latitude: c.latitude,
    longitude: c.longitude,
    accuracyM: c.accuracy ?? null,
    timestampMs: loc.timestamp,
    speedMps: c.speed != null && c.speed >= 0 ? c.speed : null,
    altitudeM: c.altitude ?? null,
    altitudeAccuracyM: c.altitudeAccuracy ?? null,
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

/** Foreground-only watcher used by Creator Mode (stops when the screen loses focus). */
export async function watchForeground(
  onSample: (s: LocationSample) => void,
  onError: (msg: string) => void,
): Promise<{ remove(): void }> {
  return Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
    (loc) => onSample(toSample(loc)),
    (reason) => onError(String(reason)),
  );
}
