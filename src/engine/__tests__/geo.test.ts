import {
  bearingDeg,
  circleRing,
  destinationPoint,
  distanceM,
  isValidLatLon,
  toLocalXY,
} from '../geo';

describe('geodesic distance', () => {
  it('is zero for identical points', () => {
    expect(distanceM({ latitude: 19.2, longitude: 73.07 }, { latitude: 19.2, longitude: 73.07 })).toBe(0);
  });

  it('matches one degree of latitude on the mean sphere (~111.195 km)', () => {
    const d = distanceM({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    expect(d).toBeCloseTo(111_195, -1);
  });

  it('matches the known London–Paris great-circle distance within 0.5%', () => {
    // Reference ellipsoidal distance ~343.9 km (Heathrow-ish to Paris centre varies; use city centres)
    const london = { latitude: 51.5074, longitude: -0.1278 };
    const paris = { latitude: 48.8566, longitude: 2.3522 };
    const d = distanceM(london, paris);
    expect(d).toBeGreaterThan(343_000 * 0.995);
    expect(d).toBeLessThan(344_000 * 1.005);
  });

  it('is symmetric and agrees with a local flat approximation at park scale', () => {
    const a = { latitude: 19.2198269, longitude: 73.0734127 };
    const b = destinationPoint(a, 37, 42);
    expect(distanceM(a, b)).toBeCloseTo(42, 6);
    expect(distanceM(b, a)).toBeCloseTo(distanceM(a, b), 9);
    const { x, y } = toLocalXY(a, b);
    expect(Math.hypot(x, y)).toBeCloseTo(42, 1);
  });

  it('destinationPoint and bearing round-trip', () => {
    const a = { latitude: 19.22, longitude: 73.07 };
    for (const brg of [0, 45, 90, 180, 270, 359]) {
      const b = destinationPoint(a, brg, 100);
      expect(distanceM(a, b)).toBeCloseTo(100, 6);
      const back = bearingDeg(a, b);
      const diff = Math.abs(((back - brg + 540) % 360) - 180);
      expect(diff).toBeLessThan(0.01);
    }
  });

  it('circleRing is closed and every vertex is on the radius', () => {
    const c = { latitude: 19.22, longitude: 73.07 };
    const ring = circleRing(c, 20, 32);
    expect(ring).toHaveLength(33);
    expect(ring[0][0]).toBeCloseTo(ring[32][0], 9);
    expect(ring[0][1]).toBeCloseTo(ring[32][1], 9);
    for (const [lon, lat] of ring) expect(distanceM(c, { latitude: lat, longitude: lon })).toBeCloseTo(20, 6);
  });

  it('validates coordinate ranges', () => {
    expect(isValidLatLon(19, 73)).toBe(true);
    expect(isValidLatLon(91, 0)).toBe(false);
    expect(isValidLatLon(0, -181)).toBe(false);
    expect(isValidLatLon(NaN, 0)).toBe(false);
  });
});
