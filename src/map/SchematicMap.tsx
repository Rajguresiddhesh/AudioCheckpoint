import { useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import type { Checkpoint } from '../data/models';
import { toLocalXY, type LatLon } from '../engine/geo';
import type { CheckpointState, LocationSample } from '../engine/types';
import { checkpointColor } from './geojson';

/**
 * Tile-free fallback "map": checkpoints and the user drawn to scale in local
 * metres. Needs no map data at all, so it always works offline.
 */
export function SchematicMap({
  checkpoints,
  states,
  user,
  center,
}: {
  checkpoints: Checkpoint[];
  states: Record<string, CheckpointState | undefined>;
  user: LocationSample | null;
  center: LatLon;
}) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) =>
    setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  const layout = useMemo(() => {
    const origin =
      checkpoints.length > 0
        ? {
            latitude: checkpoints.reduce((s, c) => s + c.latitude, 0) / checkpoints.length,
            longitude: checkpoints.reduce((s, c) => s + c.longitude, 0) / checkpoints.length,
          }
        : center;
    const items = checkpoints.map((c) => ({ c, ...toLocalXY(origin, c) }));
    const u = user ? toLocalXY(origin, user) : null;
    let extent = 40;
    for (const it of items) extent = Math.max(extent, Math.abs(it.x) + it.c.triggerRadiusM, Math.abs(it.y) + it.c.triggerRadiusM);
    if (u) extent = Math.max(extent, Math.abs(u.x) + 10, Math.abs(u.y) + 10);
    return { items, u, extent: extent * 1.15 };
  }, [checkpoints, user, center]);

  const scale = size.w > 0 ? Math.min(size.w, size.h) / 2 / layout.extent : 0; // px per metre
  const px = (x: number, y: number) => ({ left: size.w / 2 + x * scale, top: size.h / 2 - y * scale });
  const scaleBarM = niceNumber(layout.extent / 2);

  return (
    <View style={s.root} onLayout={onLayout} accessibilityLabel="Schematic map of checkpoints">
      {scale > 0 &&
        layout.items.map(({ c, x, y }) => {
          const r = c.triggerRadiusM * scale;
          const p = px(x, y);
          const color = checkpointColor(c, states[c.id]);
          return (
            <View key={c.id} pointerEvents="none">
              <View
                style={[
                  s.circle,
                  { left: p.left - r, top: p.top - r, width: r * 2, height: r * 2, borderRadius: r, borderColor: color, backgroundColor: color + '22' },
                ]}
              />
              <Text style={[s.label, { left: p.left - 60, top: p.top - 9, color }]} numberOfLines={1}>
                {c.name}
              </Text>
            </View>
          );
        })}
      {scale > 0 && layout.u && user ? (
        <>
          {user.accuracyM ? (
            <View
              pointerEvents="none"
              style={[
                s.accuracy,
                (() => {
                  const r = user.accuracyM! * scale;
                  const p = px(layout.u.x, layout.u.y);
                  return { left: p.left - r, top: p.top - r, width: r * 2, height: r * 2, borderRadius: r };
                })(),
              ]}
            />
          ) : null}
          <View pointerEvents="none" style={[s.me, { left: px(layout.u.x, layout.u.y).left - 8, top: px(layout.u.x, layout.u.y).top - 8 }]} />
        </>
      ) : null}
      <Text style={s.north}>N ↑</Text>
      {scale > 0 ? (
        <View style={s.scaleBar}>
          <View style={{ width: scaleBarM * scale, height: 4, backgroundColor: '#111827' }} />
          <Text style={s.scaleText}>{scaleBarM} m</Text>
        </View>
      ) : null}
    </View>
  );
}

function niceNumber(v: number): number {
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  return steps.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), steps[0]);
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#eef2e6', overflow: 'hidden' },
  circle: { position: 'absolute', borderWidth: 2 },
  label: { position: 'absolute', width: 120, textAlign: 'center', fontSize: 13, fontWeight: '700' },
  accuracy: { position: 'absolute', backgroundColor: 'rgba(37,99,235,0.15)', borderColor: 'rgba(37,99,235,0.5)', borderWidth: 1 },
  me: { position: 'absolute', width: 16, height: 16, borderRadius: 8, backgroundColor: '#2563eb', borderWidth: 3, borderColor: '#fff' },
  north: { position: 'absolute', top: 8, right: 10, fontWeight: '700', color: '#374151' },
  scaleBar: { position: 'absolute', left: 12, bottom: 10, gap: 2 },
  scaleText: { fontSize: 12, color: '#111827' },
});
