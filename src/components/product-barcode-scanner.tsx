// Camera scanner for the barcode the manufacturer already printed on an item (EAN/UPC, Code 128, Code 39,
// QR, Data Matrix…). Used at registration so nobody has to type it. University asset QR labels are refused
// here: they identify an asset that is already registered, not a new item's product barcode.
import { CameraView, useCameraPermissions, type BarcodeScanningResult, type BarcodeType } from 'expo-camera';
import { useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { Body, Button, Card, Notice } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { parseScannedCode } from '@shared/asset-codes';

const TYPES: BarcodeType[] = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'itf14', 'codabar', 'qr', 'datamatrix', 'pdf417', 'aztec'];
/** Same rule the server applies to the manufacturer barcode field. */
const ALLOWED = /^[0-9A-Za-z.\-]{1,64}$/;

export function ProductBarcodeScanner({ onBarcode, onCancel }: { onBarcode: (code: string) => void; onCancel: () => void }) {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [problem, setProblem] = useState<string | null>(null);
  const done = useRef(false);

  const handle = (r: BarcodeScanningResult) => {
    if (done.current) return;
    const data = (r.data ?? '').trim();
    if (parseScannedCode(data)) {
      setProblem('That is a University asset label, so this item is already registered. Scan the barcode the manufacturer printed on the item.');
      return;
    }
    if (!ALLOWED.test(data)) {
      setProblem('This code contains characters that cannot be stored as a manufacturer barcode. Try another barcode on the item, or type it.');
      return;
    }
    done.current = true; // one scan is enough
    onBarcode(data);
  };

  if (!permission) return <Body muted>Checking camera access…</Body>;
  if (!permission.granted) {
    return (
      <Card>
        <Body>The camera is used only to read the item’s barcode. Nothing is recorded or uploaded.</Body>
        {permission.canAskAgain ? (
          <Button title="Allow camera" onPress={() => requestPermission()} />
        ) : (
          <>
            <Notice kind="warning">Camera access is turned off for this app.</Notice>
            {Platform.OS !== 'web' ? <Button title="Open settings" variant="secondary" onPress={() => Linking.openSettings()} /> : null}
            {Platform.OS === 'web' ? <Body muted>Allow camera access in your browser’s site settings, then reload the page.</Body> : null}
          </>
        )}
        <Button title="Type it instead" variant="secondary" onPress={onCancel} />
      </Card>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={[styles.frame, { borderColor: t.primary }]} accessible accessibilityLabel="Camera viewfinder for scanning the item's barcode">
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: TYPES }}
          onBarcodeScanned={handle}
          onMountError={(e) => setProblem(`${e.message || 'The camera could not be started.'} You can type the barcode instead.`)}
        />
        <View pointerEvents="none" style={styles.target} />
      </View>
      <Body muted style={{ textAlign: 'center' }}>Point the camera at the barcode already on the item (on the box, sticker or label).</Body>
      {problem ? <Notice kind="warning">{problem}</Notice> : null}
      <Button title="Cancel — type it instead" variant="secondary" onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Wide, short frame suits long 1-D barcodes and still fits a phone screen.
  frame: { width: '100%', maxWidth: 480, aspectRatio: 4 / 3, alignSelf: 'center', borderWidth: 3, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' },
  target: { position: 'absolute', left: '10%', top: '30%', width: '80%', height: '40%', borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)', borderRadius: 12 },
});
