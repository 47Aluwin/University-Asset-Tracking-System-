// Phase 5 browser journey: dashboard figures checked against the API and against the lists they link to,
// filters, phone width, report preview, real PDF / Excel downloads through the app, printing, and department scope.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { WEB, DIR, OUT, SHOTS, button, choose, launch, link, newPage, notSee, runner, see, setupLink, type, visible } from './lib.mjs';

// The Excel reader is the server's own dependency; reuse it rather than installing another copy.
const ExcelJS = createRequire(path.join(DIR, '..', 'server', 'package.json'))('exceljs');

const API = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const { step, finish, track } = runner();
const browser = await launch();
const admin = await newPage(browser);
track('admin', admin);
const ADMIN_PW = 'Quiet-River-Stone-41';
const STAFF_PW = 'Amber-Wrench-Table-73';

const caller = (getToken) => async (method, p, body) => {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(`${method} ${p} → ${r.status} ${JSON.stringify(json)}`), { status: r.status });
  return json;
};
let adminToken = '';
let staffToken = '';
const asAdmin = caller(() => adminToken);
const asStaff = caller(() => staffToken);

async function asset({ name, dept, room, cost, currency, register = true }) {
  const cats = (await asAdmin('GET', '/categories')).items;
  const d = (await asAdmin('GET', '/departments')).items.find((x) => x.code === dept);
  const loc = (await asAdmin('GET', `/locations?departmentId=${d.id}`)).items.find((l) => l.room === room);
  const a = await asAdmin('POST', '/assets', {
    name, categoryId: cats.find((c) => c.name === 'Dev: Lab equipment').id, serialNumber: `E2E-${Math.random().toString(36).slice(2, 10)}`,
    departmentId: d.id, locationId: loc.id, acquisitionDate: '2025-04-01', acquisitionMethod: 'purchase', costStatus: 'recorded',
    acquisitionCost: cost, currency, condition: 'good',
  });
  if (!register) return a;
  await asAdmin('POST', `/assets/${a.id}/label-prints`, { layout: 'sheet' });
  return asAdmin('POST', `/assets/${a.id}/confirm-label`, { code: a.qrPayload, method: 'scan' });
}

/** Records files the app hands to the browser (blob URL + <a download>), so the real download path is tested. */
async function captureDownloads(p) {
  await p.evaluateOnNewDocument(() => {
    window.__downloads = [];
    const blobs = new Map();
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => {
      const u = create(b);
      blobs.set(u, b);
      return u;
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const b = blobs.get(this.href);
      if (b && this.download) {
        b.arrayBuffer().then((buf) => {
          let s = '';
          new Uint8Array(buf).forEach((x) => (s += String.fromCharCode(x)));
          window.__downloads.push({ name: this.download, type: b.type, base64: btoa(s) });
        });
        return;
      }
      return click.call(this);
    };
  });
}
async function nextDownload(p, count) {
  await p.waitForFunction((n) => window.__downloads.length >= n, { timeout: 20000 }, count);
  const d = (await p.evaluate(() => window.__downloads))[count - 1];
  return { ...d, bytes: Buffer.from(d.base64, 'base64') };
}

