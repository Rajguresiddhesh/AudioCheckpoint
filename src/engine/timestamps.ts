import type { LocationSample } from './types';

/**
 * GNSS fix times are satellite time; the phone's wall clock can be wrong by
 * minutes if the user set it manually. If the newest fix in a batch disagrees
 * with the receive time by more than `maxSkewMs`, shift the whole batch so the
 * newest fix is "now". Relative spacing (needed for dwell and speed checks) is
 * preserved, and genuinely deferred fixes within a batch stay older.
 */
export function normaliseBatchTimestamps(
  samples: LocationSample[],
  receivedAtMs: number,
  maxSkewMs = 60_000,
): LocationSample[] {
  if (samples.length === 0) return samples;
  const newest = Math.max(...samples.map((s) => s.timestampMs));
  const skew = receivedAtMs - newest;
  if (!Number.isFinite(skew) || Math.abs(skew) <= maxSkewMs) return samples;
  return samples.map((s) => ({ ...s, timestampMs: s.timestampMs + skew }));
}
