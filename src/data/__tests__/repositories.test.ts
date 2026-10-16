import { DEFAULT_SETTINGS } from '../../config/settings';
import { SqlJsDb } from '../../testing/sqlJsDb';
import { getSchemaVersion, LATEST_SCHEMA_VERSION, migrate, MIGRATIONS, type Migration } from '../migrations';
import {
  CheckpointRepository,
  deleteAllData,
  MapPackageRepository,
  SessionRepository,
  SettingsRepository,
  TriggerHistoryRepository,
  ValidationError,
} from '../repositories';
import { seedIfFirstRun } from '../seed';

let n = 0;
const newId = () => `id-${++n}`;
const opts = { duplicateDistanceM: 5, exitHysteresisM: 10 };
const base = {
  latitude: 19.22,
  longitude: 73.07,
  triggerRadiusM: 20,
  priority: 0,
  audioUri: 'melody:chime',
  audioLabel: 'Chime',
  enabled: true,
  floor: null,
  altitudeM: null,
  coordinatesVerified: true,
};

async function freshDb() {
  const db = await SqlJsDb.create();
  await migrate(db);
  return db;
}

describe('migrations', () => {
  it('creates the schema and is idempotent', async () => {
    const db = await SqlJsDb.create();
    expect(await getSchemaVersion(db)).toBe(0);
    expect(await migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(await migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
    );
    expect(tables.map((t) => t.name)).toEqual([
      'checkpoints',
      'map_packages',
      'settings',
      'tracking_sessions',
      'trigger_history',
    ]);
  });

  it('applies later migrations on top of existing data', async () => {
    const db = await freshDb();
    const repo = new CheckpointRepository(db, newId);
    await repo.save({ ...base, name: 'Swing' }, opts);
    const v2: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      description: 'test: add note column',
      statements: ['ALTER TABLE checkpoints ADD COLUMN note TEXT'],
    };
    expect(await migrate(db, [...MIGRATIONS, v2])).toBe(LATEST_SCHEMA_VERSION + 1);
    expect((await repo.list()).map((c) => c.name)).toEqual(['Swing']);
  });

  it('rolls back a failing migration and leaves the version unchanged', async () => {
    const db = await freshDb();
    const bad: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      description: 'broken',
      statements: ['ALTER TABLE checkpoints ADD COLUMN ok TEXT', 'THIS IS NOT SQL'],
    };
    await expect(migrate(db, [...MIGRATIONS, bad])).rejects.toThrow();
    expect(await getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(checkpoints)', []);
    expect(cols.map((c) => c.name)).not.toContain('ok');
  });

  it('refuses a database from a newer app version', async () => {
    const db = await freshDb();
    await db.execAsync('PRAGMA user_version = 99');
    await expect(migrate(db)).rejects.toThrow(/newer/);
  });
});

