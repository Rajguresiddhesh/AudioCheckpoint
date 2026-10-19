import { destinationPoint } from '../geo';
import type { PositioningPolicy } from '../types';
import { validateCheckpointDraft, type ExistingCheckpoint } from '../validation';

const origin = { latitude: 19.2198269, longitude: 73.0734127 };
const opts = { duplicateDistanceM: 5, exitHysteresisM: 10 };
const swing: ExistingCheckpoint = { id: 'swing', name: 'Swing', ...origin, triggerRadiusM: 20 };

const draft = (over: Partial<Parameters<typeof validateCheckpointDraft>[0]> = {}) => ({
  positioningPolicy: 'OUTDOOR_GPS' as PositioningPolicy,
  name: 'Ground',
  ...destinationPoint(origin, 180, 100),
  triggerRadiusM: 20,
  priority: 0,
  ...over,
});

describe('checkpoint validation', () => {
  it('accepts a well-separated checkpoint', () => {
    const r = validateCheckpointDraft(draft(), [swing], opts);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('rejects a duplicate name case-insensitively and ignoring extra whitespace', () => {
    const r = validateCheckpointDraft(draft({ name: '  swing ' }), [swing], opts);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/already exists/);
  });

  it('allows keeping the same name when editing the same checkpoint', () => {
    const r = validateCheckpointDraft({ ...draft({ name: 'Swing' }), id: 'swing' }, [swing], opts);
    expect(r.ok).toBe(true);
  });

  it('blocks an accidental near-duplicate location unless confirmed', () => {
    const near = draft({ name: 'Swing 2', ...destinationPoint(origin, 45, 2) });
    const r = validateCheckpointDraft(near, [swing], opts);
    expect(r.ok).toBe(false);
    expect(r.nearDuplicateOf?.id).toBe('swing');
    const confirmed = validateCheckpointDraft(near, [swing], { ...opts, allowNearDuplicate: true });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.overlaps[0]).toMatchObject({ id: 'swing', kind: 'overlap' });
  });

  it('warns when trigger areas overlap', () => {
    const r = validateCheckpointDraft(draft({ ...destinationPoint(origin, 180, 30) }), [swing], opts);
    expect(r.ok).toBe(true);
    expect(r.overlaps).toEqual([expect.objectContaining({ kind: 'overlap' })]);
    expect(r.warnings[0]).toMatch(/overlaps "Swing"/);
  });

  it('warns when only the exit hysteresis bands touch', () => {
    const r = validateCheckpointDraft(draft({ ...destinationPoint(origin, 180, 50) }), [swing], opts);
    expect(r.overlaps).toEqual([expect.objectContaining({ kind: 'hysteresis' })]);
  });

  it('validates name, radius, coordinates and priority', () => {
    expect(validateCheckpointDraft(draft({ name: '   ' }), [], opts).errors).toContain('Name is required.');
    expect(validateCheckpointDraft(draft({ triggerRadiusM: 1 }), [], opts).ok).toBe(false);
    expect(validateCheckpointDraft(draft({ triggerRadiusM: 1000 }), [], opts).ok).toBe(false);
    expect(validateCheckpointDraft(draft({ latitude: 100 }), [], opts).ok).toBe(false);
    expect(validateCheckpointDraft(draft({ priority: 1.5 }), [], opts).ok).toBe(false);
    expect(validateCheckpointDraft(draft({ triggerRadiusM: 6 }), [], opts).warnings[0]).toMatch(/GPS error/);
  });

  describe('positioning policies', () => {
    const BEACON = 'ibeacon:F7826DA6-4FA2-4E98-8024-BC5B71E0893E:1:2';

    it('elevation checkpoints need altitude, reference and vertical limits', () => {
      const r = validateCheckpointDraft(draft({ positioningPolicy: 'OUTDOOR_ELEVATION' }), [], opts);
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Altitude is required.*measured from.*difference.*vertical accuracy/);
      const ok = validateCheckpointDraft(
        draft({
          positioningPolicy: 'OUTDOOR_ELEVATION', altitudeM: 512, altitudeReference: 'MSL',
          maxVerticalDifferenceM: 10, maxVerticalUncertaintyM: 15,
        }),
        [],
        opts,
      );
      expect(ok.ok).toBe(true);
    });

    it('rejects barometric relative height until a barometer source exists', () => {
      const r = validateCheckpointDraft(
        draft({
          positioningPolicy: 'OUTDOOR_ELEVATION', altitudeM: 10, altitudeReference: 'BAROMETRIC_RELATIVE',
          maxVerticalDifferenceM: 3, maxVerticalUncertaintyM: 2,
        }),
        [],
        opts,
      );
      expect(r.errors.join()).toMatch(/not supported/);
    });

    it('BLE checkpoints need a valid beacon id; BLE + floor also needs a floor', () => {
      expect(validateCheckpointDraft(draft({ positioningPolicy: 'INDOOR_BLE' }), [], opts).errors.join()).toMatch(/beacon id is required/i);
      expect(
        validateCheckpointDraft(draft({ positioningPolicy: 'INDOOR_BLE', expectedBeaconId: 'beacon-7' }), [], opts).errors.join(),
      ).toMatch(/not valid/);
      expect(validateCheckpointDraft(draft({ positioningPolicy: 'INDOOR_BLE', expectedBeaconId: BEACON }), [], opts).ok).toBe(true);
      const noFloor = validateCheckpointDraft(draft({ positioningPolicy: 'INDOOR_BLE_FLOOR', expectedBeaconId: BEACON }), [], opts);
      expect(noFloor.errors.join()).toMatch(/Floor is required/);
    });

    it('allows two checkpoints at the same lat/lon on different floors without duplicate warnings', () => {
      const lower: ExistingCheckpoint = {
        ...swing, positioningPolicy: 'INDOOR_BLE_FLOOR', floor: 1,
        expectedBeaconId: 'ibeacon:f7826da6-4fa2-4e98-8024-bc5b71e0893e:1:1',
      };
      const upper = draft({ name: 'Upper', ...origin, positioningPolicy: 'INDOOR_BLE_FLOOR', floor: 2, expectedBeaconId: BEACON });
      const r = validateCheckpointDraft(upper, [lower], opts);
      expect(r.ok).toBe(true);
      expect(r.nearDuplicateOf).toBeNull();
      expect(r.overlaps).toEqual([]);
    });

    it('refuses to put one beacon on two floors', () => {
      const lower: ExistingCheckpoint = { ...swing, positioningPolicy: 'INDOOR_BLE_FLOOR', floor: 1, expectedBeaconId: BEACON.toLowerCase() };
      const r = validateCheckpointDraft(
        draft({ name: 'Upper', positioningPolicy: 'INDOOR_BLE_FLOOR', floor: 2, expectedBeaconId: BEACON }),
        [lower],
        opts,
      );
      expect(r.errors.join()).toMatch(/already used on floor 1/);
    });

    it('warns that GPS-only checkpoints ignore the floor', () => {
      expect(validateCheckpointDraft(draft({ floor: 2 }), [], opts).warnings.join()).toMatch(/ignore the floor/);
    });
  });
});
