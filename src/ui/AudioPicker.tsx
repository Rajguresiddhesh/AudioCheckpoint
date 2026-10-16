import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { importAudioFile, listImportedAudio, resolvePlayableUri } from '../audio/audioFiles';
import { describeAudioRef, melodyRef, parseMelodyRef } from '../audio/audioValidation';
import { MELODIES, MELODY_IDS } from '../audio/melody';
import type { Services } from '../tracking/runtime';
import { PREVIEW_PREFIX } from '../tracking/trackingController';
import { Banner, Button, Chip, Muted, Row, styles } from './components';

export interface AudioChoice {
  uri: string | null;
  label: string | null;
}

/** Choose a generated test melody, an imported file, or none; preview with the shared player. */
export function AudioPicker({
  services,
  value,
  onChange,
}: {
  services: Services;
  value: AudioChoice;
  onChange: (v: AudioChoice) => void;
}) {
  const [files, setFiles] = useState<{ uri: string; name: string }[]>(safeList);
  const [message, setMessage] = useState<{ tone: 'bad' | 'good'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => setFiles(safeList()), []);

  const selectedMelody = parseMelodyRef(value.uri);

  const onImport = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await importAudioFile();
      if (!r) return;
      if ('error' in r) setMessage({ tone: 'bad', text: r.error });
      else {
        onChange({ uri: r.uri, label: r.label });
        setMessage({ tone: 'good', text: `Imported "${r.label}".` });
        refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const onPreview = async () => {
    setMessage(null);
    const uri = await resolvePlayableUri(value.uri);
    const r = await services.audio.preview({
      checkpointId: `${PREVIEW_PREFIX}picker`,
      label: value.label ?? 'Preview',
      uri,
    });
    if (r !== 'started') setMessage({ tone: 'bad', text: services.audio.getState().lastError ?? 'Could not play audio.' });
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.fieldLabel}>Audio</Text>
      <Muted>{describeAudioRef(value.uri, value.label)}</Muted>
      <Row>
        <Chip label="None" selected={value.uri == null} onPress={() => onChange({ uri: null, label: null })} />
        {MELODY_IDS.map((id) => (
          <Chip
            key={id}
            label={MELODIES[id].label}
            selected={selectedMelody === id}
            onPress={() => onChange({ uri: melodyRef(id), label: MELODIES[id].label })}
          />
        ))}
      </Row>
      {files.length > 0 ? (
        <>
          <Muted>Imported files</Muted>
          <Row>
            {files.map((f) => (
              <Chip key={f.uri} label={f.name} selected={value.uri === f.uri} onPress={() => onChange({ uri: f.uri, label: f.name })} />
            ))}
          </Row>
        </>
      ) : null}
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
      <Row>
        <Button label="Import audio file…" variant="secondary" onPress={onImport} busy={busy} />
        <Button label="Preview" variant="secondary" onPress={onPreview} disabled={value.uri == null} />
        <Button label="Stop" variant="secondary" onPress={() => void services.audio.stop()} />
      </Row>
    </View>
  );
}

function safeList() {
  try {
    return listImportedAudio();
  } catch {
    return [];
  }
}
