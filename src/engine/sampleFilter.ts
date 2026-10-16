import { distanceM, isValidLatLon } from './geo';
import type { EngineConfig, LocationSample, SampleQuality } from './types';

/**
 * Deterministic classification of a single fix. Rules, in order:
 *  1. invalid      non-finite / out-of-range coordinates, negative accuracy, or timestamp far in the future
 *  2. mocked       mock-provider fix while mock locations are disallowed
 *  3. stale        older than maxSampleAgeMs relative to now
 *  4. out_of_order not newer than the last accepted fix (duplicate or replayed)
 *  5. outlier      implied speed from the last accepted fix exceeds maxPlausibleSpeedMps, after
 *                  generously subtracting both fixes' accuracy radii
 *  6. low_accuracy accuracy unknown or worse than maxAccuracyM (usable for exit decisions only)
 *  7. good
 */
export function classifySample(
  sample: LocationSample,
  previous: LocationSample | null,
  nowMs: number,
  config: EngineConfig,
): SampleQuality {
  if (
    !isValidLatLon(sample.latitude, sample.longitude) ||
    !Number.isFinite(sample.timestampMs) ||
    (sample.accuracyM != null && (!Number.isFinite(sample.accuracyM) || sample.accuracyM < 0)) ||
    sample.timestampMs - nowMs > config.maxFutureSkewMs
  ) {
    return 'invalid';
  }
  if (sample.mocked && !config.allowMockLocations) return 'mocked';
  if (nowMs - sample.timestampMs > config.maxSampleAgeMs) return 'stale';
  if (previous && sample.timestampMs <= previous.timestampMs) return 'out_of_order';

  if (previous) {
    const dtS = (sample.timestampMs - previous.timestampMs) / 1000;
    const slack = (sample.accuracyM ?? 0) + (previous.accuracyM ?? 0);
    const implied = Math.max(0, distanceM(previous, sample) - slack) / dtS;
    if (implied > config.maxPlausibleSpeedMps) return 'outlier';
  }

  return accuracyQuality(sample, config);
}

export function accuracyQuality(sample: LocationSample, config: EngineConfig): SampleQuality {
  if (sample.accuracyM == null || sample.accuracyM > config.maxAccuracyM) return 'low_accuracy';
  return 'good';
}

export function isUsableQuality(q: SampleQuality): boolean {
  return q === 'good' || q === 'low_accuracy';
}
