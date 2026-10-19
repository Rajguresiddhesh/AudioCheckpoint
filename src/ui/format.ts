import type { AltitudeReference, CheckpointState, PositioningPolicy, SampleQuality } from '../engine/types';
import type { Tone } from './components';

export function fmtMeters(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return '–';
  return m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`;
}

export function fmtAge(ms: number): string {
  if (ms < 2000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s ago`;
  return `${Math.round(ms / 60_000)} min ago`;
}

export function fmtTime(t: number): string {
  return new Date(t).toLocaleString();
}

export function accuracyTone(acc: number | null | undefined, threshold: number): Tone {
  if (acc == null) return 'bad';
  if (acc <= threshold) return 'good';
  if (acc <= threshold * 2) return 'warn';
  return 'bad';
}

export const QUALITY_TEXT: Record<SampleQuality, string> = {
  good: 'Good fix',
  low_accuracy: 'Low accuracy – waiting',
  stale: 'Stale fix ignored',
  out_of_order: 'Out-of-order fix ignored',
  invalid: 'Invalid fix ignored',
  outlier: 'Position jump ignored',
  mocked: 'Mock location ignored',
};

export const STATE_TEXT: Record<CheckpointState, string> = {
  OUTSIDE: 'Armed',
  CANDIDATE: 'Confirming…',
  TRIGGERED: 'Triggered',
  PLAYING: 'Playing',
  COOLDOWN: 'Visited (leave to rearm)',
};

export const POLICY_LABEL: Record<PositioningPolicy, string> = {
  OUTDOOR_GPS: 'GPS',
  OUTDOOR_ELEVATION: 'GPS + altitude',
  INDOOR_BLE: 'Indoor beacon',
  INDOOR_BLE_FLOOR: 'Indoor beacon + floor',
};

export const POLICY_HELP: Record<PositioningPolicy, string> = {
  OUTDOOR_GPS: 'Outdoors, flat ground. Triggers on GPS position only.',
  OUTDOOR_ELEVATION:
    'Hills, forts, viewpoints. Triggers only when GPS position AND altitude match; no altitude data = no trigger.',
  INDOOR_BLE: 'Indoors. Triggers only when this Bluetooth beacon is heard strongly enough. GPS is ignored.',
  INDOOR_BLE_FLOOR:
    'Multi-floor buildings. Beacon must be strong AND beacons must place you on this floor. Same spot on another floor never triggers.',
};

export const ALTITUDE_REFERENCE_LABEL: Record<AltitudeReference, string> = {
  ELLIPSOID: 'GPS ellipsoid (WGS84)',
  MSL: 'Mean sea level',
  BAROMETRIC_RELATIVE: 'Barometer (relative)',
};

/** Parse a decimal number from a text field; null when blank or invalid. */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
