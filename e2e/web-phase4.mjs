// Phase 4 browser journey: damage report with a real photo → maintenance request → external service →
// costs in two currencies → completion → condition confirmed separately → approval rule per department.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';

import { WEB, OUT, SHOTS, button, choose, tick, launch, newPage, notSee, runner, see, setupLink, type, visible } from './lib.mjs';

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
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(json)}`);
  return json;
};
let adminToken = '';
let staffToken = '';
const asAdmin = caller(() => adminToken);
const asStaff = caller(() => staffToken);

async function registerAsset(name) {
  const cats = (await asAdmin('GET', '/categories')).items;
  const cs = (await asAdmin('GET', '/departments')).items.find((d) => d.code === 'DEVCS');
  const loc = (await asAdmin('GET', `/locations?departmentId=${cs.id}`)).items.find((l) => l.room === 'Lab 101');
  const a = await asAdmin('POST', '/assets', {
    name, categoryId: cats.find((c) => c.name === 'Dev: Lab equipment').id, serialNumber: `E2E-${Date.now()}`, departmentId: cs.id,
    locationId: loc.id, acquisitionDate: '2025-04-01', acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '3200.00',
    currency: 'USD', condition: 'good',
  });
  await asAdmin('POST', `/assets/${a.id}/label-prints`, { layout: 'sheet' });
  return asAdmin('POST', `/assets/${a.id}/confirm-label`, { code: a.qrPayload, method: 'scan' });
}

/** A real (small) JPEG photo for the upload test. */
function writePhoto(file) {
  const W = 320, H = 240, data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = 160 + (x % 64); data[i + 1] = 30 + (y % 80); data[i + 2] = 48; data[i + 3] = 255;
    }
  writeFileSync(file, jpeg.encode({ data, width: W, height: H }, 85).data);
}

let asset;
let requestUrl = '';

try {
  await step('admin signs in', async () => {
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
    asset = await registerAsset('E2E Fume cupboard');
  });

  await step('report damage with a photo and open a maintenance request in one step', async () => {
    const photo = path.join(OUT, 'damage.jpg');
    writePhoto(photo);
    await admin.goto(`${WEB}/inventory/${asset.id}`, { waitUntil: 'networkidle0' });
    await button(admin, 'Report damage');
    await see(admin, 'There is damage or a fault');
    await type(admin, 'What is damaged or not working?', 'Extraction fan rattles and the sash glass is cracked');
    const [chooser] = await Promise.all([admin.waitForFileChooser(), button(admin, 'Choose photo')]);
    await chooser.accept([photo]);
    await see(admin, 'Remove');
    await tick(admin, 'Also request maintenance or repair');
    await type(admin, 'What needs doing?', 'Replace the sash glass and service the fan');
    await choose(admin, 'Urgent');
    await admin.screenshot({ path: path.join(SHOTS, 'p4-1-damage-report.png'), fullPage: true });
    await button(admin, 'Save damage report');
    await see(admin, 'created. Your department manages it from here');
    await see(admin, 'Submitted');
    await see(admin, 'Priority: Urgent');
    requestUrl = admin.url();
  });

  await step('the damage photo is stored privately and shown in the condition history', async () => {
    await admin.goto(`${WEB}/inventory/${asset.id}`, { waitUntil: 'networkidle0' });
    await see(admin, 'Condition history');
    await see(admin, 'Damage reported: Good → Damaged');
    // The thumbnail is loaded through the protected attachments endpoint (with the session token).
    await admin.waitForFunction(() => [...document.images].some((img) => img.src.startsWith('blob:') && img.naturalWidth === 320), { timeout: 15000 });
  });

  await step('work starts, then the request goes to an external service provider', async () => {
    await admin.goto(requestUrl, { waitUntil: 'networkidle0' });
    await choose(admin, 'Start work');
    await button(admin, 'Update status');
    await see(admin, 'Status changed to “In progress”');
    await choose(admin, 'Sent to external service');
    await type(admin, 'Service provider', 'PNG Lab Services');
    await type(admin, 'Contact (optional)', '+675 472 0000');
    await button(admin, 'Update status');
    await see(admin, 'Status changed to “Awaiting external service”');
    await see(admin, 'External service: PNG Lab Services');
  });

  await step('costs in two currencies are listed and never added together', async () => {
    await type(admin, 'Description', 'Replacement sash glass');
    await type(admin, 'Amount', '120.50');
    await type(admin, 'Currency', 'USD');
    await button(admin, 'Add cost');
    await see(admin, 'Cost added.');
    await choose(admin, 'External service');
    await type(admin, 'Description', 'Fan service call-out');
    await type(admin, 'Amount', '300');
    await type(admin, 'Currency', 'PGK');
    await button(admin, 'Add cost');
    await see(admin, 'K300.00 + USD 120.50 (different currencies are not added together)');
  });

  await step('completing the work does not change the asset’s condition by itself', async () => {
    await type(admin, 'Work performed', 'Glass replaced by PNG Lab Services; fan bearings replaced and tested');
    await choose(admin, 'Repaired');
    await button(admin, 'Mark completed');
    await see(admin, 'Marked completed. Now confirm');
    await see(admin, 'has not been confirmed yet');
    await see(admin, 'condition now damaged');
  });

  await step('a person confirms the resulting condition; it enters the asset’s history', async () => {
    await choose(admin, 'Good');
    await type(admin, 'Note (optional)', 'Airflow tested, sash moves freely');
    await button(admin, 'Confirm condition');
    await see(admin, 'Condition confirmed and added');
    await see(admin, 'Resulting condition confirmed as good');
    await admin.screenshot({ path: path.join(SHOTS, 'p4-2-request-completed.png'), fullPage: true });
    await admin.goto(`${WEB}/inventory/${asset.id}`, { waitUntil: 'networkidle0' });
    await see(admin, 'Condition confirmed after maintenance: Damaged → Good');
    await see(admin, 'Condition: Good');
  });

  await step('a department can require approval; the reporter cannot approve their own request', async () => {
    // A staff member in Dev: Computer Science reports a problem.
    const cs = (await asAdmin('GET', '/departments')).items.find((d) => d.code === 'DEVCS');
    const created = await asAdmin('POST', '/users', { email: 'tech@university.example', fullName: 'Tess Technician', role: 'DEPARTMENT_STAFF', departmentId: cs.id });
    const token = new URL(created.setupLink).searchParams.get('token');
    await asAdmin('POST', '/auth/reset-password', { token, newPassword: STAFF_PW });
    staffToken = (await asStaff('POST', '/auth/login', { email: 'tech@university.example', password: STAFF_PW })).token;
    // The admin turns approval on in the Departments screen.
    await admin.goto(`${WEB}/admin/departments`, { waitUntil: 'networkidle0' });
    await visible(admin, '::-p-text(Dev: Computer Science)');
    // Departments are grouped by faculty, so pick the button inside Dev: Computer Science's own card
    // (the smallest block holding one department); the success message confirms the right one changed.
    const buttons = await admin.$$('[role="button"] ::-p-text(Require maintenance approval)');
    let target = null;
    for (const b of buttons) {
      const mine = await b.evaluate((el) => {
        let n = el;
        while (n && !((n.innerText ?? '').match(/Default currency:/g)?.length === 1)) n = n.parentElement;
        return !!n && n.innerText.includes('Dev: Computer Science');
      });
      if (mine) target = b;
    }
    if (!target) throw new Error('no approval button for Dev: Computer Science');
    await target.click();
    await see(admin, 'Dev: Computer Science: maintenance approval now required for new requests');
    const r = await asStaff('POST', '/maintenance', { assetId: asset.id, problem: 'Annual safety inspection due', priority: 'normal' });
    if (!r.requiresApproval) throw new Error('request should require approval');
    if (r.can.nextStatuses.includes('in_progress')) throw new Error('work must not be able to start before approval');
    const self = await fetch(`${API}/maintenance/${r.id}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${staffToken}` }, body: JSON.stringify({ to: 'approved', version: r.version }),
    });
    if (self.status !== 403) throw new Error(`self-approval should be refused, got ${self.status}`);
    // Someone else (the admin) approves it in the app.
    await admin.goto(`${WEB}/maintenance/${r.id}`, { waitUntil: 'networkidle0' });
    await see(admin, 'Needs approval by someone other than the reporter');
    await choose(admin, 'Approve');
    await button(admin, 'Update status');
    await see(admin, 'Status changed to “Approved”');
    await see(admin, 'Approved');
    await choose(admin, 'Start work');
  });

  await step('maintenance list: open requests, then closed ones', async () => {
    await admin.goto(`${WEB}/`, { waitUntil: 'networkidle0' });
    await see(admin, '1 open');
    await admin.goto(`${WEB}/maintenance`, { waitUntil: 'networkidle0' });
    await see(admin, 'Annual safety inspection due');
    await notSee(admin, 'Replace the sash glass');
    await choose(admin, 'Closed');
    await see(admin, 'Replace the sash glass and service the fan');
    await admin.screenshot({ path: path.join(SHOTS, 'p4-3-maintenance-list.png'), fullPage: true });
  });
} finally {
  await browser.close();
  finish();
}
