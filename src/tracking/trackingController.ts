import type { AudioManager, AudioRequest, AudioState, FinishReason } from '../audio/audioManager';
import type { AppSettings } from '../config/settings';
import type { Checkpoint, PlaybackStatus, TrackingSession } from '../data/models';
import type { CheckpointEngine } from '../engine/checkpointEngine';
import type { BeaconScan, EngineEvent, EngineSnapshot, EngineStatus, LocationSample } from '../engine/types';

export const PREVIEW_PREFIX = 'preview:';

export interface TrackingStatus {
  active: boolean;
  sessionId: string | null;
  source: string | null;
  engine: EngineStatus;
  audio: AudioState;
  samplesProcessed: number;
  lastEventText: string | null;
  error: string | null;
  recoveredFromInterruption: boolean;
}

export interface TrackingDeps {
  engine: CheckpointEngine;
  audio: AudioManager;
  checkpoints: { list(): Promise<Checkpoint[]> };
  history: {
    record(e: {
      checkpointId: string;
      sessionId: string | null;
      triggeredAt: number;
      playbackStatus: PlaybackStatus;
      distanceM: number | null;
      accuracyM: number | null;
      evidence: string | null;
    }): Promise<number>;
    updateStatus(id: number, status: PlaybackStatus): Promise<void>;
  };
  sessions: {
    start(id: string, source: string): Promise<void>;
    active(): Promise<TrackingSession | null>;
    saveSnapshot(id: string, snapshot: string): Promise<void>;
    end(id: string): Promise<void>;
    endAllExcept(id: string | null): Promise<void>;
  };
  settings: { load(): Promise<AppSettings> };
  /** Turn a stored audio reference into a playable local URI (generating test tones on demand). */
  resolveAudioUri(ref: string | null): Promise<string | null>;
  newId(): string;
  now(): number;
}

/**
 * Glue between position samples, the checkpoint engine, the audio manager and
 * persistence. Contains no platform code: background task, foreground UI and
 * simulator all call into the same instance.
 */
export class TrackingController {
  private initialized = false;
  private sessionId: string | null = null;
  private source: string | null = null;
  private settings: AppSettings | null = null;
  private byId = new Map<string, Checkpoint>();
  private historyIds = new Map<string, number>();
  private samplesProcessed = 0;
  private lastEventText: string | null = null;
  private error: string | null = null;
  private recovered = false;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(s: TrackingStatus) => void>();
  private snapshotCache: TrackingStatus | null = null;

  constructor(private deps: TrackingDeps) {
    deps.audio.addListener({
      onStarted: (req) => this.onAudioStarted(req),
      onFinished: (req, reason, detail) => this.onAudioFinished(req, reason, detail),
      onStateChange: () => this.publish(),
    });
  }

