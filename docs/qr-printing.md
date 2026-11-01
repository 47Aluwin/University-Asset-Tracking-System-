# QR codes and label printing

Status: Phase 2 (2026-10-28). Browser printing workflow verified in headless Microsoft Edge (document
generation and QR decoding). **No physical printer, label stock or phone camera has been tested yet.**

## What the QR code contains

`UATS:<institutional ID>`, e.g. `UATS:UAT-2026-000123`.

- Not a URL, so labels stay valid if the web address changes. Contains no personal data or secrets.
- Uses only QR "alphanumeric" characters, giving a small 25 × 25 module code (version 2).
- Error correction level **Q** (~25% damage tolerance), suitable for scuffed labels.
- A 4-module blank border (quiet zone) is always included.
- Scanning a code grants nothing: the server still checks that the user is signed in and allowed to see that department's asset.
- The app accepts the payload or the bare ID (any letter case). Anything else, including URLs and script-like text, is rejected (`parseScannedCode` in `shared/asset-codes.ts`).

## How labels are produced

1. The server assigns the institutional ID when the asset is saved (status **Awaiting label**).
2. On the label screen the user presses **Print label**. The app first records the print on the server
   (`label_print_events`, audited), then builds the label document on the device (`shared/labels.ts`)
   and opens the print dialog.
3. **Reprints** reuse the same ID and QR code and require a reason (damaged, lost, printer jam…).
   Printing never creates or changes an asset.
4. The user sticks the label on the asset and **confirms** it by entering the code from the attached
   label. A code belonging to a different asset is refused (and the mismatch is audited). Only then
   does the asset become **Registered**.

Because the print is recorded before the dialog opens, a cancelled or failed print still counts as a
print; the next attempt is a reprint and asks for a reason (e.g. "print failed").

## Label layout (Administration → Label layout)

One institution-wide layout, validated by both app and server (`templateProblems`):
labels must fit the page, the QR code must be at least 15 mm and fit inside the label, and at least
12 mm must remain beside it for the printed asset ID (which staff type to confirm a label).

| Preset | Use |
|---|---|
| A4 sheet, 3 × 7 labels of 63.5 × 38.1 mm (margins 15.15 mm top, 7.25 mm left, 2.5 mm column gap) | Office printers with adhesive label sheets. This is a common 21-per-sheet geometry; **check your sheet's packaging** and adjust. |
| 50 × 30 mm, one label per page | Thermal / roll label printers that appear as a normal system printer. |

Other options: QR size, padding, show/hide asset name and department code, optional footer text
(e.g. "Property of the University"), and a **start position** when reusing a part-used sheet.
**Print test page** prints every position with "TEST" text and a QR code that is deliberately not an
asset code, for checking alignment.

## Printing by platform

| Platform | Mechanism | Notes |
|---|---|---|
| Browser | Label document printed from a hidden frame (`src/lib/print-labels.web.ts`), kept until the browser reports printing finished | Expo Print's `printAsync` prints the whole page on web, so it is not used there. In the dialog choose **100% / Actual size**, margins **None**, and turn **headers and footers off**. |
| iOS | `expo-print` → AirPrint | Page size passed from the template. Untested on a device. |
| Android | `expo-print` → Android print services | Expo docs note some WebViews add page margins; the label document sets `@page { margin: 0 }`. Untested on a device. |
| Dedicated label printers | Only through the operating system's print system (driver / print-service plug-in) | No printer-specific SDK (e.g. ZPL/Brother/Zebra) is integrated. Printers that cannot print from the OS print dialog are not supported yet. |

## Verification done (automated)

- Unit tests (`tests/labels.test.ts`): the exact SVG the app prints is rasterised and decoded by an independent QR reader (`jsqr`) for several IDs, and must equal the payload; quiet zone present; label HTML escapes asset names; page splitting and start positions are correct.
- Browser journey (`e2e/web-phase2.mjs`): the on-screen QR is screenshotted and decoded; the label document sent to the print dialog is captured, rendered and decoded; reprint keeps the same code.

## Not yet verified — test procedure for the university

For each printer / label stock to be used, record results in `testing.md`:

1. Admin → Label layout: choose the preset closest to the stock, adjust to the packaging measurements, **Print test page** at 100% scale.
2. Hold the test print over a label sheet against a light: every "TEST" block should sit inside one label. Adjust margins/gaps and repeat.
3. Print a real label for a test asset. Scan it with at least two phones (iOS and Android camera apps) from 10–30 cm: the text read must be `UATS:<asset ID>`.
4. Rub/scratch one corner of a spare label and rescan (checks error-correction margin).
5. For thermal printers: confirm the printer appears in the OS print dialog and that 1 label = 1 page with no blank labels fed between prints.
