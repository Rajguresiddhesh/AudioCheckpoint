import type { AltitudeReference, PositioningPolicy } from '../engine/types';

export interface Checkpoint {
  id: string;
  name: string;
  positioningPolicy: PositioningPolicy;
  latitude: number;
  longitude: number;
  /** Horizontal trigger radius. */
  triggerRadiusM: number;
  /** null = use the global Settings limit. */
  maxHorizontalAccuracyM: number | null;
  /** 'melody:<id>' for generated test tones, a file:// URI for imported audio, or null. */
  audioUri: string | null;
  audioLabel: string | null;
  enabled: boolean;
  priority: number;
  floor: number | null;
  altitudeM: number | null;
  altitudeReference: AltitudeReference | null;
  maxVerticalDifferenceM: number | null;
  maxVerticalUncertaintyM: number | null;
  /** Canonical beacon id, see src/engine/beacons.ts. */
  expectedBeaconId: string | null;
  minimumBeaconRssiDbm: number | null;
  requiredBeaconObservations: number | null;
  /** False for placeholder coordinates that must be re-captured on site. */
  coordinatesVerified: boolean;
  createdAt: number;
  updatedAt: number;
}

export type DownloadStatus =
  | 'pending'
  | 'downloading'
  | 'complete'
  | 'incomplete'
  | 'failed'
  | 'missing';

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MapPackage {
  id: string;
  name: string;
  localPath: string | null;
  offlinePackId: string | null;
  styleUrl: string | null;
  bounds: Bounds;
  minZoom: number;
  maxZoom: number;
  downloadStatus: DownloadStatus;
  progress: number;
  sizeBytes: number | null;
  verifiedAt: number | null;
  error: string | null;
  createdAt: number;
}

export type PlaybackStatus =
  | 'triggered'
  | 'playing'
  | 'completed'
  | 'stopped'
  | 'interrupted'
  | 'superseded'
  | 'ignored'
  | 'missing'
  | 'error';

export interface TriggerHistoryEntry {
  id: number;
  checkpointId: string;
  checkpointName?: string;
  sessionId: string | null;
  triggeredAt: number;
  playbackStatus: PlaybackStatus;
  distanceM: number | null;
  accuracyM: number | null;
  /** What caused the trigger (GPS/altitude/beacon/floor), for field debugging. */
  evidence: string | null;
}

export interface TrackingSession {
  id: string;
  startedAt: number;
  endedAt: number | null;
  source: string;
  engineSnapshot: string | null;
  updatedAt: number;
}
