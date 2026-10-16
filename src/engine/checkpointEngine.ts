import { distanceM } from './geo';
import { accuracyQuality, classifySample } from './sampleFilter';
import {
  DEFAULT_ENGINE_CONFIG,
  type CheckpointRuntime,
  type EngineCheckpoint,
  type EngineConfig,
  type EngineEvent,
  type EngineSnapshot,
  type EngineStatus,
  type LocationSample,
  type ProcessResult,
  type SampleQuality,
} from './types';

const HISTORY_SIZE = 20;

function freshRuntime(atMs: number): CheckpointRuntime {
  return {
    state: 'OUTSIDE',
    stateSinceMs: atMs,
    candidateCount: 0,
    candidateSinceMs: null,
    lastSupportMs: null,
    triggeredAtMs: null,
    outsideCount: 0,
    outsideSinceMs: null,
    exitNotified: false,
    lastDistanceM: null,
    lastInside: false,
  };
}

/**
 * Per-checkpoint state machine:
 *
 *   OUTSIDE --good fix inside radius--> CANDIDATE
 *   CANDIDATE --N consecutive good inside fixes (+ dwell)--> TRIGGERED   (emits 'trigger')
 *   CANDIDATE --good fix outside radius / confident exit / timeout--> OUTSIDE
 *   TRIGGERED --audio started--> PLAYING
 *   TRIGGERED|PLAYING --audio finished/failed/timeout--> COOLDOWN
 *   COOLDOWN --M consecutive confident-outside fixes, min time outside, cooldown elapsed--> OUTSIDE ('rearmed')
 *
 * "Inside" = good-accuracy fix with distance <= radius.
 * "Confidently outside" = distance > radius + hysteresis for a good fix, or
 *   distance - accuracy > radius + hysteresis for any fix with known accuracy
 *   (even a poor fix can prove you are far away).
 * Exit observations are counted during TRIGGERED/PLAYING too, so a user who
 * walks away mid-playback rearms as soon as playback ends.
 */
