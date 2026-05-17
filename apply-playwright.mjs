#!/usr/bin/env node
/**
 * apply-playwright.mjs — Playwright-based application assistant.
 * Opens the job URL in a visible Chrome window, reads the form,
 * and fills fields based on profile.yml + cv.md.
 * ALWAYS stops before Submit — human clicks the final button.
 *
 * Usage:
 *   node apply-playwright.mjs <job-url>
 *   node apply-playwright.mjs <job-url> --screenshot-only
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

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

const args = process.argv.slice(2);
const jobUrl = args.find(a => a.startsWith('http'));
const screenshotOnly = args.includes('--screenshot-only');

if (!jobUrl) {
  console.error('Usage: node apply-playwright.mjs <job-url> [--screenshot-only]');
  process.exit(1);
}

// Load profile
const profile = existsSync('config/profile.yml')
  ? yaml.load(readFileSync('config/profile.yml', 'utf-8'))
  : {};

const candidate = profile.candidate || {};
const comp = profile.compensation || {};
const loc = profile.location || {};

const FILL_MAP = {
  name:       candidate.full_name || '',
  full_name:  candidate.full_name || '',
  first_name: (candidate.full_name || '').split(' ')[0],
  last_name:  (candidate.full_name || '').split(' ').slice(1).join(' '),
  email:      candidate.email || '',
  phone:      candidate.phone || '',
  linkedin:   candidate.linkedin || '',
  portfolio:  candidate.portfolio_url || '',
  location:   loc.city ? `${loc.city}, ${loc.country}` : '',
  city:       loc.city || '',
  country:    loc.country || '',
  salary:     comp.target_range || '',
};

const chromeExe = process.env.CHROME_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const useRealChrome = existsSync(chromeExe);

async function main() {
  console.log(`\n🌐 Opening: ${jobUrl}`);

  const browser = await chromium.launch({
    headless: false,
    executablePath: useRealChrome ? chromeExe : undefined,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  });

  const page = await context.newPage();
  await page.goto(jobUrl, { waitUntil: 'load', timeout: 45_000 });
  await page.waitForTimeout(2000);

  // Screenshot the job page
  const screenshotPath = 'output/apply-screenshot.png';
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`📸 Screenshot saved: ${screenshotPath}`);

  if (screenshotOnly) {
    console.log('\nScreenshot-only mode. Browser will stay open for 30s.');
    await page.waitForTimeout(30_000);
    await browser.close();
    return;
  }

  // Look for Apply button
  console.log('\n🔍 Looking for Apply button...');
  const applySelectors = [
    'a:has-text("Apply")',
    'button:has-text("Apply")',
    'a:has-text("Apply Now")',
    'button:has-text("Apply Now")',
    '[data-apply]',
    '.apply-button',
    '#apply-button',
  ];

  let clicked = false;
  for (const sel of applySelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        console.log(`✅ Found Apply button: ${sel}`);
        await btn.click();
        await page.waitForTimeout(3000);
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    console.log('⚠️  Could not find Apply button automatically.');
    console.log('   Please click Apply manually in the browser window.');
    console.log('   Press ENTER here once the application form is open...');
    await new Promise(r => process.stdin.once('data', r));
  }

  // Screenshot the form
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`📸 Form screenshot saved: ${screenshotPath}`);

  // Read all visible form fields
  console.log('\n📋 Reading form fields...');
  const fields = await page.evaluate(() => {
    const results = [];
    const inputs = document.querySelectorAll('input, textarea, select');
    inputs.forEach(el => {
      const label = el.labels?.[0]?.textContent?.trim()
        || el.getAttribute('placeholder')
        || el.getAttribute('aria-label')
        || el.getAttribute('name')
        || el.id
        || '';
      if (label) results.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || el.id || '',
        label,
        value: el.value || '',
      });
    });
    return results;
  });

  console.log(`\nFound ${fields.length} fields:\n`);
  fields.forEach((f, i) => console.log(`  ${i + 1}. [${f.tag}${f.type ? ':' + f.type : ''}] ${f.label}`));

  // Auto-fill basic fields
  console.log('\n✍️  Auto-filling basic fields...');
  for (const field of fields) {
    const label = field.label.toLowerCase();
    let value = '';

    if (label.includes('first name'))      value = FILL_MAP.first_name;
    else if (label.includes('last name'))  value = FILL_MAP.last_name;
    else if (label.includes('full name') || label.includes('your name')) value = FILL_MAP.name;
    else if (label.includes('email'))      value = FILL_MAP.email;
    else if (label.includes('phone') || label.includes('mobile')) value = FILL_MAP.phone;
    else if (label.includes('linkedin'))   value = FILL_MAP.linkedin;
    else if (label.includes('portfolio') || label.includes('website')) value = FILL_MAP.portfolio;
    else if (label.includes('city'))       value = FILL_MAP.city;
    else if (label.includes('location'))   value = FILL_MAP.location;
    else if (label.includes('salary') || label.includes('expected') || label.includes('ctc')) value = FILL_MAP.salary;

    if (value && field.name) {
      try {
        const selector = field.name
          ? `[name="${field.name}"]`
          : `[placeholder="${field.label}"]`;
        await page.fill(selector, value);
        console.log(`  ✅ ${field.label} → ${value}`);
      } catch {
        console.log(`  ⚠️  Could not fill: ${field.label}`);
      }
    }
  }

  console.log('\n⏸️  Stopped before Submit — review the form in the browser.');
  console.log('   Upload your CV manually if there is a file upload field.');
  console.log(`   CV PDF: output/001-wells-fargo-lead-pm.pdf`);
  console.log('\n   Press ENTER to close the browser when done...');
  await new Promise(r => process.stdin.once('data', r));

  await browser.close();
  console.log('✅ Browser closed.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
