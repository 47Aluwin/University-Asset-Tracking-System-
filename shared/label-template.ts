// Label template rules. No dependencies, so the API server can validate templates too.

export type LabelTemplate = {
  /** 'sheet' = several labels per page (adhesive sheets); 'single' = one label per page (label printers). */
  layout: 'sheet' | 'single';
  pageWidthMm: number;
  pageHeightMm: number;
  columns: number;
  rows: number;
  labelWidthMm: number;
  labelHeightMm: number;
  marginTopMm: number;
  marginLeftMm: number;
  gapXMm: number;
  gapYMm: number;
  qrSizeMm: number;
  /** Inner padding of each label. */
  paddingMm: number;
  showName: boolean;
  showDepartment: boolean;
  /** Optional fixed line, e.g. "Property of the University". */
  footerText: string;
};

/**
 * Default: A4 sheet, 3 × 7 labels of 63.5 × 38.1 mm (a common 21-per-sheet layout).
 * Always check the measurements printed on the label sheet packaging and adjust in Admin → Label layout.
 */
export const DEFAULT_LABEL_TEMPLATE: LabelTemplate = {
  layout: 'sheet',
  pageWidthMm: 210,
  pageHeightMm: 297,
  columns: 3,
  rows: 7,
  labelWidthMm: 63.5,
  labelHeightMm: 38.1,
  marginTopMm: 15.15,
  marginLeftMm: 7.25,
  gapXMm: 2.5,
  gapYMm: 0,
  qrSizeMm: 30,
  paddingMm: 2,
  showName: true,
  showDepartment: true,
  footerText: '',
};

/** Example preset for a 50 × 30 mm roll label printer (one label per page). */
export const SINGLE_LABEL_PRESET: LabelTemplate = {
  ...DEFAULT_LABEL_TEMPLATE,
  layout: 'single',
  pageWidthMm: 50,
  pageHeightMm: 30,
  columns: 1,
  rows: 1,
  labelWidthMm: 50,
  labelHeightMm: 30,
  marginTopMm: 0,
  marginLeftMm: 0,
  gapXMm: 0,
  gapYMm: 0,
  qrSizeMm: 24,
  paddingMm: 2,
};

/** QR modules of quiet (blank) border required around the code for reliable scanning. */
export const QUIET_ZONE_MODULES = 4;
/** Below this printed size, phone cameras struggle with a 25-module code plus quiet zone. */
export const MIN_QR_SIZE_MM = 15;

/** Minimum width of the text column (asset ID, name) beside the QR code. */
export const MIN_TEXT_WIDTH_MM = 12;

/** Width left for text: label width minus QR and padding (left, between, right). */
export const labelTextWidthMm = (t: LabelTemplate) => t.labelWidthMm - t.qrSizeMm - 3 * t.paddingMm;

/** Returns human-readable problems with a template; empty array = usable. */
export function templateProblems(t: LabelTemplate): string[] {
  const p: string[] = [];
  const usedW = t.marginLeftMm + t.columns * t.labelWidthMm + (t.columns - 1) * t.gapXMm;
  const usedH = t.marginTopMm + t.rows * t.labelHeightMm + (t.rows - 1) * t.gapYMm;
  if (usedW > t.pageWidthMm + 0.01) p.push(`Labels are wider than the page (${usedW.toFixed(1)} mm > ${t.pageWidthMm} mm).`);
  if (usedH > t.pageHeightMm + 0.01) p.push(`Labels are taller than the page (${usedH.toFixed(1)} mm > ${t.pageHeightMm} mm).`);
  if (t.qrSizeMm < MIN_QR_SIZE_MM) p.push(`QR code must be at least ${MIN_QR_SIZE_MM} mm to scan reliably.`);
  if (t.qrSizeMm + 2 * t.paddingMm > Math.min(t.labelWidthMm, t.labelHeightMm) + 0.01) {
    p.push('QR code (plus padding) does not fit inside the label.');
  }
  if (t.layout === 'single' && (t.columns !== 1 || t.rows !== 1)) p.push('Single-label layout must have 1 column and 1 row.');
  // The printed asset ID is what staff type to confirm a label when no camera is available, so it must fit.
  if (labelTextWidthMm(t) < MIN_TEXT_WIDTH_MM) {
    p.push(`Leave at least ${MIN_TEXT_WIDTH_MM} mm beside the QR code for the printed asset ID (make the QR smaller or the label wider).`);
  }
  return p;
}
