import { checkpointAt, fixNear } from '../../testing/helpers';
import { CheckpointEngine } from '../checkpointEngine';
import { destinationPoint } from '../geo';
import { simulateRoute } from '../simulator';
import type { EngineConfig, EngineEvent, LocationSample } from '../types';

const T0 = 1_700_000_000_000;

function makeEngine(cfg: Partial<EngineConfig> = {}) {
  // Large plausible speed so tests can "teleport"; outlier logic is tested separately.
  return new CheckpointEngine({ maxPlausibleSpeedMps: 1000, cooldownMs: 0, ...cfg });
}

/** Feed fixes 1 s apart (now == fix time) and collect events. */
function feed(engine: CheckpointEngine, fixes: LocationSample[]): EngineEvent[] {
  return fixes.flatMap((f) => engine.process(f, f.timestampMs).events);
}

const triggers = (events: EngineEvent[]) => events.filter((e) => e.type === 'trigger');

describe('checkpoint entry', () => {
  const swing = checkpointAt('swing', 0, 35);

  it('triggers once after the configured number of consecutive good inside fixes', () => {
    const e = makeEngine({ entryConfirmSamples: 3 });
    e.setCheckpoints([swing]);
    const ev1 = feed(e, [fixNear(swing, 50, T0), fixNear(swing, 10, T0 + 1000), fixNear(swing, 8, T0 + 2000)]);
    expect(triggers(ev1)).toHaveLength(0);
    expect(e.getRuntime('swing')!.state).toBe('CANDIDATE');
    const ev2 = feed(e, [fixNear(swing, 6, T0 + 3000)]);
    expect(triggers(ev2)).toEqual([expect.objectContaining({ checkpointId: 'swing', type: 'trigger' })]);
    expect(e.getRuntime('swing')!.state).toBe('TRIGGERED');
  });

  it('triggers for a stationary user who is already inside (no movement direction needed)', () => {
    const e = makeEngine();
    e.setCheckpoints([swing]);
    const ev = feed(e, [fixNear(swing, 3, T0), fixNear(swing, 3, T0 + 1000)]);
    expect(triggers(ev)).toHaveLength(1);
  });

  it('honours a dwell requirement', () => {
    const e = makeEngine({ entryConfirmSamples: 2, entryDwellMs: 5000 });
    e.setCheckpoints([swing]);
    const fixes = Array.from({ length: 5 }, (_, i) => fixNear(swing, 5, T0 + i * 1000));
    expect(triggers(feed(e, fixes))).toHaveLength(0); // only 4 s between first and last
    expect(triggers(feed(e, [fixNear(swing, 5, T0 + 5000)]))).toHaveLength(1);
  });

  it('does not replay while the user remains inside', () => {
    const e = makeEngine();
    e.setCheckpoints([swing]);
    feed(e, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000)]);
    e.markPlaybackStarted('swing', T0 + 1100);
    const during = feed(e, Array.from({ length: 20 }, (_, i) => fixNear(swing, 5, T0 + 2000 + i * 1000)));
    e.markPlaybackFinished('swing', T0 + 22_500);
    const after = feed(e, Array.from({ length: 60 }, (_, i) => fixNear(swing, 5, T0 + 23_000 + i * 1000)));
    expect(triggers([...during, ...after])).toHaveLength(0);
    expect(e.getRuntime('swing')!.state).toBe('COOLDOWN');
  });

  it('goes TRIGGERED -> PLAYING -> COOLDOWN with audio callbacks', () => {
    const e = makeEngine();
    e.setCheckpoints([swing]);
    feed(e, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000)]);
    expect(e.getRuntime('swing')!.state).toBe('TRIGGERED');
    e.markPlaybackStarted('swing', T0 + 1200);
    expect(e.getRuntime('swing')!.state).toBe('PLAYING');
    expect(e.getStatus().activeCheckpointId).toBe('swing');
    e.markPlaybackFinished('swing', T0 + 5000);
    expect(e.getRuntime('swing')!.state).toBe('COOLDOWN');
  });
});

