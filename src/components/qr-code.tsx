import { useMemo } from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { qrSvg } from '@shared/labels';

/**
 * On-screen QR code for an asset. Uses the same generator as printed labels, always black on white
 * with its quiet zone (also in dark mode), so what staff see is exactly what scanners read.
 */
export function QrCode({ payload, size = 160, label }: { payload: string; size?: number; label?: string }) {
  const xml = useMemo(() => qrSvg(payload), [payload]);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label ?? `QR code for ${payload}`}
      testID="asset-qr"
      style={{ width: size, height: size, backgroundColor: '#fff' }}>
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  );
}
