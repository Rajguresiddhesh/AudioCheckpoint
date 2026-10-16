import { OfflineManager, type OfflinePack } from '@maplibre/maplibre-react-native';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import type { Bounds, MapPackage } from '../data/models';
import type { MapPackageRepository } from '../data/repositories';
import { evaluatePackStatus, looksLikeSqlite } from './packStatus';

/**
 * Offline maps use MapLibre's native offline store: a pack captures the style,
 * sprites, glyphs and every vector tile for a bounding box and zoom range, so
 * the map renders with no network. Our map_packages table mirrors the packs and
 * only marks one usable after verifying it against the native store.
 */

export interface DownloadRequest {
  name: string;
  bounds: Bounds;
  minZoom: number;
  maxZoom: number;
  styleUrl: string;
}

export async function downloadPackage(
  repo: MapPackageRepository,
  req: DownloadRequest,
  onProgress: (percentage: number) => void,
): Promise<MapPackage> {
  const pkg = await repo.create({
    name: req.name,
    localPath: null,
    offlinePackId: null,
    styleUrl: req.styleUrl,
    bounds: req.bounds,
    minZoom: req.minZoom,
    maxZoom: req.maxZoom,
    downloadStatus: 'downloading',
  });
  try {
    const pack = await OfflineManager.createPack(
      {
        mapStyle: req.styleUrl,
        bounds: [req.bounds.west, req.bounds.south, req.bounds.east, req.bounds.north],
        minZoom: req.minZoom,
        maxZoom: req.maxZoom,
        metadata: { packageId: pkg.id, name: req.name },
      },
      (_pack, status) => {
        onProgress(status.percentage);
        const result = evaluatePackStatus(status);
        void repo.updateStatus(pkg.id, {
          downloadStatus: result,
          progress: status.percentage,
          sizeBytes: status.completedResourceSize,
          verified: result === 'complete',
        });
      },
      (_pack, err) => {
        void repo.updateStatus(pkg.id, { downloadStatus: 'failed', error: err.message });
      },
    );
    await repo.updateStatus(pkg.id, { downloadStatus: 'downloading', offlinePackId: pack.id });
  } catch (e) {
    await repo.updateStatus(pkg.id, {
      downloadStatus: 'failed',
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return (await repo.list()).find((p) => p.id === pkg.id)!;
}

async function findNativePack(pkg: MapPackage): Promise<OfflinePack | null> {
  const packs = await OfflineManager.getPacks();
  return (
    packs.find((p) => p.id === pkg.offlinePackId) ??
    packs.find((p) => (p.metadata as { packageId?: string })?.packageId === pkg.id) ??
    null
  );
}

/** Re-check one package against the native store; never trust the stored flag alone. */
export async function verifyPackage(repo: MapPackageRepository, pkg: MapPackage): Promise<MapPackage['downloadStatus']> {
  try {
    const pack = await findNativePack(pkg);
    if (!pack) {
      await repo.updateStatus(pkg.id, { downloadStatus: 'missing', error: 'Offline data not found on this device.' });
      return 'missing';
    }
    const status = await pack.status();
    const result = evaluatePackStatus(status);
    await repo.updateStatus(pkg.id, {
      downloadStatus: result,
      progress: status.percentage,
      sizeBytes: status.completedResourceSize,
      verified: result === 'complete',
      offlinePackId: pack.id,
    });
    return result;
  } catch (e) {
    await repo.updateStatus(pkg.id, {
      downloadStatus: 'failed',
      error: `Verification failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return 'failed';
  }
}

/**
 * Verify all known packages and register native packs that have no row yet
 * (e.g. merged from an imported file on a previous run).
 */
export async function verifyAll(repo: MapPackageRepository, styleUrl: string): Promise<void> {
  const rows = await repo.list();
  // Rows created by importOfflineDatabase(): file merged, native pack ids not known yet.
  const importPlaceholders = rows.filter((r) => r.localPath && !r.offlinePackId);
  for (const r of rows) {
    if (r.downloadStatus !== 'downloading' && !importPlaceholders.includes(r)) await verifyPackage(repo, r);
  }
  let packs: OfflinePack[] = [];
  try {
    packs = await OfflineManager.getPacks();
  } catch {
    return;
  }
  const known = new Set((await repo.list()).map((r) => r.offlinePackId));
  const unregistered = packs.filter((p) => !known.has(p.id));
  for (const ph of importPlaceholders) {
    if (unregistered.length > 0) {
      // Merged regions now live in the native store; the copied .db is no longer needed.
      await deletePackage(repo, { ...ph, offlinePackId: null });
    } else {
      await repo.updateStatus(ph.id, {
        downloadStatus: 'failed',
        error: 'The imported file did not contain any offline regions.',
      });
    }
  }
  for (const p of unregistered) {
    if (known.has(p.id)) continue;
    const [west, south, east, north] = p.bounds;
    const meta = p.metadata as { name?: string; styleUrl?: string };
    const created = await repo.create({
      name: meta.name ?? 'Imported offline map',
      localPath: null,
      offlinePackId: p.id,
      styleUrl: meta.styleUrl ?? styleUrl,
      bounds: { west, south, east, north },
      minZoom: 0,
      maxZoom: 22,
      downloadStatus: 'pending',
    });
    await verifyPackage(repo, created);
  }
}

export async function deletePackage(repo: MapPackageRepository, pkg: MapPackage): Promise<void> {
  try {
    const pack = await findNativePack(pkg);
    if (pack) await OfflineManager.deletePack(pack.id);
  } catch {
    // Row removal below still lets the user recover from a broken pack.
  }
  if (pkg.localPath) {
    try {
      const f = new File(pkg.localPath);
      if (f.exists) f.delete();
    } catch {
      // ignore
    }
  }
  await repo.delete(pkg.id);
}

export type ImportOutcome = { ok: true; message: string } | { ok: false; message: string } | null;

/**
 * Import a MapLibre offline database (.db) prepared on another device or with
 * MapLibre tooling, merging its regions into this device's offline store.
 */
export async function importOfflineDatabase(repo: MapPackageRepository): Promise<ImportOutcome> {
  const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
  if (res.canceled) return null;
  const asset = res.assets[0];
  const src = new File(asset.uri);
  if (!src.exists || src.size < 1024) return { ok: false, message: 'The selected file is empty or too small.' };

  const handle = src.open();
  let header: Uint8Array;
  try {
    header = handle.readBytes(16);
  } finally {
    handle.close();
  }
  if (!looksLikeSqlite(header)) {
    return { ok: false, message: 'Not a MapLibre offline database (expected an SQLite .db file).' };
  }

  const dir = new Directory(Paths.document, 'maps');
  if (!dir.exists) dir.create({ intermediates: true });
  const dest = new File(dir, `${Crypto.randomUUID()}.db`);
  src.copySync(dest);
  try {
    src.delete();
  } catch {
    // best effort
  }

  try {
    await OfflineManager.mergeOfflineRegions(decodeURIComponent(dest.uri.replace(/^file:\/\//, '')));
  } catch (e) {
    dest.delete();
    return {
      ok: false,
      message: `The file could not be merged (corrupted or incompatible): ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  await repo.create({
    name: asset.name,
    localPath: dest.uri,
    offlinePackId: null,
    styleUrl: null,
    bounds: { west: -180, south: -85, east: 180, north: 85 },
    minZoom: 0,
    maxZoom: 22,
    downloadStatus: 'pending',
  });
  return {
    ok: true,
    message: 'Imported. Restart the app so the merged regions can be verified and listed.',
  };
}
