import { BEACON_ID_HELP, normaliseBeaconId } from './beacons';
import { distanceM, isValidLatLon } from './geo';
import {
  ALTITUDE_REFERENCES,
  POSITIONING_POLICIES,
  type AltitudeReference,
  type PositioningPolicy,
} from './types';

export interface PolicyFields {
  positioningPolicy: PositioningPolicy;
  maxHorizontalAccuracyM?: number | null;
  floor?: number | null;
  altitudeM?: number | null;
  altitudeReference?: AltitudeReference | null;
  maxVerticalDifferenceM?: number | null;
  maxVerticalUncertaintyM?: number | null;
  expectedBeaconId?: string | null;
  minimumBeaconRssiDbm?: number | null;
  requiredBeaconObservations?: number | null;
}

export interface CheckpointDraft extends PolicyFields {
  id?: string;
  name: string;
  latitude: number;
  longitude: number;
  triggerRadiusM: number;
  priority: number;
  enabled?: boolean;
}

export interface ExistingCheckpoint {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  triggerRadiusM: number;
  enabled?: boolean;
  positioningPolicy?: PositioningPolicy;
  floor?: number | null;
  expectedBeaconId?: string | null;
}

/** Defaults filled in when a BLE checkpoint leaves these empty. */
export const DEFAULT_MIN_BEACON_RSSI_DBM = -75;
export const DEFAULT_BEACON_OBSERVATIONS = 3;
/** Suggested defaults for elevation checkpoints (phone GNSS vertical error is often 5–15 m). */
export const DEFAULT_MAX_VERTICAL_DIFFERENCE_M = 10;
export const DEFAULT_MAX_VERTICAL_UNCERTAINTY_M = 15;

/** Canonical values as stored: beacon id normalised, BLE defaults applied. */
export function normalisePolicyFields(d: PolicyFields): Required<PolicyFields> {
  const ble = d.positioningPolicy === 'INDOOR_BLE' || d.positioningPolicy === 'INDOOR_BLE_FLOOR';
  const beacon = d.expectedBeaconId?.trim() ? (normaliseBeaconId(d.expectedBeaconId) ?? d.expectedBeaconId.trim()) : null;
  return {
    positioningPolicy: d.positioningPolicy,
    maxHorizontalAccuracyM: d.maxHorizontalAccuracyM ?? null,
    floor: d.floor ?? null,
    altitudeM: d.altitudeM ?? null,
    altitudeReference: d.altitudeReference ?? null,
    maxVerticalDifferenceM: d.maxVerticalDifferenceM ?? null,
    maxVerticalUncertaintyM: d.maxVerticalUncertaintyM ?? null,
    expectedBeaconId: beacon,
    minimumBeaconRssiDbm: d.minimumBeaconRssiDbm ?? (ble ? DEFAULT_MIN_BEACON_RSSI_DBM : null),
    requiredBeaconObservations: d.requiredBeaconObservations ?? (ble ? DEFAULT_BEACON_OBSERVATIONS : null),
  };
}

const inRange = (v: number | null | undefined, lo: number, hi: number) =>
  v != null && Number.isFinite(v) && v >= lo && v <= hi;

/** Policy-specific errors and warnings. */
export function validatePolicyFields(d: PolicyFields): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = normalisePolicyFields(d);

  if (!(POSITIONING_POLICIES as readonly string[]).includes(p.positioningPolicy)) {
    errors.push('Choose a valid positioning type.');
    return { errors, warnings };
  }
  if (p.maxHorizontalAccuracyM != null && !inRange(p.maxHorizontalAccuracyM, 1, 100)) {
    errors.push('Required GPS accuracy must be between 1 and 100 m.');
  }
  if (p.floor != null && !Number.isInteger(p.floor)) errors.push('Floor must be a whole number.');

  switch (p.positioningPolicy) {
    case 'OUTDOOR_GPS':
      if (p.floor != null) warnings.push('GPS-only checkpoints ignore the floor. Use "Indoor beacon + floor" to separate floors.');
      break;
    case 'OUTDOOR_ELEVATION':
      if (!inRange(p.altitudeM, -500, 9000)) errors.push('Altitude is required (between -500 and 9000 m).');
      if (p.altitudeReference == null || !(ALTITUDE_REFERENCES as readonly string[]).includes(p.altitudeReference)) {
        errors.push('Choose what the altitude is measured from (ellipsoid or mean sea level).');
      } else if (p.altitudeReference === 'BAROMETRIC_RELATIVE') {
        errors.push('Barometric relative height is not supported yet. Use ellipsoid or mean sea level.');
      }
      if (!inRange(p.maxVerticalDifferenceM, 0.5, 500)) errors.push('Allowed altitude difference must be between 0.5 and 500 m.');
      if (!inRange(p.maxVerticalUncertaintyM, 0.5, 100)) errors.push('Required vertical accuracy must be between 0.5 and 100 m.');
      if (p.maxVerticalDifferenceM != null && p.maxVerticalDifferenceM < 5) {
        warnings.push('Phone GPS altitude is rarely better than ±5 m; a smaller difference may never trigger.');
      }
      break;
    case 'INDOOR_BLE':
    case 'INDOOR_BLE_FLOOR':
      if (!p.expectedBeaconId) errors.push('A beacon id is required.');
      else if (!normaliseBeaconId(p.expectedBeaconId)) errors.push(`Beacon id is not valid. ${BEACON_ID_HELP}`);
      if (!inRange(p.minimumBeaconRssiDbm, -110, -20)) errors.push('Minimum beacon signal must be between -110 and -20 dBm.');
      if (
        !inRange(p.requiredBeaconObservations, 1, 20) ||
        !Number.isInteger(p.requiredBeaconObservations)
      ) {
        errors.push('Required beacon observations must be a whole number between 1 and 20.');
      }
      if (p.positioningPolicy === 'INDOOR_BLE_FLOOR' && p.floor == null) errors.push('Floor is required for "beacon + floor".');
      break;
  }
  return { errors, warnings };
}

