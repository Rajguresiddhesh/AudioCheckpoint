/**
 * Offline test-tone generator: synthesises short original note sequences into a
 * 16-bit mono PCM WAV so the app has working audio with no assets or network.
 */

export type MelodyId = 'chime' | 'bells' | 'beacon';

interface Note {
  /** MIDI note number; null = rest. */
  midi: number | null;
  beats: number;
}

export interface MelodyDefinition {
  id: MelodyId;
  label: string;
  bpm: number;
  notes: Note[];
}

const n = (midi: number | null, beats = 1): Note => ({ midi, beats });

export const MELODIES: Record<MelodyId, MelodyDefinition> = {
  // Rising major arpeggio.
  chime: {
    id: 'chime',
    label: 'Chime (rising)',
    bpm: 150,
    notes: [n(72), n(76), n(79), n(84, 2), n(null, 0.5), n(79), n(84, 3)],
  },
  // Descending bell figure.
  bells: {
    id: 'bells',
    label: 'Bells (falling)',
    bpm: 132,
    notes: [n(79), n(74), n(71), n(67, 2), n(null, 0.5), n(71), n(67, 3)],
  },
  // Repeated two-tone signal.
  beacon: {
    id: 'beacon',
    label: 'Beacon (two-tone)',
    bpm: 168,
    notes: [n(69), n(76), n(69), n(76), n(null, 1), n(69), n(76, 3)],
  },
};

export const MELODY_IDS = Object.keys(MELODIES) as MelodyId[];

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function renderMelodyPcm(def: MelodyDefinition, sampleRate = 22_050): Int16Array {
  const beatS = 60 / def.bpm;
  const totalS = def.notes.reduce((s, x) => s + x.beats * beatS, 0) + 0.4; // tail for decay
  const pcm = new Float32Array(Math.ceil(totalS * sampleRate));

  let offset = 0;
  for (const note of def.notes) {
    const durS = note.beats * beatS;
    if (note.midi != null) {
      const f = midiToHz(note.midi);
      const ringS = durS + 0.35;
      const count = Math.min(Math.floor(ringS * sampleRate), pcm.length - offset);
      for (let i = 0; i < count; i++) {
        const t = i / sampleRate;
        const attack = Math.min(1, t / 0.008);
        const env = attack * Math.exp(-t * 4.5);
        // Bell-ish timbre: fundamental plus two quieter partials.
        const v =
          Math.sin(2 * Math.PI * f * t) +
          0.35 * Math.sin(2 * Math.PI * 2 * f * t) +
          0.12 * Math.sin(2 * Math.PI * 3.01 * f * t);
        pcm[offset + i] += 0.32 * env * v;
      }
    }
    offset += Math.floor(durS * sampleRate);
  }

  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    out[i] = Math.round(s * 32767);
  }
  return out;
}

export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM format
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i], true);
  return new Uint8Array(buf);
}

export function generateMelodyWav(id: MelodyId, sampleRate = 22_050): Uint8Array {
  return encodeWav(renderMelodyPcm(MELODIES[id], sampleRate), sampleRate);
}
