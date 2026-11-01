// Copies the QR decoder used by browser camera scanning (zxing_reader.wasm) from node_modules into
// public/zxing/, so the app serves it itself instead of the decoder downloading it from a public CDN.
// Run after upgrading expo-camera / barcode-detector:  npm run sync:zxing
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Folder of the installed zxing-wasm package (its package.json is not exported, so find it from the main entry). */
export function zxingDir() {
  const main = createRequire(path.resolve('package.json')).resolve('zxing-wasm');
  const marker = `${path.sep}node_modules${path.sep}zxing-wasm${path.sep}`;
  return main.slice(0, main.lastIndexOf(marker) + marker.length - 1);
}

const dir = zxingDir();
const src = path.join(dir, 'dist', 'reader', 'zxing_reader.wasm');
const dest = path.resolve('public', 'zxing', 'zxing_reader.wasm');
mkdirSync(path.dirname(dest), { recursive: true });
copyFileSync(src, dest);
const version = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
console.log(`Copied zxing-wasm ${version} decoder -> ${path.relative(process.cwd(), dest)}`);
