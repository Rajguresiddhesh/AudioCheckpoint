/**
 * Single-channel audio arbiter. Guarantees at most one active player, applies
 * the playback policy when a new checkpoint fires during playback, and reports
 * exactly one onFinished per request (with onStarted only if it actually played).
 * Platform playback lives behind AudioBackend so this logic is unit-testable.
 */

export type PlaybackPolicy =
  /** Stop current audio and play the new checkpoint immediately. */
  | 'interrupt'
  /** Play the new checkpoint after the current one finishes. */
  | 'queue'
  /** Drop the new checkpoint's audio while something is playing. */
  | 'ignore';

export type FinishReason =
  | 'completed'
  | 'stopped'
  | 'interrupted'
  | 'superseded'
  | 'ignored'
  | 'missing'
  | 'error';

export interface AudioRequest {
  checkpointId: string;
  label: string;
  /** Playable local URI, or null when the checkpoint has no audio assigned. */
  uri: string | null;
}

export interface PlaybackHandle {
  stop(): void;
  pause(): void;
  resume(): void;
}

export interface AudioBackend {
  start(
    uri: string,
    callbacks: { onFinish: () => void; onError: (message: string) => void },
  ): Promise<PlaybackHandle>;
}

export interface AudioState {
  status: 'idle' | 'playing' | 'paused';
  current: AudioRequest | null;
  queue: AudioRequest[];
  lastError: string | null;
}

export interface AudioListener {
  onStarted?(req: AudioRequest): void;
  onFinished?(req: AudioRequest, reason: FinishReason, detail?: string): void;
  onStateChange?(state: AudioState): void;
}

const MAX_QUEUE = 5;

export class AudioManager {
  private current: { req: AudioRequest; handle: PlaybackHandle; token: number } | null = null;
  private paused = false;
  private queue: AudioRequest[] = [];
  private lastError: string | null = null;
  private token = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<AudioListener>();

  constructor(
    private backend: AudioBackend,
    private fileExists: (uri: string) => Promise<boolean>,
    private policy: PlaybackPolicy = 'queue',
  ) {}

  setPolicy(policy: PlaybackPolicy): void {
    this.policy = policy;
  }

  addListener(l: AudioListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  getState(): AudioState {
    return {
      status: this.current ? (this.paused ? 'paused' : 'playing') : 'idle',
      current: this.current?.req ?? null,
      queue: [...this.queue],
      lastError: this.lastError,
    };
  }

  /** Request playback according to the current policy. */
  play(req: AudioRequest): Promise<'started' | 'queued' | 'ignored' | 'missing' | 'error'> {
    return this.serial(async () => {
      if (this.current) {
        if (this.policy === 'ignore') {
          this.finish(req, 'ignored');
          return 'ignored';
        }
        if (this.policy === 'queue') {
          const dup = this.queue.findIndex((q) => q.checkpointId === req.checkpointId);
          if (dup >= 0) this.finish(this.queue.splice(dup, 1)[0], 'superseded');
          if (this.queue.length >= MAX_QUEUE) this.finish(this.queue.shift()!, 'superseded');
          this.queue.push(req);
          this.emitState();
          return 'queued';
        }
        this.stopCurrent('interrupted');
      }
      return this.startNow(req);
    });
  }

  /** Immediate preview (Creator Mode): always interrupts and clears the queue. */
  preview(req: AudioRequest): Promise<'started' | 'missing' | 'error'> {
    return this.serial(async () => {
      this.clearQueue();
      this.stopCurrent('interrupted');
      const r = await this.startNow(req);
      return r === 'started' ? 'started' : r;
    });
  }

  stop(): Promise<void> {
    return this.serial(async () => {
      this.clearQueue();
      this.stopCurrent('stopped');
    });
  }

  /** Stop only if the given checkpoint is playing (used for stop-on-exit). Queued audio continues. */
  stopIfCurrent(checkpointId: string): Promise<void> {
    return this.serial(async () => {
      if (this.current?.req.checkpointId === checkpointId) {
        this.stopCurrent('stopped');
        await this.startNext();
      }
    });
  }

  pause(): void {
    if (this.current && !this.paused) {
      this.current.handle.pause();
      this.paused = true;
      this.emitState();
    }
  }

  resume(): void {
    if (this.current && this.paused) {
      this.current.handle.resume();
      this.paused = false;
      this.emitState();
    }
  }

  // --- internals -----------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async startNow(req: AudioRequest): Promise<'started' | 'missing' | 'error'> {
    if (!req.uri) {
      this.lastError = `No audio assigned to "${req.label}".`;
      this.finish(req, 'missing', this.lastError);
      return 'missing';
    }
    let exists = false;
    try {
      exists = await this.fileExists(req.uri);
    } catch {
      exists = false;
    }
    if (!exists) {
      this.lastError = `Audio file for "${req.label}" is missing.`;
      this.finish(req, 'missing', this.lastError);
      return 'missing';
    }

    const token = ++this.token;
    try {
      const handle = await this.backend.start(req.uri, {
        onFinish: () => this.onBackendEnd(token, 'completed'),
        onError: (m) => this.onBackendEnd(token, 'error', m),
      });
      if (token !== this.token) {
        // Superseded while loading (should not happen given serialisation, but be safe).
        handle.stop();
        return 'error';
      }
      this.current = { req, handle, token };
      this.paused = false;
      this.lastError = null;
      for (const l of this.listeners) l.onStarted?.(req);
      this.emitState();
      return 'started';
    } catch (e) {
      this.lastError = `Could not play "${req.label}": ${e instanceof Error ? e.message : String(e)}`;
      this.finish(req, 'error', this.lastError);
      return 'error';
    }
  }

  private onBackendEnd(token: number, reason: 'completed' | 'error', detail?: string): void {
    void this.serial(async () => {
      if (!this.current || this.current.token !== token) return; // stale callback
      const { req, handle } = this.current;
      this.current = null;
      this.paused = false;
      try {
        handle.stop();
      } catch {
        // already released
      }
      if (reason === 'error') this.lastError = detail ?? 'Playback error';
      this.finish(req, reason, detail);
      await this.startNext();
    });
  }

  private async startNext(): Promise<void> {
    while (!this.current && this.queue.length > 0) {
      await this.startNow(this.queue.shift()!);
    }
    this.emitState();
  }

  private stopCurrent(reason: FinishReason): void {
    if (!this.current) return;
    const { req, handle } = this.current;
    this.current = null;
    this.paused = false;
    this.token++; // invalidate callbacks from the stopped player
    try {
      handle.stop();
    } catch {
      // ignore
    }
    this.finish(req, reason);
  }

  private clearQueue(): void {
    const dropped = this.queue;
    this.queue = [];
    for (const q of dropped) this.finish(q, 'stopped');
  }

  private finish(req: AudioRequest, reason: FinishReason, detail?: string): void {
    for (const l of this.listeners) l.onFinished?.(req, reason, detail);
    this.emitState();
  }

  private emitState(): void {
    const s = this.getState();
    for (const l of this.listeners) l.onStateChange?.(s);
  }
}
