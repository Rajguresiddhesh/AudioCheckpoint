import * as Crypto from 'expo-crypto';
import { AudioManager } from '../audio/audioManager';
import { audioFileExists, resolvePlayableUri } from '../audio/audioFiles';
import { configureAudioSession, ExpoAudioBackend } from '../audio/expoAudioBackend';
import { openAppDatabase } from '../data/database';
import {
  CheckpointRepository,
  MapPackageRepository,
  SessionRepository,
  SettingsRepository,
  TriggerHistoryRepository,
} from '../data/repositories';
import { seedIfFirstRun } from '../data/seed';
import type { SqlDb } from '../data/sqlDb';
import { CheckpointEngine } from '../engine/checkpointEngine';
import { TrackingController } from './trackingController';

export interface Services {
  db: SqlDb;
  checkpoints: CheckpointRepository;
  mapPackages: MapPackageRepository;
  history: TriggerHistoryRepository;
  sessions: SessionRepository;
  settings: SettingsRepository;
  audio: AudioManager;
  controller: TrackingController;
}

let servicesPromise: Promise<Services> | null = null;

/**
 * Process-wide singleton shared by the UI and the background location task.
 * In a headless start (OS relaunched the service), the first task invocation
 * builds it and the controller resumes the open session from SQLite.
 */
export function getServices(): Promise<Services> {
  if (!servicesPromise) {
    servicesPromise = createServices().catch((e) => {
      servicesPromise = null;
      throw e;
    });
  }
  return servicesPromise;
}

async function createServices(): Promise<Services> {
  const db = await openAppDatabase();
  const newId = () => Crypto.randomUUID();
  const checkpoints = new CheckpointRepository(db, newId);
  const mapPackages = new MapPackageRepository(db, newId);
  const history = new TriggerHistoryRepository(db);
  const sessions = new SessionRepository(db);
  const settings = new SettingsRepository(db);
  await seedIfFirstRun(checkpoints, settings);

  try {
    await configureAudioSession();
  } catch {
    // Non-fatal: playback still works in the foreground.
  }
  const loaded = await settings.load();
  const audio = new AudioManager(new ExpoAudioBackend(), audioFileExists, loaded.playbackPolicy);
  const controller = new TrackingController({
    engine: new CheckpointEngine(loaded.engine),
    audio,
    checkpoints,
    history,
    sessions,
    settings,
    resolveAudioUri: resolvePlayableUri,
    newId,
    now: Date.now,
  });
  await controller.init();
  return { db, checkpoints, mapPackages, history, sessions, settings, audio, controller };
}
