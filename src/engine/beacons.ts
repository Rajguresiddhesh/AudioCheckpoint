import type { BeaconObservation, EngineCheckpoint } from './types';

/**
 * Beacon identity helpers. Pure TypeScript (no BLE library imports) so the
 * parsing and floor logic is unit tested in Node.
 *
 * Canonical ids (always lower case):
 *   ibeacon:<uuid with dashes>:<major>:<minor>     e.g. ibeacon:f7826da6-4fa2-4e98-8024-bc5b71e0893e:1:2
 *   eddystone:<namespace 20 hex>:<instance 12 hex>  (Eddystone-UID frame)
 *   mac:<aa:bb:cc:dd:ee:ff>                         only for beacons with a fixed (non-random) address
 */

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

export const BEACON_ID_HELP =
  'Use ibeacon:<uuid>:<major>:<minor>, eddystone:<namespace>:<instance> or mac:<address>.';

/** Returns the canonical form, or null when the text is not a valid beacon id. */
export function normaliseBeaconId(text: string): string | null {
  const t = text.trim().toLowerCase();
  const [kind, ...rest] = t.split(':');
  if (kind === 'ibeacon' && rest.length === 3) {
    const [uuid, major, minor] = rest;
    if (!UUID_RE.test(uuid) || !isUint16(major) || !isUint16(minor)) return null;
    return `ibeacon:${dashUuid(uuid.replace(/-/g, ''))}:${Number(major)}:${Number(minor)}`;
  }
  if (kind === 'eddystone' && rest.length === 2) {
    const [ns, inst] = rest;
    if (!/^[0-9a-f]{20}$/.test(ns) || !/^[0-9a-f]{12}$/.test(inst)) return null;
    return `eddystone:${ns}:${inst}`;
  }
  if (kind === 'mac') {
    const mac = rest.join(':');
    return MAC_RE.test(mac) ? `mac:${mac}` : null;
  }
  return null;
}

function isUint16(s: string): boolean {
  if (!/^\d{1,5}$/.test(s)) return false;
  const n = Number(s);
  return n >= 0 && n <= 65535;
}

function dashUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Minimal base64 decoder (the BLE library hands advertisement data over as base64). */
export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const EDDYSTONE_SERVICE = 'feaa';

/** Raw advertisement as delivered by the BLE scanner (data fields base64). */
export interface RawAdvertisement {
  /** Device address; on Android a MAC address. */
  address: string | null;
  manufacturerData?: string | null;
  serviceData?: Record<string, string> | null;
}

/**
 * Every id one advertisement can be matched by: its iBeacon or Eddystone-UID
 * identity when it carries one, plus its MAC address.
 */
export function beaconIdsFromAdvertisement(adv: RawAdvertisement): string[] {
  const ids: string[] = [];
  if (adv.manufacturerData) {
    const d = decodeBase64(adv.manufacturerData);
    // Apple company id 0x004C (little endian), iBeacon type 0x02, length 0x15.
    if (d.length >= 25 && d[0] === 0x4c && d[1] === 0x00 && d[2] === 0x02 && d[3] === 0x15) {
      const uuid = dashUuid(hex(d.slice(4, 20)));
      const major = (d[20] << 8) | d[21];
      const minor = (d[22] << 8) | d[23];
      ids.push(`ibeacon:${uuid}:${major}:${minor}`);
    }
  }
  for (const [uuid, data] of Object.entries(adv.serviceData ?? {})) {
    const u = uuid.toLowerCase();
    if (u !== EDDYSTONE_SERVICE && !u.startsWith(`0000${EDDYSTONE_SERVICE}-`)) continue;
    const d = decodeBase64(data);
    // Eddystone-UID: frame 0x00, tx power, 10-byte namespace, 6-byte instance.
    if (d.length >= 18 && d[0] === 0x00) {
      ids.push(`eddystone:${hex(d.slice(2, 12))}:${hex(d.slice(12, 18))}`);
    }
  }
  if (adv.address) {
    const mac = normaliseBeaconId(`mac:${adv.address}`);
    if (mac) ids.push(mac);
  }
  return ids;
}

/** beacon id -> floor, from checkpoints that tie a beacon to a floor. Conflicting floors are dropped. */
export function beaconFloorMap(checkpoints: EngineCheckpoint[]): Map<string, number> {
  const floors = new Map<string, number>();
  const conflicted = new Set<string>();
  for (const cp of checkpoints) {
    if (!cp.expectedBeaconId || cp.floor == null) continue;
    const id = normaliseBeaconId(cp.expectedBeaconId);
    if (!id) continue;
    const prev = floors.get(id);
    if (prev != null && prev !== cp.floor) conflicted.add(id);
    floors.set(id, cp.floor);
  }
  for (const id of conflicted) floors.delete(id);
  return floors;
}

/**
 * Floor of the strongest known beacon, provided it beats the strongest known
 * beacon on any other floor by `marginDb`. null when no known beacon was heard
 * or the result is ambiguous (e.g. standing on a staircase between floors).
 */
export function estimateFloor(
  observations: BeaconObservation[],
  floors: Map<string, number>,
  marginDb: number,
): number | null {
  const bestByFloor = new Map<number, number>();
  for (const o of observations) {
    const f = floors.get(o.id);
    if (f == null) continue;
    bestByFloor.set(f, Math.max(bestByFloor.get(f) ?? -Infinity, o.rssiDbm));
  }
  const ranked = [...bestByFloor.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0][1] - ranked[1][1] < marginDb) return null;
  return ranked[0][0];
}
