import type { Bounds } from '../data/models';

/**
 * Prototype site, resolved from https://maps.app.goo.gl/gJhNw9t6da8X8kz3A on 2026-10-17.
 * The share link redirects to the Google place "Ramdas Pundalik Patil Udyan" whose
 * place pin is 19.2198269, 73.0734127. That is ONE point for the whole park: it says
 * nothing about where the swing or the ground are. The seeded checkpoints below are
 * placeholders offset from that pin and are flagged unverified until re-saved on site.
 */
export const SITE = {
  name: 'Ramdas Pundalik Patil Udyan',
  sourceUrl: 'https://maps.app.goo.gl/gJhNw9t6da8X8kz3A',
  center: { latitude: 19.2198269, longitude: 73.0734127 },
  /** ~650 m x ~650 m around the pin; generous so the whole park is covered. */
  bounds: { west: 73.0703, south: 19.2169, east: 73.0765, north: 19.2228 } satisfies Bounds,
  minZoom: 13,
  maxZoom: 18,
};

export interface SeedCheckpoint {
  name: string;
  /** Offset from the site pin; placeholder only. */
  bearingDeg: number;
  distanceM: number;
  melody: 'chime' | 'bells' | 'beacon';
  priority: number;
}

export const SEED_CHECKPOINTS: SeedCheckpoint[] = [
  { name: 'Swing', bearingDeg: 0, distanceM: 35, melody: 'chime', priority: 0 },
  { name: 'Ground', bearingDeg: 180, distanceM: 35, melody: 'bells', priority: 0 },
];
