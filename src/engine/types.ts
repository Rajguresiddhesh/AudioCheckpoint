/**
 * Core types for the checkpoint engine. This module (and everything under
 * src/engine) must stay free of React Native / Expo imports so it can be unit
 * tested in plain Node and reused by any position source (GNSS, BLE, replay).
 */

export interface LocationSample {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy radius in metres (68% confidence on Android). null = unknown. */
  accuracyM: number | null;
  /** Epoch milliseconds when the fix was produced. */
  timestampMs: number;
  speedMps?: number | null;
  altitudeM?: number | null;
  altitudeAccuracyM?: number | null;
  /** Floor identifier supplied by an indoor position source (e.g. BLE). GNSS leaves this null. */
  floor?: number | null;
  /** True when Android reports the fix came from a mock-location provider. */
  mocked?: boolean;
  /** Which source produced the sample: 'gnss', 'simulated', 'ble', ... */
  source?: string;
}

export interface EngineCheckpoint {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  /** Higher number wins when several checkpoints qualify at once. */
  priority: number;
  floor?: number | null;
  altitudeM?: number | null;
}

export type CheckpointState = 'OUTSIDE' | 'CANDIDATE' | 'TRIGGERED' | 'PLAYING' | 'COOLDOWN';

export type OverlapPolicy =
  /** Only one checkpoint may be TRIGGERED/PLAYING at a time; others wait as CANDIDATE. */
  | 'exclusive'
  /** Every qualifying checkpoint triggers; the audio manager's playback policy resolves conflicts. */
  | 'independent';

export interface EngineConfig {
  /** Samples older than this (relative to "now") are rejected as stale. */
  maxSampleAgeMs: number;
  /** Samples with worse (larger) accuracy can never advance a checkpoint towards triggering. */
  maxAccuracyM: number;
  /** Consecutive good inside-radius observations required before triggering. */
  entryConfirmSamples: number;
  /** Minimum time between first and confirming observation (0 = no dwell requirement). */
  entryDwellMs: number;
  /** Extra distance beyond the radius the user must be to count as having left (boundary hysteresis). */
  exitHysteresisM: number;
  /** Consecutive confidently-outside observations required to rearm a visited checkpoint. */
  rearmOutsideSamples: number;
  /** Minimum time the user must stay outside before rearming. */
  rearmMinOutsideMs: number;
  /** Minimum time after a trigger before the same checkpoint can rearm. */
  cooldownMs: number;
  /** A candidate with no supporting observation for this long falls back to OUTSIDE (GPS loss). */
  candidateTimeoutMs: number;
  /** TRIGGERED checkpoints the audio layer never acknowledges fall to COOLDOWN after this. */
  triggerAckTimeoutMs: number;
  /** Safety net: a PLAYING checkpoint with no "finished" callback falls to COOLDOWN after this. */
  maxPlaybackMs: number;
  /** Implied speed (after subtracting both accuracies) above which a fix is treated as an outlier jump. */
  maxPlausibleSpeedMps: number;
  /** After this many consecutive outliers, accept the new position (the jump was probably real). */
  outlierResetCount: number;
  /** Fixes timestamped further than this into the future are rejected as invalid. */
  maxFutureSkewMs: number;
  overlapPolicy: OverlapPolicy;
  allowMockLocations: boolean;
  /** When set, checkpoints with an altitude only count as "inside" within this vertical tolerance. null disables. */
  altitudeToleranceM: number | null;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  maxSampleAgeMs: 20_000,
  maxAccuracyM: 25,
  entryConfirmSamples: 2,
  entryDwellMs: 0,
  exitHysteresisM: 10,
  rearmOutsideSamples: 2,
  rearmMinOutsideMs: 0,
  cooldownMs: 30_000,
  candidateTimeoutMs: 30_000,
  triggerAckTimeoutMs: 15_000,
  maxPlaybackMs: 10 * 60_000,
  maxPlausibleSpeedMps: 15,
  outlierResetCount: 3,
  maxFutureSkewMs: 30_000,
  overlapPolicy: 'exclusive',
  allowMockLocations: true,
  altitudeToleranceM: null,
};

export type SampleQuality =
  | 'good'
  | 'low_accuracy'
  | 'stale'
  | 'out_of_order'
  | 'invalid'
  | 'outlier'
  | 'mocked';

export type EngineEvent =
  | {
      type: 'trigger';
      checkpointId: string;
      atMs: number;
      distanceM: number;
      accuracyM: number | null;
    }
  | { type: 'exit'; checkpointId: string; atMs: number }
  | { type: 'rearmed'; checkpointId: string; atMs: number };

export interface CheckpointRuntime {
  state: CheckpointState;
  stateSinceMs: number;
  candidateCount: number;
  candidateSinceMs: number | null;
  lastSupportMs: number | null;
  triggeredAtMs: number | null;
  outsideCount: number;
  outsideSinceMs: number | null;
  exitNotified: boolean;
  lastDistanceM: number | null;
  lastInside: boolean;
}

export interface CheckpointStatus {
  id: string;
  name: string;
  state: CheckpointState;
  distanceM: number | null;
  candidateCount: number;
  inside: boolean;
}

export interface EngineStatus {
  lastQuality: SampleQuality | null;
  lastSample: LocationSample | null;
  /** True when the latest sample was usable for positioning but too inaccurate to trigger. */
  lowConfidence: boolean;
  activeCheckpointId: string | null;
  checkpoints: CheckpointStatus[];
}

export interface ProcessResult {
  quality: SampleQuality;
  accepted: boolean;
  events: EngineEvent[];
}

export interface EngineSnapshot {
  version: 1;
  runtime: Record<string, CheckpointRuntime>;
  lastAccepted: LocationSample | null;
  consecutiveOutliers: number;
}
