// iOS / Android: attachments are private, so the image request carries the session token.
import { Image, type ImageStyle, type StyleProp } from 'react-native';

import { API_URL, getApiToken } from '@/lib/api';

export function PrivateImage({ attachmentId, style, label }: { attachmentId: string; style?: StyleProp<ImageStyle>; label: string }) {
  const token = getApiToken();
  return (
    <Image
      accessibilityLabel={label}
      style={style}
      resizeMode="cover"
      source={{ uri: `${API_URL}/attachments/${attachmentId}`, headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
    />
  );
}
