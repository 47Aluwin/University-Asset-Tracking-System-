// Browser: download the exported file, or open the PDF in a new tab where the browser's own viewer can print it.
import { fetchReportFile, type ReportFormat } from './report-download';

export async function exportReport(path: string, query: Record<string, string | undefined>, format: ReportFormat, action: 'save' | 'print') {
  // Open the tab straight away (inside the click) so pop-up blockers allow it; it is filled once the file arrives.
  const tab = action === 'print' ? window.open('', '_blank') : null;
  try {
    const { bytes, fileName, contentType } = await fetchReportFile(path, query, format);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }));
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
    if (tab) {
      tab.location.href = url;
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    tab?.close();
    throw e;
  }
}
