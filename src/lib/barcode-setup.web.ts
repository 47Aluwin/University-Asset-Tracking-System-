// Browser only. When a browser has no built-in barcode reader, expo-camera decodes QR codes with the
// `barcode-detector` library, which by default downloads its decoder (zxing_reader.wasm) from a public CDN.
// Point it at the copy this app serves itself (public/zxing/, kept in sync by `npm run sync:zxing`), so
// scanning does not depend on, or run code from, a third-party site.
import { setZXingModuleOverrides } from 'barcode-detector';

setZXingModuleOverrides({
  locateFile: (file: string, prefix: string) => (file.endsWith('.wasm') ? `/zxing/${file}` : prefix + file),
});
