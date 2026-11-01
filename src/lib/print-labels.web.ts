// Browser: expo-print's printAsync prints the whole current page on web, so labels are printed from a
// hidden iframe that contains only the label document. The browser's print dialog must be set to
// "Actual size / 100%" with no headers or footers for labels to line up (see docs/qr-printing.md).
import type { LabelTemplate } from '@shared/labels';

/** Fallback removal if the browser never reports that printing finished. */
const FRAME_LIFETIME_MS = 5 * 60_000;

export async function printLabelHtml(html: string, _template: LabelTemplate): Promise<void> {
  if (typeof document === 'undefined') throw new Error('Printing is not available here.');
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.title = 'Asset labels';
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(frame);
  const remove = () => frame.isConnected && frame.remove();
  try {
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!win || !doc) throw new Error('Could not prepare the print page.');
    doc.open();
    doc.write(html);
    doc.close();
    // Give the browser a moment to lay out the SVG codes before opening the print dialog.
    await new Promise((r) => setTimeout(r, 250));
    // Some browsers return from print() immediately while the dialog is still open, so the frame is
    // removed only after the browser reports printing finished (or after a generous fallback).
    win.addEventListener('afterprint', () => setTimeout(remove, 500), { once: true });
    setTimeout(remove, FRAME_LIFETIME_MS);
    win.focus();
    win.print();
  } catch (e) {
    remove();
    throw e;
  }
}
