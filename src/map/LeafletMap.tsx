import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { Bounds, Checkpoint } from '../data/models';
import type { CheckpointState, LocationSample } from '../engine/types';
import { checkpointColor } from './geojson';

/**
 * Online map: Leaflet + OpenStreetMap raster tiles in a WebView. Needs internet
 * (Leaflet itself and the tiles are fetched), but no API key. Checkpoint
 * detection never depends on it; callers fall back to the schematic view
 * through `onFail` when Leaflet cannot load.
 */
export function LeafletMap({
  bounds,
  checkpoints,
  states,
  user,
  follow,
  onLongPress,
  onFail,
  onTilesFailed,
}: {
  bounds: Bounds;
  checkpoints: Checkpoint[];
  states: Record<string, CheckpointState | undefined>;
  user: LocationSample | null;
  /** Keep panning to the user on every new fix (otherwise only the first fix centres the map). */
  follow: boolean;
  onLongPress?: (p: { latitude: number; longitude: number }) => void;
  /** Leaflet could not load (typically no internet). */
  onFail?: () => void;
  /** Leaflet loaded but map tiles fail to download. */
  onTilesFailed?: () => void;
}) {
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  // Built once: later changes are pushed with injectJavaScript so the map keeps its view.
  const html = useMemo(() => buildHtml(bounds), [bounds]);

  const data = useMemo(
    () => ({
      checkpoints: checkpoints.map((c) => ({
        id: c.id,
        name: c.name,
        lat: c.latitude,
        lon: c.longitude,
        radius: c.triggerRadiusM,
        color: checkpointColor(c, states[c.id]),
      })),
      user: user ? { lat: user.latitude, lon: user.longitude, acc: user.accuracyM } : null,
      follow,
    }),
    [checkpoints, states, user, follow],
  );

  useEffect(() => {
    if (!ready) return;
    ref.current?.injectJavaScript(`window.acmUpdate(${JSON.stringify(data)}); true;`);
  }, [ready, data]);

  const onMessage = (e: WebViewMessageEvent) => {
    let msg: { type: string; lat?: number; lon?: number };
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'ready') setReady(true);
    else if (msg.type === 'failed') onFail?.();
    else if (msg.type === 'tilesFailed') onTilesFailed?.();
    else if (msg.type === 'longpress' && msg.lat != null && msg.lon != null) {
      onLongPress?.({ latitude: msg.lat, longitude: msg.lon });
    }
  };

  return (
    <WebView
      ref={ref}
      style={StyleSheet.absoluteFill}
      originWhitelist={['*']}
      source={{ html }}
      onMessage={onMessage}
      onError={() => onFail?.()}
      // OSM's tile policy asks apps to identify themselves.
      applicationNameForUserAgent="AudioCheckpoints/0.3 (com.isl.audiocheckpoints)"
      javaScriptEnabled
      setSupportMultipleWindows={false}
      overScrollMode="never"
      nestedScrollEnabled
    />
  );
}

function buildHtml(b: Bounds): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<style>
  html, body, #map { margin: 0; height: 100%; background: #eef2e6; }
  .acm-label { background: rgba(255,255,255,0.92); border: 2px solid; border-radius: 6px; padding: 1px 6px;
    font: 700 12px sans-serif; color: #111827; white-space: nowrap; transform: translate(-50%, -50%); display: inline-block; }
  .acm-me { width: 12px; height: 12px; border-radius: 50%; background: #2563eb; border: 3px solid #fff;
    box-shadow: 0 0 3px rgba(0,0,0,0.4); }
</style>
</head><body>
<div id="map"></div>
<script>
  function post(m) { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
  window.acmUpdate = function () {};
</script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""
  onerror="post({ type: 'failed' })"></script>
<script>
(function () {
  if (typeof L === 'undefined') { post({ type: 'failed' }); return; }
  var map = L.map('map', { zoomControl: true, attributionControl: true });
  map.fitBounds([[${b.south}, ${b.west}], [${b.north}, ${b.east}]]);
  var tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  var loaded = 0, failed = 0, reported = false;
  tiles.on('tileload', function () { loaded++; });
  tiles.on('tileerror', function () {
    failed++;
    if (!reported && loaded === 0 && failed >= 4) { reported = true; post({ type: 'tilesFailed' }); }
  });
  L.control.scale({ imperial: false }).addTo(map);

  var areas = L.layerGroup().addTo(map);
  var me = L.layerGroup().addTo(map);
  var centred = false;

  map.on('contextmenu', function (e) { post({ type: 'longpress', lat: e.latlng.lat, lon: e.latlng.lng }); });

  var fitted = false;
  window.acmUpdate = function (d) {
    // First view: fit the checkpoints (the site box is too wide to read the labels).
    if (!fitted && !d.user && d.checkpoints.length > 0) {
      fitted = true;
      var fb = L.latLngBounds([]);
      d.checkpoints.forEach(function (c) { fb.extend(L.latLng(c.lat, c.lon).toBounds(c.radius * 2.5)); });
      map.fitBounds(fb, { padding: [24, 24], maxZoom: 18 });
    }
    areas.clearLayers();
    d.checkpoints.forEach(function (c) {
      L.circle([c.lat, c.lon], { radius: c.radius, color: c.color, weight: 2, fillColor: c.color, fillOpacity: 0.18 })
        .addTo(areas);
      L.marker([c.lat, c.lon], {
        interactive: false,
        icon: L.divIcon({ className: '', iconSize: null,
          html: '<span class="acm-label" style="border-color:' + c.color + '">' +
            String(c.name).replace(/[&<>"]/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }) + '</span>' })
      }).addTo(areas);
    });
    me.clearLayers();
    if (d.user) {
      if (d.user.acc && d.user.acc > 0) {
        L.circle([d.user.lat, d.user.lon], { radius: d.user.acc, color: '#2563eb', weight: 1, opacity: 0.5,
          fillColor: '#2563eb', fillOpacity: 0.12, interactive: false }).addTo(me);
      }
      L.marker([d.user.lat, d.user.lon], { interactive: false, zIndexOffset: 1000,
        icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="acm-me"></div>' })
      }).addTo(me);
      if (d.follow || !centred) {
        centred = true;
        map.setView([d.user.lat, d.user.lon], Math.max(map.getZoom(), 17), { animate: true });
      }
    }
  };
  post({ type: 'ready' });
})();
</script>
</body></html>`;
}
