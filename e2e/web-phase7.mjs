// Phase 7 browser journey: post-registration review and correction across three roles (brief §9).
// Asset Management Team returns a record → department corrects it and sends it back → re-review approves it,
// and the history shows who flagged what and the before/after values.
import path from 'node:path';

import { WEB, SHOTS, button, choose, launch, link, newPage, runner, see, setupLink, tick, type } from './lib.mjs';

const API = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const { step, finish, track } = runner();
const browser = await launch();
const ADMIN_PW = 'Quiet-River-Stone-41';
const PW = 'Amber-Wrench-Table-73';

let adminToken = '';
const call = async (method, p, body, token = adminToken) => {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function person(email, fullName, role, departmentId) {
  const u = (await call('POST', '/users', { email, fullName, role, departmentId: departmentId ?? null })).body;
  await call('POST', '/auth/reset-password', { token: new URL(u.setupLink).searchParams.get('token'), newPassword: PW }, null);
}
async function signIn(email) {
  const p = await newPage(browser);
  track(email, p);
  await p.goto(`${WEB}/sign-in`, { waitUntil: 'networkidle0' });
  await type(p, 'Email', email);
  await type(p, 'Password', PW);
  await button(p, 'Sign in');
  await see(p, 'Hello,');
  return p;
}

let asset;
let manager;
let staff;
try {
  await step('setup: admin, an Asset Management Team member, department staff and a registered asset', async () => {
    const admin = await newPage(browser);
    await admin.goto(setupLink(), { waitUntil: 'networkidle0' });
    await type(admin, 'Password', ADMIN_PW);
    await type(admin, 'Confirm', ADMIN_PW);
    await button(admin, 'Next');
    await see(admin, 'all set');
    await admin.browserContext().close();
    adminToken = (await call('POST', '/auth/login', { email: 'admin@university.example', password: ADMIN_PW }, null)).body.token;
    const cs = (await call('GET', '/departments')).body.items.find((d) => d.code === 'DEVCS');
    await person('auditor@university.example', 'Ama Auditor', 'ASSET_MANAGER');
    await person('tech@university.example', 'Tess Technician', 'DEPARTMENT_STAFF', cs.id);
    const staffToken = (await call('POST', '/auth/login', { email: 'tech@university.example', password: PW }, null)).body.token;
    const cats = (await call('GET', '/categories')).body.items;
    const loc = (await call('GET', `/locations?departmentId=${cs.id}`)).body.items.find((l) => l.room === 'Lab 101');
    const a = (await call('POST', '/assets', {
      name: 'E2E Spectrometer', categoryId: cats[0].id, model: 'SPX-100', departmentId: cs.id, locationId: loc.id,
      acquisitionDate: '2025-04-01', acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '8000.00', currency: 'USD', condition: 'good',
    }, staffToken)).body;
    await call('POST', `/assets/${a.id}/label-prints`, { layout: 'sheet' }, staffToken);
    asset = (await call('POST', `/assets/${a.id}/confirm-label`, { code: a.qrPayload, method: 'scan' }, staffToken)).body;
    if (asset.registrationStatus !== 'registered' || asset.review.status !== 'not_reviewed') throw new Error('expected registered, not yet reviewed');
  });

  await step('the Asset Management Team sees it in the review queue and returns it with a reason', async () => {
    manager = await signIn('auditor@university.example');
    await see(manager, '1 to review');
    await link(manager, 'Approve new records or return them for correction');
    await see(manager, 'Awaiting first review');
    await link(manager, `${asset.institutionalId} — E2E Spectrometer`);
    await see(manager, 'Not reviewed yet');
    await button(manager, 'Return for correction');
    await type(manager, 'What needs correcting?', 'Model does not match the plate on the device');
    await tick(manager, 'Model');
    await button(manager, 'Return to department');
    await see(manager, 'Returned to Dev: Computer Science for correction.');
    await see(manager, 'Returned for correction');
  });

  await step('the department sees the request on its home screen, corrects the record and sends it back', async () => {
    staff = await signIn('tech@university.example');
    await see(staff, '1 to correct');
    await link(staff, 'Records the Asset Management Team asked your department to correct');
    await link(staff, `${asset.institutionalId} — E2E Spectrometer`);
    await see(staff, 'Model does not match the plate on the device');
    await see(staff, 'Check: Model.');
    await button(staff, 'Edit details');
    await type(staff, 'Model (optional)', 'SPX-200');
    await button(staff, 'Save changes');
    await see(staff, 'SPX-200');
    await type(staff, 'Note to the reviewer', 'Checked the plate; model fixed');
    await button(staff, 'Corrections done — send for re-review');
    await see(staff, 'Sent back for re-review.');
    await see(staff, 'Model: SPX-100 → SPX-200');
  });

  await step('re-review shows the corrections and approves the record; identity never changed', async () => {
    await manager.goto(`${WEB}/asset-reviews`, { waitUntil: 'networkidle0' });
    await choose(manager, 'Corrected — re-review');
    await see(manager, 'Corrected by Tess Technician: Checked the plate; model fixed');
    await link(manager, `${asset.institutionalId} — E2E Spectrometer`);
    await see(manager, 'Model: SPX-100 → SPX-200');
    await button(manager, 'Approve record');
    await see(manager, 'Record approved.');
    await see(manager, 'Review approved');
    await manager.screenshot({ path: path.join(SHOTS, 'p7-1-review-history.png'), fullPage: true });
    const now = (await call('GET', `/assets/${asset.id}`)).body;
    if (now.institutionalId !== asset.institutionalId || now.qrPayload !== asset.qrPayload || now.registrationStatus !== 'registered') throw new Error('identity changed');
    const history = (await call('GET', `/assets/${asset.id}/reviews`)).body.items.map((h) => `${h.action}:${h.by}`);
    if (history.join(',') !== 'approved:Ama Auditor,corrections_submitted:Tess Technician,returned:Ama Auditor') throw new Error(history.join(','));
  });
} finally {
  await browser.close();
  finish();
}
