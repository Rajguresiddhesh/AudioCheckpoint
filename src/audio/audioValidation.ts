import { MELODY_IDS, type MelodyId } from './melody';

export const MELODY_PREFIX = 'melody:';
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

/** Formats Android's media stack (Media3/ExoPlayer under expo-audio) plays reliably. */
export const SUPPORTED_AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac'];

export function melodyRef(id: MelodyId): string {
  return `${MELODY_PREFIX}${id}`;
}

export function parseMelodyRef(ref: string | null | undefined): MelodyId | null {
  if (!ref || !ref.startsWith(MELODY_PREFIX)) return null;
  const id = ref.slice(MELODY_PREFIX.length) as MelodyId;
  return MELODY_IDS.includes(id) ? id : null;
}

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

export interface AudioCandidate {
  name: string;
  mimeType?: string | null;
  size?: number | null;
}

export type AudioImportCheck = { ok: true; extension: string } | { ok: false; reason: string };

export function validateAudioImport(file: AudioCandidate): AudioImportCheck {
  const ext = extensionOf(file.name);
  const mimeOk = !!file.mimeType && file.mimeType.startsWith('audio/');
  if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) {
    if (!mimeOk) {
      return {
        ok: false,
        reason: `Unsupported file type. Use one of: ${SUPPORTED_AUDIO_EXTENSIONS.join(', ')}.`,
      };
    }
  }
  if (file.mimeType && !mimeOk && file.mimeType !== 'application/octet-stream') {
    return { ok: false, reason: `"${file.name}" is not an audio file (${file.mimeType}).` };
  }
  if (file.size != null) {
    if (file.size <= 0) return { ok: false, reason: 'The file is empty.' };
    if (file.size > MAX_AUDIO_BYTES) return { ok: false, reason: 'The file is larger than 50 MB.' };
  }
  return { ok: true, extension: SUPPORTED_AUDIO_EXTENSIONS.includes(ext) ? ext : 'audio' };
}

export function describeAudioRef(ref: string | null, label: string | null): string {
  const melody = parseMelodyRef(ref);
  if (melody) return `Test melody: ${melody}`;
  if (ref) return label ? `File: ${label}` : 'Imported file';
  return 'No audio';
}
