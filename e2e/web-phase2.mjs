// Phase 2 browser journey: categories → staff account → register asset → QR label (decoded from pixels)
// → print (captured and decoded) → confirm attachment → edit → duplicate warning → archive → label layout.
import { button, choose, decodePrintedLabel, decodeQrOnScreen, launch, link, newPage, notSee, openFilters, runner, see, setupLink, SHOTS, type, visible, WEB } from './lib.mjs';
import path from 'node:path';

const { step, finish, track } = runner();
const browser = await launch();
const admin = await newPage(browser);
const staff = await newPage(browser, 390, 844); // phone-sized
track('admin', admin);
track('staff', staff);

const ADMIN_PW = 'Quiet-River-Stone-41';
const STAFF_PW = 'Blue-Bench-Lamp-2026';
let assetId = '';
let staffSetupLink = '';

try {
  await step('admin sets password and signs in', async () => {
    await admin.goto(setupLink(), { waitUntil: 'networkidle0' });
    await see(admin, 'admin@university.example');
    await type(admin, 'Password', ADMIN_PW);
    await type(admin, 'Confirm', ADMIN_PW);
    await button(admin, 'Next');
    await see(admin, 'all set');
    await admin.goto(`${WEB}/sign-in`, { waitUntil: 'networkidle0' });
    await type(admin, 'Email', 'admin@university.example');
    await type(admin, 'Password', ADMIN_PW);
    await button(admin, 'Sign in');
    await see(admin, 'Hello, E2E Admin');
    await see(admin, 'Label layout');
  });

  await step('admin adds a category', async () => {
    await link(admin, 'Categories');
    await type(admin, 'Name', 'Laptops');
    await button(admin, 'Add category');
    await see(admin, 'Category added.');
  });

  await step('admin creates a staff account in Dev: Computer Science', async () => {
    await admin.goto(`${WEB}/admin/users/new`, { waitUntil: 'networkidle0' });
    await type(admin, 'Full name', 'Sam Registrar');
    await type(admin, 'Institutional email', 'sam@university.example');
    await choose(admin, 'Department Staff');
    await choose(admin, 'Dev: Computer Science');
    await button(admin, 'Create account');
    await see(admin, 'Account created');
    staffSetupLink = await admin.evaluate(() => document.body.innerText.match(/https?:\/\/\S+reset-password\?token=\S+/)[0]);
  });

  await step('staff sets password and signs in on a phone-sized screen', async () => {
    await staff.goto(staffSetupLink.replace(/^https?:\/\/[^/]+/, WEB), { waitUntil: 'networkidle0' });
    await see(staff, 'Welcome, Sam Registrar');
    await see(staff, 'sam@university.example');
    // Live checklist: using the email address as the password is flagged before submitting.
    await type(staff, 'Password', 'sam@university.example');
    await type(staff, 'Confirm', 'sam@university.example');
    await button(staff, 'Next');
    await see(staff, 'doesn’t include your email');
    await type(staff, 'Password', STAFF_PW);
    await type(staff, 'Confirm', STAFF_PW);
    await staff.screenshot({ path: path.join(SHOTS, 'p2-0-create-password-phone.png'), fullPage: true });
    await button(staff, 'Next');
    await see(staff, 'all set');
    // "Sign in" on the success screen pre-fills the email.
    await button(staff, 'Sign in');
    const prefilled = await (await visible(staff, 'input[aria-label="Email"]')).evaluate((e) => e.value);
    if (prefilled !== 'sam@university.example') throw new Error(`email not pre-filled: "${prefilled}"`);
    await staff.goto(`${WEB}/sign-in`, { waitUntil: 'networkidle0' });
    await type(staff, 'Email', 'sam@university.example');
    await type(staff, 'Password', STAFF_PW);
    await button(staff, 'Sign in');
    await see(staff, 'Hello, Sam Registrar');
    await see(staff, 'Register asset');
    await notSee(staff, 'Label layout');
  });

  await step('registration form explains missing fields', async () => {
    await link(staff, 'Register asset');
    await button(staff, 'Save and generate QR code');
    await see(staff, 'Please correct the highlighted fields.');
    await see(staff, 'Choose a category.');
  });

  await step('staff registers an asset; the server assigns its ID', async () => {
    await type(staff, 'Asset name', 'Dell Latitude 5440 laptop');
    await choose(staff, 'Laptops');
    await type(staff, 'Manufacturer (optional)', 'Dell');
    await choose(staff, 'Dev: Computer Science');
    await choose(staff, 'Dev: Science Block · Lab 101');
    await type(staff, 'Purchase / acquisition date', '2026-03-14');
    await type(staff, 'Purchase cost', '1250.00');
    const currency = await (await visible(staff, 'input[aria-label="Currency"]')).evaluate((e) => e.value);
    if (currency !== 'USD') throw new Error(`currency should default to the department's USD, got "${currency}"`);
    await choose(staff, 'Excellent');
    await staff.screenshot({ path: path.join(SHOTS, 'p2-1-register-phone.png'), fullPage: true });
    await button(staff, 'Save and generate QR code');
    const notice = await see(staff, 'has been assigned');
    assetId = (await notice.evaluate((e) => e.textContent)).match(/UAT-\d{4}-\d{6}/)[0];
    await see(staff, 'Awaiting label');
  });

  await step('on-screen QR code decodes to this asset (read from pixels)', async () => {
    const decoded = await decodeQrOnScreen(staff);
    if (decoded !== `UATS:${assetId}`) throw new Error(`decoded "${decoded}", expected UATS:${assetId}`);
    await staff.screenshot({ path: path.join(SHOTS, 'p2-2-label-phone.png'), fullPage: true });
  });

  await step('confirming before printing is not possible', async () => {
    await see(staff, 'Print the label first.');
  });

  await step('printing sends a real label document; its QR decodes to this asset', async () => {
    await button(staff, 'Print label');
    await see(staff, 'Print dialog opened');
    const printed = await staff.evaluate(() => window.__printed);
    if (printed.length !== 1) throw new Error(`expected 1 printed document, got ${printed.length}`);
    if (!printed[0].includes(assetId)) throw new Error('printed label does not show the asset ID');
    if (!printed[0].includes('size: 210mm 297mm')) throw new Error('printed page size not set from the template');
    const decoded = await decodePrintedLabel(browser, printed[0], 'p2-3-printed-label.png');
    if (decoded !== `UATS:${assetId}`) throw new Error(`printed QR decoded as "${decoded}"`);
  });

  await step('reprint asks for a reason and keeps the same ID', async () => {
    await see(staff, 'Reason for reprint');
    await button(staff, 'Reprint label');
    await see(staff, 'Say why the label is being reprinted');
    await type(staff, 'Reason for reprint', 'Test reprint');
    await button(staff, 'Reprint label');
    await see(staff, 'Printed 2 time(s)');
    const printed = await staff.evaluate(() => window.__printed);
    const decoded = await decodePrintedLabel(browser, printed[1], 'p2-4-reprinted-label.png');
    if (decoded !== `UATS:${assetId}`) throw new Error(`reprinted QR decoded as "${decoded}"`);
  });

  await step('a wrong label code is rejected with an explanation', async () => {
    await type(staff, 'ID on the attached label', 'UAT-2026-999999');
    await button(staff, 'Confirm label attached');
    await see(staff, 'is for UAT-2026-999999, not');
  });

  await step('the correct code completes registration', async () => {
    await type(staff, 'ID on the attached label', assetId.toLowerCase());
    await button(staff, 'Confirm label attached');
    await see(staff, 'Identification');
    await see(staff, 'Registered');
    await see(staff, 'Label attached and confirmed');
    await see(staff, 'USD 1,250.00');
  });

  await step('editing records old and new values in the history', async () => {
    await button(staff, 'Edit details');
    await see(staff, 'To move a registered asset to another school, building or room, use Relocate');
    await type(staff, 'Asset name', 'Dell Latitude 5440 (Lab 101)');
    await button(staff, 'Save changes');
    await see(staff, 'Name: Dell Latitude 5440 laptop → Dell Latitude 5440 (Lab 101)');
  });

  await step('a second asset is registered (no serial number asked for)', async () => {
    await staff.goto(`${WEB}/inventory/new`, { waitUntil: 'networkidle0' });
    await notSee(staff, 'Manufacturer serial number');
    await type(staff, 'Asset name', 'Second laptop');
    await choose(staff, 'Laptops');
    await type(staff, 'Manufacturer (optional)', 'Dell');
    await choose(staff, 'Dev: Computer Science');
    await choose(staff, 'Dev: Science Block · Office 204');
    await type(staff, 'Purchase / acquisition date', '2026-03-15');
    await type(staff, 'Purchase cost', '900');
    await choose(staff, 'Good');
    await button(staff, 'Save and generate QR code');
    await see(staff, 'has been assigned');
  });

  await step('asset list: search and filter', async () => {
    await staff.goto(`${WEB}/inventory`, { waitUntil: 'networkidle0' });
    await see(staff, '2 assets');
    await type(staff, 'Search', 'Lab 101');
    await see(staff, '1 asset');
    await see(staff, 'Dell Latitude 5440 (Lab 101)');
    await type(staff, 'Search', '');
    await openFilters(staff);
    await choose(staff, 'Awaiting label');
    await see(staff, 'Second laptop');
    await notSee(staff, 'Dell Latitude 5440 (Lab 101)');
    await staff.screenshot({ path: path.join(SHOTS, 'p2-5-list-phone.png'), fullPage: true });
  });

  await step('finding an asset by the code on its label', async () => {
    await staff.goto(`${WEB}/inventory/find`, { waitUntil: 'networkidle0' });
    await type(staff, 'Asset ID', assetId);
    await button(staff, 'Open asset');
    await see(staff, 'Dell Latitude 5440 (Lab 101)');
  });

  await step('staff cannot archive a registered asset (no option shown)', async () => {
    await notSee(staff, 'Archive asset');
  });

  await step('admin archives it; it leaves the current list but stays in the archive', async () => {
    await admin.goto(`${WEB}/inventory`, { waitUntil: 'networkidle0' });
    await link(admin, 'Dell Latitude 5440 (Lab 101)');
    await type(admin, 'Reason', 'E2E test archive');
    await button(admin, 'Archive asset');
    await see(admin, 'Asset archived.');
    await admin.screenshot({ path: path.join(SHOTS, 'p2-6-detail-desktop.png'), fullPage: true });
    await staff.goto(`${WEB}/inventory`, { waitUntil: 'networkidle0' });
    await see(staff, '1 asset');
    await openFilters(staff);
    await choose(staff, 'Archived');
    await see(staff, 'Dell Latitude 5440 (Lab 101)');
  });

  await step('admin switches label layout to a label printer preset', async () => {
    await admin.goto(`${WEB}/admin/label-layout`, { waitUntil: 'networkidle0' });
    await button(admin, 'Label printer, 50 × 30 mm');
    await see(admin, 'Labels fit the page');
    await button(admin, 'Save layout');
    await see(admin, 'Label layout saved');
    await type(admin, 'QR code size (mm)', '10');
    await see(admin, 'QR code must be at least 15 mm');
  });

  await step('audit log shows asset events', async () => {
    await admin.goto(`${WEB}/admin/audit`, { waitUntil: 'networkidle0' });
    await see(admin, 'asset.archive');
    await see(admin, 'asset.register');
  });
} finally {
  await browser.close();
  finish();
}
