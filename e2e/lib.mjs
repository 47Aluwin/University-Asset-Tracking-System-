// Shared helpers for browser journeys (Phase 2 onwards).
import puppeteer from 'puppeteer-core';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB = process.env.WEB_URL ?? 'http://localhost:8099';
export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(DIR, '.out');
export const SHOTS = path.join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });

export const setupLink = () =>
  readFileSync(process.env.SETUP_FILE ?? path.join(OUT, 'admin.txt'), 'utf8')
    .match(/http\S+/)[0]
    .replace(/^https?:\/\/[^/]+/, WEB);

export async function launch() {
  return puppeteer.launch({
    executablePath: process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--no-first-run', '--disable-extensions'],
  });
}

/**
 * New page that auto-accepts confirm() dialogs and captures label documents sent to print:
 * the app prints labels from a hidden iframe, so each iframe's print() is replaced by a recorder.
 */
export async function newPage(browser, width = 1280, height = 900) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width, height });
  // Light mode by default (E2E_COLOR_SCHEME=dark to check the dark theme).
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.E2E_COLOR_SCHEME ?? 'light' }]);
  p.on('dialog', (d) => d.accept());
  p.on('pageerror', (e) => console.log('  [page error]', e.message));
  await p.evaluateOnNewDocument(() => {
    window.__printed = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n.tagName === 'IFRAME' && n.contentWindow) {
            n.contentWindow.print = () => window.__printed.push(n.contentDocument.documentElement.outerHTML);
          }
    }).observe(document, { childList: true, subtree: true });
  });
  return p;
}

// The navigator keeps earlier screens in the DOM (hidden), so always act on the *visible* match.
export async function visible(p, selector, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const el of await p.$$(selector)) {
      const box = await el.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0 && (await el.isVisible().catch(() => false))) return el;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no visible element for ${selector}`);
}

export const type = async (p, label, text) => {
  const el = await visible(p, `input[aria-label="${label}"], textarea[aria-label="${label}"]`);
  if ((await el.evaluate((e) => e.type)) === 'date') {
    await el.evaluate((e, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, v);
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
    return;
  }
  await el.click({ clickCount: 3 });
  await el.press('Backspace');
  await el.type(text);
};
/** Opens a folded filter panel (phone-sized windows start with filters hidden). */
export const openFilters = async (p) => {
  const folded = await p.$('[role="button"] ::-p-text(▸ Filters)');
  if (folded) await folded.click();
};
/** Clicks a button whose text matches exactly (avoids "Approve" matching "Approved"). */
export const button = async (p, text) => (await visible(p, `[role="button"] ::-p-text(${text})`)).click();
export const choose = async (p, text) => (await visible(p, `[role="radio"] ::-p-text(${text})`)).click();
export const tick = async (p, text) => (await visible(p, `[role="checkbox"] ::-p-text(${text})`)).click();
export const link = async (p, text) => (await visible(p, `[role="link"] ::-p-text(${text})`)).click();
export const see = (p, text, timeout = 10000) => visible(p, `::-p-text(${text})`, timeout);
export const notSee = async (p, text) => {
  for (const el of await p.$$(`::-p-text(${text})`)) {
    if (await el.isVisible().catch(() => false)) throw new Error(`unexpectedly found "${text}"`);
  }
};

export function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
}

/** Screenshots the visible on-screen QR code and decodes it. */
export async function decodeQrOnScreen(p) {
  const el = await visible(p, '[data-testid="asset-qr"]');
  return decodePng(await el.screenshot({ type: 'png' }));
}

/** Renders a captured label document in a fresh page and decodes the first label's QR from pixels. */
export async function decodePrintedLabel(browser, html, name) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 });
  await p.setContent(html, { waitUntil: 'load' });
  const qr = await p.$('.qr');
  const shot = await qr.screenshot({ type: 'png' });
  await p.screenshot({ path: path.join(SHOTS, name), fullPage: false });
  await ctx.close();
  return decodePng(shot);
}

export function runner() {
  const results = [];
  const pages = [];
  const step = async (name, fn) => {
    try {
      await fn();
      results.push(['PASS', name]);
      console.log('PASS', name);
    } catch (e) {
      results.push(['FAIL', name, e.message]);
      console.log('FAIL', name, '-', String(e.message).split('\n')[0]);
      for (const [label, p] of pages) {
        try {
          await p.screenshot({ path: path.join(SHOTS, `FAIL-${label}.png`), fullPage: true });
          console.log(`  ${label} url:`, p.url());
          console.log(`  ${label} text:`, (await p.evaluate(() => document.body.innerText)).slice(0, 500).replace(/\s*\n\s*/g, ' | '));
        } catch {}
      }
      throw e;
    }
  };
  const finish = () => {
    const failed = results.filter((r) => r[0] === 'FAIL').length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  };
  return { step, finish, track: (label, p) => pages.push([label, p]) };
}
