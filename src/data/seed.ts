import { melodyRef } from '../audio/audioValidation';
import { MELODIES } from '../audio/melody';
import { SEED_CHECKPOINTS, SITE } from '../config/site';
import { destinationPoint } from '../engine/geo';
import type { CheckpointRepository, SettingsRepository } from './repositories';

const SEED_FLAG = 'seeded_v1';

/**
 * First-run sample data: Swing and Ground with PLACEHOLDER coordinates (marked
 * unverified) and distinct test melodies. Runs once; deleting them is permanent.
 */
export async function seedIfFirstRun(
  checkpoints: CheckpointRepository,
  settings: SettingsRepository,
): Promise<boolean> {
  if (await settings.getFlag(SEED_FLAG)) return false;
  const s = await settings.load();
  for (const seed of SEED_CHECKPOINTS) {
    const p = destinationPoint(SITE.center, seed.bearingDeg, seed.distanceM);
    await checkpoints.save(
      {
        name: seed.name,
        positioningPolicy: 'OUTDOOR_GPS',
        latitude: p.latitude,
        longitude: p.longitude,
        triggerRadiusM: s.defaultRadiusM,
        priority: seed.priority,
        audioUri: melodyRef(seed.melody),
        audioLabel: MELODIES[seed.melody].label,
        enabled: true,
        floor: null,
        altitudeM: null,
        coordinatesVerified: false,
      },
      { duplicateDistanceM: s.duplicateDistanceM, exitHysteresisM: s.engine.exitHysteresisM },
    );
  }
  await settings.setFlag(SEED_FLAG, String(Date.now()));
  return true;
}
