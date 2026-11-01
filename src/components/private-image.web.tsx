// Browser: an <img> cannot send the session token, so the photo is fetched with the token and shown
// from a temporary in-memory URL that is released when the component goes away.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Text, View, type ImageStyle, type StyleProp } from 'react-native';

import { API_URL, getApiToken } from '@/lib/api';

export function PrivateImage({ attachmentId, style, label }: { attachmentId: string; style?: StyleProp<ImageStyle>; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let live = true;
    const token = getApiToken();
    fetch(`${API_URL}/attachments/${attachmentId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        objectUrl = URL.createObjectURL(b);
        if (live) setUrl(objectUrl);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);

  if (failed) {
    return (
      <View style={[style as object, { alignItems: 'center', justifyContent: 'center' }]}>
        <Text>Image unavailable</Text>
      </View>
    );
  }
  if (!url) {
    return (
      <View style={[style as object, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator />
      </View>
    );
  }
  return <Image accessibilityLabel={label} style={style} resizeMode="cover" source={{ uri: url }} />;
}
