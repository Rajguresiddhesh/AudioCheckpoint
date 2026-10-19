import { normaliseBeaconId } from './beacons';
import { distanceM } from './geo';
import type { BeaconScan, EngineCheckpoint, EngineConfig, LocationSample } from './types';

/**
 * What one observation says about one checkpoint. The state machine in
 * checkpointEngine.ts only ever acts on these flags, so each positioning
 * policy decides here, and only here, what counts as being "there".
 *
 * Invariant: `inside` requires every kind of evidence the policy needs. A
 * missing or untrustworthy measurement yields `inconclusive`, never a silent
 * fallback to latitude/longitude.
 */
export interface Evidence {
  /** Counts towards entry confirmation. */
  inside: boolean;
  /** Ends a half-confirmed candidate (the user is not inside right now). */
  breaksCandidate: boolean;
  /** Counts towards exit / rearm (the user has clearly left). */
  confidentlyOutside: boolean;
  /** Resets exit counting (the user clearly has not left yet). */
  clearlyNotOutside: boolean;
  /** Horizontal distance when this observation had a position; null otherwise. */
  distanceM: number | null;
  /** Why the observation could not decide; null when it was conclusive. */
  inconclusive: string | null;
  /** Human-readable evidence, reported with a trigger. */
  detail: string;
}

const NO_EVIDENCE = (reason: string, distance: number | null = null): Evidence => ({
  inside: false,
  breaksCandidate: false,
  confidentlyOutside: false,
  clearlyNotOutside: false,
  distanceM: distance,
  inconclusive: reason,
  detail: '',
});

export function isBlePolicy(cp: EngineCheckpoint): boolean {
  return cp.policy === 'INDOOR_BLE' || cp.policy === 'INDOOR_BLE_FLOOR';
}

export function requiredObservations(cp: EngineCheckpoint, config: EngineConfig): number {
  if (isBlePolicy(cp)) return Math.max(1, cp.requiredBeaconObservations ?? config.entryConfirmSamples);
  return Math.max(1, config.entryConfirmSamples);
}

