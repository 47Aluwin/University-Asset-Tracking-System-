// Phase 3 browser journey: schedules → scan/find → verify (with discrepancy) → review flag → relocate →
// missing report/confirm/found → due & overdue list → camera scan using a fake camera that shows a QR label.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import QRCode from 'qrcode';
import puppeteer from 'puppeteer-core';

import { WEB, OUT, SHOTS, button, choose, launch, link, newPage, notSee, runner, see, setupLink, type, visible } from './lib.mjs';

const API = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const { step, finish, track } = runner();
const browser = await launch();
const admin = await newPage(browser);
track('admin', admin);
const ADMIN_PW = 'Quiet-River-Stone-41';

let token = '';
const call = async (method, p, body) => {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(json)}`);
  return json;
};

/** Registers an asset through the API (creation, label print, label confirmation). */
async function registerAsset(name, categoryName) {
  const cats = (await call('GET', '/categories')).items;
  const depts = (await call('GET', '/departments')).items;
  const cs = depts.find((d) => d.code === 'DEVCS');
  const locs = (await call('GET', `/locations?departmentId=${cs.id}`)).items;
  const a = await call('POST', '/assets', {
    name,
    categoryId: cats.find((c) => c.name === categoryName).id,
    serialNumber: `E2E-${Math.random().toString(36).slice(2, 10)}`,
    departmentId: cs.id,
    locationId: locs.find((l) => l.room === 'Lab 101').id,
    acquisitionDate: '2025-05-01',
    acquisitionMethod: 'purchase',
    costStatus: 'recorded',
    acquisitionCost: '500.00',
    currency: 'USD',
    condition: 'good',
  });
  await call('POST', `/assets/${a.id}/label-prints`, { layout: 'sheet' });
  return call('POST', `/assets/${a.id}/confirm-label`, { code: a.qrPayload, method: 'scan' });
}

/** A short MJPEG "video" of a printed QR label, for Chromium's fake camera. */
async function writeFakeCamera(payload, file) {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'Q' });
  const W = 640, H = 480, size = qr.modules.size, scale = 10, quiet = 4;
  const total = (size + quiet * 2) * scale;
  const ox = Math.floor((W - total) / 2), oy = Math.floor((H - total) / 2);
  const data = Buffer.alloc(W * H * 4, 0xff);
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (qr.modules.get(r, c))
        for (let y = 0; y < scale; y++)
          for (let x = 0; x < scale; x++) {
            const i = ((oy + (r + quiet) * scale + y) * W + ox + (c + quiet) * scale + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
  const frame = jpeg.encode({ data, width: W, height: H }, 90).data;
  writeFileSync(file, Buffer.concat(Array.from({ length: 30 }, () => frame)));
}

let first, second;

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
    token = (await call('POST', '/auth/login', { email: 'admin@university.example', password: ADMIN_PW })).token;
  });

  await step('admin adds an institution-wide monthly verification schedule', async () => {
    await link(admin, 'Verification schedules');
    await see(admin, 'No schedules yet');
    await button(admin, 'Monthly');
    await button(admin, 'Add schedule');
    await see(admin, 'Schedule added');
    await see(admin, 'Every 30 days');
  });

  await step('a newly registered asset shows "not yet verified" with a due date', async () => {
    first = await registerAsset('E2E Spectrometer', 'Dev: Lab equipment');
    await admin.goto(`${WEB}/inventory/${first.id}`, { waitUntil: 'networkidle0' });
    await see(admin, 'Physical verification');
    await see(admin, 'Never verified');
    await see(admin, 'Every 30 days');
  });

  await step('find by typed code, confirm identity, verify somewhere else (discrepancy)', async () => {
    await admin.goto(`${WEB}/scan`, { waitUntil: 'networkidle0' });
    await type(admin, 'Or type the asset ID', first.institutionalId);
    await button(admin, 'Find asset');
    await see(admin, 'Is this the asset?');
    await see(admin, 'E2E Spectrometer');
    await button(admin, 'Yes — record that I can see it');
    await see(admin, 'Where are you now?');
    await choose(admin, 'Office 204');
    await see(admin, 'This is not where the asset is recorded');
    await admin.screenshot({ path: path.join(SHOTS, 'p3-1-verify.png'), fullPage: true });
    await button(admin, 'Confirm I can see this asset');
    await see(admin, 'Verification recorded');
    await see(admin, 'flagged for the Asset Management Team');
    await see(admin, 'Its recorded location was not changed');
  });

  await step('the discrepancy appears in Review flags and is resolved with a note', async () => {
    await admin.goto(`${WEB}/review`, { waitUntil: 'networkidle0' });
    await see(admin, 'Found in a different location');
    await see(admin, 'Recorded at Dev: Science Block, Lab 101, seen at Dev: Science Block, Office 204');
    await button(admin, 'Resolve');
    await see(admin, 'Say what was checked or done');
    await type(admin, 'What did you check or do?', 'Moved back to Lab 101 by the lab manager');
    await button(admin, 'Resolve');
    await see(admin, 'Flag resolved.');
    await see(admin, 'Nothing to review.');
  });

  await step('relocate the asset; history keeps the old location', async () => {
    await admin.goto(`${WEB}/inventory/${first.id}`, { waitUntil: 'networkidle0' });
    await button(admin, 'Relocate');
    await choose(admin, 'Office 204');
    await button(admin, 'Relocate asset');
    await see(admin, 'Relocation recorded');
    await see(admin, 'Movement history');
    await see(admin, 'Dev: Science Block, Lab 101 → Dev: Science Block, Office 204');
    await see(admin, 'Verification history');
  });

  await step('report missing, confirm missing, then a verification marks it found', async () => {
    await type(admin, 'Where was it last seen?', 'Not in Office 204 at the October check');
    await button(admin, 'Report missing');
    await see(admin, 'Reported missing.');
    await type(admin, 'Note', 'Searched the whole building');
    await button(admin, 'Confirm missing');
    await see(admin, 'Confirmed missing.');
    await admin.screenshot({ path: path.join(SHOTS, 'p3-2-missing.png'), fullPage: true });
    await button(admin, 'Verify (seen it)');
    await button(admin, 'Confirm I can see this asset');
    await see(admin, 'Verification recorded');
    await button(admin, 'View asset');
    await notSee(admin, 'Confirmed missing');
    await admin.goto(`${WEB}/review`, { waitUntil: 'networkidle0' });
    await see(admin, 'Found after being missing');
  });

  await step('an overdue asset appears in "Due and overdue", most overdue first', async () => {
    second = await registerAsset('E2E Old cabinet', 'Dev: Furniture');
    const furniture = (await call('GET', '/categories')).items.find((c) => c.name === 'Dev: Furniture');
    await call('POST', '/verification-schedules', { departmentId: null, categoryId: furniture.id, intervalDays: 1, dueWindowDays: 0 });
    // Last seen three days ago with a daily schedule → due two days ago.
    await call('POST', `/assets/${second.id}/verifications`, { method: 'manual', eventTime: new Date(Date.now() - 3 * 86400000).toISOString() });
    await admin.goto(`${WEB}/`, { waitUntil: 'networkidle0' });
    await see(admin, '1 overdue');
    await link(admin, 'Due and overdue');
    await see(admin, 'E2E Old cabinet');
    await see(admin, 'Overdue 2 d');
    await notSee(admin, 'E2E Spectrometer');
    await admin.screenshot({ path: path.join(SHOTS, 'p3-3-overdue-list.png'), fullPage: true });
  });

  /**
   * Opens a separate headless Edge whose camera is a video of the given QR payload, signs in, and runs fn.
   * Requests to the public CDN the web QR decoder would otherwise use are blocked, and recorded.
   */
  async function withFakeCamera(payload, fn) {
    const video = path.join(OUT, 'fake-camera.mjpeg');
    await writeFakeCamera(payload, video);
    const camBrowser = await puppeteer.launch({
      executablePath: process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
    });
    const blockedCdn = [];
    const decoderRequests = [];
    try {
      const p = await newPage(camBrowser, 900, 1000);
      await p.setRequestInterception(true);
      p.on('request', (r) => {
        const u = r.url();
        if (/jsdelivr|unpkg|fastly/i.test(u)) {
          blockedCdn.push(u);
          return r.abort();
        }
        if (u.endsWith('.wasm')) decoderRequests.push(new URL(u).pathname);
        r.continue();
      });
      await p.goto(`${WEB}/sign-in`, { waitUntil: 'networkidle0' });
      await type(p, 'Email', 'admin@university.example');
      await type(p, 'Password', ADMIN_PW);
      await button(p, 'Sign in');
      await see(p, 'Hello, E2E Admin');
      const native = await p.evaluate(() => typeof globalThis.BarcodeDetector !== 'undefined');
      await fn(p);
      if (blockedCdn.length) throw new Error(`the page tried to load code from a public CDN: ${blockedCdn[0]}`);
      return { native, decoderRequests };
    } finally {
      await camBrowser.close();
    }
  }

  await step('camera: the scan screen reads a QR label with no help from public CDNs', async () => {
    const r = await withFakeCamera(second.qrPayload, async (p) => {
      await p.goto(`${WEB}/scan`, { waitUntil: 'networkidle0' });
      const allow = await p.$('[role="button"] ::-p-text(Allow camera)');
      if (allow) await allow.click();
      await visible(p, '::-p-text(Is this the asset?)', 30000);
      await see(p, 'E2E Old cabinet');
      await p.screenshot({ path: path.join(SHOTS, 'p3-4-camera-scan.png'), fullPage: true });
    });
    console.log(`  browser built-in barcode reader: ${r.native ? 'yes' : 'no (self-hosted decoder used)'}; decoder files loaded: ${r.decoderRequests.join(', ') || 'none'}`);
    if (!r.native && !r.decoderRequests.includes('/zxing/zxing_reader.wasm')) {
      throw new Error('expected the self-hosted decoder /zxing/zxing_reader.wasm to be loaded');
    }
  });

  await step('camera: scanning the attached label completes registration', async () => {
    // A new asset with its label printed but not yet confirmed.
    const cats = (await call('GET', '/categories')).items;
    const depts = (await call('GET', '/departments')).items;
    const cs = depts.find((d) => d.code === 'DEVCS');
    const locs = (await call('GET', `/locations?departmentId=${cs.id}`)).items;
    const a = await call('POST', '/assets', {
      name: 'E2E Projector', categoryId: cats.find((c) => c.name === 'Dev: Audio-visual').id, serialNumber: `E2E-P-${Date.now()}`,
      departmentId: cs.id, locationId: locs.find((l) => l.room === 'Lab 101').id, acquisitionDate: '2025-06-01',
      acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '700.00', currency: 'USD', condition: 'excellent',
    });
    await call('POST', `/assets/${a.id}/label-prints`, { layout: 'sheet' });
    await withFakeCamera(a.qrPayload, async (p) => {
      await p.goto(`${WEB}/inventory/${a.id}/label`, { waitUntil: 'networkidle0' });
      await button(p, 'Scan the attached label');
      const allow = await p.$('[role="button"] ::-p-text(Allow camera)');
      if (allow) await allow.click();
      // Confirmation happens as soon as the camera reads the label; the app then opens the asset page.
      await visible(p, '::-p-text(Identification)', 30000);
      await see(p, 'Label attached and confirmed');
      await see(p, 'QR code scanned');
    });
    const after = await call('GET', `/assets/${a.id}`);
    if (after.registrationStatus !== 'registered') throw new Error(`expected registered, got ${after.registrationStatus}`);
  });
} finally {
  await browser.close();
  finish();
}
