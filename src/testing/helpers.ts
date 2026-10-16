import { destinationPoint, type LatLon } from '../engine/geo';
import type { EngineCheckpoint, LocationSample } from '../engine/types';

export const ORIGIN: LatLon = { latitude: 19.2198269, longitude: 73.0734127 };

export function checkpointAt(
  id: string,
  bearing: number,
  distance: number,
  extra: Partial<EngineCheckpoint> = {},
): EngineCheckpoint {
  const p = destinationPoint(ORIGIN, bearing, distance);
  return { id, name: id, latitude: p.latitude, longitude: p.longitude, radiusM: 20, priority: 0, ...extra };
}

export interface FixOptions {
  accuracyM?: number | null;
  bearingDeg?: number;
  extra?: Partial<LocationSample>;
}

/** A fix `distance` metres from `target` on `bearingDeg` (default due east). */
export function fixNear(
  target: LatLon,
  distance: number,
  timestampMs: number,
  { accuracyM = 5, bearingDeg = 90, extra = {} }: FixOptions = {},
): LocationSample {
  const p = distance === 0 ? target : destinationPoint(target, bearingDeg, distance);
  return { latitude: p.latitude, longitude: p.longitude, accuracyM, timestampMs, ...extra };
}
