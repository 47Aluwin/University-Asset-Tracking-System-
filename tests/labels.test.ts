// Tests for code shared by the app and server: asset codes, money, dates, QR generation, label layout.
// Run: npm run test:shared
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';

import {
  formatInstitutionalId,
  formatMoney,
  isValidDate,
  parseMoney,
  parseScannedCode,
  qrPayloadFor,
  todayIn,
} from '../shared/asset-codes.ts';
import {
  DEFAULT_LABEL_TEMPLATE,
  QUIET_ZONE_MODULES,
  SINGLE_LABEL_PRESET,
  labelSheetHtml,
  qrMatrix,
  qrSvg,
  templateProblems,
} from '../shared/labels.ts';

/** Rasterises the SVG produced by qrSvg (by reading its path back) and decodes it with an independent QR reader. */
function decodeSvg(svg: string, pxPerModule = 6): string | null {
  const total = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)![1]);
  const size = total * pxPerModule;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  const d = svg.match(/<path fill="#000" d="([^"]*)"/)![1];
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let py = y * pxPerModule; py < (y + 1) * pxPerModule; py++) {
      for (let px = x * pxPerModule; px < (x + w) * pxPerModule; px++) {
        const i = (py * size + px) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return jsQR(data, size, size)?.data ?? null;
}

test('institutional IDs and QR payloads have the documented format', () => {
  assert.equal(formatInstitutionalId('UAT', 2026, 123), 'UAT-2026-000123');
  assert.equal(formatInstitutionalId('UAT', 2026, 1234567), 'UAT-2026-1234567', 'more than 999,999 assets still works');
  assert.equal(qrPayloadFor('UAT-2026-000123'), 'UATS:UAT-2026-000123');
});

test('generated QR SVG decodes back to exactly the asset payload', () => {
  for (const id of ['UAT-2026-000001', 'UAT-2026-000123', 'UNV-2031-987654', 'UAT-2026-1234567']) {
    const payload = qrPayloadFor(id);
    assert.equal(decodeSvg(qrSvg(payload)), payload, `QR for ${id} must decode`);
  }
});

test('QR includes a 4-module quiet zone and uses high error correction', () => {
  const svg = qrSvg('UATS:UAT-2026-000123', 30);
  const m = qrMatrix('UATS:UAT-2026-000123');
  assert.match(svg, new RegExp(`viewBox="0 0 ${m.size + 8} ${m.size + 8}"`));
  assert.match(svg, /width="30mm" height="30mm"/);
  const coords = [...svg.matchAll(/M(\d+) (\d+)/g)].flatMap((x) => [Number(x[1]), Number(x[2])]);
  assert.ok(Math.min(...coords) >= QUIET_ZONE_MODULES, 'nothing drawn inside the quiet zone');
  assert.ok(Math.max(...coords) < m.size + QUIET_ZONE_MODULES);
  assert.equal(m.size, 25, 'payload fits a small version-2 code at level Q');
});

test('scanned codes are parsed strictly and never treated as instructions', () => {
  assert.equal(parseScannedCode('UATS:UAT-2026-000123'), 'UAT-2026-000123');
  assert.equal(parseScannedCode('  uats:uat-2026-000123 \n'), 'UAT-2026-000123');
  assert.equal(parseScannedCode('UAT-2026-000123'), 'UAT-2026-000123');
  for (const bad of [
    '',
    'https://example.com/UAT-2026-000123',
    'javascript:alert(1)',
    '<script>alert(1)</script>',
    'UATS:UAT-2026-12',
    'UATS:UAT-2026-000123; DROP TABLE assets',
    '5012345678900',
    'X'.repeat(500),
  ]) {
    assert.equal(parseScannedCode(bad), null, `should reject ${bad.slice(0, 40)}`);
  }
});

test('money parsing keeps exact decimals and formatting shows the currency', () => {
  assert.equal(parseMoney('1250'), '1250.00');
  assert.equal(parseMoney(' 1,999.5 '), '1999.50');
  assert.equal(parseMoney('0.10'), '0.10');
  assert.equal(parseMoney('000123.4'), '123.40');
  for (const bad of ['12.345', '-1', '1e5', 'abc', '', '1.2.3']) assert.equal(parseMoney(bad), null, bad);
  assert.equal(formatMoney('1234567.50', 'TZS'), 'TZS 1,234,567.50');
  assert.equal(formatMoney('45000', 'PGK'), 'K45,000.00', 'kina is written K, the PNG convention');
  assert.equal(formatMoney('-12.5', 'PGK'), 'K-12.50');
  assert.equal(formatMoney(null, 'USD'), '—');
});

test('dates are validated strictly and "today" respects the institution time zone', () => {
  assert.equal(isValidDate('2024-02-29'), true);
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('26-01-01'), false);
  const instant = new Date('2026-10-28T22:30:00Z');
  assert.equal(todayIn('UTC', instant), '2026-10-28');
  assert.equal(todayIn('Africa/Nairobi', instant), '2026-10-29', 'UTC+3 is already the next day');
});

