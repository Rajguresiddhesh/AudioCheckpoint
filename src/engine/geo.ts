/**
 * Geodesic helpers. Haversine on the IUGG mean Earth radius is within ~0.5% of
 * the WGS-84 ellipsoidal (Vincenty) distance, i.e. < 10 cm error at checkpoint
 * scales of tens of metres, far below GNSS noise.
 */

export const EARTH_MEAN_RADIUS_M = 6_371_008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export interface LatLon {
  latitude: number;
  longitude: number;
}

export function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

export function distanceM(a: LatLon, b: LatLon): number {
  const phi1 = toRad(a.latitude);
  const phi2 = toRad(b.latitude);
  const dPhi = toRad(b.latitude - a.latitude);
  const dLambda = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_MEAN_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Point reached by travelling `distance` metres from `origin` on initial bearing `bearingDeg`. */
export function destinationPoint(origin: LatLon, bearingDeg: number, distance: number): LatLon {
  const delta = distance / EARTH_MEAN_RADIUS_M;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(origin.latitude);
  const lambda1 = toRad(origin.longitude);
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return { latitude: toDeg(phi2), longitude: ((toDeg(lambda2) + 540) % 360) - 180 };
}

/** Initial bearing in degrees [0, 360) from a to b. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const phi1 = toRad(a.latitude);
  const phi2 = toRad(b.latitude);
  const dLambda = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Closed ring of [lon, lat] pairs approximating a circle, for drawing radius overlays. */
export function circleRing(center: LatLon, radius: number, steps = 64): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const p = destinationPoint(center, (i / steps) * 360, radius);
    ring.push([p.longitude, p.latitude]);
  }
  return ring;
}

/** Local east/north offset in metres from origin (equirectangular; fine for areas of a few km). */
export function toLocalXY(origin: LatLon, p: LatLon): { x: number; y: number } {
  const x =
    toRad(p.longitude - origin.longitude) *
    Math.cos(toRad((origin.latitude + p.latitude) / 2)) *
    EARTH_MEAN_RADIUS_M;
  const y = toRad(p.latitude - origin.latitude) * EARTH_MEAN_RADIUS_M;
  return { x, y };
}

export function interpolate(a: LatLon, b: LatLon, f: number): LatLon {
  return {
    latitude: a.latitude + (b.latitude - a.latitude) * f,
    longitude: a.longitude + (b.longitude - a.longitude) * f,
  };
}
