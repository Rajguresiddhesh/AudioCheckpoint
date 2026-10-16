import { Camera, GeoJSONSource, Layer, Map, Marker } from '@maplibre/maplibre-react-native';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Bounds, Checkpoint } from '../data/models';
import type { CheckpointState, LocationSample } from '../engine/types';
import { checkpointAreas, checkpointColor, userFeatures } from './geojson';

/**
 * MapLibre map. When the style URL matches a downloaded offline pack, MapLibre
 * serves style, glyphs and tiles from its offline store with no network.
 * Labels use RN Markers (not map glyphs) so they render even if fonts are missing.
 */
export function CheckpointMap({
  styleUrl,
  bounds,
  checkpoints,
  states,
  user,
  onFail,
}: {
  styleUrl: string;
  bounds: Bounds;
  checkpoints: Checkpoint[];
  states: Record<string, CheckpointState | undefined>;
  user: LocationSample | null;
  onFail: () => void;
}) {
  const areas = useMemo(() => checkpointAreas(checkpoints, states), [checkpoints, states]);
  const me = useMemo(() => userFeatures(user), [user]);

  return (
    <Map
      style={StyleSheet.absoluteFill}
      mapStyle={styleUrl}
      onDidFailLoadingMap={onFail}
      attribution
      logo={false}
      compass
      scaleBar
    >
      <Camera
        initialViewState={{ bounds: [bounds.west, bounds.south, bounds.east, bounds.north], padding: { top: 30, bottom: 30, left: 30, right: 30 } }}
        maxBounds={[bounds.west - 0.01, bounds.south - 0.01, bounds.east + 0.01, bounds.north + 0.01]}
      />
      <GeoJSONSource id="checkpoint-areas" data={areas}>
        <Layer id="checkpoint-fill" type="fill" paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 }} />
        <Layer id="checkpoint-outline" type="line" paint={{ 'line-color': ['get', 'color'], 'line-width': 2 }} />
      </GeoJSONSource>
      <GeoJSONSource id="user-position" data={me}>
        <Layer
          id="user-accuracy"
          type="fill"
          filter={['==', ['get', 'kind'], 'accuracy']}
          paint={{ 'fill-color': '#2563eb', 'fill-opacity': 0.12 }}
        />
        <Layer
          id="user-dot"
          type="circle"
          filter={['==', ['get', 'kind'], 'dot']}
          paint={{ 'circle-radius': 7, 'circle-color': '#2563eb', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 }}
        />
      </GeoJSONSource>
      {checkpoints.map((cp) => (
        <Marker key={cp.id} id={`label-${cp.id}`} lngLat={[cp.longitude, cp.latitude]} anchor="center">
          <View style={[styles.label, { borderColor: checkpointColor(cp, states[cp.id]) }]} accessibilityLabel={`Checkpoint ${cp.name}`}>
            <Text style={styles.labelText}>{cp.name}</Text>
          </View>
        </Marker>
      ))}
    </Map>
  );
}

const styles = StyleSheet.create({
  label: { backgroundColor: 'rgba(255,255,255,0.92)', borderWidth: 2, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  labelText: { fontSize: 12, fontWeight: '700', color: '#111827' },
});