export class CheckpointEngine {
  private config: EngineConfig;
  private checkpoints = new Map<string, EngineCheckpoint>();
  private runtime = new Map<string, CheckpointRuntime>();
  private lastAccepted: LocationSample | null = null;
  private history: LocationSample[] = [];
  private consecutiveOutliers = 0;
  private lastQuality: SampleQuality | null = null;

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
  }

  getConfig(): EngineConfig {
    return this.config;
  }

  setConfig(partial: Partial<EngineConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** Replace the active (enabled) checkpoint set, keeping state for unchanged ones. */
  setCheckpoints(list: EngineCheckpoint[], atMs = 0): void {
    const next = new Map(list.map((c) => [c.id, c]));
    for (const id of [...this.runtime.keys()]) {
      if (!next.has(id)) this.runtime.delete(id);
    }
    for (const cp of list) {
      const prev = this.checkpoints.get(cp.id);
      const rt = this.runtime.get(cp.id);
      const geometryChanged =
        prev != null &&
        (prev.latitude !== cp.latitude ||
          prev.longitude !== cp.longitude ||
          prev.radiusM !== cp.radiusM ||
          prev.floor !== cp.floor);
      if (!rt) {
        this.runtime.set(cp.id, freshRuntime(atMs));
      } else if (geometryChanged && rt.state !== 'TRIGGERED' && rt.state !== 'PLAYING') {
        this.runtime.set(cp.id, freshRuntime(atMs));
      }
    }
    this.checkpoints = next;
  }

  getCheckpoints(): EngineCheckpoint[] {
    return [...this.checkpoints.values()];
  }

  getHistory(): readonly LocationSample[] {
    return this.history;
  }

  process(sample: LocationSample, nowMs: number): ProcessResult {
    let quality = classifySample(sample, this.lastAccepted, nowMs, this.config);

    if (quality === 'outlier') {
      this.consecutiveOutliers++;
      if (this.consecutiveOutliers < this.config.outlierResetCount) {
        this.lastQuality = quality;
        return { quality, accepted: false, events: this.applyTimeouts(nowMs) };
      }
      // Several consecutive "jumps" agree with each other more than with the old fix:
      // accept the new position as genuine (e.g. GNSS re-acquired after signal loss).
      quality = accuracyQuality(sample, this.config);
    }
    if (quality !== 'good' && quality !== 'low_accuracy') {
      this.lastQuality = quality;
      return { quality, accepted: false, events: this.applyTimeouts(nowMs) };
    }

    this.consecutiveOutliers = 0;
    this.lastQuality = quality;
    this.lastAccepted = sample;
    this.history.push(sample);
    if (this.history.length > HISTORY_SIZE) this.history.shift();

    const events: EngineEvent[] = [];
    const t = sample.timestampMs;
    for (const cp of this.checkpoints.values()) {
      this.observe(cp, sample, quality === 'good', t, events);
    }
    events.push(...this.applyTimeouts(nowMs));
    events.push(...this.fireReadyCandidates(t));
    return { quality, accepted: true, events };
  }

  /** Advance time-based transitions when no fixes arrive (e.g. GPS signal lost). */
  tick(nowMs: number): EngineEvent[] {
    return this.applyTimeouts(nowMs);
  }

  markPlaybackStarted(checkpointId: string, atMs: number): void {
    const rt = this.runtime.get(checkpointId);
    if (rt && rt.state === 'TRIGGERED') this.setState(rt, 'PLAYING', atMs);
  }

  /**
   * Audio for this checkpoint ended (completed, stopped, failed, missing, ignored).
   * Returns any events caused by freeing the audio channel (waiting candidates may fire).
   */
  markPlaybackFinished(checkpointId: string, atMs: number): EngineEvent[] {
    const events: EngineEvent[] = [];
    const rt = this.runtime.get(checkpointId);
    if (rt && (rt.state === 'TRIGGERED' || rt.state === 'PLAYING')) {
      this.setState(rt, 'COOLDOWN', atMs);
      this.tryRearm(checkpointId, rt, atMs, events);
    }
    events.push(...this.fireReadyCandidates(atMs));
    return events;
  }

  /**
   * Called after a process restart. Anything mid-playback is treated as already
   * heard (no replay while the user is still there); half-confirmed candidates
   * are dropped because their evidence is stale.
   */
  recoverAfterInterruption(atMs: number): void {
    for (const rt of this.runtime.values()) {
      if (rt.state === 'TRIGGERED' || rt.state === 'PLAYING') this.setState(rt, 'COOLDOWN', atMs);
      else if (rt.state === 'CANDIDATE') this.resetToOutside(rt, atMs);
    }
  }

  getStatus(): EngineStatus {
    let active: string | null = null;
    const checkpoints = [...this.checkpoints.values()].map((cp) => {
      const rt = this.runtime.get(cp.id)!;
      if (rt.state === 'PLAYING' || (rt.state === 'TRIGGERED' && active == null)) active = cp.id;
      return {
        id: cp.id,
        name: cp.name,
        state: rt.state,
        distanceM: rt.lastDistanceM,
        candidateCount: rt.candidateCount,
        inside: rt.lastInside,
      };
    });
    return {
      lastQuality: this.lastQuality,
      lastSample: this.lastAccepted,
      lowConfidence: this.lastQuality === 'low_accuracy',
      activeCheckpointId: active,
      checkpoints,
    };
  }

  getRuntime(checkpointId: string): CheckpointRuntime | undefined {
    const rt = this.runtime.get(checkpointId);
    return rt ? { ...rt } : undefined;
  }

  snapshot(): EngineSnapshot {
    const runtime: Record<string, CheckpointRuntime> = {};
    for (const [id, rt] of this.runtime) runtime[id] = { ...rt };
    return {
      version: 1,
      runtime,
      lastAccepted: this.lastAccepted,
      consecutiveOutliers: this.consecutiveOutliers,
    };
  }

  /** Restore persisted state. Call setCheckpoints first; unknown ids are ignored. */
  restore(snapshot: EngineSnapshot): void {
    if (snapshot.version !== 1) return;
    for (const [id, rt] of Object.entries(snapshot.runtime)) {
      if (this.checkpoints.has(id)) this.runtime.set(id, { ...rt });
    }
    this.lastAccepted = snapshot.lastAccepted;
    this.consecutiveOutliers = snapshot.consecutiveOutliers;
  }

  reset(atMs = 0): void {
    for (const id of this.runtime.keys()) this.runtime.set(id, freshRuntime(atMs));
    this.lastAccepted = null;
    this.history = [];
    this.consecutiveOutliers = 0;
    this.lastQuality = null;
  }

  // --- internals -----------------------------------------------------------

  private observe(
    cp: EngineCheckpoint,
    sample: LocationSample,
    good: boolean,
    t: number,
    events: EngineEvent[],
  ): void {
    const rt = this.runtime.get(cp.id)!;
    const d = distanceM(cp, sample);
    const exitRadius = cp.radiusM + this.config.exitHysteresisM;
    const floorKnown = sample.floor != null && cp.floor != null;
    const floorMismatch = floorKnown && sample.floor !== cp.floor;

    const inside = good && d <= cp.radiusM && !floorMismatch && this.altitudeOk(cp, sample);
    const confidentlyOutside =
      floorMismatch ||
      (good && d > exitRadius) ||
      (sample.accuracyM != null && d - sample.accuracyM > exitRadius);
    // A good fix inside the exit band is clear evidence the user has not left yet.
    const clearlyNotOutside = good && d <= exitRadius && !floorMismatch;

    rt.lastDistanceM = d;
    rt.lastInside = inside;

    switch (rt.state) {
      case 'OUTSIDE':
        if (inside) {
          this.setState(rt, 'CANDIDATE', t);
          rt.candidateCount = 1;
          rt.candidateSinceMs = t;
          rt.lastSupportMs = t;
        }
        break;
      case 'CANDIDATE':
        if (inside) {
          rt.candidateCount++;
          rt.lastSupportMs = t;
        } else if ((good && d > cp.radiusM) || confidentlyOutside) {
          this.resetToOutside(rt, t);
        }
        // Low-accuracy fixes that don't prove an exit neither add nor remove evidence.
        break;
      case 'TRIGGERED':
      case 'PLAYING':
      case 'COOLDOWN':
        if (confidentlyOutside) {
          if (rt.outsideCount === 0) rt.outsideSinceMs = t;
          rt.outsideCount++;
          if (!rt.exitNotified) {
            rt.exitNotified = true;
            events.push({ type: 'exit', checkpointId: cp.id, atMs: t });
          }
        } else if (clearlyNotOutside) {
          rt.outsideCount = 0;
          rt.outsideSinceMs = null;
        }
        if (rt.state === 'COOLDOWN') this.tryRearm(cp.id, rt, t, events);
        break;
    }
  }

  private altitudeOk(cp: EngineCheckpoint, sample: LocationSample): boolean {
    const tol = this.config.altitudeToleranceM;
    if (tol == null || cp.altitudeM == null || sample.altitudeM == null) return true;
    // Without a vertical accuracy estimate GNSS altitude is not meaningful enough to reject on.
    if (sample.altitudeAccuracyM == null) return true;
    return Math.abs(sample.altitudeM - cp.altitudeM) <= tol + sample.altitudeAccuracyM;
  }

  private tryRearm(id: string, rt: CheckpointRuntime, t: number, events: EngineEvent[]): void {
    if (rt.state !== 'COOLDOWN') return;
    if (rt.outsideCount < this.config.rearmOutsideSamples || rt.outsideSinceMs == null) return;
    if (t - rt.outsideSinceMs < this.config.rearmMinOutsideMs) return;
    if (rt.triggeredAtMs != null && t - rt.triggeredAtMs < this.config.cooldownMs) return;
    this.resetToOutside(rt, t);
    events.push({ type: 'rearmed', checkpointId: id, atMs: t });
  }

  private applyTimeouts(nowMs: number): EngineEvent[] {
    const events: EngineEvent[] = [];
    for (const [id, rt] of this.runtime) {
      if (
        rt.state === 'CANDIDATE' &&
        rt.lastSupportMs != null &&
        nowMs - rt.lastSupportMs > this.config.candidateTimeoutMs
      ) {
        this.resetToOutside(rt, nowMs);
      } else if (
        (rt.state === 'TRIGGERED' && nowMs - rt.stateSinceMs > this.config.triggerAckTimeoutMs) ||
        (rt.state === 'PLAYING' && nowMs - rt.stateSinceMs > this.config.maxPlaybackMs)
      ) {
        this.setState(rt, 'COOLDOWN', nowMs);
        this.tryRearm(id, rt, nowMs, events);
      } else if (rt.state === 'COOLDOWN') {
        this.tryRearm(id, rt, nowMs, events);
      }
    }
    return events;
  }

  private isReady(rt: CheckpointRuntime, atMs: number): boolean {
    return (
      rt.state === 'CANDIDATE' &&
      rt.candidateCount >= this.config.entryConfirmSamples &&
      rt.candidateSinceMs != null &&
      rt.lastSupportMs != null &&
      rt.lastSupportMs - rt.candidateSinceMs >= this.config.entryDwellMs &&
      atMs - rt.lastSupportMs <= this.config.candidateTimeoutMs
    );
  }

  private isBusy(): boolean {
    for (const rt of this.runtime.values()) {
      if (rt.state === 'TRIGGERED' || rt.state === 'PLAYING') return true;
    }
    return false;
  }

  /** Precedence: higher priority, then nearer, then id (stable). */
  private compare(a: EngineCheckpoint, b: EngineCheckpoint): number {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const da = this.runtime.get(a.id)!.lastDistanceM ?? Infinity;
    const db = this.runtime.get(b.id)!.lastDistanceM ?? Infinity;
    if (da !== db) return da - db;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  private fireReadyCandidates(atMs: number): EngineEvent[] {
    const ready = [...this.checkpoints.values()]
      .filter((cp) => this.isReady(this.runtime.get(cp.id)!, atMs))
      .sort((a, b) => this.compare(a, b));
    if (ready.length === 0) return [];

    const chosen =
      this.config.overlapPolicy === 'independent' ? ready : this.isBusy() ? [] : [ready[0]];
    // Unchosen candidates stay CANDIDATE with their evidence intact and fire once the channel frees up.
    return chosen.map((cp) => {
      const rt = this.runtime.get(cp.id)!;
      this.setState(rt, 'TRIGGERED', atMs);
      rt.triggeredAtMs = atMs;
      rt.candidateCount = 0;
      rt.candidateSinceMs = null;
      rt.outsideCount = 0;
      rt.outsideSinceMs = null;
      rt.exitNotified = false;
      return {
        type: 'trigger' as const,
        checkpointId: cp.id,
        atMs,
        distanceM: rt.lastDistanceM ?? 0,
        accuracyM: this.lastAccepted?.accuracyM ?? null,
      };
    });
  }

  private setState(rt: CheckpointRuntime, state: CheckpointRuntime['state'], atMs: number): void {
    rt.state = state;
    rt.stateSinceMs = atMs;
  }

  private resetToOutside(rt: CheckpointRuntime, atMs: number): void {
    const { lastDistanceM, lastInside } = rt;
    Object.assign(rt, freshRuntime(atMs), { lastDistanceM, lastInside });
  }
}
