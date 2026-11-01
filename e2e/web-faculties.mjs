// Browser journey: faculty → school/department classification (PNG University of Technology structure).
// Dependent dropdowns (faculty first, schools filtered, reset on change, searchable), registration with the new
// fields, faculty kept on edit, faculty shown on details, filters, dashboard and reports — on desktop and phone width.
import path from 'node:path';

import { WEB, SHOTS, button, choose, launch, link, newPage, notSee, runner, see, setupLink, type } from './lib.mjs';

const API = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const { step, finish, track } = runner();
const browser = await launch();
const ADMIN_PW = 'Quiet-River-Stone-41';

let adminToken = '';
const call = async (method, p, body, token = adminToken) => {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

let admin;
let assetId;
try {
  await step('setup: administrator signs in; faculties and schools are already there', async () => {
    admin = await newPage(browser);
    track('admin', admin);
    await admin.goto(setupLink(), { waitUntil: 'networkidle0' });
    await type(admin, 'Password', ADMIN_PW);
    await type(admin, 'Confirm', ADMIN_PW);
    await button(admin, 'Next');
    await see(admin, 'all set');
    await admin.goto(`${WEB}/sign-in`, { waitUntil: 'networkidle0' });
    await type(admin, 'Email', 'admin@university.example');
    await type(admin, 'Password', ADMIN_PW);
    await button(admin, 'Sign in');
    await see(admin, 'Hello,');
    adminToken = (await call('POST', '/auth/login', { email: 'admin@university.example', password: ADMIN_PW }, null)).body.token;
    const faculties = (await call('GET', '/faculties')).body.items;
    if (faculties.length !== 6) throw new Error(`expected 6 faculties, got ${faculties.length}`);
    await call('POST', '/categories', { name: 'Survey equipment' });
  });

  await step('faculty first: schools appear only for the chosen faculty, and reset when the faculty changes', async () => {
    await admin.goto(`${WEB}/inventory/new`, { waitUntil: 'networkidle0' });
    await see(admin, 'Choose the faculty first');
    await notSee(admin, 'School of Civil Engineering');
    await choose(admin, 'Faculty of Engineering');
    await see(admin, 'School of Civil Engineering');
    await see(admin, 'School of Mining Engineering');
    await notSee(admin, 'School of Forestry');
    await choose(admin, 'School of Civil Engineering');
    await see(admin, 'No locations in this department yet.');
    await choose(admin, 'Faculty of Natural Resources');
    await see(admin, 'School of Forestry');
    await notSee(admin, 'School of Civil Engineering');
    await notSee(admin, 'No locations in this department yet.'); // school (and its rooms) were reset
  });

  await step('both dropdowns are searchable', async () => {
    await type(admin, 'Search faculty', 'built');
    await see(admin, 'Faculty of Built Environment');
    await notSee(admin, 'Faculty of Sciences');
    await type(admin, 'Search faculty', '');
    await choose(admin, 'Faculty of Engineering');
    await type(admin, 'Search school / department', 'mech');
    await see(admin, 'School of Mechanical Engineering');
    await notSee(admin, 'School of Mining Engineering');
    await type(admin, 'Search school / department', '');
  });

  await step('registration saves the classification and new fields', async () => {
    await choose(admin, 'School of Civil Engineering');
    await type(admin, 'New building', 'Civil Engineering Block');
    await type(admin, 'New room number', 'CE-12');
    await button(admin, 'Add location');
    await see(admin, 'Civil Engineering Block · CE-12');
    await type(admin, 'Asset name', 'Leica total station');
    await type(admin, 'Asset description (optional)', 'Survey instrument for field classes');
    await choose(admin, 'Survey equipment');
    await type(admin, 'Purchase / acquisition date', '2025-06-10');
    await type(admin, 'Purchase cost', '45000.00');
    await choose(admin, 'Good');
    await choose(admin, 'In storage');
    await type(admin, 'Assigned staff member (optional)', 'Dr. Jane Kila');
    await see(admin, 'Will be registered to School of Civil Engineering (Faculty of Engineering)');
    await admin.screenshot({ path: path.join(SHOTS, 'fac-1-register.png'), fullPage: true });
    await button(admin, 'Save and generate QR code');
    const notice = await see(admin, 'has been assigned');
    assetId = (await notice.evaluate((e) => e.textContent)).match(/UAT-\d{4}-\d{6}/)[0];
    const saved = (await call('GET', `/assets/lookup?code=${assetId}`)).body;
    if (saved.faculty?.name !== 'Faculty of Engineering' || saved.department.code !== 'CIVIL') throw new Error('faculty/school not saved');
    if (saved.assignedTo !== 'Dr. Jane Kila' || saved.usageStatus !== 'in_storage') throw new Error('assigned staff / status not saved');
  });

  await step('asset details show faculty and custody; editing keeps the faculty and school', async () => {
    const saved = (await call('GET', `/assets/lookup?code=${assetId}`)).body;
    await admin.goto(`${WEB}/inventory/${saved.id}`, { waitUntil: 'networkidle0' });
    await see(admin, 'Ownership and custody');
    await see(admin, 'Faculty of Engineering');
    await see(admin, 'Dr. Jane Kila');
    await see(admin, 'In storage');
    await admin.goto(`${WEB}/inventory/${saved.id}/edit`, { waitUntil: 'networkidle0' });
    await see(admin, 'Faculty of Engineering'); // the faculty is shown as selected, not reset
    await type(admin, 'Assigned staff member (optional)', 'Mr. Peter Wari');
    await button(admin, 'Save changes');
    await see(admin, 'Mr. Peter Wari');
    const after = (await call('GET', `/assets/${saved.id}`)).body;
    if (after.faculty?.name !== 'Faculty of Engineering' || after.department.code !== 'CIVIL') throw new Error('edit lost the faculty/school');
  });

  await step('asset list filters by faculty, and searches by assigned staff member', async () => {
    await admin.goto(`${WEB}/inventory`, { waitUntil: 'networkidle0' });
    await choose(admin, 'Faculty of Engineering');
    await see(admin, 'Leica total station');
    await choose(admin, 'Faculty of Sciences');
    await see(admin, 'No assets match these filters.');
    await choose(admin, 'Faculty of Engineering');
    await type(admin, 'Search', 'Peter Wari');
    await see(admin, 'Leica total station');
  });

  await step('dashboard: distribution across faculties, with condition and value per faculty', async () => {
    await admin.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle0' });
    await see(admin, '4. Faculty and department summaries');
    await see(admin, 'Asset distribution across faculties');
    await see(admin, 'Faculty of Engineering (4 schools / units)');
    await see(admin, 'K45,000.00');
    await admin.screenshot({ path: path.join(SHOTS, 'fac-2-dashboard.png'), fullPage: true });
  });

  await step('reports: faculty filter and faculty tables', async () => {
    await admin.goto(`${WEB}/reports?kind=department-summary`, { waitUntil: 'networkidle0' });
    await choose(admin, 'Faculty of Engineering');
    await see(admin, 'Faculty: Faculty of Engineering');
    await see(admin, 'Assets by faculty (condition breakdown)');
    await see(admin, 'Recorded acquisition value by faculty and currency');
  });

  await step('phone width: the faculty and school dropdowns work on a small screen', async () => {
    const phone = await newPage(browser, 390, 844);
    track('phone', phone);
    await phone.goto(`${WEB}/sign-in`, { waitUntil: 'networkidle0' });
    await type(phone, 'Email', 'admin@university.example');
    await type(phone, 'Password', ADMIN_PW);
    await button(phone, 'Sign in');
    await see(phone, 'Hello,');
    await phone.goto(`${WEB}/inventory/new`, { waitUntil: 'networkidle0' });
    await choose(phone, 'Faculty of Built Environment');
    await see(phone, 'School of Surveying and Land Studies');
    await choose(phone, 'Central administration (no faculty)');
    await see(phone, 'University Library');
    await see(phone, 'Student Support & Facility Centre');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) throw new Error('page scrolls sideways at phone width');
    await phone.screenshot({ path: path.join(SHOTS, 'fac-3-phone.png'), fullPage: true });
  });
} finally {
  await finish(browser);
}
