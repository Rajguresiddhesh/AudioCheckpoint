import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { deleteImportedAudio, importAudioFile, listImportedAudio, resolvePlayableUri } from '../audio/audioFiles';
import { melodyRef } from '../audio/audioValidation';
import { MELODIES, MELODY_IDS } from '../audio/melody';
import { formatBytes } from '../map/packStatus';
import { PREVIEW_PREFIX } from '../tracking/trackingController';
import { Banner, Button, Card, Loading, Muted, Row, Screen, colors, styles } from '../ui/components';
import { useCheckpoints, useServices, useTrackingStatus } from '../ui/hooks';

/** Audio library: preview test melodies and imported files; optionally assign one to a checkpoint. */
export default function AudioLibrary() {
  const { checkpointId } = useLocalSearchParams<{ checkpointId?: string }>();
  const { services } = useServices();
  const status = useTrackingStatus(services);
  const { checkpoints, reload } = useCheckpoints(services);
  const [files, setFiles] = useState<{ uri: string; name: string; size: number }[]>(safeList);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const refresh = useCallback(() => setFiles(safeList()), []);

  if (!services) return <Loading />;
  const target = checkpoints.find((c) => c.id === checkpointId) ?? null;

  const preview = async (ref: string, label: string) => {
    setMessage(null);
    const r = await services.audio.preview({ checkpointId: `${PREVIEW_PREFIX}library`, label, uri: await resolvePlayableUri(ref) });
    if (r !== 'started') setMessage({ tone: 'bad', text: services.audio.getState().lastError ?? 'Could not play.' });
  };

  const assign = async (ref: string, label: string) => {
    if (!target) return;
    await services.checkpoints.setAudio(target.id, ref, label);
    await services.controller.reloadCheckpoints();
    await reload();
    setMessage({ tone: 'good', text: `Assigned "${label}" to ${target.name}.` });
  };

  const onImport = async () => {
    const r = await importAudioFile();
    if (!r) return;
    if ('error' in r) setMessage({ tone: 'bad', text: r.error });
    else {
      setMessage({ tone: 'good', text: `Imported "${r.label}".` });
      refresh();
    }
  };

  const onDelete = async (uri: string, name: string) => {
    if (await services.checkpoints.isAudioReferenced(uri)) {
      setMessage({ tone: 'bad', text: `"${name}" is used by a checkpoint. Assign different audio first.` });
      return;
    }
    Alert.alert('Delete audio', `Delete "${name}" from this phone?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteImportedAudio(uri);
          refresh();
        },
      },
    ]);
  };

  const Item = ({ refId, label, sub, onDel }: { refId: string; label: string; sub?: string; onDel?: () => void }) => (
    <View style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 8, gap: 6 }}>
      <Text style={styles.body}>{label}</Text>
      {sub ? <Muted>{sub}</Muted> : null}
      <Row>
        <Button label="Preview" variant="secondary" onPress={() => void preview(refId, label)} />
        {target ? <Button label={`Use for ${target.name}`} onPress={() => void assign(refId, label)} /> : null}
        {onDel ? <Button label="Delete" variant="danger" onPress={onDel} /> : null}
      </Row>
    </View>
  );

  return (
    <Screen>
      {target ? <Banner tone="info">Choosing audio for “{target.name}”.</Banner> : null}
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
      <Row>
        <Button label="Stop playback" variant="secondary" onPress={() => void services.audio.stop()} />
        <Text style={styles.hint}>
          {status?.audio.current ? `${status.audio.status}: ${status.audio.current.label}` : 'Nothing playing'}
        </Text>
      </Row>

      <Card title="Test melodies (generated on the phone)">
        <Muted>Original tone sequences synthesised offline. Use them until your real audio is ready.</Muted>
        {MELODY_IDS.map((id) => (
          <Item key={id} refId={melodyRef(id)} label={MELODIES[id].label} />
        ))}
      </Card>

      <Card title="Imported audio">
        <Muted>Files are copied into the app’s private storage so they keep working offline.</Muted>
        {files.length === 0 ? <Muted>No imported files yet.</Muted> : null}
        {files.map((f) => (
          <Item key={f.uri} refId={f.uri} label={f.name} sub={formatBytes(f.size)} onDel={() => void onDelete(f.uri, f.name)} />
        ))}
        <Button label="Import audio file…" onPress={() => void onImport()} />
      </Card>

      {!target && checkpoints.length > 0 ? (
        <Card title="Assign to a checkpoint">
          <Muted>Open a checkpoint in Creator Mode to change its audio, or pick one here:</Muted>
          <Row>
            {checkpoints.map((c) => (
              <Button
                key={c.id}
                label={c.name}
                variant="secondary"
                onPress={() => router.setParams({ checkpointId: c.id })}
              />
            ))}
          </Row>
        </Card>
      ) : null}
    </Screen>
  );
}

function safeList() {
  try {
    return listImportedAudio();
  } catch {
    return [];
  }
}
