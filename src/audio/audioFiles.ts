import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { parseMelodyRef, validateAudioImport } from './audioValidation';
import { generateMelodyWav } from './melody';

const MELODY_VERSION = 1;

function audioDir(): Directory {
  const dir = new Directory(Paths.document, 'audio');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Resolve a stored audio reference to a playable local file URI.
 * Test melodies are synthesised on first use and cached in app storage.
 */
export async function resolvePlayableUri(ref: string | null): Promise<string | null> {
  if (!ref) return null;
  const melody = parseMelodyRef(ref);
  if (melody) {
    const file = new File(audioDir(), `melody-${melody}-v${MELODY_VERSION}.wav`);
    if (!file.exists) {
      file.create({ overwrite: true });
      file.write(generateMelodyWav(melody));
    }
    return file.uri;
  }
  return ref;
}

export async function audioFileExists(uri: string): Promise<boolean> {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

export type ImportResult = { uri: string; label: string } | { error: string } | null;

/**
 * Pick an audio file through Android's Storage Access Framework and copy it into
 * app-private storage, so playback never depends on a SAF grant that can expire
 * or on the original file staying where it was.
 */
export async function importAudioFile(): Promise<ImportResult> {
  const res = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled) return null;
  const asset = res.assets[0];
  const check = validateAudioImport({ name: asset.name, mimeType: asset.mimeType, size: asset.size });
  if (!check.ok) return { error: check.reason };

  const src = new File(asset.uri);
  const dest = new File(audioDir(), `${Crypto.randomUUID()}.${check.extension}`);
  try {
    src.copySync(dest);
  } catch (e) {
    return { error: `Could not copy the file: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    try {
      if (src.uri.includes('/cache/')) src.delete();
    } catch {
      // cache cleanup is best effort
    }
  }
  if (!dest.exists || dest.size === 0) return { error: 'The copied file is empty.' };
  return { uri: dest.uri, label: asset.name };
}

/** List imported (non-generated) audio files in app storage. */
export function listImportedAudio(): { uri: string; name: string; size: number }[] {
  return audioDir()
    .list()
    .filter((e): e is File => e instanceof File && !e.name.startsWith('melody-'))
    .map((f) => ({ uri: f.uri, name: f.name, size: f.size }));
}

/** Delete an imported file inside the app's audio folder (never touches anything else). */
export function deleteImportedAudio(uri: string): void {
  const dir = audioDir();
  if (!uri.startsWith(dir.uri)) return;
  const f = new File(uri);
  if (f.exists) f.delete();
}

export function deleteAllAudio(): void {
  const dir = new Directory(Paths.document, 'audio');
  if (dir.exists) dir.delete();
}