let dash;
try {
  await step('admin signs in; assets in two currencies and three departments', async () => {
    await captureDownloads(admin);
    await admin.goto(setupLink(), { waitUntil: 'networkidle0' });
    await type(admin, 'Password', ADMIN_PW);
    await type(admin, 'Confirm', ADMIN_PW);
    await button(admin, 'Next');
    await see(admin, 'all set');
    await admin.goto(`${WEB}/sign-in`, { waitUntil: 'networkidle0' });
    await type(admin, 'Email', 'admin@university.example');
    await type(admin, 'Password', ADMIN_PW);
    await button(admin, 'Sign in');
    await see(admin, 'Hello, E2E Admin');
    adminToken = (await asAdmin('POST', '/auth/login', { email: 'admin@university.example', password: ADMIN_PW })).token;
    await asset({ name: 'E2E Oscilloscope', dept: 'DEVCS', room: 'Lab 101', cost: '3200.00', currency: 'USD' });
    await asset({ name: 'E2E Server rack', dept: 'DEVCS', room: 'Office 204', cost: '1800.50', currency: 'USD' });
    await asset({ name: 'E2E Rare map cabinet', dept: 'DEVLIB', room: 'Ground floor', cost: '900.00', currency: 'EUR' });
    await asset({ name: 'E2E Lathe', dept: 'DEVENG', room: 'Bay 1', cost: '500.00', currency: 'USD', register: false });
    await fetch(`${API}/access-requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: 'Pat Pending', email: 'pat@university.example', departmentId: (await asAdmin('GET', '/departments')).items[0].id, requestedRole: 'DEPARTMENT_STAFF', justification: 'New lab technician', password: 'Requested-Password-42' }),
    });
  });

  await step('dashboard shows all five sections, with figures equal to the API and totals per currency', async () => {
    await admin.goto(`${WEB}/`, { waitUntil: 'networkidle0' });
    await link(admin, 'Totals, values per currency');
    await see(admin, '1. Total assets and asset value');
    for (const s of ['2. Verified, due and overdue assets', '3. Damaged assets and outstanding maintenance', '4. Faculty and department summaries', '5. Pending staff access requests'])
      await see(admin, s);
    dash = await asAdmin('GET', '/dashboard?periodDays=90');
    if (dash.totals.assets !== 4 || dash.totals.registered !== 3 || dash.totals.awaitingLabel !== 1) throw new Error(`unexpected totals ${JSON.stringify(dash.totals)}`);
    await see(admin, 'USD 5,500.50');
    await see(admin, 'EUR 900.00');
    await see(admin, 'amounts in different currencies are never added together');
    const text = await admin.evaluate(() => document.body.innerText);
    if (/6,400\.50|6400\.50/.test(text)) throw new Error('USD and EUR were added together');
    await see(admin, 'Pending requests');
    await see(admin, 'How these figures are calculated');
    await admin.screenshot({ path: path.join(SHOTS, 'p5-1-dashboard.png'), fullPage: true });
  });

  await step('a dashboard card opens the matching filtered list with the same number', async () => {
    await (await visible(admin, '[role="link"][aria-label^="Awaiting label: 1"]')).click();
    await see(admin, 'E2E Lathe');
    await notSee(admin, 'E2E Oscilloscope');
    if (!admin.url().includes('status=awaiting_label')) throw new Error(`url ${admin.url()}`);
    const list = await asAdmin('GET', '/assets?status=awaiting_label&pageSize=1');
    if (list.total !== dash.totals.awaitingLabel) throw new Error('list and dashboard disagree');
  });

  await step('department filter: only that department and its own currency', async () => {
    await admin.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle0' });
    await see(admin, 'USD 5,500.50');
    await choose(admin, 'Dev: Library');
    await see(admin, 'EUR 900.00');
    await notSee(admin, 'USD 5,500.50');
  });

  await step('dashboard works at phone width without sideways scrolling', async () => {
    const phone = await newPage(browser, 390, 844);
    track('phone', phone);
    await phone.goto(`${WEB}/sign-in`, { waitUntil: 'networkidle0' });
    await type(phone, 'Email', 'admin@university.example');
    await type(phone, 'Password', ADMIN_PW);
    await button(phone, 'Sign in');
    await see(phone, 'Hello, E2E Admin');
    await phone.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle0' });
    await see(phone, '4. Faculty and department summaries');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) throw new Error(`page is ${overflow}px wider than the phone screen`);
    await phone.screenshot({ path: path.join(SHOTS, 'p5-2-dashboard-phone.png'), fullPage: true });
    await phone.browserContext().close();
  });

  await step('report preview: asset register with filters, generation time and per-currency totals', async () => {
    await admin.goto(`${WEB}/reports`, { waitUntil: 'networkidle0' });
    await see(admin, 'Complete asset register');
    await see(admin, 'E2E Rare map cabinet');
    await see(admin, 'Totals by currency (recorded acquisition cost)');
    await see(admin, 'School / department: All departments you can access');
    await type(admin, 'Acquired from', '2000-01-01');
    await type(admin, 'Acquired to', '2000-12-31');
    await see(admin, 'No assets match the selected filters.');
    await type(admin, 'Acquired to', '2000-02-30');
    await see(admin, 'Use the form YYYY-MM-DD.');
    await admin.screenshot({ path: path.join(SHOTS, 'p5-3-reports.png'), fullPage: true });
  });

  await step('Excel download from the app is a valid workbook with the right values', async () => {
    await admin.goto(`${WEB}/reports`, { waitUntil: 'networkidle0' });
    await see(admin, 'E2E Rare map cabinet');
    await button(admin, 'Download Excel');
    const d = await nextDownload(admin, 1);
    if (!/^asset-register-\d{4}-\d{2}-\d{2}\.xlsx$/.test(d.name)) throw new Error(`file name ${d.name}`);
    writeFileSync(path.join(OUT, d.name), d.bytes);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(d.bytes);
    const sheet = wb.getWorksheet('Assets');
    const names = sheet.getColumn(5).values.slice(2);
    for (const n of ['E2E Oscilloscope', 'E2E Server rack', 'E2E Rare map cabinet', 'E2E Lathe'])
      if (!names.includes(n)) throw new Error(`${n} missing from the workbook`);
    const totals = wb.getWorksheet('Totals by currency (recorded');
    const got = [2, 3].map((r) => [totals.getCell(`A${r}`).value, totals.getCell(`B${r}`).value]);
    if (JSON.stringify(got) !== JSON.stringify([['EUR', 900], ['USD', 5500.5]])) throw new Error(`totals ${JSON.stringify(got)}`);
    await see(admin, 'The Excel file has been downloaded.');
  });

  await step('PDF download and print for the verification report', async () => {
    await choose(admin, '3. Verification and overdue assets');
    await see(admin, 'Summary by verification status');
    await button(admin, 'Download PDF');
    const d = await nextDownload(admin, 2);
    if (!d.name.endsWith('.pdf') || d.bytes.subarray(0, 5).toString() !== '%PDF-' || !/%%EOF\s*$/.test(d.bytes.subarray(-8).toString()))
      throw new Error(`not a PDF: ${d.name}`);
    writeFileSync(path.join(OUT, d.name), d.bytes);
    // Print opens the PDF in a new tab, where the browser's viewer prints it.
    const tab = browser.waitForTarget((t) => t.url().startsWith('blob:'), { timeout: 20000 });
    await button(admin, 'Print');
    await tab;
  });

  await step('department staff see only their department; another department is refused by the server', async () => {
    const cs = (await asAdmin('GET', '/departments')).items.find((x) => x.code === 'DEVCS');
    const lib = (await asAdmin('GET', '/departments')).items.find((x) => x.code === 'DEVLIB');
    const created = await asAdmin('POST', '/users', { email: 'tech@university.example', fullName: 'Tess Technician', role: 'DEPARTMENT_STAFF', departmentId: cs.id });
    await asAdmin('POST', '/auth/reset-password', { token: new URL(created.setupLink).searchParams.get('token'), newPassword: STAFF_PW });
    staffToken = (await asStaff('POST', '/auth/login', { email: 'tech@university.example', password: STAFF_PW })).token;
    const staff = await newPage(browser);
    track('staff', staff);
    await staff.goto(`${WEB}/sign-in`, { waitUntil: 'networkidle0' });
    await type(staff, 'Email', 'tech@university.example');
    await type(staff, 'Password', STAFF_PW);
    await button(staff, 'Sign in');
    await see(staff, 'Hello, Tess Technician');
    await staff.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle0' });
    await see(staff, 'USD 5,000.50');
    await notSee(staff, 'EUR 900.00');
    await see(staff, 'Only System Administrators review access requests.');
    await staff.goto(`${WEB}/reports`, { waitUntil: 'networkidle0' });
    await see(staff, 'E2E Oscilloscope');
    await notSee(staff, 'E2E Rare map cabinet');
    let status = 0;
    await asStaff('GET', `/reports/asset-register?departmentId=${lib.id}&format=xlsx`).catch((e) => (status = e.status));
    if (status !== 403) throw new Error(`expected 403, got ${status}`);
    await staff.screenshot({ path: path.join(SHOTS, 'p5-4-staff-reports.png'), fullPage: true });
  });
} finally {
  await browser.close();
  finish();
}
