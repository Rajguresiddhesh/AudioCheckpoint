import { normaliseBatchTimestamps } from '../../engine/timestamps';
import { evaluatePackStatus, formatBytes, looksLikeSqlite } from '../packStatus';
import { checkpointAreas, userFeatures } from '../geojson';

describe('offline pack verification', () => {
  it('only reports complete when the store is complete and all resources are present', () => {
    expect(evaluatePackStatus({ state: 'complete', percentage: 100, completedResourceCount: 120, requiredResourceCount: 120 })).toBe('complete');
    expect(evaluatePackStatus({ state: 'complete', percentage: 100, completedResourceCount: 119, requiredResourceCount: 120 })).toBe('incomplete');
    expect(evaluatePackStatus({ state: 'complete', percentage: 0, completedResourceCount: 0, requiredResourceCount: 0 })).toBe('incomplete');
    expect(evaluatePackStatus({ state: 'active', percentage: 40, completedResourceCount: 48, requiredResourceCount: 120 })).toBe('downloading');
    expect(evaluatePackStatus({ state: 'inactive', percentage: 40, completedResourceCount: 48, requiredResourceCount: 120 })).toBe('incomplete');
  });

  it('recognises SQLite headers and rejects corrupt/non-SQLite files', () => {
    const good = new TextEncoder().encode('SQLite format 3\u0000rest-of-header');
    expect(looksLikeSqlite(good)).toBe(true);
    expect(looksLikeSqlite(new TextEncoder().encode('PK\u0003\u0004zipfile......'))).toBe(false);
    expect(looksLikeSqlite(new Uint8Array(4))).toBe(false);
  });

  it('formats sizes', () => {
    expect(formatBytes(null)).toBe('–');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('GeoJSON overlays', () => {
  const cp = {
    id: 'a', name: 'Swing', latitude: 19.22, longitude: 73.07, triggerRadiusM: 20, audioUri: null, audioLabel: null,
    enabled: true, priority: 0, floor: null, altitudeM: null, coordinatesVerified: true, createdAt: 0, updatedAt: 0,
  };
  it('builds one polygon per checkpoint coloured by state', () => {
    const fc = checkpointAreas([cp, { ...cp, id: 'b', enabled: false }], { a: 'PLAYING' });
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].properties?.color).toBe('#16a34a');
    expect(fc.features[1].properties?.color).toBe('#9ca3af');
  });
  it('builds a user dot with an accuracy circle', () => {
    expect(userFeatures(null).features).toHaveLength(0);
    expect(userFeatures({ latitude: 19.2, longitude: 73, accuracyM: 8, timestampMs: 0 }).features).toHaveLength(2);
  });
});

describe('batch timestamp normalisation (wrong phone clock)', () => {
  const s = (t: number) => ({ latitude: 0, longitude: 0, accuracyM: 5, timestampMs: t });
  it('leaves batches alone when clocks roughly agree', () => {
    const batch = [s(1000), s(2000)];
    expect(normaliseBatchTimestamps(batch, 2500)).toBe(batch);
  });
  it('shifts a skewed batch so the newest fix is now, preserving spacing', () => {
    const out = normaliseBatchTimestamps([s(1000), s(2000)], 10 * 60_000);
    expect(out.map((x) => x.timestampMs)).toEqual([10 * 60_000 - 1000, 10 * 60_000]);
  });
});
