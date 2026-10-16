import type { DownloadStatus } from '../data/models';

export interface PackProgress {
  state: 'inactive' | 'active' | 'complete';
  percentage: number;
  completedResourceCount: number;
  requiredResourceCount: number;
  completedResourceSize?: number;
}

/**
 * A pack is only "complete" when the native store says so AND every required
 * resource (style, sprites, glyphs, tiles) is present. Anything else is never
 * advertised as available offline.
 */
export function evaluatePackStatus(p: PackProgress): DownloadStatus {
  const allResources = p.requiredResourceCount > 0 && p.completedResourceCount >= p.requiredResourceCount;
  if (p.state === 'complete' && allResources) return 'complete';
  if (p.state === 'active') return 'downloading';
  return 'incomplete';
}

const SQLITE_MAGIC = 'SQLite format 3\u0000';

/** MapLibre offline databases are SQLite files; reject anything else before merging. */
export function looksLikeSqlite(header: Uint8Array): boolean {
  if (header.length < 16) return false;
  for (let i = 0; i < 16; i++) if (header[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  return true;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
