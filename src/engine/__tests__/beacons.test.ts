import { checkpointAt } from '../../testing/helpers';
import { beaconFloorMap, beaconIdsFromAdvertisement, decodeBase64, estimateFloor, normaliseBeaconId } from '../beacons';

const b64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

describe('beacon ids', () => {
  it('normalises iBeacon, Eddystone and MAC ids', () => {
    expect(normaliseBeaconId(' iBeacon:F7826DA64FA24E988024BC5B71E0893E:01:2 ')).toBe(
      'ibeacon:f7826da6-4fa2-4e98-8024-bc5b71e0893e:1:2',
    );
    expect(normaliseBeaconId('eddystone:EDD1EBEAC04E5DEFA017:0BDB87539B67')).toBe(
      'eddystone:edd1ebeac04e5defa017:0bdb87539b67',
    );
    expect(normaliseBeaconId('mac:AA:BB:CC:DD:EE:FF')).toBe('mac:aa:bb:cc:dd:ee:ff');
  });

  it.each([
    'ibeacon:not-a-uuid:1:2',
    'ibeacon:f7826da6-4fa2-4e98-8024-bc5b71e0893e:70000:1',
    'eddystone:short:0bdb87539b67',
    'mac:aa:bb',
    'beacon-1',
    '',
  ])('rejects %p', (id) => {
    expect(normaliseBeaconId(id)).toBeNull();
  });

  it('decodes base64 like the platform does', () => {
    expect(Array.from(decodeBase64(b64('4c000215ff')))).toEqual([0x4c, 0x00, 0x02, 0x15, 0xff]);
  });
});

describe('advertisement parsing', () => {
  it('reads an iBeacon frame (Apple manufacturer data)', () => {
    const data = b64('4c000215' + 'f7826da64fa24e988024bc5b71e0893e' + '0001' + '0102' + 'c5');
    expect(beaconIdsFromAdvertisement({ address: 'AA:BB:CC:DD:EE:FF', manufacturerData: data })).toEqual([
      'ibeacon:f7826da6-4fa2-4e98-8024-bc5b71e0893e:1:258',
      'mac:aa:bb:cc:dd:ee:ff',
    ]);
  });

  it('reads an Eddystone-UID frame (service data 0xFEAA)', () => {
    const data = b64('00eb' + 'edd1ebeac04e5defa017' + '0bdb87539b67' + '0000');
    const ids = beaconIdsFromAdvertisement({
      address: null,
      serviceData: { '0000feaa-0000-1000-8000-00805f9b34fb': data },
    });
    expect(ids).toEqual(['eddystone:edd1ebeac04e5defa017:0bdb87539b67']);
  });

  it('ignores other manufacturers and Eddystone URL/TLM frames', () => {
    expect(
      beaconIdsFromAdvertisement({
        address: null,
        manufacturerData: b64('75000215' + '00'.repeat(21)),
        serviceData: { feaa: b64('10eb0068747470') },
      }),
    ).toEqual([]);
  });
});

describe('floor estimation', () => {
  const A = 'ibeacon:f7826da6-4fa2-4e98-8024-bc5b71e0893e:1:1';
  const B = 'ibeacon:f7826da6-4fa2-4e98-8024-bc5b71e0893e:1:2';
  const floors = beaconFloorMap([
    checkpointAt('g1', 0, 0, { policy: 'INDOOR_BLE_FLOOR', floor: 1, expectedBeaconId: A }),
    checkpointAt('g2', 0, 0, { policy: 'INDOOR_BLE_FLOOR', floor: 2, expectedBeaconId: B }),
  ]);

  it('picks the floor of the clearly strongest known beacon', () => {
    expect(estimateFloor([{ id: A, rssiDbm: -80 }, { id: B, rssiDbm: -60 }], floors, 3)).toBe(2);
  });

  it('is unknown when floors are within the margin or no known beacon is heard', () => {
    expect(estimateFloor([{ id: A, rssiDbm: -61 }, { id: B, rssiDbm: -60 }], floors, 3)).toBeNull();
    expect(estimateFloor([{ id: 'mac:aa:bb:cc:dd:ee:ff', rssiDbm: -40 }], floors, 3)).toBeNull();
  });

  it('drops a beacon assigned to two different floors', () => {
    const conflicted = beaconFloorMap([
      checkpointAt('x', 0, 0, { floor: 1, expectedBeaconId: A }),
      checkpointAt('y', 0, 0, { floor: 3, expectedBeaconId: A }),
    ]);
    expect(conflicted.has(A)).toBe(false);
  });
});
