// Phase 1 browser journey against the real API + exported web app (headless Microsoft Edge).
import puppeteer from 'puppeteer-core';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Configuration (see e2e/README.md):
//   WEB_URL      where the exported web app is served (default http://localhost:8099)
//   BROWSER_PATH Chrome/Edge executable (default: Microsoft Edge on Windows)
//   SETUP_FILE   file containing the output of `npm run create-admin` (default e2e/.out/admin.txt)
const WEB = process.env.WEB_URL ?? 'http://localhost:8099';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, '.out');
const SHOTS = path.join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const setupLink = readFileSync(process.env.SETUP_FILE ?? path.join(OUT, 'admin.txt'), 'utf8').match(/http\S+/)[0];

const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log('PASS', name);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
    console.log('FAIL', name, '-', e.message.split(String.fromCharCode(10))[0]);
    for (const [label, p] of [['admin', admin], ['staff', staff]]) {
      try {
        await p.screenshot({ path: path.join(SHOTS, `FAIL-${label}.png`), fullPage: true });
        console.log(`  ${label} url:`, p.url());
        console.log(`  ${label} text:`, (await p.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\s*\n\s*/g, ' | '));
      } catch {}
    }
    throw e;
  }
};

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-first-run', '--disable-extensions'],
});

async function newPage(ctx, width = 1280, height = 900) {
  const p = await ctx.newPage();
  await p.setViewport({ width, height });
  p.on('dialog', (d) => d.accept()); // confirm() prompts for consequential actions
  p.on('pageerror', (e) => console.log('  [page error]', e.message));
  return p;
}
// The navigator keeps earlier screens in the DOM (hidden), so always act on the *visible* match.
async function visible(p, selector, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const el of await p.$$(selector)) {
      const box = await el.boundingBox().catch(() => null);
      const shown = box && box.width > 0 && box.height > 0 && (await el.isVisible().catch(() => false));
      if (shown) return el;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no visible element for ${selector}`);
}
const type = async (p, label, text) => {
  const el = await visible(p, `input[aria-label="${label}"], textarea[aria-label="${label}"]`);
  await el.click({ clickCount: 3 });
  await el.type(text);
};
const click = async (p, text) => {
  const el = await visible(p, `[role="button"] ::-p-text(${text}), [role="link"] ::-p-text(${text}), [role="radio"] ::-p-text(${text})`);
  await el.click();
};
const button = async (p, text) => (await visible(p, `[role="button"] ::-p-text(${text})`)).click();
const see = (p, text, timeout = 10000) => visible(p, `::-p-text(${text})`, timeout);
const notSee = async (p, text) => {
  for (const el of await p.$$(`::-p-text(${text})`)) {
    if (await el.isVisible().catch(() => false)) throw new Error(`unexpectedly found "${text}"`);
  }
};

const adminCtx = await browser.createBrowserContext();
const staffCtx = await browser.createBrowserContext();
const admin = await newPage(adminCtx);
const staff = await newPage(staffCtx, 390, 844); // phone-sized viewport

try {
  await step('admin creates a password from the one-time setup link', async () => {
    await admin.goto(setupLink.replace(/^https?:\/\/[^/]+/, WEB), { waitUntil: 'networkidle0' });
    await see(admin, 'Create a password');
    await see(admin, 'admin@university.example');
    await type(admin, 'Password', 'Quiet-River-Stone-41');
    await type(admin, 'Confirm', 'Quiet-River-Stone-41');
    await click(admin, 'Next');
    await see(admin, 'all set');
  });

  await step('setup link cannot be reused (refused before typing anything)', async () => {
    await admin.goto(setupLink.replace(/^https?:\/\/[^/]+/, WEB), { waitUntil: 'networkidle0' });
    await see(admin, 'This link no longer works');
  });

  await step('wrong password shows generic error', async () => {
    await admin.goto(`${WEB}/sign-in`, { waitUntil: 'networkidle0' });
    await type(admin, 'Email', 'admin@university.example');
    await type(admin, 'Password', 'not-the-password');
    await click(admin, 'Sign in');
    await see(admin, 'Email or password is incorrect.');
  });

  await step('admin signs in and sees administration tiles', async () => {
    await type(admin, 'Password', 'Quiet-River-Stone-41');
    await click(admin, 'Sign in');
    await see(admin, 'Hello, E2E Admin');
    await see(admin, 'Access requests');
    await see(admin, 'Audit log');
    await admin.screenshot({ path: path.join(SHOTS, '1-admin-home-desktop.png') });
  });

  await step('staff submits an access request (phone width)', async () => {
    await staff.goto(`${WEB}/sign-in`, { waitUntil: 'networkidle0' });
    await click(staff, 'Request access');
    await type(staff, 'Full name', 'Pat Fieldworker');
    await type(staff, 'Institutional email', 'pat@university.example');
    await click(staff, 'Dev: Engineering');
    await type(staff, 'Reason for access', 'I receive new workshop equipment.');
    await type(staff, 'Choose a password', 'Green-Lathe-Bench-88');
    await type(staff, 'Confirm password', 'Green-Lathe-Bench-88');
    await staff.screenshot({ path: path.join(SHOTS, '2-request-access-phone.png'), fullPage: true });
    await click(staff, 'Submit request');
    await see(staff, 'Request submitted');
  });

  await step('pending staff cannot sign in and is told why', async () => {
    await click(staff, 'Back to sign in');
    await type(staff, 'Email', 'pat@university.example');
    await type(staff, 'Password', 'Green-Lathe-Bench-88');
    await click(staff, 'Sign in');
    await see(staff, 'awaiting administrator approval');
  });

  await step('admin sees pending count and approves the request', async () => {
    await admin.goto(`${WEB}/`, { waitUntil: 'networkidle0' });
    await see(admin, '1 pending');
    await click(admin, 'Access requests');
    await see(admin, 'Pat Fieldworker');
    await button(admin, 'Approve');
    await see(admin, 'Approved Pat Fieldworker.');
    await see(admin, 'No pending requests.');
  });

  await step('approved staff signs in; no admin tools shown', async () => {
    await click(staff, 'Sign in');
    await see(staff, 'Hello, Pat Fieldworker');
    await see(staff, 'Department Staff · Dev: Engineering');
    await notSee(staff, 'Administration');
    await staff.screenshot({ path: path.join(SHOTS, '3-staff-home-phone.png'), fullPage: true });
  });

  await step('staff opening an admin URL directly is refused by the server', async () => {
    await staff.goto(`${WEB}/admin/users`, { waitUntil: 'networkidle0' });
    await see(staff, 'You do not have permission');
  });

  await step('admin deactivates the staff account', async () => {
    await admin.goto(`${WEB}/admin/users`, { waitUntil: 'networkidle0' });
    await click(admin, 'Pat Fieldworker');
    await see(admin, 'pat@university.example');
    await type(admin, 'Reason for deactivation', 'E2E test: left the university');
    await click(admin, 'Deactivate account');
    await see(admin, 'Account deactivated.');
    await admin.screenshot({ path: path.join(SHOTS, '4-user-detail-desktop.png'), fullPage: true });
  });

  await step('deactivated staff is signed out on next action and cannot sign back in', async () => {
    await staff.goto(`${WEB}/account`, { waitUntil: 'networkidle0' });
    await see(staff, 'Sign in with your institutional account');
    await type(staff, 'Email', 'pat@university.example');
    await type(staff, 'Password', 'Green-Lathe-Bench-88');
    await click(staff, 'Sign in');
    await see(staff, 'This account has been deactivated');
  });

  await step('audit log shows the approval and deactivation', async () => {
    await admin.goto(`${WEB}/admin/audit`, { waitUntil: 'networkidle0' });
    await see(admin, 'user.deactivate');
    await see(admin, 'access_request.approve');
  });
} finally {
  await browser.close();
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