describe('exit and rearming', () => {
  const swing = checkpointAt('swing', 0, 35);

  function visit(e: CheckpointEngine, t: number) {
    feed(e, [fixNear(swing, 5, t), fixNear(swing, 5, t + 1000)]);
    e.markPlaybackStarted('swing', t + 1100);
    e.markPlaybackFinished('swing', t + 1500);
  }

  it('rearms after leaving beyond radius + hysteresis and triggers again on return', () => {
    const e = makeEngine({ rearmOutsideSamples: 2, exitHysteresisM: 10 });
    e.setCheckpoints([swing]);
    visit(e, T0);
    const out = feed(e, [fixNear(swing, 40, T0 + 3000), fixNear(swing, 40, T0 + 4000)]);
    expect(out.map((x) => x.type)).toEqual(['exit', 'rearmed']);
    expect(e.getRuntime('swing')!.state).toBe('OUTSIDE');
    const back = feed(e, [fixNear(swing, 5, T0 + 10_000), fixNear(swing, 5, T0 + 11_000)]);
    expect(triggers(back)).toHaveLength(1);
  });

  it('does not rearm in the hysteresis band (radius < d <= radius + hysteresis)', () => {
    const e = makeEngine({ exitHysteresisM: 10 });
    e.setCheckpoints([swing]);
    visit(e, T0);
    const band = feed(e, Array.from({ length: 10 }, (_, i) => fixNear(swing, 27, T0 + 3000 + i * 1000)));
    expect(band).toHaveLength(0);
    expect(e.getRuntime('swing')!.state).toBe('COOLDOWN');
  });

  it('requires consecutive outside fixes: one inside fix resets the count', () => {
    const e = makeEngine({ rearmOutsideSamples: 3 });
    e.setCheckpoints([swing]);
    visit(e, T0);
    feed(e, [
      fixNear(swing, 45, T0 + 3000),
      fixNear(swing, 45, T0 + 4000),
      fixNear(swing, 10, T0 + 5000), // back inside the band -> reset
      fixNear(swing, 45, T0 + 6000),
      fixNear(swing, 45, T0 + 7000),
    ]);
    expect(e.getRuntime('swing')!.state).toBe('COOLDOWN');
    const ev = feed(e, [fixNear(swing, 45, T0 + 8000)]);
    expect(ev.map((x) => x.type)).toContain('rearmed');
  });

  it('respects the minimum time outside and cooldown duration', () => {
    const e = makeEngine({ rearmOutsideSamples: 1, rearmMinOutsideMs: 10_000, cooldownMs: 60_000 });
    e.setCheckpoints([swing]);
    visit(e, T0);
    feed(e, Array.from({ length: 30 }, (_, i) => fixNear(swing, 60, T0 + 3000 + i * 1000)));
    // 30 s outside, but only ~32 s since trigger -> still cooling down
    expect(e.getRuntime('swing')!.state).toBe('COOLDOWN');
    const ev = feed(e, [fixNear(swing, 60, T0 + 62_000)]);
    expect(ev.map((x) => x.type)).toContain('rearmed');
  });

  it('counts exits observed during playback so rearm happens right after playback ends', () => {
    const e = makeEngine({ rearmOutsideSamples: 2 });
    e.setCheckpoints([swing]);
    feed(e, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000)]);
    e.markPlaybackStarted('swing', T0 + 1100);
    const ev = feed(e, [fixNear(swing, 50, T0 + 2000), fixNear(swing, 50, T0 + 3000)]);
    expect(ev.map((x) => x.type)).toEqual(['exit']);
    expect(e.getRuntime('swing')!.state).toBe('PLAYING');
    const fin = e.markPlaybackFinished('swing', T0 + 4000);
    expect(fin.map((x) => x.type)).toEqual(['rearmed']);
  });
});

