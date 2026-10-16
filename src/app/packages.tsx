import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { SITE } from '../config/site';
import type { MapPackage } from '../data/models';
import { deletePackage, downloadPackage, importOfflineDatabase, verifyAll, verifyPackage } from '../map/offlineMaps';
import { formatBytes } from '../map/packStatus';
import { Banner, Body, Button, Card, Field, Loading, Muted, Row, Screen, StatusRow, colors, styles } from '../ui/components';
import { fmtTime, parseNumber } from '../ui/format';
import { useInterval, useServices } from '../ui/hooks';

const STATUS_TONE = {
  complete: 'good',
  downloading: 'info',
  pending: 'muted',
  incomplete: 'warn',
  failed: 'bad',
  missing: 'bad',
} as const;

export default function OfflineMaps() {
  const { services } = useServices();
  const [packages, setPackages] = useState<MapPackage[]>([]);
  const [name, setName] = useState(SITE.name);
  const [minZoom, setMinZoom] = useState(String(SITE.minZoom));
  const [maxZoom, setMaxZoom] = useState(String(SITE.maxZoom));
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (services) setPackages(await services.mapPackages.list());
  }, [services]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  // Poll while a download is running so progress written by the native listener shows up.
  useInterval(() => {
    if (packages.some((p) => p.downloadStatus === 'downloading')) void reload();
  }, 1500);

  if (!services) return <Loading />;
  const usable = packages.find((p) => p.downloadStatus === 'complete' && p.verifiedAt != null);

  const download = async () => {
    const zMin = parseNumber(minZoom);
    const zMax = parseNumber(maxZoom);
    if (zMin == null || zMax == null || zMin < 0 || zMax > 20 || zMin > zMax) {
      setMessage({ tone: 'bad', text: 'Zoom range must be within 0–20 and min ≤ max.' });
      return;
    }
    setBusy(true);
    setMessage({ tone: 'info', text: 'Downloading… keep the app open and stay online until it completes.' });
    try {
      const s = await services.settings.load();
      const pkg = await downloadPackage(
        services.mapPackages,
        { name: name.trim() || SITE.name, bounds: SITE.bounds, minZoom: zMin, maxZoom: zMax, styleUrl: s.mapStyleUrl },
        (p) => setProgress(p),
      );
      if (pkg.downloadStatus === 'failed') setMessage({ tone: 'bad', text: pkg.error ?? 'Download failed.' });
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const verify = async (p: MapPackage) => {
    const r = await verifyPackage(services.mapPackages, p);
    setMessage({
      tone: r === 'complete' ? 'good' : 'bad',
      text: r === 'complete' ? `"${p.name}" verified: all resources present.` : `"${p.name}" is ${r}.`,
    });
    await reload();
  };

  const remove = (p: MapPackage) =>
    Alert.alert('Delete offline map', `Delete "${p.name}" from this phone?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deletePackage(services.mapPackages, p);
          await reload();
        },
      },
    ]);

  const importFile = async () => {
    setBusy(true);
    try {
      const r = await importOfflineDatabase(services.mapPackages);
      if (r) setMessage({ tone: r.ok ? 'good' : 'bad', text: r.message });
    } catch (e) {
      setMessage({ tone: 'bad', text: `Import failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const reverify = async () => {
    const s = await services.settings.load();
    await verifyAll(services.mapPackages, s.mapStyleUrl);
    await reload();
  };

  return (
    <Screen>
      <Banner tone={usable ? 'good' : 'warn'}>
        {usable
          ? `Offline map available: "${usable.name}" (verified ${fmtTime(usable.verifiedAt!)}).`
          : 'No verified offline map on this phone. The app still works offline using the schematic view.'}
      </Banner>
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}

      <Card title="Packages on this phone">
        {packages.length === 0 ? <Muted>None.</Muted> : null}
        {packages.map((p) => (
          <View key={p.id} style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 8, gap: 4 }}>
            <Text style={styles.cardTitle}>{p.name}</Text>
            <StatusRow
              label="Status"
              value={p.downloadStatus === 'downloading' ? `Downloading ${p.progress.toFixed(0)}%` : p.downloadStatus}
              tone={STATUS_TONE[p.downloadStatus]}
            />
            <StatusRow label="Size" value={formatBytes(p.sizeBytes)} />
            <StatusRow label="Zoom" value={`${p.minZoom}–${p.maxZoom}`} />
            {p.verifiedAt ? <StatusRow label="Verified" value={fmtTime(p.verifiedAt)} tone="good" /> : null}
            {p.error ? <Text style={styles.error}>{p.error}</Text> : null}
            <Row>
              <Button label="Verify" variant="secondary" onPress={() => void verify(p)} />
              <Button label="Delete" variant="danger" onPress={() => remove(p)} />
            </Row>
          </View>
        ))}
        {packages.length > 0 ? <Button label="Re-check all" variant="secondary" onPress={() => void reverify()} /> : null}
      </Card>

      <Card title="Download the park area (needs internet now)">
        <Muted>
          Area: {SITE.bounds.south.toFixed(4)}–{SITE.bounds.north.toFixed(4)} N, {SITE.bounds.west.toFixed(4)}–
          {SITE.bounds.east.toFixed(4)} E (about 650 × 650 m around {SITE.name}). Map data: OpenStreetMap via OpenFreeMap.
        </Muted>
        <Field label="Package name" value={name} onChangeText={setName} />
        <Row>
          <View style={{ flex: 1 }}>
            <Field label="Min zoom" value={minZoom} onChangeText={setMinZoom} keyboardType="numeric" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Max zoom" value={maxZoom} onChangeText={setMaxZoom} keyboardType="numeric" />
          </View>
        </Row>
        {progress != null && busy ? <Muted>Progress: {progress.toFixed(0)}%</Muted> : null}
        <Button label="Download for offline use" onPress={() => void download()} busy={busy} />
      </Card>

      <Card title="Import a prepared offline map file">
        <Body>
          Import a MapLibre offline database (.db) made on another phone running this app or with MapLibre tooling.
          It is checked, copied into app storage and merged. Restart the app afterwards to verify and list it.
        </Body>
        <Muted>
          The pack must use the same style URL as Settings → Map style, or the map will not find its tiles offline.
        </Muted>
        <Button label="Import .db file…" variant="secondary" onPress={() => void importFile()} busy={busy} />
      </Card>
    </Screen>
  );
}
