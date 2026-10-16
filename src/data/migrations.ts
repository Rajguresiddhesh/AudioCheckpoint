import type { SqlDb } from './sqlDb';

export interface Migration {
  version: number;
  description: string;
  statements: string[];
}

/**
 * Append-only list. Never edit a shipped migration; add a new version instead.
 * The applied version is tracked in SQLite's PRAGMA user_version.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema',
    statements: [
      `CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
        longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
        trigger_radius_m REAL NOT NULL CHECK (trigger_radius_m > 0),
        audio_uri TEXT,
        audio_label TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        floor INTEGER,
        altitude_m REAL,
        coordinates_verified INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_checkpoints_name ON checkpoints (name COLLATE NOCASE)`,
      `CREATE TABLE map_packages (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        local_path TEXT,
        offline_pack_id TEXT,
        style_url TEXT,
        west REAL NOT NULL,
        south REAL NOT NULL,
        east REAL NOT NULL,
        north REAL NOT NULL,
        min_zoom REAL NOT NULL,
        max_zoom REAL NOT NULL,
        download_status TEXT NOT NULL CHECK (download_status IN
          ('pending','downloading','complete','incomplete','failed','missing')),
        progress REAL NOT NULL DEFAULT 0,
        size_bytes INTEGER,
        verified_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE tracking_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        source TEXT NOT NULL,
        engine_snapshot TEXT,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE trigger_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        checkpoint_id TEXT NOT NULL REFERENCES checkpoints (id) ON DELETE CASCADE,
        session_id TEXT REFERENCES tracking_sessions (id) ON DELETE SET NULL,
        triggered_at INTEGER NOT NULL,
        playback_status TEXT NOT NULL,
        distance_m REAL,
        accuracy_m REAL
      )`,
      `CREATE INDEX idx_trigger_history_time ON trigger_history (triggered_at DESC)`,
      `CREATE TABLE settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export async function getSchemaVersion(db: SqlDb): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version', []);
  return row?.user_version ?? 0;
}

/**
 * Apply pending migrations, each inside its own transaction together with the
 * user_version bump so a crash can never leave a half-applied version.
 * Refuses to open a database created by a newer app version.
 */
export async function migrate(db: SqlDb, migrations: Migration[] = MIGRATIONS): Promise<number> {
  await db.execAsync('PRAGMA foreign_keys = ON');
  const current = await getSchemaVersion(db);
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  if (current > latest) {
    throw new Error(
      `Database schema v${current} is newer than this app supports (v${latest}). Update the app.`,
    );
  }
  for (const m of migrations) {
    if (m.version <= current) continue;
    await db.withTransactionAsync(async () => {
      for (const sql of m.statements) await db.execAsync(sql);
      await db.execAsync(`PRAGMA user_version = ${m.version}`);
    });
  }
  return getSchemaVersion(db);
}
