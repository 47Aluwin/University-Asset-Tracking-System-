// Picking photos (camera or library) and showing uploaded attachments.
import * as ImagePicker from 'expo-image-picker';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { PrivateImage } from '@/components/private-image';
import { Body, Button, Row } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { API_URL, getApiToken, type UploadFile } from '@/lib/api';
import type { Attachment } from '@/lib/types';

export const MAX_PHOTOS = 5;

function toUpload(a: ImagePicker.ImagePickerAsset, i: number): UploadFile {
  const type = a.mimeType ?? 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  return { uri: a.uri, name: a.fileName ?? `photo-${i + 1}.${ext}`, type, file: a.file ?? undefined };
}

/** Lets the user add up to MAX_PHOTOS photos before saving; shows local previews. */
export function PhotoPicker({ photos, onChange }: { photos: UploadFile[]; onChange: (p: UploadFile[]) => void }) {
  const t = useTheme();
  const room = MAX_PHOTOS - photos.length;
  // Quality 0.6 keeps phone photos well under the 5 MB upload limit while staying clear enough to see damage.
  const pick = async (source: 'camera' | 'library') => {
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.6, allowsMultipleSelection: source === 'library', selectionLimit: room };
    if (source === 'camera' && Platform.OS !== 'web') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
    }
    const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (!r.canceled && r.assets?.length) onChange([...photos, ...r.assets.slice(0, room).map((a, i) => toUpload(a, photos.length + i))]);
  };
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: t.text, fontWeight: '600', fontSize: 15 }}>Photos (optional, up to {MAX_PHOTOS})</Text>
      {photos.length ? (
        <Row>
          {photos.map((p, i) => (
            <View key={`${p.uri}-${i}`} style={{ gap: 4, alignItems: 'center' }}>
              <Image source={{ uri: p.uri }} style={styles.thumb} accessibilityLabel={`Photo ${i + 1} to upload`} />
              <Text accessibilityRole="button" onPress={() => onChange(photos.filter((_, j) => j !== i))} style={{ color: t.danger, fontSize: 13 }}>
                Remove
              </Text>
            </View>
          ))}
        </Row>
      ) : null}
      {room > 0 ? (
        <Row>
          <Button title="Take photo" variant="secondary" onPress={() => pick('camera')} />
          <Button title="Choose photo" variant="secondary" onPress={() => pick('library')} />
        </Row>
      ) : null}
    </View>
  );
}

/** Uploaded attachments: photos as thumbnails, documents as links. */
export function AttachmentList({ items }: { items: Attachment[] }) {
  const t = useTheme();
  if (!items.length) return null;
  const photos = items.filter((a) => a.contentType.startsWith('image/'));
  const docs = items.filter((a) => !a.contentType.startsWith('image/'));
  const openDoc = async (a: Attachment) => {
    // Documents are private too: fetch with the session token, then let the device open the file.
    const token = getApiToken();
    {
      const r = await fetch(`${API_URL}/attachments/${a.id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!r.ok) return;
      const url = URL.createObjectURL(await r.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = a.fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  };
  return (
    <View style={{ gap: 8 }}>
      {photos.length ? (
        <Row>
          {photos.map((a) => (
            <PrivateImage key={a.id} attachmentId={a.id} style={styles.thumb} label={`Photo ${a.fileName}, uploaded by ${a.uploadedBy}`} />
          ))}
        </Row>
      ) : null}
      {docs.map((a) =>
        // Browsers can download private files with the session token; on phones that needs a download
        // step not built yet, so documents are listed and opened from the browser version.
        Platform.OS === 'web' ? (
          <Pressable key={a.id} accessibilityRole="link" onPress={() => openDoc(a)}>
            <Text style={{ color: t.primary, textDecorationLine: 'underline' }}>
              📄 {a.fileName} ({Math.ceil(a.sizeBytes / 1024)} KB)
            </Text>
          </Pressable>
        ) : (
          <Text key={a.id} style={{ color: t.text }}>
            📄 {a.fileName} ({Math.ceil(a.sizeBytes / 1024)} KB) — open in the browser version
          </Text>
        ),
      )}
      <Body muted>
        {items.length} {items.length === 1 ? 'file' : 'files'}
      </Body>
    </View>
  );
}

const styles = StyleSheet.create({
  thumb: { width: 96, height: 96, borderRadius: 8, backgroundColor: '#ddd' },
});
