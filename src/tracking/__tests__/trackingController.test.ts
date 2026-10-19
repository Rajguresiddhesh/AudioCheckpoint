import * as fs from 'fs';
import * as path from 'path';
import { AudioManager, type AudioBackend, type PlaybackHandle } from '../../audio/audioManager';
import { DEFAULT_SETTINGS } from '../../config/settings';
import { migrate } from '../../data/migrations';
import {
  CheckpointRepository,
  SessionRepository,
  SettingsRepository,
  TriggerHistoryRepository,
} from '../../data/repositories';
import { CheckpointEngine } from '../../engine/checkpointEngine';
import { destinationPoint } from '../../engine/geo';
import { demoRouteThrough, simulateRoute } from '../../engine/simulator';
import type { LocationSample } from '../../engine/types';
import { ORIGIN } from '../../testing/helpers';
import { SqlJsDb } from '../../testing/sqlJsDb';
import { TrackingController } from '../trackingController';

const T0 = 1_700_000_000_000;

/** Backend whose clips "play" until the test advances the clock past their duration. */
class ClockedBackend implements AudioBackend {
  active: { uri: string; endsAt: number; onFinish: () => void; stopped: boolean }[] = [];
  maxConcurrent = 0;
  played: string[] = [];
  constructor(
    private clock: { now: number },
    private clipMs = 3000,
  ) {}
  async start(uri: string, cb: { onFinish: () => void }): Promise<PlaybackHandle> {
    const e = { uri, endsAt: this.clock.now + this.clipMs, onFinish: cb.onFinish, stopped: false };
    this.active.push(e);
    this.played.push(uri);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active.filter((a) => !a.stopped).length);
    return {
      stop: () => {
        e.stopped = true;
      },
      pause: () => {},
      resume: () => {},
    };
  }
  advance() {
    for (const e of this.active) {
      if (!e.stopped && this.clock.now >= e.endsAt) {
        e.stopped = true;
        e.onFinish();
      }
    }
  }
}

const settle = () => new Promise((r) => setImmediate(r));
async function drain(times = 5) {
  for (let i = 0; i < times; i++) await settle();
}

async function buildWorld(db?: SqlJsDb, missingUris: string[] = []) {
  db ??= await SqlJsDb.create();
  await migrate(db);
  let id = 0;
  const clock = { now: T0 };
  const now = () => clock.now;
  const newId = () => `id-${++id}-${Math.random().toString(36).slice(2, 6)}`;
  const checkpoints = new CheckpointRepository(db, newId, now);
  const settings = new SettingsRepository(db);
  await settings.save({ ...DEFAULT_SETTINGS, engine: { ...DEFAULT_SETTINGS.engine, cooldownMs: 0 } });
  const backend = new ClockedBackend(clock);
  const audio = new AudioManager(backend, async (u) => !missingUris.includes(u), 'queue');
  const history = new TriggerHistoryRepository(db);
  const controller = new TrackingController({
    engine: new CheckpointEngine(),
    audio,
    checkpoints,
    history,
    sessions: new SessionRepository(db, now),
    settings,
    resolveAudioUri: async (ref) => (ref ? `file:///audio/${ref.replace(':', '_')}.wav` : null),
    newId,
    now,
  });
  return { db, clock, checkpoints, history, backend, audio, controller };
}

async function addSwingAndGround(checkpoints: CheckpointRepository, groundAudio: string | null = 'melody:bells') {
  const opts = { duplicateDistanceM: 5, exitHysteresisM: 10 };
  const common = {
    positioningPolicy: 'OUTDOOR_GPS' as const,
    triggerRadiusM: 20, priority: 0, enabled: true, floor: null, altitudeM: null, coordinatesVerified: true,
  };
  const swingP = destinationPoint(ORIGIN, 0, 35);
  const groundP = destinationPoint(ORIGIN, 180, 35);
  const swing = await checkpoints.save(
    { ...common, name: 'Swing', ...swingP, audioUri: 'melody:chime', audioLabel: 'Chime' },
    opts,
  );
  const ground = await checkpoints.save(
    { ...common, name: 'Ground', ...groundP, audioUri: groundAudio, audioLabel: null },
    opts,
  );
  return { swing, ground };
}

/** Replay fixes one by one with a moving clock, letting audio finish naturally. */
async function walk(w: Awaited<ReturnType<typeof buildWorld>>, fixes: LocationSample[]) {
  for (const f of fixes) {
    w.clock.now = f.timestampMs;
    w.backend.advance();
    await drain();
    await w.controller.handleSamples([f]);
    await drain();
  }
}

