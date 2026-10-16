import { AudioManager, type AudioBackend, type FinishReason, type PlaybackHandle } from '../audioManager';

/** Fake backend that records concurrency and lets tests finish/err playback on demand. */
class FakeBackend implements AudioBackend {
  active = 0;
  maxActive = 0;
  started: string[] = [];
  private callbacks: { uri: string; onFinish: () => void; onError: (m: string) => void; stopped: boolean }[] = [];
  failUris = new Set<string>();

  async start(uri: string, cb: { onFinish: () => void; onError: (m: string) => void }): Promise<PlaybackHandle> {
    await new Promise((r) => setTimeout(r, 1)); // async load, as on device
    if (this.failUris.has(uri)) throw new Error('decoder error');
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.started.push(uri);
    const entry = { uri, ...cb, stopped: false };
    this.callbacks.push(entry);
    return {
      stop: () => {
        if (!entry.stopped) {
          entry.stopped = true;
          this.active--;
        }
      },
      pause: () => {},
      resume: () => {},
    };
  }

  /** Simulate natural end of the most recent player for uri. */
  finish(uri: string) {
    const e = [...this.callbacks].reverse().find((c) => c.uri === uri && !c.stopped);
    if (!e) throw new Error(`no active player for ${uri}`);
    e.onFinish();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 10));

function setup(policy: 'interrupt' | 'queue' | 'ignore' = 'queue', missing: string[] = []) {
  const backend = new FakeBackend();
  const exists = async (uri: string) => !missing.includes(uri);
  const mgr = new AudioManager(backend, exists, policy);
  const finished: [string, FinishReason][] = [];
  const startedIds: string[] = [];
  mgr.addListener({
    onStarted: (r) => startedIds.push(r.checkpointId),
    onFinished: (r, reason) => finished.push([r.checkpointId, reason]),
  });
  return { backend, mgr, finished, startedIds };
}

const req = (id: string, uri: string | null = `file:///${id}.wav`) => ({ checkpointId: id, label: id, uri });

describe('AudioManager', () => {
  it('reports missing audio without touching the backend', async () => {
    const { backend, mgr, finished } = setup('queue', ['file:///gone.wav']);
    expect(await mgr.play(req('a', null))).toBe('missing');
    expect(await mgr.play(req('b', 'file:///gone.wav'))).toBe('missing');
    expect(backend.started).toEqual([]);
    expect(finished).toEqual([
      ['a', 'missing'],
      ['b', 'missing'],
    ]);
    expect(mgr.getState().lastError).toMatch(/missing/);
  });

  it('reports backend load errors and stays idle', async () => {
    const { backend, mgr, finished } = setup();
    backend.failUris.add('file:///bad.wav');
    expect(await mgr.play(req('bad', 'file:///bad.wav'))).toBe('error');
    expect(finished).toEqual([['bad', 'error']]);
    expect(mgr.getState().status).toBe('idle');
  });

  it('never runs two players at once, even with concurrent play() calls (interrupt policy)', async () => {
    const { backend, mgr, finished } = setup('interrupt');
    await Promise.all([mgr.play(req('a')), mgr.play(req('b')), mgr.play(req('c'))]);
    await flush();
    expect(backend.maxActive).toBe(1);
    expect(backend.active).toBe(1);
    expect(mgr.getState().current?.checkpointId).toBe('c');
    expect(finished).toEqual([
      ['a', 'interrupted'],
      ['b', 'interrupted'],
    ]);
  });

  it('queue policy plays sequentially and dedupes queued checkpoints', async () => {
    const { backend, mgr, finished, startedIds } = setup('queue');
    expect(await mgr.play(req('a'))).toBe('started');
    expect(await mgr.play(req('b'))).toBe('queued');
    expect(await mgr.play(req('b'))).toBe('queued'); // supersedes the earlier queued b
    expect(mgr.getState().queue.map((q) => q.checkpointId)).toEqual(['b']);
    backend.finish('file:///a.wav');
    await flush();
    expect(startedIds).toEqual(['a', 'b']);
    expect(backend.maxActive).toBe(1);
    backend.finish('file:///b.wav');
    await flush();
    expect(finished).toEqual([
      ['b', 'superseded'],
      ['a', 'completed'],
      ['b', 'completed'],
    ]);
    expect(mgr.getState().status).toBe('idle');
  });

  it('ignore policy drops new requests while busy', async () => {
    const { mgr, finished } = setup('ignore');
    await mgr.play(req('a'));
    expect(await mgr.play(req('b'))).toBe('ignored');
    expect(finished).toEqual([['b', 'ignored']]);
  });

  it('stop() stops current and clears the queue; stale finish callbacks are ignored', async () => {
    const { backend, mgr, finished } = setup('queue');
    await mgr.play(req('a'));
    await mgr.play(req('b'));
    await mgr.stop();
    expect(backend.active).toBe(0);
    expect(finished).toEqual([
      ['b', 'stopped'],
      ['a', 'stopped'],
    ]);
    // A late "finished" from the stopped player must not start anything.
    await flush();
    expect(mgr.getState().status).toBe('idle');
  });

  it('stopIfCurrent only affects the matching checkpoint and then continues the queue', async () => {
    const { backend, mgr, startedIds } = setup('queue');
    await mgr.play(req('a'));
    await mgr.play(req('b'));
    await mgr.stopIfCurrent('b');
    expect(mgr.getState().current?.checkpointId).toBe('a');
    await mgr.stopIfCurrent('a');
    expect(startedIds).toEqual(['a', 'b']);
    expect(backend.maxActive).toBe(1);
  });

  it('pause and resume update state', async () => {
    const { mgr } = setup();
    await mgr.play(req('a'));
    mgr.pause();
    expect(mgr.getState().status).toBe('paused');
    mgr.resume();
    expect(mgr.getState().status).toBe('playing');
  });

  it('preview interrupts and clears queued tracking audio', async () => {
    const { backend, mgr, finished } = setup('queue');
    await mgr.play(req('a'));
    await mgr.play(req('b'));
    expect(await mgr.preview(req('preview:x'))).toBe('started');
    expect(backend.maxActive).toBe(1);
    expect(finished).toEqual([
      ['b', 'stopped'],
      ['a', 'interrupted'],
    ]);
  });
});
