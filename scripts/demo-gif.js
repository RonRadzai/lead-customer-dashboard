#!/usr/bin/env node
// Record the README demo GIF: a scripted 30 to 45 second walk through the seeded app.
//
//   npm run build && npm run seed && npm run server   (terminal 1)
//   npm run demo-gif                                  (terminal 2)
//
// Pure JavaScript, no ffmpeg: Playwright drives the browser and takes a screenshot at
// every pause point of the walkthrough; each frame is shown for as long as that pause
// lasted; identical consecutive frames are merged; gifenc encodes docs/demo.gif.
// Set APP_URL to record against a different origin (default http://localhost:3002).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { PNG } = require('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const APP_URL = process.env.APP_URL || 'http://localhost:3002';
const OUT = path.join(__dirname, '..', 'docs', 'demo.gif');
const SIZE = { width: 1200, height: 750 };
const MAX_COLORS = 128;
const IDENTITY = { name: 'Avery Chen', email: 'avery.chen@example.com' };

async function launch() {
  let lastErr;
  for (const opts of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try { return await chromium.launch({ headless: true, ...opts }); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Every pause captures the current screen as a frame, then holds it for `ms`.
const frames = [];
async function pause(page, ms) {
  frames.push({ t: Date.now(), png: await page.screenshot({ type: 'png' }) });
  await page.waitForTimeout(ms);
}

async function scroll(page, px, steps = 5) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, px / steps); await pause(page, 180); }
}

async function nav(page, label, waitFor) {
  await page.click(`.sidebar .nav-item:has-text("${label}")`);
  await page.waitForSelector(waitFor, { timeout: 15000 });
}

// ── The walkthrough (mirrors the click path described in the README) ────────
async function walkthrough(page) {
  // 1. Dashboard: stat cards and the week of upcoming meetings
  await page.goto(`${APP_URL}/#dashboard`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.stat-card .stat-value');
  await pause(page, 3000);
  await page.hover('.meeting-chip');
  await pause(page, 1500);

  // 2. Leads: open a lead and advance it one stage on the pipeline bar
  await nav(page, 'Leads', 'table tbody tr');
  await pause(page, 2500);
  await page.click('tr.tbl-row:has-text("Nikolai Ivanov")');
  await page.waitForSelector('.pipeline-bar');
  await pause(page, 2500);
  // Click the stage after the active one, so re-running the script still has something to advance.
  const stages = page.locator('.pipeline-stage');
  const activeIdx = await stages.evaluateAll(els => els.findIndex(el => el.classList.contains('active')));
  const nextIdx = Math.min(activeIdx + 1, (await stages.count()) - 2); // never the terminal "Converted" stage
  const targetLabel = (await stages.nth(nextIdx).textContent()).replace('✓', '').trim().toLowerCase();
  await stages.nth(nextIdx).click();
  await pause(page, 1500);
  await page.click('button:has-text("Yes")');
  // The detail page refetches after the change; wait until the new stage is the active one.
  await page.waitForFunction(label => {
    const active = document.querySelector('.pipeline-stage.active');
    return !document.querySelector('.loading-state') && active && active.textContent.trim().toLowerCase().startsWith(label);
  }, targetLabel, { timeout: 15000 });
  await pause(page, 2500);

  // 3. New Users: triage badges, then an administrator's detail page
  await nav(page, 'New Users', '.record-card');
  await pause(page, 3000);
  await page.click('.record-card:has-text("Dana Whitfield")');
  await page.waitForSelector('.detail-layout');
  await pause(page, 3000);
  await scroll(page, 450);
  await pause(page, 2500);

  // 4. Recent Interactions: every touchpoint in one table
  await nav(page, 'Recent Interactions', '.data-table tbody tr');
  await pause(page, 2500);
  await page.hover('.data-table tbody tr');
  await pause(page, 2000);
  await scroll(page, 300);
  await pause(page, 2500);
  frames.push({ t: Date.now(), png: await page.screenshot({ type: 'png' }) }); // closing frame
}

// ── Encode: merge identical frames, quantize each to a local palette ────────
function encodeGif(frames) {
  const merged = [];
  for (const f of frames) {
    const prev = merged[merged.length - 1];
    if (prev && prev.png.equals(f.png)) continue;   // still frame: the delay math below covers it
    merged.push(f);
  }
  const gif = GIFEncoder();
  merged.forEach((f, i) => {
    const next = merged[i + 1];
    const delay = next ? next.t - f.t : 2000;
    const { width, height, data } = PNG.sync.read(f.png);
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const palette = quantize(rgba, MAX_COLORS);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, width, height, { palette, delay });
  });
  gif.finish();
  return { bytes: gif.bytes(), uniqueFrames: merged.length, totalFrames: frames.length };
}

async function main() {
  const browser = await launch();
  const context = await browser.newContext({ viewport: SIZE, colorScheme: 'light', locale: 'en-US', timezoneId: 'America/New_York' });
  await context.addInitScript(identity => {
    localStorage.setItem('lcd-user', JSON.stringify(identity));
    localStorage.setItem('lcd-theme', 'light');
  }, IDENTITY);
  const page = await context.newPage();

  const started = Date.now();
  await walkthrough(page);
  const seconds = Math.round((Date.now() - started) / 1000);
  await browser.close();

  console.log(`captured ${frames.length} frames over ${seconds}s, encoding…`);
  const { bytes, uniqueFrames } = encodeGif(frames);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bytes);
  console.log(`saved ${path.relative(process.cwd(), OUT)} (${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${uniqueFrames} unique frames, ${seconds}s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