describe('TrackingController (simulated walk, end to end)', () => {
  it('plays each checkpoint once per visit, never overlapping, and logs history', async () => {
    const w = await buildWorld();
    const { swing, ground } = await addSwingAndGround(w.checkpoints);
    await w.controller.init();
    await w.controller.startSession('simulated');

    const route = demoRouteThrough([
      { ...swing, radiusM: swing.triggerRadiusM },
      { ...ground, radiusM: ground.triggerRadiusM },
    ]);
    const fixes = simulateRoute(route, { startMs: T0, accuracyM: 6, jitterM: 3, seed: 7 });
    await walk(w, fixes);

    // Swing, Ground, then Swing again after leaving and returning (rearm).
    expect(w.backend.played).toEqual([
      'file:///audio/melody_chime.wav',
      'file:///audio/melody_bells.wav',
      'file:///audio/melody_chime.wav',
    ]);
    expect(w.backend.maxConcurrent).toBe(1);
    const hist = await w.history.recent();
    expect(hist.map((h) => h.checkpointName).reverse()).toEqual(['Swing', 'Ground', 'Swing']);
    expect(hist.every((h) => h.playbackStatus === 'completed')).toBe(true);
  });

  it('handles missing audio gracefully: logs it, reports an error, and does not loop', async () => {
    const w = await buildWorld(undefined, ['file:///audio/melody_bells.wav']);
    const { ground } = await addSwingAndGround(w.checkpoints);
    await w.controller.init();
    await w.controller.startSession('simulated');
    const fixes = simulateRoute(
      [destinationPoint(ground, 180, 60), { ...ground, dwellMs: 30_000 }],
      { startMs: T0, accuracyM: 5 },
    );
    await walk(w, fixes);
    const hist = await w.history.recent();
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ checkpointName: 'Ground', playbackStatus: 'missing' });
    expect(w.controller.getStatus().error).toMatch(/missing/);
    expect(w.backend.played).toEqual([]);
  });

  it('a checkpoint with no audio assigned is logged as missing, not crashed on', async () => {
    const w = await buildWorld();
    const { ground } = await addSwingAndGround(w.checkpoints, null);
    await w.controller.init();
    await w.controller.startSession('simulated');
    await walk(w, simulateRoute([destinationPoint(ground, 180, 50), { ...ground, dwellMs: 5000 }], { startMs: T0 }));
    expect((await w.history.recent())[0].playbackStatus).toBe('missing');
  });

  it('mixed indoor + outdoor: floors stacked on the same lat/lon play only for the floor the user is on', async () => {
    const w = await buildWorld();
    const opts = { duplicateDistanceM: 5, exitHysteresisM: 10 };
    const common = {
      triggerRadiusM: 20, priority: 0, enabled: true, altitudeM: null, coordinatesVerified: true, ...ORIGIN,
      positioningPolicy: 'INDOOR_BLE_FLOOR' as const, minimumBeaconRssiDbm: -75, requiredBeaconObservations: 2,
    };
    const B1 = 'ibeacon:f7826da6-4fa2-4e98-8024-bc5b71e0893e:7:1';
    const B2 = 'ibeacon:f7826da6-4fa2-4e98-8024-bc5b71e0893e:7:2';
    await w.checkpoints.save({ ...common, name: 'Ground floor', floor: 0, expectedBeaconId: B1, audioUri: 'melody:chime', audioLabel: null }, opts);
    await w.checkpoints.save({ ...common, name: 'First floor', floor: 1, expectedBeaconId: B2, audioUri: 'melody:bells', audioLabel: null }, opts);
    await w.controller.init();
    await w.controller.startSession('gnss');
    expect(w.controller.needsBeaconScans()).toBe(true);

    // GPS standing exactly on the shared lat/lon: nothing may play.
    await walk(w, Array.from({ length: 6 }, (_, i) => ({ ...ORIGIN, accuracyM: 4, timestampMs: T0 + i * 1000 })));
    expect(w.backend.played).toEqual([]);

    // Beacons place the user on the first floor (ground floor beacon leaks through at -78 dBm).
    for (let i = 0; i < 3; i++) {
      w.clock.now = T0 + 10_000 + i * 2000;
      await w.controller.handleBeaconScan({
        timestampMs: w.clock.now,
        beacons: [{ id: B2, rssiDbm: -60 }, { id: B1, rssiDbm: -78 }],
      });
      await drain();
    }
    expect(w.backend.played).toEqual(['file:///audio/melody_bells.wav']);
    const [h] = await w.history.recent();
    expect(h).toMatchObject({ checkpointName: 'First floor', distanceM: null });
    expect(h.evidence).toMatch(/floor 1/);
  });

  it('ignores samples when no session is active', async () => {
    const w = await buildWorld();
    await addSwingAndGround(w.checkpoints);
    await w.controller.init();
    expect(await w.controller.handleSamples([{ ...ORIGIN, accuracyM: 5, timestampMs: T0 }])).toBe('inactive');
  });
});

