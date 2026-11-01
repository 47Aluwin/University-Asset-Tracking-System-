// iOS / Android: hand the label HTML to the operating system's print service (AirPrint, Android
// print services, or a label printer's own print-service plug-in). Page size is set from the template.
import * as Print from 'expo-print';

import { mmToPoints, type LabelTemplate } from '@shared/labels';

export async function printLabelHtml(html: string, template: LabelTemplate): Promise<void> {
  await Print.printAsync({
    html,
    width: mmToPoints(template.pageWidthMm),
    height: mmToPoints(template.pageHeightMm),
  });
}
