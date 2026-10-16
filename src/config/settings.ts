import type { PlaybackPolicy } from '../audio/audioManager';
import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from '../engine/types';

export interface AppSettings {
  engine: EngineConfig;
  playbackPolicy: PlaybackPolicy;
  /** Stop a checkpoint's audio when the user confidently leaves its area. */
  stopAudioOnExit: boolean;
  defaultRadiusM: number;
  /** Creator Mode: refuse to save while reported accuracy is worse than this. */
  saveAccuracyThresholdM: number;
  requireAccuracyForSave: boolean;
  duplicateDistanceM: number;
  /** GNSS update interval while tracking. */
  locationIntervalMs: number;
  /** Vector style used for online viewing and offline pack downloads. */
  mapStyleUrl: string;
}

/** OpenFreeMap: free, key-less OpenStreetMap vector tiles. See README for attribution. */
export const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

export const DEFAULT_SETTINGS: AppSettings = {
  engine: DEFAULT_ENGINE_CONFIG,
  playbackPolicy: 'queue',
  stopAudioOnExit: false,
  defaultRadiusM: 20,
  saveAccuracyThresholdM: 15,
  requireAccuracyForSave: true,
  duplicateDistanceM: 5,
  locationIntervalMs: 2000,
  mapStyleUrl: DEFAULT_MAP_STYLE_URL,
};

/** Merge stored JSON over defaults so new settings keys get sane values after upgrades. */
export function mergeSettings(stored: unknown): AppSettings {
  if (!stored || typeof stored !== 'object') return DEFAULT_SETTINGS;
  const s = stored as Partial<AppSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    engine: { ...DEFAULT_ENGINE_CONFIG, ...(s.engine ?? {}) },
  };
}
