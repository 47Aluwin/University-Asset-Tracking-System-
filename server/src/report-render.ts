// Turns a Report into a real PDF (pdfkit) or Excel workbook (exceljs). Both start from the same data as the preview.
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

import { formatTimestamp, type Cell, type Column, type Report, type Table } from './reports.ts';

const BRAND = { maroon: '#4E0530', crimson: '#A51C30', ink: '#1F1F1F', muted: '#5F5F5F', rule: '#BDBDBD', zebra: '#F4F1F2' };
const APP_NAME = 'University Asset Tracking System';

/** "1,234.50" for a decimal string, keeping the exact cents (no floating point). */
export function formatAmount(v: string): string {
  const neg = v.startsWith('-');
  const [whole, frac = '00'] = (neg ? v.slice(1) : v).split('.');
  return `${neg ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

function cellText(v: Cell, col: Column): string {
  if (v === null || v === undefined || v === '') return col.kind === 'money' ? 'Restricted' : '—';
  if (col.kind === 'money') return formatAmount(String(v));
  if (col.kind === 'int') return Number(v).toLocaleString('en');
  return String(v);
}

/** The built-in PDF fonts only cover Western European characters; replace anything else visibly. */
const pdfSafe = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF—–’‘“”•…\n]/g, '?');

export const fileBaseName = (r: Report) => `${r.kind}-${formatTimestamp(r.generatedAt, r.timeZone)!.slice(0, 10)}`;

// ------------------------------------------------------------------ PDF

export function toPdf(r: Report): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 36, bottom: 40, left: 30, right: 30 },
    bufferPages: true,
    info: { Title: r.title, Author: APP_NAME, Subject: `${r.title} — generated ${formatTimestamp(r.generatedAt, r.timeZone)} (${r.timeZone})`, CreationDate: new Date(r.generatedAt) },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  // Title block
  doc.rect(0, 0, doc.page.width, 8).fill(BRAND.maroon);
  doc.fillColor(BRAND.crimson).font('Helvetica-Bold').fontSize(16).text(pdfSafe(r.title), left, 24, { width });
  doc.moveDown(0.2).fillColor(BRAND.muted).font('Helvetica').fontSize(8.5);
  doc.text(pdfSafe(`${APP_NAME} · Generated ${formatTimestamp(r.generatedAt, r.timeZone)} (${r.timeZone}) by ${r.generatedBy}`), { width });
  doc.text(pdfSafe(r.filters.map(([k, v]) => `${k}: ${v}`).join('   ·   ')), { width });
  doc.moveDown(0.3).fillColor(BRAND.ink).fontSize(7.5);
  for (const n of r.notes) doc.text(pdfSafe(`• ${n}`), { width });
  doc.moveDown(0.6);

  for (const t of r.tables) drawTable(doc, t, left, width, bottom);

  // Footer with page numbers on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The footer sits inside the bottom margin; lift the margin while writing it so no extra page is started.
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 28;
    doc.font('Helvetica').fontSize(7).fillColor(BRAND.muted);
    doc.text(pdfSafe(`${r.title} · ${formatTimestamp(r.generatedAt, r.timeZone)} (${r.timeZone})`), left, y, { width: width / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = margin;
  }
  doc.end();
  return done;
}

function drawTable(doc: PDFKit.PDFDocument, t: Table, left: number, width: number, bottom: () => number) {
  const FONT = 6.8;
  const PAD = 2.5;
  const weights = t.columns.map((c) => c.width ?? 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / sum) * width);
  const align = (c: Column) => (c.kind === 'money' || c.kind === 'int' ? 'right' : 'left');

  const rowHeight = (cells: string[], bold: boolean) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT);
    return Math.max(...cells.map((s, i) => doc.heightOfString(s, { width: widths[i] - PAD * 2 }))) + PAD * 2;
  };
  const drawRow = (cells: string[], y: number, h: number, opts: { header?: boolean; zebra?: boolean }) => {
    if (opts.header) doc.rect(left, y, width, h).fill(BRAND.maroon);
    else if (opts.zebra) doc.rect(left, y, width, h).fill(BRAND.zebra);
    doc.font(opts.header ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT).fillColor(opts.header ? '#FFFFFF' : BRAND.ink);
    let x = left;
    cells.forEach((s, i) => {
      doc.text(s, x + PAD, y + PAD, { width: widths[i] - PAD * 2, align: align(t.columns[i]) });
      x += widths[i];
    });
    doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.3).strokeColor(BRAND.rule).stroke();
  };

  const header = t.columns.map((c) => pdfSafe(c.label));
  const headerH = rowHeight(header, true);
  // Keep the heading with at least the header row and one line.
  if (doc.y + 16 + headerH + 14 > bottom()) doc.addPage();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.crimson).text(pdfSafe(t.title), left, doc.y, { width });
  const shown = t.rows.length < t.totalRows ? ` (showing ${t.rows.length} of ${t.totalRows})` : ` (${t.totalRows} ${t.totalRows === 1 ? 'row' : 'rows'})`;
  doc.font('Helvetica').fontSize(7).fillColor(BRAND.muted).text(shown.trim(), { width });
  doc.moveDown(0.2);

  if (!t.rows.length) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(BRAND.muted).text(pdfSafe(t.emptyText ?? 'No records.'), left, doc.y, { width });
    doc.moveDown(1);
    return;
  }
  let y = doc.y;
  drawRow(header, y, headerH, { header: true });
  y += headerH;
  t.rows.forEach((row, ri) => {
    const cells = row.map((v, i) => pdfSafe(cellText(v, t.columns[i])));
    const h = rowHeight(cells, false);
    if (y + h > bottom()) {
      doc.addPage();
      y = doc.page.margins.top;
      drawRow(header, y, headerH, { header: true }); // repeat the header on each page
      y += headerH;
    }
    drawRow(cells, y, h, { zebra: ri % 2 === 1 });
    y += h;
  });
  doc.x = left;
  doc.y = y + 14;
}

// ------------------------------------------------------------------ Excel

const sheetName = (title: string, used: Set<string>) => {
  const base = title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 28).trim() || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)} ${i}`;
  used.add(name.toLowerCase());
  return name;
};

