import Constants from 'expo-constants';
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { Circle, Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import type { Bounds, Checkpoint } from '../data/models';
import type { CheckpointState, LocationSample } from '../engine/types';
import { checkpointColor } from './geojson';

/** True when the build was made with GOOGLE_MAPS_API_KEY set (see app.config.ts). */
export const googleMapsConfigured: boolean = Constants.expoConfig?.extra?.googleMapsConfigured === true;

/**
 * Online Google map (needs internet and a Maps SDK API key baked into the build).
 * Checkpoint areas and the user's position come from the same data as the
 * offline views, so detection never depends on this map.
 */
export function GoogleCheckpointMap({
  bounds,
  checkpoints,
  states,
  user,
  follow,
}: {
  bounds: Bounds;
  checkpoints: Checkpoint[];
  states: Record<string, CheckpointState | undefined>;
  user: LocationSample | null;
  /** Re-centre on the user when a new fix arrives. */
  follow: boolean;
}) {
  const ref = useRef<MapView>(null);
  const centred = useRef(false);

  useEffect(() => {
    if (!user || !ref.current) return;
    if (!follow && centred.current) return;
    centred.current = true;
    ref.current.animateCamera({ center: { latitude: user.latitude, longitude: user.longitude } }, { duration: 500 });
  }, [user, follow]);

  return (
    <MapView
      ref={ref}
      style={StyleSheet.absoluteFill}
      provider={PROVIDER_GOOGLE}
      initialRegion={{
        latitude: (bounds.north + bounds.south) / 2,
        longitude: (bounds.east + bounds.west) / 2,
        latitudeDelta: (bounds.north - bounds.south) * 1.1,
        longitudeDelta: (bounds.east - bounds.west) * 1.1,
      }}
      showsCompass
      showsScale
      toolbarEnabled={false}
    >
      {checkpoints.map((cp) => {
        const color = checkpointColor(cp, states[cp.id]);
        return (
          <Circle
            key={`area-${cp.id}`}
            center={{ latitude: cp.latitude, longitude: cp.longitude }}
            radius={cp.triggerRadiusM}
            strokeColor={color}
            strokeWidth={2}
            fillColor={color + '2e'}
          />
        );
      })}
      {checkpoints.map((cp) => (
        <Marker
          key={`label-${cp.id}`}
          coordinate={{ latitude: cp.latitude, longitude: cp.longitude }}
          anchor={{ x: 0.5, y: 0.5 }}
          tracksViewChanges={false}
          title={cp.name}
        >
          <View style={[styles.label, { borderColor: checkpointColor(cp, states[cp.id]) }]}>
            <Text style={styles.labelText}>{cp.name}</Text>
          </View>
        </Marker>
      ))}
      {user && user.accuracyM != null && user.accuracyM > 0 ? (
        <Circle
          center={{ latitude: user.latitude, longitude: user.longitude }}
          radius={user.accuracyM}
          strokeColor="rgba(37,99,235,0.5)"
          strokeWidth={1}
          fillColor="rgba(37,99,235,0.12)"
          zIndex={2}
        />
      ) : null}
      {user ? (
        <Marker
          coordinate={{ latitude: user.latitude, longitude: user.longitude }}
          anchor={{ x: 0.5, y: 0.5 }}
          tracksViewChanges={false}
          title="You"
          zIndex={3}
        >
          <View style={styles.me} />
        </Marker>
      ) : null}
    </MapView>
  );
}

const styles = StyleSheet.create({
  label: { backgroundColor: 'rgba(255,255,255,0.92)', borderWidth: 2, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  labelText: { fontSize: 12, fontWeight: '700', color: '#111827' },
  me: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#2563eb', borderWidth: 3, borderColor: '#fff' },
});