describe('CheckpointRepository', () => {
  it('persists checkpoints across "restarts" (new repository on the same database)', async () => {
    const db = await freshDb();
    await new CheckpointRepository(db, newId).save({ ...base, name: 'Swing' }, opts);
    const again = new CheckpointRepository(db, newId);
    const list = await again.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Swing', triggerRadiusM: 20, enabled: true, audioUri: 'melody:chime' });
  });

  it('prevents duplicate names and near-duplicate locations', async () => {
    const db = await freshDb();
    const repo = new CheckpointRepository(db, newId);
    await repo.save({ ...base, name: 'Swing' }, opts);
    await expect(repo.save({ ...base, name: 'SWING', latitude: 19.23 }, opts)).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.save({ ...base, name: 'Other' }, opts)).rejects.toThrow(/within 5 m/);
    await repo.save({ ...base, name: 'Other' }, { ...opts, allowNearDuplicate: true });
    expect(await repo.list()).toHaveLength(2);
  });

  it('the database itself rejects duplicate names even if validation is bypassed', async () => {
    const db = await freshDb();
    const repo = new CheckpointRepository(db, newId);
    await repo.save({ ...base, name: 'Swing' }, opts);
    await expect(
      db.runAsync(
        `INSERT INTO checkpoints (id,name,latitude,longitude,trigger_radius_m,created_at,updated_at)
         VALUES ('x','swing',1,1,20,0,0)`,
        [],
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('updates, toggles, reassigns audio and deletes', async () => {
    const db = await freshDb();
    const repo = new CheckpointRepository(db, newId);
    const cp = await repo.save({ ...base, name: 'Swing' }, opts);
    await repo.save({ ...base, id: cp.id, name: 'Swing', triggerRadiusM: 25 }, opts);
    await repo.setEnabled(cp.id, false);
    await repo.setAudio(cp.id, 'file:///a.mp3', 'a.mp3');
    const got = await repo.get(cp.id);
    expect(got).toMatchObject({ triggerRadiusM: 25, enabled: false, audioUri: 'file:///a.mp3' });
    expect(await repo.isAudioReferenced('file:///a.mp3')).toBe(true);
    await repo.delete(cp.id);
    expect(await repo.get(cp.id)).toBeNull();
  });
});

describe('history, sessions, packages, settings', () => {
  it('records trigger history and cascades on checkpoint delete', async () => {
    const db = await freshDb();
    const cps = new CheckpointRepository(db, newId);
    const sessions = new SessionRepository(db);
    const hist = new TriggerHistoryRepository(db);
    const cp = await cps.save({ ...base, name: 'Swing' }, opts);
    await sessions.start('s1', 'gnss');
    const hid = await hist.record({
      checkpointId: cp.id,
      sessionId: 's1',
      triggeredAt: 1000,
      playbackStatus: 'triggered',
      distanceM: 4,
      accuracyM: 5,
    });
    await hist.updateStatus(hid, 'completed');
    expect(await hist.recent()).toEqual([expect.objectContaining({ checkpointName: 'Swing', playbackStatus: 'completed' })]);
    await cps.delete(cp.id);
    expect(await hist.recent()).toEqual([]);
  });

  it('tracks an active session and its snapshot', async () => {
    const db = await freshDb();
    const s = new SessionRepository(db);
    await s.start('s1', 'gnss');
    await s.saveSnapshot('s1', '{"x":1}');
    expect(await s.active()).toMatchObject({ id: 's1', engineSnapshot: '{"x":1}' });
    await s.end('s1');
    expect(await s.active()).toBeNull();
  });

  it('only reports a map package usable once complete and verified', async () => {
    const db = await freshDb();
    const repo = new MapPackageRepository(db, newId);
    const p = await repo.create({
      name: 'Park',
      localPath: null,
      offlinePackId: null,
      styleUrl: 'https://example/style.json',
      bounds: { west: 1, south: 2, east: 3, north: 4 },
      minZoom: 13,
      maxZoom: 18,
      downloadStatus: 'downloading',
    });
    expect(await repo.findUsable()).toBeNull();
    await repo.updateStatus(p.id, { downloadStatus: 'complete', progress: 100 });
    expect(await repo.findUsable()).toBeNull(); // complete but not verified
    await repo.updateStatus(p.id, { downloadStatus: 'complete', verified: true });
    expect((await repo.findUsable())?.id).toBe(p.id);
  });

  it('settings round-trip and survive corrupted JSON', async () => {
    const db = await freshDb();
    const repo = new SettingsRepository(db);
    expect(await repo.load()).toEqual(DEFAULT_SETTINGS);
    await repo.save({ ...DEFAULT_SETTINGS, defaultRadiusM: 30 });
    expect((await repo.load()).defaultRadiusM).toBe(30);
    await db.runAsync("UPDATE settings SET value='{not json' WHERE key='app_settings'", []);
    expect(await repo.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('seeds Swing and Ground once, flagged unverified, and deleteAllData does not re-seed', async () => {
    const db = await freshDb();
    const cps = new CheckpointRepository(db, newId);
    const settings = new SettingsRepository(db);
    expect(await seedIfFirstRun(cps, settings)).toBe(true);
    expect(await seedIfFirstRun(cps, settings)).toBe(false);
    const list = await cps.list();
    expect(list.map((c) => c.name).sort()).toEqual(['Ground', 'Swing']);
    expect(list.every((c) => !c.coordinatesVerified && c.triggerRadiusM === 20)).toBe(true);
    await deleteAllData(db);
    expect(await cps.list()).toEqual([]);
    expect(await seedIfFirstRun(cps, settings)).toBe(false);
  });
});
