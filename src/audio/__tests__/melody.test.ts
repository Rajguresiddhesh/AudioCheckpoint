import { describeAudioRef, melodyRef, parseMelodyRef, validateAudioImport } from '../audioValidation';
import { MELODY_IDS, encodeWav, generateMelodyWav, midiToHz } from '../melody';

describe('generated test melody', () => {
  it('maps MIDI 69 to 440 Hz', () => {
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(81)).toBeCloseTo(880, 9);
  });

  it.each(MELODY_IDS)('%s renders a valid 16-bit mono PCM WAV of a few seconds', (id) => {
    const wav = generateMelodyWav(id, 22_050);
    const v = new DataView(wav.buffer);
    const str = (o: number, n: number) => String.fromCharCode(...wav.slice(o, o + n));
    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(str(12, 4)).toBe('fmt ');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(22_050);
    expect(v.getUint16(34, true)).toBe(16);
    expect(str(36, 4)).toBe('data');
    const dataBytes = v.getUint32(40, true);
    expect(wav.length).toBe(44 + dataBytes);
    expect(v.getUint32(4, true)).toBe(36 + dataBytes);
    const seconds = dataBytes / 2 / 22_050;
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(6);
    // Not silent, not clipped everywhere.
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(v.getInt16(i, true)));
    expect(peak).toBeGreaterThan(3000);
    expect(peak).toBeLessThanOrEqual(32767);
  });

  it('different melodies produce different audio', () => {
    const a = generateMelodyWav('chime');
    const b = generateMelodyWav('bells');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('encodeWav handles empty input', () => {
    expect(encodeWav(new Int16Array(0), 8000).length).toBe(44);
  });
});

describe('audio references and import validation', () => {
  it('round-trips melody references and rejects unknown ones', () => {
    expect(parseMelodyRef(melodyRef('chime'))).toBe('chime');
    expect(parseMelodyRef('melody:unknown')).toBeNull();
    expect(parseMelodyRef('file:///x.mp3')).toBeNull();
    expect(parseMelodyRef(null)).toBeNull();
    expect(describeAudioRef(null, null)).toBe('No audio');
  });

  it('accepts common audio files and rejects other types, empty or huge files', () => {
    expect(validateAudioImport({ name: 'Swing.mp3', mimeType: 'audio/mpeg', size: 1000 }).ok).toBe(true);
    expect(validateAudioImport({ name: 'clip', mimeType: 'audio/ogg', size: 1000 }).ok).toBe(true);
    expect(validateAudioImport({ name: 'notes.pdf', mimeType: 'application/pdf', size: 1000 }).ok).toBe(false);
    expect(validateAudioImport({ name: 'evil.mp3', mimeType: 'image/png', size: 1000 }).ok).toBe(false);
    expect(validateAudioImport({ name: 'a.wav', mimeType: 'audio/wav', size: 0 }).ok).toBe(false);
    expect(validateAudioImport({ name: 'a.wav', mimeType: 'audio/wav', size: 60 * 1024 * 1024 }).ok).toBe(false);
  });
});
