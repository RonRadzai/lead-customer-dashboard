#!/usr/bin/env node
// Capture the README screenshots from a running instance using a headless browser.
//
//   npm run seed && npm run server        (terminal 1, after `npm run build` so the API serves the UI)
//   npm run screenshots                   (terminal 2)
//
// Uses playwright-core with a browser already on the machine (Chrome or Edge), so no
// browser download is needed. Set APP_URL to point at a different origin (for example
// the CRA dev server on http://localhost:3000). Output goes to docs/screenshots/.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const APP_URL = process.env.APP_URL || 'http://localhost:3002';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const VIEWPORT = { width: 1440, height: 900 };

// The app asks "Who are you?" on first load; pre-select a seeded team member.
const IDENTITY = { name: 'Avery Chen', email: 'avery.chen@example.com' };

// view -> route (URL hash) and an element that proves the data has loaded.
const SHOTS = [
  { file: 'dashboard.png',           hash: 'dashboard',           waitFor: '.stat-card .stat-value' },
  { file: 'leads.png',               hash: 'leads',               waitFor: 'table tbody tr' },
  { file: 'new-users.png',           hash: 'new-users?period=last_month', waitFor: '.record-card' },
  { file: 'new-user-detail.png',     hash: null,                  waitFor: '.detail-layout' }, // resolved below
  { file: 'recent-interactions.png', hash: 'recent-interactions', waitFor: '.data-table tbody tr' },
  { file: 'meetings.png',            hash: 'meetings',            waitFor: 'table tbody tr' },
];

async function launch() {
  const attempts = [
    { channel: 'chrome' },
    { channel: 'msedge' },
    {}, // bundled Chromium, if `npx playwright install chromium` has been run
  ];
  let lastErr;
  for (const opts of attempts) {
    try { return await chromium.launch({ headless: true, ...opts }); }
    catch (err) { lastErr = err; }
  }
  throw lastErr;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Pick the seeded administrator whose detail page shows the triage panel plus meetings and tickets.
  const usersRes = await fetch(`${APP_URL}/api/new-users?period=last_month&search=dana.whitfield`);
  const { users } = await usersRes.json();
  const detailId = users?.[0]?.id;
  if (!detailId) throw new Error('Seeded user not found. Run `npm run seed` first.');

  const browser = await launch();
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light', timezoneId: 'America/New_York', locale: 'en-US' });
  await context.addInitScript(identity => {
    localStorage.setItem('lcd-user', JSON.stringify(identity));
    localStorage.setItem('lcd-theme', 'light');
  }, IDENTITY);

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(err.message));

  for (const shot of SHOTS) {
    const hash = shot.hash ?? `new-user-detail/${detailId}`;
    await page.goto(`${APP_URL}/#${hash}`, { waitUntil: 'networkidle' });
    await page.waitForSelector(shot.waitFor, { timeout: 15000 });
    await page.waitForTimeout(600); // let skeletons and async sections settle
    const out = path.join(OUT_DIR, shot.file);
    await page.screenshot({ path: out, fullPage: false });
    console.log('saved', path.relative(process.cwd(), out));
  }

  await browser.close();
  if (consoleErrors.length) {
    console.warn(`\n${consoleErrors.length} console error(s) while capturing:`);
    consoleErrors.forEach(e => console.warn('  -', e));
  } else {
    console.log('\nNo console errors.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
