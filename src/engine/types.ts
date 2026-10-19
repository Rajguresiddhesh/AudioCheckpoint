/**
 * Core types for the checkpoint engine. This module (and everything under
 * src/engine) must stay free of React Native / Expo imports so it can be unit
 * tested in plain Node and reused by any position source (GNSS, BLE, replay).
 */

/**
 * How a checkpoint decides that the user is "there". Every policy except
 * OUTDOOR_GPS needs evidence that latitude/longitude alone cannot give; when
 * that evidence is missing the result is inconclusive and nothing triggers.
 */
export const POSITIONING_POLICIES = ['OUTDOOR_GPS', 'OUTDOOR_ELEVATION', 'INDOOR_BLE', 'INDOOR_BLE_FLOOR'] as const;
export type PositioningPolicy = (typeof POSITIONING_POLICIES)[number];

/**
 * Vertical datum of an altitude. Values with different references are never
 * compared (ellipsoid vs MSL differ by the local geoid height, tens of metres).
 *  - ELLIPSOID: height above the WGS84 ellipsoid (what Android GNSS reports)
 *  - MSL: height above mean sea level / geoid (what maps and iOS report)
 *  - BAROMETRIC_RELATIVE: pressure-derived height relative to a calibration point
 */
export const ALTITUDE_REFERENCES = ['ELLIPSOID', 'MSL', 'BAROMETRIC_RELATIVE'] as const;
export type AltitudeReference = (typeof ALTITUDE_REFERENCES)[number];

export interface LocationSample {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy radius in metres (68% confidence on Android). null = unknown. */
  accuracyM: number | null;
  /** Epoch milliseconds when the fix was produced. */
  timestampMs: number;
  speedMps?: number | null;
  altitudeM?: number | null;
  /** Vertical accuracy in metres. null = unknown, which makes the altitude unusable for gating. */
  altitudeAccuracyM?: number | null;
  /** Datum of altitudeM. null/undefined = unknown, which makes the altitude unusable for gating. */
  altitudeReference?: AltitudeReference | null;
  /** Floor identifier supplied by an indoor position source (e.g. BLE). GNSS leaves this null. */
  floor?: number | null;
  /** True when Android reports the fix came from a mock-location provider. */
  mocked?: boolean;
  /** Which source produced the sample: 'gnss', 'simulated', 'ble', ... */
  source?: string;
}

/** Strongest RSSI heard from one beacon during a scan window. */
export interface BeaconObservation {
  /** Normalised id, see src/engine/beacons.ts (e.g. "ibeacon:<uuid>:<major>:<minor>"). */
  id: string;
  rssiDbm: number;
}

/** One BLE scan window. An empty `beacons` list is evidence that no beacon was heard. */
export interface BeaconScan {
  /** End of the scan window (epoch ms). */
  timestampMs: number;
  beacons: BeaconObservation[];
  source?: string;
}

export interface EngineCheckpoint {
  id: string;
  name: string;
  policy: PositioningPolicy;
  latitude: number;
  longitude: number;
  radiusM: number;
  /** Higher number wins when several checkpoints qualify at once. */
  priority: number;
  /** Per-checkpoint horizontal accuracy limit; falls back to EngineConfig.maxAccuracyM. */
  maxHorizontalAccuracyM?: number | null;
  floor?: number | null;
  altitudeM?: number | null;
  altitudeReference?: AltitudeReference | null;
  /** OUTDOOR_ELEVATION: allowed |altitude difference|. */
  maxVerticalDifferenceM?: number | null;
  /** OUTDOOR_ELEVATION: fixes with worse (or unknown) vertical accuracy are inconclusive. */
  maxVerticalUncertaintyM?: number | null;
  expectedBeaconId?: string | null;
  minimumBeaconRssiDbm?: number | null;
  /** Consecutive qualifying scan windows needed to trigger a BLE checkpoint. */
  requiredBeaconObservations?: number | null;
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
  /** OUTDOOR_ELEVATION: extra vertical distance beyond maxVerticalDifferenceM needed to count as having left. */
  verticalExitHysteresisM: number;
  /** BLE: RSSI this far below the checkpoint minimum (or the beacon not heard) counts as having left. */
  beaconExitHysteresisDb: number;
  /** BLE: default minimum RSSI when a checkpoint does not set one. */
  defaultMinimumBeaconRssiDbm: number;
  /** INDOOR_BLE_FLOOR: the strongest known beacon must beat beacons on other floors by this margin. */
  floorRssiMarginDb: number;
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
  verticalExitHysteresisM: 5,
  beaconExitHysteresisDb: 6,
  defaultMinimumBeaconRssiDbm: -75,
  floorRssiMarginDb: 3,
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
      /** Horizontal distance from the centre; null when the trigger came from beacons only. */
      distanceM: number | null;
      accuracyM: number | null;
      /** Human-readable summary of the evidence that caused the trigger. */
      evidence: string;
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
  /** Why the latest observation could not decide inside/outside (null when it could). */
  lastInconclusive?: string | null;
  /** Evidence text of the latest inside observation (reported with the trigger). */
  lastEvidence?: string | null;
}

export interface CheckpointStatus {
  id: string;
  name: string;
  policy: PositioningPolicy;
  state: CheckpointState;
  distanceM: number | null;
  candidateCount: number;
  inside: boolean;
  /** Why this checkpoint cannot currently trigger, e.g. "waiting for beacon". null when evidence is conclusive. */
  waitingFor: string | null;
}

export interface EngineStatus {
  lastQuality: SampleQuality | null;
  lastSample: LocationSample | null;
  lastBeaconScan: BeaconScan | null;
  /** Floor estimated from the latest beacon scan (null = unknown). */
  floorEstimate: number | null;
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
  lastBeaconScan?: BeaconScan | null;
}
