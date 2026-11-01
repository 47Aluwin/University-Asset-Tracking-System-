// QR code and label layout generation. Pure functions (no React, no network) so labels can be
// produced on any device, including offline in later phases, and tested with the Node test runner.
import QRCode from 'qrcode';

import { QUIET_ZONE_MODULES, labelTextWidthMm, type LabelTemplate } from './label-template.ts';

export * from './label-template.ts';

export type QrMatrix = { size: number; isDark: (row: number, col: number) => boolean };

/** Error correction level Q (~25% damage tolerance) suits labels that get scuffed. */
export function qrMatrix(payload: string): QrMatrix {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'Q' });
  return { size: qr.modules.size, isDark: (r, c) => Boolean(qr.modules.get(r, c)) };
}

/**
 * SVG for a QR code, including the quiet zone. Dark modules are merged into horizontal runs so the
 * path stays small. `crispEdges` keeps module edges sharp when printed.
 */
export function qrSvg(payload: string, sizeMm?: number): string {
  const m = qrMatrix(payload);
  const total = m.size + 2 * QUIET_ZONE_MODULES;
  let d = '';
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.isDark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < m.size && m.isDark(r, c)) c++;
      d += `M${start + QUIET_ZONE_MODULES} ${r + QUIET_ZONE_MODULES}h${c - start}v1h-${c - start}z`;
    }
  }
  const dims = sizeMm ? ` width="${sizeMm}mm" height="${sizeMm}mm"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"${dims} shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`
  );
}

export type LabelData = {
  institutionalId: string;
  qrPayload: string;
  name?: string;
  departmentCode?: string;
};

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Full HTML document laying out the given labels with exact millimetre positions.
 * `startPosition` (1-based) skips already-used positions on a partly used sheet.
 */
export function labelSheetHtml(labels: LabelData[], t: LabelTemplate, startPosition = 1): string {
  const perPage = t.columns * t.rows;
  const skip = Math.min(Math.max(1, Math.floor(startPosition)), perPage) - 1;
  const slots: (LabelData | null)[] = [...Array(skip).fill(null), ...labels];
  const pages: (LabelData | null)[][] = [];
  for (let i = 0; i < slots.length; i += perPage) pages.push(slots.slice(i, i + perPage));

  const textWidth = Math.max(0, labelTextWidthMm(t));
  const label = (l: LabelData | null, index: number) => {
    const col = index % t.columns;
    const row = Math.floor(index / t.columns);
    const left = t.marginLeftMm + col * (t.labelWidthMm + t.gapXMm);
    const top = t.marginTopMm + row * (t.labelHeightMm + t.gapYMm);
    if (!l) return '';
    const lines = [
      `<div class="id">${escapeHtml(l.institutionalId)}</div>`,
      t.showName && l.name ? `<div class="name">${escapeHtml(l.name)}</div>` : '',
      t.showDepartment && l.departmentCode ? `<div class="dept">${escapeHtml(l.departmentCode)}</div>` : '',
      t.footerText ? `<div class="footer">${escapeHtml(t.footerText)}</div>` : '',
    ].join('');
    return (
      `<div class="label" style="left:${left}mm;top:${top}mm">` +
      `<div class="qr">${qrSvg(l.qrPayload, t.qrSizeMm)}</div>` +
      // The asset ID is always printed; templateProblems() guarantees room for it.
      `<div class="text" style="width:${textWidth}mm">${lines}</div>` +
      `</div>`
    );
  };

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Asset labels</title><style>
@page { size: ${t.pageWidthMm}mm ${t.pageHeightMm}mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; width: ${t.pageWidthMm}mm; height: ${t.pageHeightMm}mm; overflow: hidden; page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
.label { position: absolute; width: ${t.labelWidthMm}mm; height: ${t.labelHeightMm}mm; padding: ${t.paddingMm}mm;
  display: flex; align-items: center; gap: ${t.paddingMm}mm; overflow: hidden; }
.qr { flex: 0 0 ${t.qrSizeMm}mm; width: ${t.qrSizeMm}mm; height: ${t.qrSizeMm}mm; }
.qr svg { display: block; width: 100%; height: 100%; }
.text { overflow: hidden; line-height: 1.15; }
.id { font-family: "Courier New", monospace; font-weight: bold; font-size: 8pt; word-break: break-all; }
.name { font-size: 7pt; margin-top: 1mm; max-height: 3.4em; overflow: hidden; }
.dept { font-size: 7pt; margin-top: 1mm; font-weight: bold; }
.footer { font-size: 6pt; margin-top: 1mm; }
</style></head><body>${pages
    .map((p) => `<div class="page">${p.map((l, i) => label(l, i)).join('')}</div>`)
    .join('')}</body></html>`;
}

export const mmToPoints = (mm: number) => Math.round((mm * 72) / 25.4);