describe('boundary jitter', () => {
  const swing = checkpointAt('swing', 0, 35);

  it('a user standing at the edge produces exactly one trigger despite noisy fixes', () => {
    const e = makeEngine({ entryConfirmSamples: 2, rearmOutsideSamples: 2 });
    e.setCheckpoints([swing]);
    // Distances oscillate 16..28 m around a 20 m radius with 10 m hysteresis (exit at 30 m).
    const pattern = [18, 23, 19, 17, 25, 21, 16, 28, 19, 22, 18, 27, 20, 24, 17];
    const fixes = Array.from({ length: 120 }, (_, i) =>
      fixNear(swing, pattern[i % pattern.length], T0 + i * 1000, { bearingDeg: (i * 37) % 360 }),
    );
    let all: EngineEvent[] = [];
    for (const f of fixes) {
      const r = e.process(f, f.timestampMs);
      all = all.concat(r.events);
      const rt = e.getRuntime('swing')!;
      if (rt.state === 'TRIGGERED') e.markPlaybackStarted('swing', f.timestampMs);
      if (rt.state === 'PLAYING' && f.timestampMs - rt.stateSinceMs > 5000) {
        all = all.concat(e.markPlaybackFinished('swing', f.timestampMs));
      }
    }
    expect(triggers(all)).toHaveLength(1);
    expect(all.filter((x) => x.type === 'rearmed')).toHaveLength(0);
  });

  it('a single fix inside the radius does not trigger when 2 are required', () => {
    const e = makeEngine({ entryConfirmSamples: 2 });
    e.setCheckpoints([swing]);
    const ev = feed(e, [fixNear(swing, 25, T0), fixNear(swing, 19, T0 + 1000), fixNear(swing, 24, T0 + 2000)]);
    expect(triggers(ev)).toHaveLength(0);
    expect(e.getRuntime('swing')!.state).toBe('OUTSIDE');
  });
});

describe('poor accuracy and invalid samples', () => {
  const swing = checkpointAt('swing', 0, 35);

  it('poor-accuracy fixes inside the radius never trigger and report low confidence', () => {
    const e = makeEngine({ maxAccuracyM: 25 });
    e.setCheckpoints([swing]);
    const ev = feed(e, Array.from({ length: 10 }, (_, i) => fixNear(swing, 2, T0 + i * 1000, { accuracyM: 60 })));
    expect(triggers(ev)).toHaveLength(0);
    expect(e.getStatus().lowConfidence).toBe(true);
    expect(e.getStatus().lastQuality).toBe('low_accuracy');
  });

  it('fixes with unknown accuracy cannot trigger', () => {
    const e = makeEngine();
    e.setCheckpoints([swing]);
    const ev = feed(e, [fixNear(swing, 1, T0, { accuracyM: null }), fixNear(swing, 1, T0 + 1000, { accuracyM: null })]);
    expect(triggers(ev)).toHaveLength(0);
  });

  it('a low-accuracy fix between good ones neither adds nor removes evidence', () => {
    const e = makeEngine({ entryConfirmSamples: 2 });
    e.setCheckpoints([swing]);
    feed(e, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000, { accuracyM: 80 })]);
    expect(e.getRuntime('swing')!.state).toBe('CANDIDATE');
    expect(e.getRuntime('swing')!.candidateCount).toBe(1);
    expect(triggers(feed(e, [fixNear(swing, 5, T0 + 2000)]))).toHaveLength(1);
  });

  it('a poor fix can still prove the user is far away (distance - accuracy > exit radius)', () => {
    const e = makeEngine({ rearmOutsideSamples: 2 });
    e.setCheckpoints([swing]);
    feed(e, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000)]);
    e.markPlaybackFinished('swing', T0 + 1500);
    const ev = feed(e, [
      fixNear(swing, 120, T0 + 20_000, { accuracyM: 60 }),
      fixNear(swing, 120, T0 + 21_000, { accuracyM: 60 }),
    ]);
    expect(ev.map((x) => x.type)).toEqual(['exit', 'rearmed']);
  });

  it('a poor fix that does not prove an exit does not rearm', () => {
    const e = makeEngine({ rearmOutsideSamples: 1 });
    e.setCheckpoints([swing]);
    feed(e, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000)]);
    e.markPlaybackFinished('swing', T0 + 1500);
    const ev = feed(e, [fixNear(swing, 50, T0 + 20_000, { accuracyM: 40 })]); // 50-40 = 10 < 30
    expect(ev).toHaveLength(0);
    expect(e.getRuntime('swing')!.state).toBe('COOLDOWN');
  });

  it('rejects stale fixes', () => {
    const e = makeEngine({ maxSampleAgeMs: 10_000 });
    e.setCheckpoints([swing]);
    const now = T0 + 60_000;
    const r1 = e.process(fixNear(swing, 1, T0), now);
    const r2 = e.process(fixNear(swing, 1, T0 + 1000), now);
    expect([r1.quality, r2.quality]).toEqual(['stale', 'stale']);
    expect(r1.accepted || r2.accepted).toBe(false);
    expect(e.getRuntime('swing')!.state).toBe('OUTSIDE');
  });

  it('rejects out-of-order and duplicate timestamps', () => {
    const e = makeEngine();
    e.setCheckpoints([swing]);
    expect(e.process(fixNear(swing, 1, T0 + 5000), T0 + 5000).quality).toBe('good');
    expect(e.process(fixNear(swing, 1, T0 + 5000), T0 + 5000).quality).toBe('out_of_order');
    expect(e.process(fixNear(swing, 1, T0 + 3000), T0 + 5000).quality).toBe('out_of_order');
    expect(e.getRuntime('swing')!.candidateCount).toBe(1);
  });

  it('rejects invalid coordinates, negative accuracy and far-future timestamps', () => {
    const e = makeEngine();
    e.setCheckpoints([swing]);
    expect(e.process({ latitude: NaN, longitude: 73, accuracyM: 5, timestampMs: T0 }, T0).quality).toBe('invalid');
    expect(e.process({ latitude: 95, longitude: 73, accuracyM: 5, timestampMs: T0 }, T0).quality).toBe('invalid');
    expect(e.process({ ...fixNear(swing, 1, T0), accuracyM: -1 }, T0).quality).toBe('invalid');
    expect(e.process(fixNear(swing, 1, T0 + 3_600_000), T0).quality).toBe('invalid');
  });

  it('can reject mock-location fixes when configured', () => {
    const e = makeEngine({ allowMockLocations: false });
    e.setCheckpoints([swing]);
    expect(e.process(fixNear(swing, 1, T0, { extra: { mocked: true } }), T0).quality).toBe('mocked');
  });
});

