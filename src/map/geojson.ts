import type { Checkpoint } from '../data/models';
import { circleRing } from '../engine/geo';
import type { CheckpointState, LocationSample } from '../engine/types';

export const STATE_COLORS: Record<CheckpointState | 'DISABLED', string> = {
  OUTSIDE: '#2563eb',
  CANDIDATE: '#d97706',
  TRIGGERED: '#16a34a',
  PLAYING: '#16a34a',
  COOLDOWN: '#6b7280',
  DISABLED: '#9ca3af',
};

export function checkpointColor(cp: Checkpoint, state: CheckpointState | undefined): string {
  if (!cp.enabled) return STATE_COLORS.DISABLED;
  return STATE_COLORS[state ?? 'OUTSIDE'];
}

export function checkpointAreas(
  checkpoints: Checkpoint[],
  states: Record<string, CheckpointState | undefined>,
): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  return {
    type: 'FeatureCollection',
    features: checkpoints.map((cp) => ({
      type: 'Feature',
      id: cp.id,
      properties: { id: cp.id, name: cp.name, color: checkpointColor(cp, states[cp.id]) },
      geometry: { type: 'Polygon', coordinates: [circleRing(cp, cp.triggerRadiusM)] },
    })),
  };
}

export function userFeatures(sample: LocationSample | null): GeoJSON.FeatureCollection {
  if (!sample) return { type: 'FeatureCollection', features: [] };
  const features: GeoJSON.Feature[] = [
    {
      type: 'Feature',
      properties: { kind: 'dot' },
      geometry: { type: 'Point', coordinates: [sample.longitude, sample.latitude] },
    },
  ];
  if (sample.accuracyM != null && sample.accuracyM > 0) {
    features.unshift({
      type: 'Feature',
      properties: { kind: 'accuracy' },
      geometry: { type: 'Polygon', coordinates: [circleRing(sample, sample.accuracyM, 48)] },
    });
  }
  return { type: 'FeatureCollection', features };
}
