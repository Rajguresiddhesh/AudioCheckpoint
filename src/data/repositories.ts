import { mergeSettings, type AppSettings } from '../config/settings';
import {
  validateCheckpointDraft,
  type CheckpointDraft,
  type ValidationResult,
} from '../engine/validation';
import type {
  Checkpoint,
  DownloadStatus,
  MapPackage,
  PlaybackStatus,
  TrackingSession,
  TriggerHistoryEntry,
} from './models';
import type { SqlDb, SqlParam } from './sqlDb';

export type Clock = () => number;
export type IdFactory = () => string;

export class ValidationError extends Error {
  constructor(public readonly result: ValidationResult) {
    super(result.errors.join(' '));
    this.name = 'ValidationError';
  }
}

// --- Checkpoints -------------------------------------------------------------

interface CheckpointRow {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  trigger_radius_m: number;
  audio_uri: string | null;
  audio_label: string | null;
  enabled: number;
  priority: number;
  floor: number | null;
  altitude_m: number | null;
  coordinates_verified: number;
  created_at: number;
  updated_at: number;
}

const toCheckpoint = (r: CheckpointRow): Checkpoint => ({
  id: r.id,
  name: r.name,
  latitude: r.latitude,
  longitude: r.longitude,
  triggerRadiusM: r.trigger_radius_m,
  audioUri: r.audio_uri,
  audioLabel: r.audio_label,
  enabled: r.enabled === 1,
  priority: r.priority,
  floor: r.floor,
  altitudeM: r.altitude_m,
  coordinatesVerified: r.coordinates_verified === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface CheckpointInput extends CheckpointDraft {
  audioUri: string | null;
  audioLabel: string | null;
  enabled: boolean;
  floor: number | null;
  altitudeM: number | null;
  coordinatesVerified: boolean;
}

export class CheckpointRepository {
  constructor(
    private db: SqlDb,
    private newId: IdFactory,
    private now: Clock = Date.now,
  ) {}

  async list(): Promise<Checkpoint[]> {
    const rows = await this.db.getAllAsync<CheckpointRow>(
      'SELECT * FROM checkpoints ORDER BY priority DESC, name COLLATE NOCASE',
      [],
    );
    return rows.map(toCheckpoint);
  }

  async get(id: string): Promise<Checkpoint | null> {
    const row = await this.db.getFirstAsync<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', [id]);
    return row ? toCheckpoint(row) : null;
  }

  async validate(
    draft: CheckpointDraft,
    opts: { duplicateDistanceM: number; exitHysteresisM: number; allowNearDuplicate?: boolean },
  ): Promise<ValidationResult> {
    const existing = await this.list();
    return validateCheckpointDraft(
      draft,
      existing.map((c) => ({ ...c, triggerRadiusM: c.triggerRadiusM })),
      opts,
    );
  }

  /** Validates (duplicates, ranges) and inserts or updates. Throws ValidationError. */
  async save(
    input: CheckpointInput,
    opts: { duplicateDistanceM: number; exitHysteresisM: number; allowNearDuplicate?: boolean },
  ): Promise<Checkpoint> {
    const result = await this.validate(input, opts);
    if (!result.ok) throw new ValidationError(result);

    const t = this.now();
    const name = input.name.trim().replace(/\s+/g, ' ');
    const values: SqlParam[] = [
      name,
      input.latitude,
      input.longitude,
      input.triggerRadiusM,
      input.audioUri,
      input.audioLabel,
      input.enabled ? 1 : 0,
      input.priority,
      input.floor,
      input.altitudeM,
      input.coordinatesVerified ? 1 : 0,
    ];
    if (input.id && (await this.get(input.id))) {
      await this.db.runAsync(
        `UPDATE checkpoints SET name=?, latitude=?, longitude=?, trigger_radius_m=?, audio_uri=?,
           audio_label=?, enabled=?, priority=?, floor=?, altitude_m=?, coordinates_verified=?, updated_at=?
         WHERE id=?`,
        [...values, t, input.id],
      );
      return (await this.get(input.id))!;
    }
    const id = input.id ?? this.newId();
    await this.db.runAsync(
      `INSERT INTO checkpoints (name, latitude, longitude, trigger_radius_m, audio_uri, audio_label,
         enabled, priority, floor, altitude_m, coordinates_verified, created_at, updated_at, id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [...values, t, t, id],
    );
    return (await this.get(id))!;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.runAsync('UPDATE checkpoints SET enabled=?, updated_at=? WHERE id=?', [
      enabled ? 1 : 0,
      this.now(),
      id,
    ]);
  }

  async setAudio(id: string, audioUri: string | null, audioLabel: string | null): Promise<void> {
    await this.db.runAsync('UPDATE checkpoints SET audio_uri=?, audio_label=?, updated_at=? WHERE id=?', [
      audioUri,
      audioLabel,
      this.now(),
      id,
    ]);
  }

  async delete(id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM checkpoints WHERE id=?', [id]);
  }

  async isAudioReferenced(audioUri: string): Promise<boolean> {
    const row = await this.db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM checkpoints WHERE audio_uri=?',
      [audioUri],
    );
    return (row?.n ?? 0) > 0;
  }
}

// --- Map packages ------------------------------------------------------------

interface MapPackageRow {
  id: string;
  name: string;
  local_path: string | null;
  offline_pack_id: string | null;
  style_url: string | null;
  west: number;
  south: number;
  east: number;
  north: number;
  min_zoom: number;
  max_zoom: number;
  download_status: DownloadStatus;
  progress: number;
  size_bytes: number | null;
  verified_at: number | null;
  error: string | null;
  created_at: number;
}

const toMapPackage = (r: MapPackageRow): MapPackage => ({
  id: r.id,
  name: r.name,
  localPath: r.local_path,
  offlinePackId: r.offline_pack_id,
  styleUrl: r.style_url,
  bounds: { west: r.west, south: r.south, east: r.east, north: r.north },
  minZoom: r.min_zoom,
  maxZoom: r.max_zoom,
  downloadStatus: r.download_status,
  progress: r.progress,
  sizeBytes: r.size_bytes,
  verifiedAt: r.verified_at,
  error: r.error,
  createdAt: r.created_at,
});

export class MapPackageRepository {
  constructor(
    private db: SqlDb,
    private newId: IdFactory,
    private now: Clock = Date.now,
  ) {}

  async list(): Promise<MapPackage[]> {
    const rows = await this.db.getAllAsync<MapPackageRow>(
      'SELECT * FROM map_packages ORDER BY created_at DESC',
      [],
    );
    return rows.map(toMapPackage);
  }

  /** A package counts as usable offline only if complete AND verified against the tile store. */
  async findUsable(): Promise<MapPackage | null> {
    const row = await this.db.getFirstAsync<MapPackageRow>(
      `SELECT * FROM map_packages WHERE download_status='complete' AND verified_at IS NOT NULL
       ORDER BY verified_at DESC LIMIT 1`,
      [],
    );
    return row ? toMapPackage(row) : null;
  }

  async create(
    p: Omit<MapPackage, 'id' | 'createdAt' | 'verifiedAt' | 'error' | 'progress' | 'sizeBytes'>,
  ): Promise<MapPackage> {
    const id = this.newId();
    await this.db.runAsync(
      `INSERT INTO map_packages (id, name, local_path, offline_pack_id, style_url, west, south, east, north,
         min_zoom, max_zoom, download_status, progress, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      [
        id,
        p.name,
        p.localPath,
        p.offlinePackId,
        p.styleUrl,
        p.bounds.west,
        p.bounds.south,
        p.bounds.east,
        p.bounds.north,
        p.minZoom,
        p.maxZoom,
        p.downloadStatus,
        this.now(),
      ],
    );
    return (await this.list()).find((x) => x.id === id)!;
  }

  async updateStatus(
    id: string,
    patch: {
      downloadStatus: DownloadStatus;
      progress?: number;
      sizeBytes?: number | null;
      verified?: boolean;
      error?: string | null;
      offlinePackId?: string | null;
    },
  ): Promise<void> {
    await this.db.runAsync(
      `UPDATE map_packages SET download_status=?, progress=COALESCE(?, progress),
         size_bytes=COALESCE(?, size_bytes), verified_at=?, error=?,
         offline_pack_id=COALESCE(?, offline_pack_id)
       WHERE id=?`,
      [
        patch.downloadStatus,
        patch.progress ?? null,
        patch.sizeBytes ?? null,
        patch.verified ? this.now() : null,
        patch.error ?? null,
        patch.offlinePackId ?? null,
        id,
      ],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM map_packages WHERE id=?', [id]);
  }
}

// --- Trigger history ---------------------------------------------------------

export class TriggerHistoryRepository {
  constructor(private db: SqlDb) {}

  async record(e: Omit<TriggerHistoryEntry, 'id' | 'checkpointName'>): Promise<number> {
    const r = await this.db.runAsync(
      `INSERT INTO trigger_history (checkpoint_id, session_id, triggered_at, playback_status, distance_m, accuracy_m)
       VALUES (?,?,?,?,?,?)`,
      [e.checkpointId, e.sessionId, e.triggeredAt, e.playbackStatus, e.distanceM, e.accuracyM],
    );
    return r.lastInsertRowId;
  }

  async updateStatus(id: number, status: PlaybackStatus): Promise<void> {
    await this.db.runAsync('UPDATE trigger_history SET playback_status=? WHERE id=?', [status, id]);
  }

  async recent(limit = 50): Promise<TriggerHistoryEntry[]> {
    const rows = await this.db.getAllAsync<{
      id: number;
      checkpoint_id: string;
      name: string | null;
      session_id: string | null;
      triggered_at: number;
      playback_status: PlaybackStatus;
      distance_m: number | null;
      accuracy_m: number | null;
    }>(
      `SELECT h.*, c.name FROM trigger_history h LEFT JOIN checkpoints c ON c.id = h.checkpoint_id
       ORDER BY h.triggered_at DESC, h.id DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      checkpointId: r.checkpoint_id,
      checkpointName: r.name ?? undefined,
      sessionId: r.session_id,
      triggeredAt: r.triggered_at,
      playbackStatus: r.playback_status,
      distanceM: r.distance_m,
      accuracyM: r.accuracy_m,
    }));
  }

  async clear(): Promise<void> {
    await this.db.runAsync('DELETE FROM trigger_history', []);
  }
}

// --- Tracking sessions -------------------------------------------------------

export class SessionRepository {
  constructor(
    private db: SqlDb,
    private now: Clock = Date.now,
  ) {}

  async start(id: string, source: string): Promise<void> {
    const t = this.now();
    await this.db.runAsync(
      'INSERT INTO tracking_sessions (id, started_at, source, updated_at) VALUES (?,?,?,?)',
      [id, t, source, t],
    );
  }

  async active(): Promise<TrackingSession | null> {
    const r = await this.db.getFirstAsync<{
      id: string;
      started_at: number;
      ended_at: number | null;
      source: string;
      engine_snapshot: string | null;
      updated_at: number;
    }>('SELECT * FROM tracking_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1', []);
    return r
      ? {
          id: r.id,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          source: r.source,
          engineSnapshot: r.engine_snapshot,
          updatedAt: r.updated_at,
        }
      : null;
  }

  async saveSnapshot(id: string, snapshot: string): Promise<void> {
    await this.db.runAsync('UPDATE tracking_sessions SET engine_snapshot=?, updated_at=? WHERE id=?', [
      snapshot,
      this.now(),
      id,
    ]);
  }

  async end(id: string): Promise<void> {
    await this.db.runAsync('UPDATE tracking_sessions SET ended_at=?, updated_at=? WHERE id=?', [
      this.now(),
      this.now(),
      id,
    ]);
  }

  /** Close any session left open (e.g. by a crash) other than `keepId`. */
  async endAllExcept(keepId: string | null): Promise<void> {
    await this.db.runAsync(
      'UPDATE tracking_sessions SET ended_at=? WHERE ended_at IS NULL AND id IS NOT ?',
      [this.now(), keepId],
    );
  }
}

// --- Settings ----------------------------------------------------------------

export class SettingsRepository {
  constructor(private db: SqlDb) {}

  async load(): Promise<AppSettings> {
    const row = await this.db.getFirstAsync<{ value: string }>(
      "SELECT value FROM settings WHERE key='app_settings'",
      [],
    );
    if (!row) return mergeSettings(null);
    try {
      return mergeSettings(JSON.parse(row.value));
    } catch {
      return mergeSettings(null); // corrupted JSON: fall back to defaults rather than crash
    }
  }

  async save(settings: AppSettings): Promise<void> {
    await this.db.runAsync(
      "INSERT INTO settings (key, value) VALUES ('app_settings', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify(settings)],
    );
  }

  async getFlag(key: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key=?', [key]);
    return row?.value ?? null;
  }

  async setFlag(key: string, value: string): Promise<void> {
    await this.db.runAsync(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, value],
    );
  }
}

/**
 * Wipe all user data (checkpoints, history, sessions, packages, settings).
 * The first-run seed flag is kept so placeholder checkpoints do not reappear.
 */
export async function deleteAllData(db: SqlDb): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync('DELETE FROM trigger_history');
    await db.execAsync('DELETE FROM tracking_sessions');
    await db.execAsync('DELETE FROM checkpoints');
    await db.execAsync('DELETE FROM map_packages');
    await db.execAsync("DELETE FROM settings WHERE key NOT LIKE 'seeded_%'");
  });
}