describe('outlier jumps', () => {
  const swing = checkpointAt('swing', 0, 35);

  it('ignores an implausible single jump into the checkpoint', () => {
    const e = new CheckpointEngine({ maxPlausibleSpeedMps: 15, entryConfirmSamples: 1 });
    e.setCheckpoints([swing]);
    e.process(fixNear(swing, 400, T0), T0);
    const r = e.process(fixNear(swing, 1, T0 + 1000), T0 + 1000); // 399 m in 1 s
    expect(r.quality).toBe('outlier');
    expect(r.events).toHaveLength(0);
    expect(e.process(fixNear(swing, 400, T0 + 2000), T0 + 2000).quality).toBe('good');
  });

  it('accepts the new position after repeated consistent jumps (GPS re-acquired)', () => {
    const e = new CheckpointEngine({ maxPlausibleSpeedMps: 15, outlierResetCount: 3 });
    e.setCheckpoints([swing]);
    e.process(fixNear(swing, 400, T0), T0);
    const q = [1, 2, 3].map((i) => e.process(fixNear(swing, 2, T0 + i * 1000), T0 + i * 1000).quality);
    expect(q).toEqual(['outlier', 'outlier', 'good']);
  });
});

describe('temporary GPS loss', () => {
  const swing = checkpointAt('swing', 0, 35);

  it('a candidate falls back to OUTSIDE after the timeout with no fixes', () => {
    const e = makeEngine({ entryConfirmSamples: 3, candidateTimeoutMs: 10_000 });
    e.setCheckpoints([swing]);
    feed(e, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000)]);
    expect(e.getRuntime('swing')!.state).toBe('CANDIDATE');
    e.tick(T0 + 5000);
    expect(e.getRuntime('swing')!.state).toBe('CANDIDATE');
    e.tick(T0 + 12_000);
    expect(e.getRuntime('swing')!.state).toBe('OUTSIDE');
  });

  it('a visited checkpoint stays visited through signal loss (no replay when fixes resume inside)', () => {
    const e = makeEngine();
    e.setCheckpoints([swing]);
    feed(e, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000)]);
    e.markPlaybackStarted('swing', T0 + 1100);
    e.markPlaybackFinished('swing', T0 + 4000);
    e.tick(T0 + 120_000);
    const ev = feed(e, [fixNear(swing, 5, T0 + 121_000), fixNear(swing, 5, T0 + 122_000)]);
    expect(triggers(ev)).toHaveLength(0);
  });

  it('a PLAYING checkpoint whose audio never reports completion is released by timeout', () => {
    const e = makeEngine({ maxPlaybackMs: 60_000 });
    e.setCheckpoints([swing]);
    feed(e, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000)]);
    e.markPlaybackStarted('swing', T0 + 1000);
    e.tick(T0 + 62_000);
    expect(e.getRuntime('swing')!.state).toBe('COOLDOWN');
  });

  it('an unacknowledged trigger is released by timeout', () => {
    const e = makeEngine({ triggerAckTimeoutMs: 5000 });
    e.setCheckpoints([swing]);
    feed(e, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000)]);
    e.tick(T0 + 7000);
    expect(e.getRuntime('swing')!.state).toBe('COOLDOWN');
  });
});

