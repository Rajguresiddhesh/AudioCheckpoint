import type { LocationSample } from '../engine/types';

/**
 * Anything that can produce position samples for the checkpoint engine.
 * GNSS (expo-location) and the route simulator implement this today; a BLE
 * beacon source (indoor, with `floor` set on each sample) or a sensor-fusion /
 * dead-reckoning source can be added later without touching the engine.
 */
export interface PositionSource {
  readonly id: 'gnss' | 'simulated' | 'ble' | string;
  start(onSamples: (samples: LocationSample[]) => void): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
}

/**
 * Planned interface for BLE beacons. Not implemented in v1 (no BLE hardware is
 * required); kept here to document the contract.
 */
export interface BeaconPositionSource extends PositionSource {
  id: 'ble';
  /** Map of beacon identifier -> surveyed position and floor. */
  configureBeacons(
    beacons: { id: string; latitude: number; longitude: number; floor: number; txPowerDbm: number }[],
  ): void;
}
