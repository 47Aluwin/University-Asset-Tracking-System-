// Phase 6 browser journey. The web app is online-only: losing the connection gives a clear message and
// nothing is half-saved. Edits that phones made offline and that clashed with newer changes are reviewed on the
// "Waiting to sync" page. (The phone's offline queue itself is tested against the real API in
// server/test/offline-sync.test.ts; phones are not available in this environment.)
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { WEB, SHOTS, button, launch, newPage, runner, see, setupLink, type } from './lib.mjs';

const API = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const { step, finish, track } = runner();
const browser = await launch();
const admin = await newPage(browser);
track('admin', admin);
const ADMIN_PW = 'Quiet-River-Stone-41';

let adminToken = '';
const call = async (method, p, body, headers = {}) => {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

let asset;
try {
  await step('admin signs in; a registered asset exists', async () => {
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
    adminToken = (await call('POST', '/auth/login', { email: 'admin@university.example', password: ADMIN_PW })).body.token;
    const cats = (await call('GET', '/categories')).body.items;
    const cs = (await call('GET', '/departments')).body.items.find((d) => d.code === 'DEVCS');
    const loc = (await call('GET', `/locations?departmentId=${cs.id}`)).body.items.find((l) => l.room === 'Lab 101');
    const a = (await call('POST', '/assets', {
      name: 'E2E Field radio', categoryId: cats[0].id, serialNumber: `E2E-${Date.now()}`, departmentId: cs.id, locationId: loc.id,
      acquisitionDate: '2025-04-01', acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '300.00', currency: 'USD', condition: 'good',
    })).body;
    await call('POST', `/assets/${a.id}/label-prints`, { layout: 'sheet' });
    asset = (await call('POST', `/assets/${a.id}/confirm-label`, { code: a.qrPayload, method: 'scan' })).body;
  });

  await step('web is online-only: losing the connection gives a clear message and saves nothing', async () => {
    await admin.goto(`${WEB}/inventory/${asset.id}/verify`, { waitUntil: 'networkidle0' });
    await see(admin, `Verify ${asset.institutionalId}`);
    await admin.setOfflineMode(true);
    await button(admin, 'Confirm I can see this asset');
    await see(admin, 'Cannot reach the server');
    await admin.setOfflineMode(false);
    const v = await call('GET', `/assets/${asset.id}/verifications`);
    if (v.body.items.length !== 0) throw new Error('a verification was recorded while offline');
    // Back online, the same button works, once.
    await button(admin, 'Confirm I can see this asset');
    await see(admin, 'Verification recorded');
    const after = await call('GET', `/assets/${asset.id}/verifications`);
    if (after.body.items.length !== 1) throw new Error(`expected 1 verification, got ${after.body.items.length}`);
  });

  await step('an offline edit that clashed with a newer change is shown side by side and can be applied', async () => {
    // A colleague edits online; then a phone delivers an edit it made earlier, from the older version.
    const v = asset.version;
    await call('PATCH', `/assets/${asset.id}`, { notes: 'Office note', version: v });
    const clash = await call('PATCH', `/assets/${asset.id}`, { notes: 'Field note: aerial bent', version: v, baseValues: { notes: null } }, { 'X-Operation-Id': randomUUID() });
    if (clash.status !== 409 || clash.body.error.code !== 'SYNC_CONFLICT') throw new Error(JSON.stringify(clash));
    const current = (await call('GET', `/assets/${asset.id}`)).body;
    if (current.notes !== 'Office note') throw new Error('the newer change was overwritten');

    await admin.goto(`${WEB}/sync`, { waitUntil: 'networkidle0' });
    await see(admin, 'Edits that clashed with newer changes');
    await see(admin, `${asset.institutionalId} — E2E Field radio`);
    await see(admin, 'notes: now “Office note” · field edit “Field note: aerial bent”');
    await admin.screenshot({ path: path.join(SHOTS, 'p6-1-conflict.png'), fullPage: true });
    await type(admin, 'Note (optional)', 'Checked with the field team');
    await button(admin, 'Apply the field edit');
    await see(admin, `The field edit was applied to ${asset.institutionalId}.`);
    const fixed = (await call('GET', `/assets/${asset.id}`)).body;
    if (fixed.notes !== 'Field note: aerial bent') throw new Error(`notes are ${fixed.notes}`);
  });

  await step('a second clash can be discarded, keeping the current values', async () => {
    const v = (await call('GET', `/assets/${asset.id}`)).body.version;
    await call('PATCH', `/assets/${asset.id}`, { model: 'RX-3', version: v });
    await call('PATCH', `/assets/${asset.id}`, { model: 'RX-1', version: v, baseValues: { model: null } }, { 'X-Operation-Id': randomUUID() });
    await admin.goto(`${WEB}/sync`, { waitUntil: 'networkidle0' });
    await see(admin, 'model: now “RX-3” · field edit “RX-1”');
    await button(admin, 'Keep current values');
    await see(admin, `The field edit for ${asset.institutionalId} was discarded.`);
    if ((await call('GET', `/assets/${asset.id}`)).body.model !== 'RX-3') throw new Error('model changed');
    const audit = await call('GET', '/audit?action=sync.conflict_discarded');
    if (audit.status === 200 && audit.body.items && !audit.body.items.length) throw new Error('discard not audited');
  });
} finally {
  await browser.close();
  finish();
}