describe('overlapping checkpoints', () => {
  // Two checkpoints 10 m apart with 20 m radii: a point between them is inside both.
  const a = checkpointAt('a', 90, 0, { priority: 1 });
  const b = checkpointAt('b', 90, 10, { priority: 5 });
  const mid = destinationPoint(a, 90, 5);

  it('exclusive policy: higher priority fires first, the other waits and fires after playback', () => {
    const e = makeEngine({ overlapPolicy: 'exclusive' });
    e.setCheckpoints([a, b]);
    const ev = feed(e, [fixNear(mid, 0, T0), fixNear(mid, 0, T0 + 1000)]);
    expect(triggers(ev).map((x) => x.checkpointId)).toEqual(['b']);
    e.markPlaybackStarted('b', T0 + 1100);
    // a keeps its evidence while b plays
    feed(e, [fixNear(mid, 0, T0 + 2000), fixNear(mid, 0, T0 + 3000)]);
    expect(e.getRuntime('a')!.state).toBe('CANDIDATE');
    const after = e.markPlaybackFinished('b', T0 + 3500);
    expect(triggers(after).map((x) => x.checkpointId)).toEqual(['a']);
  });

  it('exclusive policy: ties break by distance', () => {
    const e = makeEngine();
    const a0 = { ...a, priority: 0 };
    const b0 = { ...b, priority: 0 };
    e.setCheckpoints([a0, b0]);
    const nearB = destinationPoint(a, 90, 8);
    const ev = feed(e, [fixNear(nearB, 0, T0), fixNear(nearB, 0, T0 + 1000)]);
    expect(triggers(ev).map((x) => x.checkpointId)).toEqual(['b']);
  });

  it('the waiting checkpoint is not suppressed forever if the user leaves', () => {
    const e = makeEngine();
    e.setCheckpoints([a, b]);
    feed(e, [fixNear(mid, 0, T0), fixNear(mid, 0, T0 + 1000)]);
    e.markPlaybackStarted('b', T0 + 1100);
    feed(e, [fixNear(a, 60, T0 + 5000, { bearingDeg: 270 })]); // leave both
    expect(e.getRuntime('a')!.state).toBe('OUTSIDE');
    e.markPlaybackFinished('b', T0 + 6000);
    // Return later directly to a (outside b's radius) -> a triggers normally.
    const nearA = destinationPoint(a, 270, 8);
    const ev = feed(e, [fixNear(nearA, 0, T0 + 60_000), fixNear(nearA, 0, T0 + 61_000)]);
    expect(triggers(ev).map((x) => x.checkpointId)).toEqual(['a']);
  });

  it('independent policy: both trigger together', () => {
    const e = makeEngine({ overlapPolicy: 'independent' });
    e.setCheckpoints([a, b]);
    const ev = feed(e, [fixNear(mid, 0, T0), fixNear(mid, 0, T0 + 1000)]);
    expect(triggers(ev).map((x) => x.checkpointId)).toEqual(['b', 'a']);
  });
});