export async function toXlsx(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = APP_NAME;
  wb.title = r.title;
  wb.created = new Date(r.generatedAt);
  const used = new Set<string>();

  const about = wb.addWorksheet(sheetName('About this report', used));
  about.columns = [{ width: 24 }, { width: 110 }];
  about.addRow([r.title]).font = { bold: true, size: 14, color: { argb: 'FFA51C30' } };
  about.addRow(['Generated', `${formatTimestamp(r.generatedAt, r.timeZone)} (${r.timeZone})`]);
  about.addRow(['Generated by', r.generatedBy]);
  about.addRow(['System', APP_NAME]);
  about.addRow([]);
  about.addRow(['Filters']).font = { bold: true };
  for (const [k, v] of r.filters) about.addRow([k, v]);
  about.addRow([]);
  about.addRow(['Notes']).font = { bold: true };
  for (const n of r.notes) about.addRow(['', n]).getCell(2).alignment = { wrapText: true, vertical: 'top' };
  about.addRow([]);
  about.addRow(['Sheets']).font = { bold: true };
  for (const t of r.tables) about.addRow([t.title, `${t.totalRows} ${t.totalRows === 1 ? 'row' : 'rows'}`]);

  for (const t of r.tables) {
    const ws = wb.addWorksheet(sheetName(t.title, used), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = t.columns.map((c) => ({
      header: c.label,
      width: Math.min(60, Math.max(10, Math.round((c.width ?? 1) * 16))),
      style:
        c.kind === 'money' ? { numFmt: '#,##0.00' }
        : c.kind === 'int' ? { numFmt: '0' }
        : c.kind === 'date' ? { numFmt: 'yyyy-mm-dd' }
        : {},
    }));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4E0530' } };
    head.alignment = { vertical: 'middle', wrapText: true };
    for (const row of t.rows) {
      ws.addRow(
        row.map((v, i) => {
          const kind = t.columns[i].kind;
          if (v === null || v === undefined) return kind === 'money' ? 'Restricted' : null;
          // Money stays exact in the database; Excel stores numbers as doubles, which is exact to the cent at these sizes.
          if (kind === 'money' || kind === 'int') return Number(v);
          if (kind === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
          // Text is written as text: values beginning with "=" are never turned into formulas.
          return String(v);
        }),
      );
    }
    if (!t.rows.length) ws.addRow([t.emptyText ?? 'No records.']);
    else ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: t.columns.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
