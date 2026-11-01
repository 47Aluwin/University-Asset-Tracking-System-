// Camera QR scanner for asset labels (iOS, Android and supported browsers via expo-camera).
// Only university asset codes are accepted; anything else is reported, never acted on.
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { Body, Button, Card, Notice } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { parseScannedCode } from '@shared/asset-codes';

/** The same code read again within this time is ignored (the camera reports many frames per second). */
const REPEAT_IGNORE_MS = 3000;

export function QrScanner({
  onAssetCode,
  active = true,
  hint = 'Point the camera at the QR code on the asset label.',
}: {
  /** Called with the institutional ID (e.g. UAT-2026-000123) and the raw scanned text. */
  onAssetCode: (institutionalId: string, raw: string) => void;
  /** Turn off when the screen is not visible or while a result is being handled. */
  active?: boolean;
  hint?: string;
}) {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [notOurs, setNotOurs] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const last = useRef<{ data: string; at: number }>({ data: '', at: 0 });

  const handle = (r: BarcodeScanningResult) => {
    const now = Date.now();
    if (r.data === last.current.data && now - last.current.at < REPEAT_IGNORE_MS) return;
    last.current = { data: r.data, at: now };
    const id = parseScannedCode(r.data);
    if (!id) {
      setNotOurs('That code is not a University asset label. Scan the QR code printed on the asset tag.');
      return;
    }
    setNotOurs(null);
    onAssetCode(id, r.data);
  };

  if (!permission) {
    return <Body muted>Checking camera access…</Body>;
  }
  if (!permission.granted) {
    return (
      <Card>
        <Body>The camera is used only to read asset QR labels. Nothing is recorded or uploaded.</Body>
        {permission.canAskAgain ? (
          <Button title="Allow camera" onPress={() => requestPermission()} />
        ) : (
          <>
            <Notice kind="warning">Camera access is turned off for this app.</Notice>
            {Platform.OS !== 'web' ? <Button title="Open settings" variant="secondary" onPress={() => Linking.openSettings()} /> : null}
            {Platform.OS === 'web' ? <Body muted>Allow camera access in your browser’s site settings, then reload the page.</Body> : null}
          </>
        )}
        <Body muted>You can also type the asset ID printed under the QR code instead.</Body>
      </Card>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={[styles.frame, { borderColor: t.primary }]} accessible accessibilityLabel="Camera viewfinder for scanning asset QR codes">
        {active ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handle}
            onMountError={(e) => setCameraError(e.message || 'The camera could not be started.')}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.paused]}>
            <Text style={{ color: '#fff' }}>Camera paused</Text>
          </View>
        )}
        <View pointerEvents="none" style={styles.target} />
      </View>
      <Body muted style={{ textAlign: 'center' }}>{hint}</Body>
      {cameraError ? <Notice kind="error">{cameraError} You can type the asset ID instead.</Notice> : null}
      {notOurs ? <Notice kind="warning">{notOurs}</Notice> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%', maxWidth: 420, aspectRatio: 1, alignSelf: 'center', borderWidth: 3, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' },
  target: { position: 'absolute', left: '20%', top: '20%', width: '60%', height: '60%', borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)', borderRadius: 12 },
  paused: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
});
