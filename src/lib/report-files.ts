// iOS / Android: save an exported report to the app's cache, then print it (PDF) or open the share sheet
// (save to Files, email, open in Excel). The server checks permissions; this only carries the token.
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { fetchReportFile, type ReportFormat } from './report-download';

export async function exportReport(path: string, query: Record<string, string | undefined>, format: ReportFormat, action: 'save' | 'print') {
  const { bytes, fileName, contentType } = await fetchReportFile(path, query, format);
  const file = new File(Paths.cache, fileName);
  file.create({ overwrite: true });
  file.write(bytes);
  if (action === 'print' && format === 'pdf') {
    await Print.printAsync({ uri: file.uri });
    return;
  }
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing files is not available on this device.');
  await Sharing.shareAsync(file.uri, {
    mimeType: contentType,
    dialogTitle: fileName,
    UTI: format === 'pdf' ? 'com.adobe.pdf' : 'org.openxmlformats.spreadsheetml.sheet',
  });
}