describe('tracking session interruption and recovery', () => {
  it('resumes an open session after a process restart without replaying, then rearms normally', async () => {
    const db = await SqlJsDb.create();
    const w1 = await buildWorld(db);
    const { swing } = await addSwingAndGround(w1.checkpoints);
    await w1.controller.init();
    const sessionId = await w1.controller.startSession('gnss');

    // Walk into Swing; audio starts; then the process "dies" mid-playback.
    const approach = simulateRoute([destinationPoint(swing, 0, 50), { ...swing, dwellMs: 3000 }], {
      startMs: T0,
    });
    await walk(w1, approach);
    expect(w1.backend.played).toHaveLength(1);
    const tDeath = w1.clock.now;

    // New process: fresh engine/audio/controller on the same database.
    const w2 = await buildWorld(db);
    w2.clock.now = tDeath + 20_000;
    await w2.controller.init();
    const st = w2.controller.getStatus();
    expect(st.active).toBe(true);
    expect(st.sessionId).toBe(sessionId);
    expect(st.recoveredFromInterruption).toBe(true);

    // Still standing at Swing -> no replay.
    const stay = simulateRoute([{ ...swing, dwellMs: 10_000 }], { startMs: w2.clock.now + 1000 });
    await walk(w2, stay);
    expect(w2.backend.played).toEqual([]);

    // Leave and come back -> plays again.
    const t = w2.clock.now + 1000;
    const leaveReturn = simulateRoute(
      [swing, destinationPoint(swing, 0, 60), { ...swing, dwellMs: 5000 }],
      { startMs: t },
    );
    await walk(w2, leaveReturn);
    expect(w2.backend.played).toEqual(['file:///audio/melody_chime.wav']);
  });

  it('a stopped session is not resumed after restart', async () => {
    const db = await SqlJsDb.create();
    const w1 = await buildWorld(db);
    await addSwingAndGround(w1.checkpoints);
    await w1.controller.init();
    await w1.controller.startSession('gnss');
    await w1.controller.stopSession();
    const w2 = await buildWorld(db);
    await w2.controller.init();
    expect(w2.controller.getStatus().active).toBe(false);
  });
});

describe('offline operation', () => {
  it('runs a full simulated session with every network API disabled', async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest, WebSocket: g.WebSocket };
    const boom = () => {
      throw new Error('network access attempted while offline');
    };
    g.fetch = jest.fn(boom);
    g.XMLHttpRequest = jest.fn(boom);
    g.WebSocket = jest.fn(boom);
    try {
      const w = await buildWorld();
      const { swing } = await addSwingAndGround(w.checkpoints);
      await w.controller.init();
      await w.controller.startSession('simulated');
      await walk(w, simulateRoute([destinationPoint(swing, 0, 60), { ...swing, dwellMs: 8000 }], { startMs: T0 }));
      expect(w.backend.played).toEqual(['file:///audio/melody_chime.wav']);
      expect(g.fetch).not.toHaveBeenCalled();
      expect(g.XMLHttpRequest).not.toHaveBeenCalled();
      expect(g.WebSocket).not.toHaveBeenCalled();
    } finally {
      Object.assign(g, saved);
    }
  });

  it('core modules (engine, audio logic, data, tracking) contain no network calls', () => {
    const root = path.resolve(__dirname, '../..');
    const dirs = ['engine', 'audio', 'data', 'tracking'];
    const offenders: string[] = [];
    const walkDir = (d: string) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) {
          if (ent.name !== '__tests__') walkDir(p);
        } else if (/\.(ts|tsx)$/.test(ent.name)) {
          const src = fs.readFileSync(p, 'utf8');
          if (/\bfetch\s*\(|XMLHttpRequest|new WebSocket|https?:\/\//.test(src)) offenders.push(path.relative(root, p));
        }
      }
    };
    dirs.forEach((d) => walkDir(path.join(root, d)));
    expect(offenders).toEqual([]);
  });
});
