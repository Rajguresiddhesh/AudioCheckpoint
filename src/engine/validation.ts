import { distanceM, isValidLatLon } from './geo';

export interface CheckpointDraft {
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

  const others = existing.filter((c) => c.id !== draft.id);
  const clash = others.find((c) => normaliseName(c.name) === normaliseName(name));
  if (name && clash) errors.push(`A checkpoint named "${clash.name}" already exists.`);

  let nearDuplicateOf: ExistingCheckpoint | null = null;
  const overlaps: OverlapInfo[] = [];
  if (isValidLatLon(draft.latitude, draft.longitude) && Number.isFinite(draft.triggerRadiusM)) {
    for (const other of others) {
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

  return { errors, warnings, nearDuplicateOf, overlaps, ok: errors.length === 0 };
}