  subscribe(fn: (s: TrackingStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getStatus(): TrackingStatus {
    return {
      active: this.sessionId != null,
      sessionId: this.sessionId,
      source: this.source,
      engine: this.deps.engine.getStatus(),
      audio: this.deps.audio.getState(),
      samplesProcessed: this.samplesProcessed,
      lastEventText: this.lastEventText,
      error: this.error,
      recoveredFromInterruption: this.recovered,
    };
  }

  /**
   * Load settings/checkpoints and resume an interrupted session if one is still
   * open in the database (process killed while tracking). Idempotent.
   */
  init(): Promise<void> {
    return this.serial(() => this.ensureInit());
  }

  startSession(source: string): Promise<string> {
    return this.serial(async () => {
      await this.ensureInit();
      if (this.sessionId) await this.deps.sessions.end(this.sessionId);
      await this.deps.sessions.endAllExcept(null);
      const id = this.deps.newId();
      await this.deps.sessions.start(id, source);
      await this.loadConfig();
      this.deps.engine.reset(this.deps.now());
      this.sessionId = id;
      this.source = source;
      this.samplesProcessed = 0;
      this.historyIds.clear();
      this.error = null;
      this.recovered = false;
      this.lastEventText = `Tracking started (${source})`;
      this.publish();
      return id;
    });
  }

  stopSession(): Promise<void> {
    return this.serial(async () => {
      const id = this.sessionId;
      this.sessionId = null;
      this.source = null;
      await this.deps.audio.stop();
      if (id) {
        await this.deps.sessions.saveSnapshot(id, JSON.stringify(this.deps.engine.snapshot()));
        await this.deps.sessions.end(id);
      }
      this.lastEventText = 'Tracking stopped';
      this.publish();
    });
  }

  /** Feed a batch of fixes. Returns 'inactive' when no session is running (caller should stop updates). */
  handleSamples(samples: LocationSample[]): Promise<'ok' | 'inactive'> {
    return this.serial(async () => {
      await this.ensureInit();
      if (!this.sessionId) return 'inactive';
      const sorted = [...samples].sort((a, b) => a.timestampMs - b.timestampMs);
      for (const s of sorted) {
        const r = this.deps.engine.process(s, this.deps.now());
        this.samplesProcessed++;
        await this.handleEvents(r.events);
      }
      await this.persist();
      this.publish();
      return 'ok';
    });
  }

  /** Feed one BLE scan window (indoor checkpoints). Returns 'inactive' when no session is running. */
  handleBeaconScan(scan: BeaconScan): Promise<'ok' | 'inactive'> {
    return this.serial(async () => {
      await this.ensureInit();
      if (!this.sessionId) return 'inactive';
      const r = this.deps.engine.processBeaconScan(scan, this.deps.now());
      await this.handleEvents(r.events);
      if (r.accepted) await this.persist();
      this.publish();
      return 'ok';
    });
  }

  /** True when an enabled checkpoint needs BLE scans while tracking. */
  needsBeaconScans(): boolean {
    return this.deps.engine.needsBeaconScans();
  }

  /** Beacon ids of enabled BLE checkpoints (lets the scanner pick a screen-off-friendly filter). */
  beaconIds(): string[] {
    return this.deps.engine
      .getCheckpoints()
      .map((c) => c.expectedBeaconId)
      .filter((id): id is string => !!id);
  }

  /** Periodic timer while no fixes arrive (GPS loss). */
  tick(): Promise<void> {
    return this.serial(async () => {
      if (!this.sessionId) return;
      await this.handleEvents(this.deps.engine.tick(this.deps.now()));
      this.publish();
    });
  }

  reloadCheckpoints(): Promise<void> {
    return this.serial(async () => {
      await this.loadConfig();
      this.publish();
    });
  }

  reportError(message: string): void {
    this.error = message;
    this.publish();
  }

  // --- internals -----------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Must only run inside serial(). */
  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.loadConfig();
    const open = await this.deps.sessions.active();
    if (open) {
      this.sessionId = open.id;
      this.source = open.source;
      if (open.engineSnapshot) {
        try {
          this.deps.engine.restore(JSON.parse(open.engineSnapshot) as EngineSnapshot);
        } catch {
          // Corrupted snapshot: start the engine fresh rather than fail tracking.
        }
      }
      this.deps.engine.recoverAfterInterruption(this.deps.now());
      this.recovered = true;
      this.lastEventText = 'Resumed tracking session after interruption';
    }
    this.initialized = true;
    this.publish();
  }

  private async loadConfig(): Promise<void> {
    this.settings = await this.deps.settings.load();
    this.deps.engine.setConfig(this.settings.engine);
    this.deps.audio.setPolicy(this.settings.playbackPolicy);
    const all = await this.deps.checkpoints.list();
    this.byId = new Map(all.map((c) => [c.id, c]));
    this.deps.engine.setCheckpoints(
      all
        .filter((c) => c.enabled)
        .map((c) => ({
          id: c.id,
          name: c.name,
          policy: c.positioningPolicy,
          latitude: c.latitude,
          longitude: c.longitude,
          radiusM: c.triggerRadiusM,
          priority: c.priority,
          maxHorizontalAccuracyM: c.maxHorizontalAccuracyM,
          floor: c.floor,
          altitudeM: c.altitudeM,
          altitudeReference: c.altitudeReference,
          maxVerticalDifferenceM: c.maxVerticalDifferenceM,
          maxVerticalUncertaintyM: c.maxVerticalUncertaintyM,
          expectedBeaconId: c.expectedBeaconId,
          minimumBeaconRssiDbm: c.minimumBeaconRssiDbm,
          requiredBeaconObservations: c.requiredBeaconObservations,
        })),
      this.deps.now(),
    );
  }

  private async persist(): Promise<void> {
    if (!this.sessionId) return;
    await this.deps.sessions.saveSnapshot(this.sessionId, JSON.stringify(this.deps.engine.snapshot()));
  }

  private async handleEvents(events: EngineEvent[]): Promise<void> {
    for (const e of events) {
      const cp = this.byId.get(e.checkpointId);
      const name = cp?.name ?? e.checkpointId;
      if (e.type === 'trigger') {
        this.lastEventText = `Reached ${name} (${e.evidence || 'confirmed'})`;
        const historyId = await this.deps.history.record({
          checkpointId: e.checkpointId,
          sessionId: this.sessionId,
          triggeredAt: e.atMs,
          playbackStatus: 'triggered',
          distanceM: e.distanceM,
          accuracyM: e.accuracyM,
          evidence: e.evidence || null,
        });
        this.historyIds.set(e.checkpointId, historyId);
        let uri: string | null = null;
        try {
          uri = await this.deps.resolveAudioUri(cp?.audioUri ?? null);
        } catch (err) {
          this.error = `Could not prepare audio for ${name}: ${String(err)}`;
        }
        // Not awaited inside the audio chain's callbacks; play() itself is serialised.
        await this.deps.audio.play({ checkpointId: e.checkpointId, label: name, uri });
      } else if (e.type === 'exit') {
        this.lastEventText = `Left ${name}`;
        if (this.settings?.stopAudioOnExit) await this.deps.audio.stopIfCurrent(e.checkpointId);
      } else {
        this.lastEventText = `${name} rearmed`;
      }
    }
  }

  private onAudioStarted(req: AudioRequest): void {
    if (req.checkpointId.startsWith(PREVIEW_PREFIX)) return;
    void this.serial(async () => {
      this.deps.engine.markPlaybackStarted(req.checkpointId, this.deps.now());
      const hid = this.historyIds.get(req.checkpointId);
      if (hid != null) await this.deps.history.updateStatus(hid, 'playing');
      this.publish();
    });
  }

  private onAudioFinished(req: AudioRequest, reason: FinishReason, detail?: string): void {
    if (req.checkpointId.startsWith(PREVIEW_PREFIX)) return;
    void this.serial(async () => {
      if (reason === 'missing' || reason === 'error') this.error = detail ?? `Audio ${reason}`;
      const hid = this.historyIds.get(req.checkpointId);
      if (hid != null) {
        await this.deps.history.updateStatus(hid, reason);
        this.historyIds.delete(req.checkpointId);
      }
      const events = this.deps.engine.markPlaybackFinished(req.checkpointId, this.deps.now());
      if (this.sessionId) {
        await this.handleEvents(events);
        await this.persist();
      }
      this.publish();
    });
  }

  /** Cached status, stable between publishes (for React's useSyncExternalStore). */
  getSnapshot(): TrackingStatus {
    this.snapshotCache ??= this.getStatus();
    return this.snapshotCache;
  }

  private publish(): void {
    this.snapshotCache = this.getStatus();
    for (const l of this.listeners) l(this.snapshotCache);
  }
}