test('default label templates fit their pages; bad templates are explained', () => {
  assert.deepEqual(templateProblems(DEFAULT_LABEL_TEMPLATE), []);
  assert.deepEqual(templateProblems(SINGLE_LABEL_PRESET), []);
  assert.equal(templateProblems({ ...DEFAULT_LABEL_TEMPLATE, columns: 4 }).length, 1);
  assert.match(templateProblems({ ...DEFAULT_LABEL_TEMPLATE, qrSizeMm: 10 }).join(), /at least 15 mm/);
  assert.match(templateProblems({ ...DEFAULT_LABEL_TEMPLATE, qrSizeMm: 40 }).join(), /does not fit inside the label/);
  // A square label where the QR fills the width would print no asset ID: refused.
  assert.match(templateProblems({ ...DEFAULT_LABEL_TEMPLATE, labelWidthMm: 38.1, qrSizeMm: 30 }).join(), /printed asset ID/);
});

test('label sheet: one label per asset, pages split correctly, partial sheets supported', () => {
  const labels = Array.from({ length: 22 }, (_, i) => {
    const id = formatInstitutionalId('UAT', 2026, i + 1);
    return { institutionalId: id, qrPayload: qrPayloadFor(id), name: `Asset ${i + 1}`, departmentCode: 'CS' };
  });
  const html = labelSheetHtml(labels, DEFAULT_LABEL_TEMPLATE);
  assert.equal((html.match(/class="label"/g) ?? []).length, 22);
  assert.equal((html.match(/class="page"/g) ?? []).length, 2, '21 per A4 sheet → 2 pages');
  assert.match(html, /@page \{ size: 210mm 297mm; margin: 0; \}/);
  const firstLabelLeft = html.match(/class="label" style="left:([\d.]+)mm;top:([\d.]+)mm"/)!;
  assert.deepEqual([Number(firstLabelLeft[1]), Number(firstLabelLeft[2])], [7.25, 15.15]);

  const partial = labelSheetHtml(labels.slice(0, 2), DEFAULT_LABEL_TEMPLATE, 5);
  const positions = [...partial.matchAll(/class="label" style="left:([\d.]+)mm;top:([\d.]+)mm"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  // Position 5 = row 2, column 2 on a 3-column sheet.
  assert.deepEqual(positions[0], [7.25 + 63.5 + 2.5, 15.15 + 38.1]);
});

test('every printed label carries the human-readable asset ID', () => {
  for (const t of [DEFAULT_LABEL_TEMPLATE, SINGLE_LABEL_PRESET]) {
    const html = labelSheetHtml([{ institutionalId: 'UAT-2026-000042', qrPayload: 'UATS:UAT-2026-000042' }], t);
    assert.match(html, /<div class="id">UAT-2026-000042<\/div>/);
  }
});

test('label text is HTML-escaped so asset names cannot inject markup', () => {
  const html = labelSheetHtml(
    [{ institutionalId: 'UAT-2026-000001', qrPayload: 'UATS:UAT-2026-000001', name: '<img src=x onerror=alert(1)> & "Lab"' }],
    { ...DEFAULT_LABEL_TEMPLATE, footerText: '<b>x</b>' },
  );
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Lab&quot;'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
});

test('single-label layout prints one label per page at the label size', () => {
  const html = labelSheetHtml(
    [1, 2, 3].map((n) => ({ institutionalId: `UAT-2026-00000${n}`, qrPayload: `UATS:UAT-2026-00000${n}` })),
    SINGLE_LABEL_PRESET,
  );
  assert.equal((html.match(/class="page"/g) ?? []).length, 3);
  assert.match(html, /@page \{ size: 50mm 30mm; margin: 0; \}/);
});

test('the self-hosted web QR decoder matches the installed library version', async () => {
  // public/zxing/zxing_reader.wasm must be the file the installed zxing-wasm expects (re-run `npm run sync:zxing`).
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..');
  const main = createRequire(path.join(root, 'package.json')).resolve('zxing-wasm');
  const marker = `${path.sep}node_modules${path.sep}zxing-wasm${path.sep}`;
  const installed = path.join(main.slice(0, main.lastIndexOf(marker) + marker.length), 'dist', 'reader', 'zxing_reader.wasm');
  const hash = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
  assert.equal(hash(path.join(root, 'public', 'zxing', 'zxing_reader.wasm')), hash(installed), 'run npm run sync:zxing');
});
