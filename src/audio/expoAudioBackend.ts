import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioBackend, PlaybackHandle } from './audioManager';

const LOAD_TIMEOUT_MS = 8000;

/** Audio session suitable for a walking tour: plays with screen off / app in background. */
export async function configureAudioSession(): Promise<void> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: 'duckOthers',
    allowsRecording: false,
    shouldRouteThroughEarpiece: false,
  });
}

/** expo-audio (Media3/ExoPlayer on Android) implementation of the playback backend. */
export class ExpoAudioBackend implements AudioBackend {
  async start(
    uri: string,
    cb: { onFinish: () => void; onError: (message: string) => void },
  ): Promise<PlaybackHandle> {
    const player = createAudioPlayer({ uri }, { updateInterval: 250 });
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(loadTimer);
      sub.remove();
      try {
        player.pause();
      } catch {
        // player may already be torn down
      }
      player.remove();
    };

    const sub = player.addListener('playbackStatusUpdate', (status) => {
      if (status.didJustFinish) {
        release();
        cb.onFinish();
      }
    });

    const loadTimer = setTimeout(() => {
      if (!released && !player.isLoaded) {
        release();
        cb.onError('Audio could not be loaded (unsupported or corrupted file).');
      }
    }, LOAD_TIMEOUT_MS);

    player.play();

    return {
      stop: release,
      pause: () => {
        if (!released) player.pause();
      },
      resume: () => {
        if (!released) player.play();
      },
    };
  }
}
