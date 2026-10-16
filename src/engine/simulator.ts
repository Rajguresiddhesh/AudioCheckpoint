import { destinationPoint, distanceM, interpolate, type LatLon } from './geo';
import type { LocationSample } from './types';

export interface RouteWaypoint extends LatLon {
  /** Time to stand still at this waypoint before moving on. */
  dwellMs?: number;
}

export interface SimulationOptions {
  startMs: number;
  speedMps?: number;
  intervalMs?: number;
  accuracyM?: number;
  /** Max random horizontal error added to each fix (deterministic per seed). */
  jitterM?: number;
  seed?: number;
}

/** Small deterministic PRNG so simulated routes are reproducible in tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate fixes at a fixed interval while walking the waypoints in order. */
export function simulateRoute(waypoints: RouteWaypoint[], options: SimulationOptions): LocationSample[] {
  const speed = options.speedMps ?? 1.4;
  const interval = options.intervalMs ?? 1000;
  const accuracy = options.accuracyM ?? 5;
  const jitter = options.jitterM ?? 0;
  const rand = mulberry32(options.seed ?? 1);
  const samples: LocationSample[] = [];
  let t = options.startMs;

  const emit = (p: LatLon) => {
    let pos = p;
    if (jitter > 0) pos = destinationPoint(p, rand() * 360, rand() * jitter);
    samples.push({
      latitude: pos.latitude,
      longitude: pos.longitude,
      accuracyM: accuracy,
      timestampMs: t,
      speedMps: speed,
      source: 'simulated',
    });
    t += interval;
  };

  if (waypoints.length === 0) return samples;
  emit(waypoints[0]);
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    for (let waited = 0; waited < (wp.dwellMs ?? 0); waited += interval) emit(wp);
    const next = waypoints[i + 1];
    if (!next) break;
    const legM = distanceM(wp, next);
    const steps = Math.max(1, Math.ceil(legM / (speed * (interval / 1000))));
    for (let s = 1; s <= steps; s++) emit(interpolate(wp, next, s / steps));
  }
  return samples;
}

/**
 * Demo route that approaches each checkpoint from outside, lingers inside it,
 * walks well clear, then returns to the first one to demonstrate rearming.
 */
export function demoRouteThrough(
  checkpoints: (LatLon & { radiusM: number })[],
  dwellMs = 12_000,
): RouteWaypoint[] {
  if (checkpoints.length === 0) return [];
  const first = checkpoints[0];
  const start = destinationPoint(first, 225, first.radiusM + 50);
  const route: RouteWaypoint[] = [start];
  for (const cp of checkpoints) route.push({ ...cp, dwellMs });
  const last = checkpoints[checkpoints.length - 1];
  route.push(destinationPoint(last, 45, last.radiusM + 50));
  route.push({ ...first, dwellMs });
  route.push(start);
  return route;
}