describe('floor and altitude (future positioning hooks)', () => {
  it('a floor-tagged fix on another floor never triggers', () => {
    const cp = checkpointAt('gallery', 0, 0, { floor: 2 });
    const e = makeEngine();
    e.setCheckpoints([cp]);
    const ev = feed(e, [
      fixNear(cp, 1, T0, { extra: { floor: 1 } }),
      fixNear(cp, 1, T0 + 1000, { extra: { floor: 1 } }),
    ]);
    expect(triggers(ev)).toHaveLength(0);
    const ev2 = feed(e, [
      fixNear(cp, 1, T0 + 2000, { extra: { floor: 2 } }),
      fixNear(cp, 1, T0 + 3000, { extra: { floor: 2 } }),
    ]);
    expect(triggers(ev2)).toHaveLength(1);
  });

  it('GNSS fixes without floor info ignore the checkpoint floor', () => {
    const cp = checkpointAt('gallery', 0, 0, { floor: 2 });
    const e = makeEngine();
    e.setCheckpoints([cp]);
    expect(triggers(feed(e, [fixNear(cp, 1, T0), fixNear(cp, 1, T0 + 1000)]))).toHaveLength(1);
  });

  it('altitude gating applies only when enabled and the fix has vertical accuracy', () => {
    const cp = checkpointAt('summit', 0, 0, { altitudeM: 500 });
    const low = { altitudeM: 400, altitudeAccuracyM: 5 };
    const e = makeEngine({ altitudeToleranceM: 15 });
    e.setCheckpoints([cp]);
    expect(triggers(feed(e, [fixNear(cp, 1, T0, { extra: low }), fixNear(cp, 1, T0 + 1000, { extra: low })]))).toHaveLength(0);
    const noVa = { altitudeM: 400, altitudeAccuracyM: null };
    expect(
      triggers(feed(e, [fixNear(cp, 1, T0 + 2000, { extra: noVa }), fixNear(cp, 1, T0 + 3000, { extra: noVa })])),
    ).toHaveLength(1);
  });
});

describe('snapshot / restore and recovery', () => {
  const swing = checkpointAt('swing', 0, 35);

  it('round-trips state through JSON and does not replay after an interruption', () => {
    const e1 = makeEngine();
    e1.setCheckpoints([swing]);
    feed(e1, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000)]);
    e1.markPlaybackStarted('swing', T0 + 1100);
    const json = JSON.stringify(e1.snapshot());

    const e2 = makeEngine();
    e2.setCheckpoints([swing]);
    e2.restore(JSON.parse(json));
    expect(e2.getRuntime('swing')!.state).toBe('PLAYING');
    e2.recoverAfterInterruption(T0 + 30_000);
    expect(e2.getRuntime('swing')!.state).toBe('COOLDOWN');
    const ev = feed(e2, [fixNear(swing, 5, T0 + 31_000), fixNear(swing, 5, T0 + 32_000)]);
    expect(triggers(ev)).toHaveLength(0);
  });

  it('keeps state for unchanged checkpoints and resets moved ones on setCheckpoints', () => {
    const e = makeEngine();
    e.setCheckpoints([swing]);
    feed(e, [fixNear(swing, 5, T0), fixNear(swing, 5, T0 + 1000)]);
    e.markPlaybackFinished('swing', T0 + 2000);
    e.setCheckpoints([{ ...swing }]);
    expect(e.getRuntime('swing')!.state).toBe('COOLDOWN');
    e.setCheckpoints([{ ...swing, radiusM: 30 }]);
    expect(e.getRuntime('swing')!.state).toBe('OUTSIDE');
  });
});

describe('simulated walk', () => {
  it('a realistic noisy walk through two checkpoints triggers each exactly once, then rearms', () => {
    const swing = checkpointAt('swing', 0, 35);
    const ground = checkpointAt('ground', 180, 35);
    const e = new CheckpointEngine({ cooldownMs: 0 }); // default outlier filter ON
    e.setCheckpoints([swing, ground]);
    const start = destinationPoint(swing, 0, 80);
    const fixes = simulateRoute(
      [
        start,
        { ...swing, dwellMs: 10_000 },
        { ...ground, dwellMs: 10_000 },
        destinationPoint(ground, 180, 80),
        { ...ground, dwellMs: 10_000 },
      ],
      { startMs: T0, intervalMs: 1000, accuracyM: 6, jitterM: 4, seed: 42 },
    );
    const order: string[] = [];
    for (const f of fixes) {
      for (const ev of e.process(f, f.timestampMs).events) {
        if (ev.type === 'trigger') {
          order.push(ev.checkpointId);
          e.markPlaybackStarted(ev.checkpointId, f.timestampMs);
          // pretend 3 s clip: finish immediately for simplicity
          e.markPlaybackFinished(ev.checkpointId, f.timestampMs);
        }
      }
    }
    expect(order).toEqual(['swing', 'ground', 'ground']);
  });
});