const m = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} m`;

// --- GNSS fixes ----------------------------------------------------------------

/** Evidence from a GNSS fix that passed the sample filter (good or low accuracy). */
export function evaluateFix(cp: EngineCheckpoint, sample: LocationSample, config: EngineConfig): Evidence {
  const d = distanceM(cp, sample);
  if (isBlePolicy(cp)) {
    // Indoors, GNSS positions are unreliable (reflections can be off by 50 m while
    // reporting 10 m accuracy), so they neither trigger nor rearm BLE checkpoints.
    return NO_EVIDENCE('waiting for beacon (GPS cannot confirm indoor checkpoints)', d);
  }

  const acc = sample.accuracyM;
  const limit = cp.maxHorizontalAccuracyM ?? config.maxAccuracyM;
  const accurate = acc != null && acc <= limit;
  const exitRadius = cp.radiusM + config.exitHysteresisM;
  const hInside = accurate && d <= cp.radiusM;
  const hOutside = (accurate && d > exitRadius) || (acc != null && d - acc > exitRadius);
  const hNotOutside = accurate && d <= exitRadius;
  const hBreaks = (accurate && d > cp.radiusM) || hOutside;
  const hDetail = `GPS ±${acc != null ? m(acc) : '?'}, ${m(d)} from centre`;

  if (cp.policy === 'OUTDOOR_GPS') {
    return {
      inside: hInside,
      breaksCandidate: hBreaks,
      confidentlyOutside: hOutside,
      clearlyNotOutside: hNotOutside,
      distanceM: d,
      inconclusive: accurate ? null : `GPS accuracy worse than ${m(limit)}`,
      detail: hDetail,
    };
  }

  // OUTDOOR_ELEVATION: horizontal AND vertical evidence.
  const v = evaluateVertical(cp, sample, config);
  return {
    inside: hInside && v.kind === 'match',
    breaksCandidate: hBreaks || v.kind === 'mismatch',
    confidentlyOutside: hOutside || v.kind === 'far',
    clearlyNotOutside: hNotOutside && v.kind === 'match',
    distanceM: d,
    inconclusive: !accurate ? `GPS accuracy worse than ${m(limit)}` : v.kind === 'inconclusive' ? v.reason : null,
    detail: `${hDetail}, ${v.detail}`,
  };
}

type Vertical =
  | { kind: 'match'; detail: string }
  /** Outside the allowed band (ends a candidate). */
  | { kind: 'mismatch'; detail: string }
  /** Outside the band even after hysteresis and uncertainty (counts as having left). */
  | { kind: 'far'; detail: string }
  | { kind: 'inconclusive'; reason: string; detail: string };

export function evaluateVertical(cp: EngineCheckpoint, sample: LocationSample, config: EngineConfig): Vertical {
  const inc = (reason: string): Vertical => ({ kind: 'inconclusive', reason, detail: reason });
  if (cp.altitudeM == null || cp.altitudeReference == null || cp.maxVerticalDifferenceM == null) {
    return inc('checkpoint altitude is not configured');
  }
  if (sample.altitudeM == null || !Number.isFinite(sample.altitudeM)) return inc('no altitude in GPS fix');
  if (sample.altitudeReference == null) return inc('altitude reference of the fix is unknown');
  if (sample.altitudeReference !== cp.altitudeReference) {
    return inc(`altitude reference mismatch (fix ${sample.altitudeReference}, checkpoint ${cp.altitudeReference})`);
  }
  const va = sample.altitudeAccuracyM;
  // <= 0 is Android's "no vertical accuracy" value, not a perfect measurement.
  if (va == null || !Number.isFinite(va) || va <= 0) return inc('vertical accuracy unknown');
  const maxUnc = cp.maxVerticalUncertaintyM ?? Infinity;
  const diff = Math.abs(sample.altitudeM - cp.altitudeM);
  const detail = `altitude Δ${m(diff)} ±${m(va)} (${cp.altitudeReference.toLowerCase()})`;
  // Clearly at another level even allowing for the reported uncertainty: proves an exit.
  if (diff - va > cp.maxVerticalDifferenceM + config.verticalExitHysteresisM) return { kind: 'far', detail };
  if (va > maxUnc) return inc(`vertical accuracy ±${m(va)} worse than ${m(maxUnc)}`);
  if (diff > cp.maxVerticalDifferenceM) return { kind: 'mismatch', detail };
  return { kind: 'match', detail };
}

// --- BLE scans -------------------------------------------------------------------

/**
 * Evidence from one BLE scan window, or null when scans say nothing about this
 * checkpoint (outdoor policies). `floorEstimate` comes from estimateFloor().
 */
export function evaluateScan(
  cp: EngineCheckpoint,
  scan: BeaconScan,
  floorEstimate: number | null,
  config: EngineConfig,
): Evidence | null {
  if (!isBlePolicy(cp)) return null;
  const expected = cp.expectedBeaconId ? normaliseBeaconId(cp.expectedBeaconId) : null;
  if (!expected) return NO_EVIDENCE('no valid beacon configured');

  const min = cp.minimumBeaconRssiDbm ?? config.defaultMinimumBeaconRssiDbm;
  const obs = scan.beacons.find((b) => b.id === expected);
  const strong = obs != null && obs.rssiDbm >= min;
  const gone = obs == null || obs.rssiDbm < min - config.beaconExitHysteresisDb;
  const beaconDetail = obs ? `beacon ${obs.rssiDbm} dBm (need ≥ ${min})` : 'beacon not heard';

  if (cp.policy === 'INDOOR_BLE') {
    return {
      inside: strong,
      breaksCandidate: !strong,
      confidentlyOutside: gone,
      clearlyNotOutside: strong,
      distanceM: null,
      inconclusive: strong ? null : obs ? `beacon too weak (${obs.rssiDbm} dBm, need ≥ ${min})` : 'waiting for beacon',
      detail: beaconDetail,
    };
  }

  // INDOOR_BLE_FLOOR: the beacon AND the floor must agree. The same lat/lon on
  // another floor (beacon heard through the ceiling) must not trigger.
  if (cp.floor == null) return NO_EVIDENCE('checkpoint floor is not configured');
  const floorOk = floorEstimate === cp.floor;
  const otherFloor = floorEstimate != null && floorEstimate !== cp.floor;
  const floorDetail = floorEstimate == null ? 'floor unknown' : `floor ${floorEstimate}`;
  return {
    inside: strong && floorOk,
    breaksCandidate: !strong || otherFloor,
    confidentlyOutside: gone || otherFloor,
    clearlyNotOutside: strong && floorOk,
    distanceM: null,
    inconclusive:
      strong && floorOk
        ? null
        : !strong
          ? obs
            ? `beacon too weak (${obs.rssiDbm} dBm, need ≥ ${min})`
            : 'waiting for beacon'
          : otherFloor
            ? `on floor ${floorEstimate}, checkpoint is on floor ${cp.floor}`
            : 'floor cannot be determined from beacons',
    detail: `${beaconDetail}, ${floorDetail}`,
  };
}
