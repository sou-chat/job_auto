#!/usr/bin/env node

/**
 * scan-naukri.mjs — Playwright-based Naukri scraper.
 *
 * Logs in with NAUKRI_EMAIL + NAUKRI_PASSWORD from .env, then intercepts
 * Naukri's own internal jobapi responses — no HTML parsing, clean JSON.
 *
 * Requires: NAUKRI_EMAIL and NAUKRI_PASSWORD in .env
 *
 * Usage:
 *   node scan-naukri.mjs                  # run all searches
 *   node scan-naukri.mjs --dry-run        # preview without writing files
 *   node scan-naukri.mjs --headed         # show browser window (debug)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

// ── Load .env ────────────────────────────────────────────────────────────────

function loadEnv(envPath = '.env') {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

loadEnv();

// ── Constants ────────────────────────────────────────────────────────────────

const PORTALS_PATH      = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH     = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const SESSION_PATH      = 'data/naukri-session.json'; // gitignored, stores cookies
const NAUKRI_BASE       = 'https://www.naukri.com';

mkdirSync('data', { recursive: true });

// ── Searches to run ───────────────────────────────────────────────────────────
// Each entry hits one Naukri search URL and collects up to `pages` pages.

const SEARCHES = [
  { label: 'Product Manager',        path: '/product-manager-jobs-in-india',        pages: 5 },
  { label: 'Senior Product Manager', path: '/senior-product-manager-jobs-in-india', pages: 3 },
  { label: 'AI Product Manager',     path: '/ai-product-manager-jobs-in-india',     pages: 2 },
];

// ── Filters (from portals.yml) ───────────────────────────────────────────────

function buildTitleFilter(tf) {
  const pos = (tf?.positive || []).map(k => k.toLowerCase());
  const neg = (tf?.negative || []).map(k => k.toLowerCase());
  return t => {
    const l = (t || '').toLowerCase();
    return (pos.length === 0 || pos.some(k => l.includes(k))) && !neg.some(k => l.includes(k));
  };
}

function buildLocationFilter(lf) {
  if (!lf) return () => true;
  const allow = (lf.allow || []).map(k => k.toLowerCase());
  const block = (lf.block || []).map(k => k.toLowerCase());
  return loc => {
    if (!loc) return true;
    const l = loc.toLowerCase();
    if (block.some(k => l.includes(k))) return false;
    return allow.length === 0 || allow.some(k => l.includes(k));
  };
}

// ── Dedup ────────────────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    for (const m of readFileSync(PIPELINE_PATH, 'utf-8').matchAll(/- \[[ x]\] (https?:\/\/\S+)/g))
      seen.add(m[1]);
  }
  if (existsSync(APPLICATIONS_PATH)) {
    for (const m of readFileSync(APPLICATIONS_PATH, 'utf-8').matchAll(/https?:\/\/[^\s|)]+/g))
      seen.add(m[0]);
  }
  return seen;
}

// ── Pipeline + history writers ────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (!offers.length) return;
  let text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '';
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    const pi = text.indexOf('## Procesadas');
    const at = pi === -1 ? text.length : pi;
    text = text.slice(0, at) +
      `\n${marker}\n\n` + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n\n' +
      text.slice(at);
  } else {
    const after = idx + marker.length;
    const next  = text.indexOf('\n## ', after);
    const at    = next === -1 ? text.length : next;
    text = text.slice(0, at) +
      '\n' + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n' +
      text.slice(at);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH))
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  appendFileSync(SCAN_HISTORY_PATH,
    offers.map(o => `${o.url}\t${date}\tnaukri-playwright\t${o.title}\t${o.company}\tadded\t${o.location || ''}`).join('\n') + '\n',
    'utf-8');
}

// ── Naukri login ──────────────────────────────────────────────────────────────

async function login(page, email, password, headed) {
  await page.goto(`${NAUKRI_BASE}/nlogin/login`, { waitUntil: 'load', timeout: 45_000 });

  // Pre-fill credentials
  try {
    await page.getByPlaceholder(/email id/i).fill(email);
    await page.getByPlaceholder(/password/i).fill(password);
    await page.getByRole('button', { name: /^login$/i }).click();
  } catch {
    try {
      await page.fill('input[type="email"], #usernameField', email);
      await page.fill('input[type="password"], #passwordField', password);
      await page.click('[type="submit"]');
    } catch {
      if (!headed) throw new Error('Could not fill login form — run with --headed to log in manually.');
      console.log('\n  Could not auto-fill — please log in manually in the browser window.');
    }
  }

  if (headed) {
    // No timeout — wait as long as it takes for user to complete OTP/CAPTCHA
    console.log('\n  Browser is open — complete login (enter OTP if asked), then the script will continue automatically…');
    await page.waitForURL(url => !String(url).includes('/nlogin'), { timeout: 0 });
  } else {
    try {
      await page.waitForURL(url => !String(url).includes('/nlogin'), { timeout: 30_000 });
    } catch (err) {
      if (err.message.includes('context was destroyed')) return;
      try { if (!page.url().includes('/nlogin')) return; } catch {}
      throw new Error('Headless login failed — run once with --headed to save a session, then retry.');
    }
  }
}

// ── Collect jobs from one search page via API interception ────────────────────

async function collectJobs(page, searchPath, maxPages) {
  const jobs = [];
  const captured = [];

  // Intercept Naukri's internal jobapi responses
  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('/jobapi/') || !url.includes('search')) return;
    try {
      const json = await res.json();
      if (json?.jobDetails) captured.push(...json.jobDetails);
    } catch {}
  });

  for (let p = 1; p <= maxPages; p++) {
    const suffix = p === 1 ? '' : `-${p}`;
    await page.goto(`${NAUKRI_BASE}${searchPath}${suffix}`, {
      waitUntil: 'load',
      timeout: 45_000,
    });

    // Wait for Naukri's SPA to fire its internal jobapi XHR responses
    await page.waitForTimeout(3000);
  }

  // Remove response listener to avoid leaks
  page.removeAllListeners('response');

  // Parse captured API responses
  for (const job of captured) {
    const jdPath = job.jdURL || '';
    if (!jdPath || !job.title) continue;
    const url = NAUKRI_BASE + (jdPath.startsWith('/') ? '' : '/') + jdPath;
    const locPH = (job.placeholders || []).find(p => p.label?.toLowerCase().includes('loc'));
    jobs.push({
      title:    job.title.trim(),
      company:  (job.companyName || '').trim(),
      location: (locPH?.title || '').trim(),
      url,
    });
  }

  return jobs;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args       = process.argv.slice(2);
  const dryRun     = args.includes('--dry-run');
  const headed     = args.includes('--headed');
  const relogin    = args.includes('--relogin');   // force fresh login even if session exists

  const email    = process.env.NAUKRI_EMAIL;
  const password = process.env.NAUKRI_PASSWORD;

  if (!email || email === 'your_naukri_email_here') {
    console.error('Error: NAUKRI_EMAIL not set in .env');
    process.exit(1);
  }
  if (!password || password === 'your_naukri_password_here') {
    console.error('Error: NAUKRI_PASSWORD not set in .env');
    process.exit(1);
  }

  const config         = existsSync(PORTALS_PATH)
    ? yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) : {};
  const titleFilter    = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const seenUrls       = loadSeenUrls();
  const date           = new Date().toISOString().slice(0, 10);

  console.log(`Naukri Playwright scan — ${date}`);
  if (dryRun) console.log('(dry run — no files will be written)\n');
  else console.log('');

  // Strategy: launch real Chrome (not Playwright's Chromium) so Akamai/Naukri
  // sees an authentic browser fingerprint. channel:'chrome' uses the installed
  // Chrome executable with a fresh temp profile — no profile lock conflict even
  // if Chrome is already open.
  const chromeExe = process.env.CHROME_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const useRealChrome = existsSync(chromeExe);

  let context;
  if (useRealChrome) {
    const browser = await chromium.launch({
      headless: !headed,
      executablePath: chromeExe,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    console.log('  Using real Chrome ✅');
  } else {
    // Fallback: Playwright's bundled Chromium
    console.log(`  Chrome not found at ${chromeExe} — using bundled Chromium (may be blocked by Akamai)`);
    const browser = await chromium.launch({
      headless: !headed,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    }).catch(e => {
      console.error('Error: Playwright Chromium not installed. Run: node node_modules/playwright/cli.js install chromium');
      process.exit(1);
    });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en'] });
  });
  const page = await context.newPage();

  // ── Session management ───────────────────────────────────────────────────────
  // Load saved cookies to skip login on subsequent runs.
  // First run (or --relogin): do full login + OTP, then save cookies.
  const hasSession = existsSync(SESSION_PATH) && !relogin;

  if (hasSession) {
    try {
      const { cookies, timestamp } = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
      await context.addCookies(cookies);
      const age = Math.round((Date.now() - timestamp) / 3_600_000);
      console.log(`  Session loaded from ${SESSION_PATH} (${age}h old) ✅`);
    } catch {
      console.log('  Session file corrupt — doing fresh login');
    }
  }

  // Login
  process.stdout.write('  Logging in … ');
  try {
    if (hasSession) {
      // Verify session is still valid — just check we're not redirected to login
      await page.goto(NAUKRI_BASE, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForTimeout(1500);
      const currentUrl = page.url();
      const isLoggedIn = !currentUrl.includes('/nlogin');
      if (!isLoggedIn) {
        console.log('session expired, re-logging in …');
        await login(page, email, password, headed);
      } else {
        console.log('✅ (session valid)');
      }
    } else {
      await login(page, email, password, headed);
      // Save cookies for future runs
      const cookies = await context.cookies();
      mkdirSync('data', { recursive: true });
      writeFileSync(SESSION_PATH, JSON.stringify({ cookies, timestamp: Date.now() }, null, 2));
      console.log(`✅ (session saved to ${SESSION_PATH})`);
    }
  } catch (err) {
    console.log(`❌ ${err.message}`);
    await context.close();
    process.exit(1);
  }

  const allJobs = [];
  let totalRaw = 0, filteredTitle = 0, filteredLoc = 0, dupes = 0;

  for (const search of SEARCHES) {
    process.stdout.write(`  ⏳ ${search.label} … `);
    try {
      const jobs = await collectJobs(page, search.path, search.pages);
      totalRaw += jobs.length;
      let added = 0;

      for (const job of jobs) {
        if (!titleFilter(job.title))    { filteredTitle++; continue; }
        if (!locationFilter(job.location)) { filteredLoc++;   continue; }
        if (seenUrls.has(job.url))      { dupes++;          continue; }
        seenUrls.add(job.url);
        allJobs.push(job);
        added++;
      }

      console.log(`✅ ${jobs.length} raw → ${added} new`);
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  await context.close();

  // Write results
  if (!dryRun && allJobs.length > 0) {
    appendToPipeline(allJobs);
    appendToScanHistory(allJobs, date);
  }

  // Summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Naukri Playwright Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Total raw results:     ${totalRaw}`);
  console.log(`Filtered by title:     ${filteredTitle} removed`);
  console.log(`Filtered by location:  ${filteredLoc} removed`);
  console.log(`Duplicates:            ${dupes} skipped`);
  console.log(`New offers added:      ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log('\nNew offers:');
    for (const o of allJobs) console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    if (!dryRun) console.log(`\nResults saved to ${PIPELINE_PATH}`);
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
