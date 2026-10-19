# Audio Checkpoints: offline GPS-triggered audio for Android (React Native)

Walk to a saved checkpoint (e.g. **Swing** or **Ground**) and its audio plays automatically, once per visit, with no internet.
Built with **React Native + Expo (SDK 57, RN 0.86, TypeScript)**, MapLibre, SQLite and a location foreground service.

> Prototype site: **Ramdas Pundalik Patil Udyan**, resolved from `https://maps.app.goo.gl/gJhNw9t6da8X8kz3A`
> (place pin 19.2198269, 73.0734127). That link gives **one pin for the whole park**. It does not say where the swing
> or the ground are. Swing and Ground are therefore seeded with **placeholder** coordinates (35 m north and south of
> the pin, see `docs/sample-checkpoints.json`) and flagged as unverified in the app until you re-capture them on site.

---

## Download

Get the latest APK from the [Releases page](https://github.com/Rajguresiddhesh/AudioCheckpoint/releases/latest)
(open it on the phone, allow installing from your browser, then tap **Install**). It is a side-loading build signed with the
Android debug key, so Play Protect may warn about an unknown developer.

---

## 1. Architecture (Phase 1)

```
 ┌──────────── UI (Expo Router screens, src/app) ───────────┐
 │ Home · User Mode · Creator · Edit · Audio · Maps · Status · Settings │
 └───────────────┬──────────────────────────────▲────────────┘
                 │ commands                      │ status (subscribe)
        ┌────────▼──────────────────────────────┴────────┐
        │ TrackingController (src/tracking)               │  pure TS, injected deps
        │  samples → engine → events → audio + history    │
        └──┬──────────────┬───────────────┬───────────────┘
           │              │               │
 ┌─────────▼───────┐ ┌────▼──────────┐ ┌──▼──────────────────────┐
 │ CheckpointEngine│ │ AudioManager  │ │ Repositories (SQLite)    │
 │ state machine   │ │ single channel│ │ checkpoints, history,    │
 │ (src/engine)    │ │ queue/interrupt│ │ sessions(+snapshot),     │
 │ no RN imports   │ │ /ignore policy │ │ map packages, settings   │
 └─────────▲───────┘ └────┬──────────┘ └──────────────────────────┘
           │              │ AudioBackend
 ┌─────────┴────────────┐ ┌▼──────────────────────┐
 │ PositionSource        │ │ expo-audio (Media3/   │
 │  • GNSS: expo-location│ │ ExoPlayer), generated │
 │    + foreground svc   │ │ WAV test melodies     │
 │  • Simulator          │ └───────────────────────┘
 │  • (future) BLE, PDR  │
 └───────────────────────┘
```

* **Data flow:** fixes arrive (background task or simulator) → `normaliseBatchTimestamps` → `TrackingController.handleSamples`
  → `CheckpointEngine.process` → `trigger` / `exit` / `rearmed` events → `AudioManager.play` → audio callbacks feed back to the
  engine (`PLAYING` → `COOLDOWN`) → state snapshot saved to SQLite after every batch.
* **One pipeline for foreground and background:** tracking always runs through an Android *location foreground service*
  (`Location.startLocationUpdatesAsync` with a persistent notification). The same JS singleton (`src/tracking/runtime.ts`)
  serves the UI and the background task. If the OS restarts the JS runtime headlessly, the task rebuilds it and the controller
  resumes the open session from SQLite.
* **Main technical risks** (and what the code does about them)

  | Risk | Mitigation |
  |---|---|
  | GPS jitter at the radius edge | Separate entry (radius) and exit (radius + hysteresis) thresholds; N consecutive fixes to enter, M to rearm |
  | Poor / unknown accuracy | Fixes worse than `maxAccuracyM` can never trigger, and show "low confidence". They can still prove you are *far away* |
  | Stale, duplicated, out-of-order or teleporting fixes | Deterministic sample classifier with an outlier filter (implied speed after subtracting both accuracy radii) |
  | Phone clock wrong vs GNSS time | Batch timestamps are re-based when skew > 60 s |
  | Process killed mid-session | Engine snapshot persisted per batch. On restart, mid-playback becomes "visited" (no replay) |
  | Two checkpoints qualify together | Priority → distance → id ordering. "One at a time" keeps the loser as a waiting candidate (never permanently suppressed) |
  | Overlapping audio | Single-channel `AudioManager`, serialised operations, stale-callback tokens |
  | Background audio / OEM battery killers | Foreground service + `shouldPlayInBackground`. Must be field-tested per device (see §7) |

### Spec mapping (Kotlin → React Native)
The original spec targeted Kotlin/Compose. These are the equivalents used here:

| Spec | This project |
|---|---|
| Kotlin, Compose, MVVM, Hilt | TypeScript, React Native, controller + hooks, explicit constructor injection |
| Coroutines / Flow | Promises + serialised async chains, `subscribe()` / `useSyncExternalStore` |
| Room + migrations | `expo-sqlite` with versioned migrations (`PRAGMA user_version`), FK cascade, CHECK & UNIQUE constraints |
| DataStore | `settings` table (JSON), merged over defaults on upgrade |
| MapLibre Native | `@maplibre/maplibre-react-native` 11 (wraps MapLibre Native Android) + `OfflineManager` |
| Fused Location Provider | `expo-location` (uses Google Play Services FusedLocationProviderClient on Android) |
| Media3 ExoPlayer | `expo-audio` (Media3/ExoPlayer under the hood on Android) |
| Foreground location service | expo-location's `LocationTaskService` (`foregroundServiceType="location"`) |
| JUnit + coroutine tests | Jest (+ sql.js real SQLite in tests) |
| Instrumentation tests | Maestro UI flows in `.maestro/` (device only) |

## 2. Project layout

```
index.ts                      entry: registers the background location task, then Expo Router
app.json / eas.json           Expo config (permissions, plugins) / cloud build profiles
src/app/                      screens (Expo Router): index, map, creator, checkpoint/[id], audio, packages, status, settings
src/engine/                   PURE: geo, sample filter, positioning policies, beacon parsing/floors, state machine, validation, simulator (+ tests)
src/audio/                    AudioManager (pure) + expo backend, melody synth (pure), import/validation
src/data/                     migrations, models, repositories, seed, expo-sqlite adapter (+ tests on sql.js)
src/tracking/                 TrackingController (pure) + runtime singleton (+ end-to-end tests)
src/location/                 expo-location adapter, foreground service, BLE beacon scanner, simulator driver
src/map/                      MapLibre view, schematic fallback, offline pack management, GeoJSON helpers
src/ui/                       components, hooks, formatting
.maestro/                     device UI flows
docs/sample-checkpoints.json  Swing / Ground placeholder dataset
```

## 3. Build and run

### Prerequisites
* Node.js 20+ (built with Node 24 / npm 11)
* For local native builds: **Android Studio** (SDK 36, a recent build-tools), **JDK 17**, `ANDROID_HOME` set, and an
  Android phone with USB debugging or an emulator.
* Expo Go **cannot** run this app (MapLibre and background location need native code). Use a development build or an APK.

```bash
cd AudioCheckpointMap
npm install
npm test            # Jest unit + integration tests
npm run typecheck   # tsc --noEmit
npm run lint
```

### Development build on a phone (local)
```bash
npx expo run:android          # generates android/ (prebuild), builds, installs, starts Metro
```

### Release APK, local Gradle
```bash
npx expo prebuild --platform android --clean
cd android
./gradlew assembleRelease       # Windows: gradlew.bat assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
adb install -r app/build/outputs/apk/release/app-release.apk
```
The generated project signs release builds with the debug keystore. That is fine for side-loading. For Play Store
distribution, configure your own keystore (`android/app/build.gradle` signingConfigs, or let EAS manage credentials).

### APK in the cloud (no Android SDK needed)
```bash
npx eas-cli@latest login
npx eas-cli@latest build -p android --profile preview      # installable APK
npx eas-cli@latest build -p android --profile development  # dev client APK
```

`android/` is generated (Continuous Native Generation) and git-ignored. Change native behaviour in `app.json`, not by hand.

## 4. Permissions

| Permission | Why | When requested |
|---|---|---|
| `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` | Detect checkpoints. **Precise** is required (approximate cannot resolve 20 m) | On "Start tracking" / opening Creator Mode |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` | Keep GPS running with the screen off, with a persistent notification | Install-time (normal permission) |
| `POST_NOTIFICATIONS` (Android 13+) | Show that notification in the shade (tracking works without it) | On "Start tracking" |
| `BLUETOOTH_SCAN` (Android 12+, "Nearby devices") | Hear indoor beacons. Declared **without** `neverForLocation`, because beacon results are used for positioning and Android would otherwise filter them | On "Start tracking" when a beacon checkpoint exists, or *Scan for nearby beacons* |
| `BLUETOOTH`, `BLUETOOTH_ADMIN`, `BLUETOOTH_CONNECT` | Added by react-native-ble-plx (legacy scanning on Android ≤ 11); the app never connects to devices | Install-time |
| `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `MODIFY_AUDIO_SETTINGS` | Added by expo-audio for background playback | Install-time |
| `INTERNET` | **Only** for downloading an offline map / online map view | Install-time |
| `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK` | Required by expo-task-manager, which hands each location fix to JS through a persisted JobScheduler job. Without it Android throws and the app crashes on the first fix | Install-time |

**Not requested:** `ACCESS_BACKGROUND_LOCATION` ("Allow all the time") is explicitly removed. A user-started location foreground
service only needs "While using the app". `RECORD_AUDIO`, storage and overlay permissions are also removed. This was verified
from the manifest generated by `expo prebuild`.

## 5. Offline maps

The map is optional. **Checkpoint detection and audio never need map data.** Without a verified package, User Mode shows a
**schematic view** (checkpoints and you, drawn to scale with a scale bar) and says so.

**Option A: download in the app (needs internet once)**
1. Connect to Wi-Fi. Open *Offline maps* → *Download for offline use*. This downloads the park bounding box
   (19.2169–19.2228 N, 73.0703–73.0765 E) at zoom 13–18 from the configured style (default
   [OpenFreeMap](https://openfreemap.org) "liberty", OpenStreetMap data, no API key).
2. Wait for **Status: complete**. The app then **verifies** the pack against MapLibre's native store (all required
   resources present). Only then does it show "Offline map available".
3. Test: airplane mode → User Mode → "Offline map".

**Option B: import a prepared file.** *Offline maps* → *Import .db file…* accepts a MapLibre offline database (an SQLite file;
the header is checked before merging). Typical source: another phone running this app, which has the database in its app
storage (`…/files/.maplibre/` or similar; extract with `adb run-as com.isl.audiocheckpoints`), or MapLibre's offline tooling.
Restart the app after importing so the merged regions are listed and verified. The pack must use the same style URL as
*Settings → Map style*.

**Never done:** scraping Google Maps tiles, or treating a Google Maps share link as map data.

### Online map (Leaflet)
User Mode opens on an **online map**: [Leaflet](https://leafletjs.com) 1.9.4 in a WebView with OpenStreetMap tiles,
showing checkpoint circles coloured by state and your position with its accuracy circle. Creator Mode shows the same map;
**long-press** it to add a checkpoint at that point. No API key is needed. It needs internet (Leaflet is loaded from
unpkg with a pinned SRI hash, tiles from `tile.openstreetmap.org`); without internet the app falls back to the schematic
view on its own. Detection and audio never depend on it. Tiles follow the
[OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) (the WebView identifies the app in its
User-Agent); for heavy use, switch to a commercial tile provider in `src/map/LeafletMap.tsx`.

## 6. Using the app

1. **Creator Mode:** walk to the spot, wait for accuracy ≤ the threshold (default 15 m), press *Save checkpoint here*, name it,
   keep or change the radius (default 20 m), choose audio (test melody or *Import audio file…* through the system picker),
   *Preview*, *Save*. Edit, disable or delete from the list. The app blocks duplicate names and points within 5 m of another
   checkpoint (unless you confirm), and warns about overlapping areas.
   *For Swing and Ground:* open each one, stand at the real spot, press **Use my current position**, then save.
2. **User Mode:** *Start tracking* (grant location; a notification appears). Walk to a checkpoint and its audio plays once.
   Pause, resume or stop from the panel. *Stop tracking* ends the service.
3. **Simulate a walk:** in User Mode, with tracking stopped, plays a synthetic walk through all enabled checkpoints using the real
   engine and audio. Use it to demo without walking.

### Positioning policies (per checkpoint)
Each checkpoint says how it is detected. **Latitude/longitude alone never triggers a checkpoint that needs more evidence.**
If the extra evidence is missing or untrustworthy, the result is *inconclusive*: nothing plays, and User Mode and
*Permissions & status* show why (e.g. "waiting for beacon", "vertical accuracy unknown").

| Policy (editor label) | Use for | Triggers only when |
|---|---|---|
| `OUTDOOR_GPS` (GPS) | Gardens, campuses, flat outdoor spots | Good GPS fix inside the radius (optional per-checkpoint accuracy limit). Floor/altitude are ignored, so this must be chosen explicitly. |
| `OUTDOOR_ELEVATION` (GPS + altitude) | Hills, forts, viewpoints, stacked paths | Horizontal check **and** a fix with altitude in the **same datum**, vertical accuracy ≤ the checkpoint's limit, and \|Δaltitude\| ≤ the allowed difference. |
| `INDOOR_BLE` (Indoor beacon) | Rooms, museum exhibits | The checkpoint's beacon is heard at ≥ its minimum RSSI in N consecutive 2 s scan windows. GPS neither triggers nor rearms it. |
| `INDOOR_BLE_FLOOR` (Indoor beacon + floor) | Multi-floor buildings (same lat/lon on every floor) | As above **and** the strongest known beacon places the user on this floor, beating other floors' beacons by a margin (default 3 dB). Ambiguous floor = no trigger. |

* **Altitude datums are never mixed.** Android GNSS reports height above the WGS84 **ellipsoid**; maps and iOS use **mean sea
  level**. Near Thane these differ by tens of metres and the app has no geoid model, so a checkpoint in a different datum than
  the phone's is inconclusive (the editor warns). Capture the altitude on site with *Use my current position*, which also
  records its datum. Android's "no altitude" fixes (altitude 0, vertical accuracy 0) are treated as having no altitude.
* **Beacon ids:** `ibeacon:<uuid>:<major>:<minor>`, `eddystone:<namespace>:<instance>` (Eddystone-UID) or `mac:<address>`.
  In the editor, *Scan for nearby beacons* lists what the phone hears; tapping one fills the id and a minimum RSSI 8 dB below
  the signal at that spot. A beacon belongs to one floor (the editor refuses to reuse it on another floor). The floor map is
  built from the checkpoints themselves.
* **Leaving:** GPS: beyond radius + hysteresis. Elevation: also when the altitude differs by more than the allowed difference
  + 5 m after subtracting the reported uncertainty. Beacon: not heard, or 6 dB below the minimum. Floor: beacons place you on
  another floor. Margins are in *Settings → Elevation and indoor checkpoints*.
* Beacon scanning runs only while tracking **and** some enabled checkpoint uses a beacon policy.
* *Simulate a walk* also simulates altitude (near elevation checkpoints) and beacons (inside beacon checkpoints) for demos.

### Default detection rules (all configurable in Settings)
* A fix is usable to **trigger** only if accuracy ≤ 25 m, it is ≤ 20 s old, newer than the last fix, and not an implausible
  jump (> 15 m/s after subtracting accuracies).
* **Enter:** 2 consecutive good fixes with distance ≤ radius → trigger (optional dwell time).
* **No replay** while inside. **Rearm** after 2 consecutive fixes beyond radius + 10 m (or a poor fix whose distance minus
  accuracy is beyond that), plus a 30 s cooldown since the trigger.
* **Overlaps:** "One at a time" (default). Higher priority, then nearer, plays first; the other plays afterwards if you are
  still there. "Independent" lets each trigger, with the audio policy (queue / interrupt / ignore) arbitrating.

## 7. Testing

### Automated (executed here)
`npm test` runs 9 suites with **139 tests, all passing** (Jest 29, 2026-10-20); `tsc --noEmit` and `expo lint` are clean.
The policy tests were mutation-checked: re-introducing the old "fall back to lat/lon when altitude/floor is unknown"
behaviour makes 7 of them fail. A release APK was built and run on an Android 15 emulator (GPS via `geo fix`; the emulator
has no real beacons): v1 → v2 upgrade with existing data, beacon scan + permission prompt, "waiting for beacon" while GPS
sat on the checkpoint's exact lat/lon, and a beacon + floor trigger during *Simulate a walk*. **Not yet tested with real
beacons, real altitude in hilly terrain, or a physical phone.** Maestro flows have not been run.

| Spec test | Where |
|---|---|
| 1 Distance calculations | `src/engine/__tests__/geo.test.ts` |
| 2 Entry · 3 Exit/rearm · 4 Boundary jitter · 5 Poor accuracy · 6 Stale samples | `src/engine/__tests__/checkpointEngine.test.ts` |
| 7 Duplicate prevention | `validation.test.ts`, `src/data/__tests__/repositories.test.ts` (incl. DB UNIQUE index) |
| 8 Overlapping priority | `checkpointEngine.test.ts` › overlapping checkpoints |
| 9 Missing audio · 10 Playback exclusivity | `src/audio/__tests__/audioManager.test.ts`, `trackingController.test.ts` |
| 11 Interruption & recovery | `trackingController.test.ts` › interruption and recovery (new controller on the same DB) |
| 12 Offline operation | `trackingController.test.ts` › offline (full session with `fetch`, XHR and WebSocket throwing, plus a static scan of core modules) |
| Simulated movement | `src/engine/simulator.ts`, used by the engine and controller tests and the in-app *Simulate a walk* |
| Migrations, rollback, newer-DB refusal, v1 → v2 upgrade keeps data | `repositories.test.ts` |
| Positioning policies (elevation datum/uncertainty, beacon RSSI/observations, floors, lat/lon-only never triggers) | `checkpointEngine.test.ts` › positioning policies |
| iBeacon / Eddystone parsing, floor estimation | `src/engine/__tests__/beacons.test.ts` |
| Same lat/lon on two floors, end to end with SQLite + audio | `trackingController.test.ts` › mixed indoor + outdoor |

Device UI flows (not executed): `maestro test .maestro/` against an installed build.

### Manual field-test procedure (real phone, at the park)
Preparation (at home, online): install the APK, open *Offline maps* → download → wait for *verified*. Check that
*Settings → Accept mock locations* is **off** for real visits.

1. **Capture:** at the swing, open Creator Mode, wait until accuracy shows green (≤ 15 m), open *Swing* → *Use my current
   position* → *Save*. Repeat at the ground. The placeholder warning on Home should disappear.
2. **Airplane mode:** enable airplane mode, then re-enable *Location* if the phone turned it off. Wi-Fi and data stay off.
3. **Basic trigger:** start tracking about 50 m from Swing and walk in. Expect the melody within roughly 2–6 s of crossing
   ~20 m, played **once**.
4. **No repeat:** stand inside Swing for 2 minutes. Expect no replay; Status shows "Visited (leave to rearm)".
5. **Rearm:** walk more than 30 m away (radius + hysteresis) for at least 30 s, then return. Expect it to play again.
6. **Edge jitter:** stand right at the ~20 m edge for 2 minutes. Expect at most one play.
7. **Screen off / background:** lock the phone in your pocket, walk to Ground. It should play with the screen off. Repeat
   with the app swiped to the background.
8. **GPS loss:** enter a covered area or tree canopy. The status should show low accuracy or "No recent GPS fix" and not trigger
   falsely. Come out and confirm normal behaviour.
9. **Battery saver:** enable battery saver and repeat step 7. Note any delays; some OEMs throttle GPS.
10. **Interruption:** while tracking, force-close the app from Recents (not *Force stop*), then reopen. Status should show the
    session resumed; no replay while still inside.
11. **Permission revocation:** while tracking, revoke location in system settings. The app should stop receiving fixes and
    show an error, without crashing. Re-grant and start again.
12. **History:** *Permissions & status* → trigger history should list each play with its evidence.
13. **Elevation (on a hill or fort):** create a *GPS + altitude* checkpoint at the top with *Use my current position*.
    Walk below it on the same lat/lon (e.g. a road under a viewpoint): it must not play. At the top it plays once the
    vertical accuracy is within the limit.
14. **Indoor floors:** place one beacon per floor, create a *beacon + floor* checkpoint per floor at the same spot (use *Scan
    for nearby beacons* on each floor). Stand on each floor and on the stairs: only that floor's checkpoint plays, and the
    stairs stay "floor cannot be determined". Note RSSI and delay per phone.

Record per step: phone model and Android version, reported accuracy, distance at trigger, and delay.

## 8. Data model (SQLite, schema v2)
* `checkpoints`: id, name (unique, case-insensitive), positioning_policy (`OUTDOOR_GPS|OUTDOOR_ELEVATION|INDOOR_BLE|
  INDOOR_BLE_FLOOR`, CHECK), latitude, longitude, trigger_radius_m, max_horizontal_accuracy_m?, audio_uri (`melody:<id>` or an
  app-private `file://` copy), audio_label, enabled, priority, floor?, altitude_m?, altitude_reference?
  (`ELLIPSOID|MSL|BAROMETRIC_RELATIVE`), max_vertical_difference_m?, max_vertical_uncertainty_m?, expected_beacon_id?,
  minimum_beacon_rssi_dbm?, required_beacon_observations?, coordinates_verified, created_at, updated_at.
* v1 → v2 only adds columns: existing checkpoints become `OUTDOOR_GPS` (their previous behaviour) and existing altitudes are
  marked `ELLIPSOID` (v1 could only capture them from Android GNSS).
* `map_packages`: id, name, local_path, offline_pack_id, style_url, west, south, east, north, min/max zoom,
  download_status (`pending|downloading|complete|incomplete|failed|missing`), progress, size, verified_at, error, created_at.
* `trigger_history`: id, checkpoint_id → checkpoints (CASCADE), session_id → tracking_sessions, triggered_at,
  playback_status, distance_m (null for beacon triggers), accuracy_m, evidence (what triggered it).
* `tracking_sessions`: id, started_at, ended_at, source, engine_snapshot (JSON), updated_at.
* `settings`: key/value.

Migrations are append-only, applied in a transaction together with the `user_version` bump. The app refuses to open a
database written by a newer app version.

## 9. Privacy, licensing and attribution
* Location, history and audio stay on the device. There is no backend, Firebase, analytics or tracking SDK. Core modules are
  test-checked for network calls. *Settings → Delete all local data* wipes checkpoints, history, imported audio, offline map
  packs and settings.
* **Map data:** © OpenStreetMap contributors (ODbL). Online map tiles from openstreetmap.org via Leaflet (BSD-2-Clause); offline packs via OpenFreeMap / OpenMapTiles schema. The MapLibre map shows the
  attribution button. Keep it visible.
* **Libraries:** MapLibre Native / MapLibre React Native (BSD-2-Clause), Expo modules & React Native (MIT), sql.js (MIT, tests only).
* **Audio:** the test melodies are original note sequences synthesised at runtime. No recordings are bundled. Imported audio is
  your responsibility to license.

## 10. Known limitations
* **Indoor and elevation detection are not field-tested yet** (emulator and unit tests only). Expect to tune minimum RSSI and
  observations per building; walls, bodies and phone models shift RSSI by 10 dB or more.
* With the screen off, Android stops delivering *unfiltered* BLE scan results. When all beacon checkpoints use Eddystone ids
  the app scans with the Eddystone service filter, which keeps working in the pocket; **iBeacon/MAC checkpoints need the screen
  on** (or Eddystone beacons).
* No geoid model: ellipsoid and mean-sea-level altitudes cannot be converted, so mismatched checkpoints never trigger (by
  design). Barometric relative height and QR/NFC checkpoints are not implemented.
* Phone GNSS altitude is typically ±5–15 m; elevation checkpoints separate levels tens of metres apart, not floors.
* Background playback with the screen off, OEM battery killers (Xiaomi, Oppo, Vivo, Samsung "deep
  sleep") and Doze behaviour must be verified with §7. Some phones need the app exempted from battery optimisation.
* Requires Google Play Services (Fused Location Provider via expo-location). There is no raw `LocationManager` fallback for
  Play-Services-free devices.
* After **Force stop**, a reboot, or the OS killing the service, tracking cannot restart until the user opens the app (it then
  restarts automatically). This is an Android restriction on starting location foreground services from the background.
* Offline map download is limited to the configured park bounds. Imported `.db` packs appear only after an app restart, and
  must share the configured style URL.
* Phone GPS under tree cover is often 10–30 m; very small radii (< 10 m) will be unreliable.
* No iOS testing (the code is mostly cross-platform, but background modes are configured for Android only).

## 11. Future improvements
* Barometer-based relative elevation (calibrated at a reference point), an offline geoid grid for ellipsoid ↔ MSL, and
  QR/NFC checkpoints.
* Native BLE scanning with hardware filters for iBeacon so screen-off scanning works without Eddystone.
* Sensor fusion / pedestrian dead reckoning to bridge GPS gaps.
* Draw or select the download area on the map; export and import checkpoint sets (JSON) with their audio.
* Per-checkpoint playback options (volume, loop, play-once-ever) and lock-screen controls.
* Raw `LocationManager` fallback for devices without Play Services.
* Run the Maestro flows in CI on an emulator with scripted `geo fix` routes.
