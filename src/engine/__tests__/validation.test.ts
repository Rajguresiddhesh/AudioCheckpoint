import { destinationPoint } from '../geo';
import { validateCheckpointDraft, type ExistingCheckpoint } from '../validation';

const origin = { latitude: 19.2198269, longitude: 73.0734127 };
const opts = { duplicateDistanceM: 5, exitHysteresisM: 10 };
const swing: ExistingCheckpoint = { id: 'swing', name: 'Swing', ...origin, triggerRadiusM: 20 };

const draft = (over: Partial<Parameters<typeof validateCheckpointDraft>[0]> = {}) => ({
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
});