/** Two checkpoints can only fire on the same evidence if this is true; otherwise overlap is harmless. */
function canConflict(a: PolicyFields, b: ExistingCheckpoint): boolean {
  if (a.floor != null && b.floor != null && a.floor !== b.floor) return false;
  const aBle = a.positioningPolicy === 'INDOOR_BLE' || a.positioningPolicy === 'INDOOR_BLE_FLOOR';
  const bBle = b.positioningPolicy === 'INDOOR_BLE' || b.positioningPolicy === 'INDOOR_BLE_FLOOR';
  if (aBle !== bBle) return false;
  if (aBle && bBle) {
    const ia = a.expectedBeaconId ? normaliseBeaconId(a.expectedBeaconId) : null;
    const ib = b.expectedBeaconId ? normaliseBeaconId(b.expectedBeaconId) : null;
    return ia != null && ia === ib;
  }
  return true;
}

export interface ValidationOptions {
  /** Another checkpoint centre closer than this is treated as an accidental duplicate. */
  duplicateDistanceM: number;
  /** Exit hysteresis of the engine; used to warn about entry/exit bands that touch. */
  exitHysteresisM: number;
  /** Set when the user explicitly confirmed saving next to an existing checkpoint. */
  allowNearDuplicate?: boolean;
}

export interface OverlapInfo {
  id: string;
  name: string;
  distanceM: number;
  kind: 'overlap' | 'hysteresis';
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  nearDuplicateOf: ExistingCheckpoint | null;
  overlaps: OverlapInfo[];
  ok: boolean;
}

export const RADIUS_MIN_M = 3;
export const RADIUS_MAX_M = 500;
export const NAME_MAX_LENGTH = 60;

export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function validateCheckpointDraft(
  draft: CheckpointDraft,
  existing: ExistingCheckpoint[],
  options: ValidationOptions,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = draft.name.trim();

  if (!name) errors.push('Name is required.');
  if (name.length > NAME_MAX_LENGTH) errors.push(`Name must be ${NAME_MAX_LENGTH} characters or fewer.`);
  if (!isValidLatLon(draft.latitude, draft.longitude)) errors.push('Coordinates are not valid.');
  if (
    !Number.isFinite(draft.triggerRadiusM) ||
    draft.triggerRadiusM < RADIUS_MIN_M ||
    draft.triggerRadiusM > RADIUS_MAX_M
  ) {
    errors.push(`Trigger radius must be between ${RADIUS_MIN_M} and ${RADIUS_MAX_M} m.`);
  } else if (draft.triggerRadiusM < 10) {
    warnings.push(
      'Radius under 10 m is smaller than typical phone GPS error; the checkpoint may be missed.',
    );
  }
  if (!Number.isInteger(draft.priority)) errors.push('Priority must be a whole number.');
  const policy = validatePolicyFields(draft);
  errors.push(...policy.errors);
  warnings.push(...policy.warnings);

  const others = existing.filter((c) => c.id !== draft.id);
  const clash = others.find((c) => normaliseName(c.name) === normaliseName(name));
  if (name && clash) errors.push(`A checkpoint named "${clash.name}" already exists.`);

  let nearDuplicateOf: ExistingCheckpoint | null = null;
  const overlaps: OverlapInfo[] = [];
  if (isValidLatLon(draft.latitude, draft.longitude) && Number.isFinite(draft.triggerRadiusM)) {
    for (const other of others) {
      // e.g. two galleries stacked on different floors share lat/lon legitimately.
      if (!canConflict(draft, other)) continue;
      const d = distanceM(draft, other);
      if (d < options.duplicateDistanceM && nearDuplicateOf == null) nearDuplicateOf = other;
      if (d < draft.triggerRadiusM + other.triggerRadiusM) {
        overlaps.push({ id: other.id, name: other.name, distanceM: d, kind: 'overlap' });
      } else if (d < draft.triggerRadiusM + other.triggerRadiusM + 2 * options.exitHysteresisM) {
        overlaps.push({ id: other.id, name: other.name, distanceM: d, kind: 'hysteresis' });
      }
    }
  }

  if (nearDuplicateOf && !options.allowNearDuplicate) {
    errors.push(
      `This is within ${options.duplicateDistanceM} m of "${nearDuplicateOf.name}". ` +
        'Confirm if you really want two checkpoints here.',
    );
  }
  for (const o of overlaps) {
    warnings.push(
      o.kind === 'overlap'
        ? `Trigger area overlaps "${o.name}" (${o.distanceM.toFixed(0)} m apart).`
        : `Exit band touches "${o.name}" (${o.distanceM.toFixed(0)} m apart); rearming may be slow.`,
    );
  }

  const beacon = draft.expectedBeaconId ? normaliseBeaconId(draft.expectedBeaconId) : null;
  if (beacon && draft.positioningPolicy === 'INDOOR_BLE_FLOOR' && draft.floor != null) {
    const clashFloor = others.find(
      (o) => o.expectedBeaconId && normaliseBeaconId(o.expectedBeaconId) === beacon && o.floor != null && o.floor !== draft.floor,
    );
    if (clashFloor) {
      errors.push(`This beacon is already used on floor ${clashFloor.floor} by "${clashFloor.name}". A beacon belongs to one floor.`);
    }
  }

  return { errors, warnings, nearDuplicateOf, overlaps, ok: errors.length === 0 };
}
