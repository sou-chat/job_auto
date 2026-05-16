#!/usr/bin/env node

/**
 * scan-apify.mjs — Apify-powered scraper for LinkedIn, Naukri, IIMjobs,
 * Hirist, Indeed, and Instahyre.
 *
 * Config lives in portals.yml under `apify_sources`. Title/location filters
 * and dedup logic are shared with scan.mjs conventions.
 *
 * Requires APIFY_TOKEN in .env (or already in process.env).
 *
 * Usage:
 *   node scan-apify.mjs                  # scrape all enabled sources
 *   node scan-apify.mjs --dry-run        # preview without writing files
 *   node scan-apify.mjs --source naukri  # scrape a single source by name
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import https from 'https';
import path from 'path';
import yaml from 'js-yaml';

// ── Load .env ───────────────────────────────────────────────────────────────

function loadEnv(envPath = '.env') {
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

loadEnv();

// ── Constants ───────────────────────────────────────────────────────────────

const PORTALS_PATH       = 'portals.yml';
const SCAN_HISTORY_PATH  = 'data/scan-history.tsv';
const PIPELINE_PATH      = 'data/pipeline.md';
const APPLICATIONS_PATH  = 'data/applications.md';
const APIFY_BASE         = 'api.apify.com';
const ACTOR_TIMEOUT_MS   = 5 * 60 * 1000;  // 5 min max per actor run
const POLL_INTERVAL_MS   = 5_000;           // poll every 5 s

mkdirSync('data', { recursive: true });

// ── Apify REST helpers ──────────────────────────────────────────────────────

function apifyRequest(method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const sep = pathname.includes('?') ? '&' : '?';
    const fullPath = `/v2${pathname}${sep}token=${token}`;
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: APIFY_BASE,
      path: fullPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          resolve({ rawStatus: res.statusCode });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startRun(actorId, input, token) {
  const encoded = encodeURIComponent(actorId);
  const res = await apifyRequest('POST', `/acts/${encoded}/runs`, input, token);
  const id = res?.data?.id;
  if (!id) throw new Error(`Failed to start actor "${actorId}": ${JSON.stringify(res)}`);
  return id;
}

async function waitForRun(runId, token) {
  const deadline = Date.now() + ACTOR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const res = await apifyRequest('GET', `/actor-runs/${runId}`, null, token);
    const status = res?.data?.status;
    if (!status) throw new Error(`Cannot read run status for ${runId}`);
    if (status === 'SUCCEEDED') return res.data.defaultDatasetId;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      throw new Error(`Actor run ${runId} ended with status: ${status}`);
    }
    // RUNNING or READY — keep polling
  }
  throw new Error(`Actor run ${runId} timed out after ${ACTOR_TIMEOUT_MS / 1000}s`);
}

async function fetchDataset(datasetId, token, limit = 1000) {
  const res = await apifyRequest(
    'GET',
    `/datasets/${datasetId}/items?limit=${limit}&clean=true`,
    null,
    token,
  );
  // Apify returns a JSON array directly for dataset items
  if (Array.isArray(res)) return res;
  if (res?.data?.items) return res.data.items;
  return [];
}

// ── Filters (mirrors scan.mjs) ──────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const lower = (title || '').toLowerCase();
    const ok = positive.length === 0 || positive.some(k => lower.includes(k));
    const bad = negative.some(k => lower.includes(k));
    return ok && !bad;
  };
}

function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const allow = (locationFilter.allow || []).map(k => k.toLowerCase());
  const block = (locationFilter.block || []).map(k => k.toLowerCase());
  return (location) => {
    if (!location) return true;
    const lower = location.toLowerCase();
    if (block.length > 0 && block.some(k => lower.includes(k))) return false;
    if (allow.length === 0) return true;
    return allow.some(k => lower.includes(k));
  };
}

// ── Dedup (mirrors scan.mjs) ────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const m of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) seen.add(m[1]);
  }
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const m of text.matchAll(/https?:\/\/[^\s|)]+/g)) seen.add(m[0]);
  }
  return seen;
}

// ── Pipeline + history writers (mirrors scan.mjs) ───────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;
  let text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '';
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` +
      offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    const block = '\n' +
      offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH,
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }
  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Field normalizers — each source returns different keys ──────────────────
// Add new field aliases here when a new actor is added or fields shift.
//
// misceres/indeed-scraper  → positionName, company, location, jobUrl, externalApplyLink
// bebity/linkedin-*        → title, companyName, location, jobUrl
// apify/linkedin-jobs      → title, company, place, url
// naukri actors            → title, company, location, jobUrl

function normalizeItem(item, source) {
  const title =
    item.positionName ||   // misceres/indeed-scraper
    item.title        ||
    item.jobTitle     ||
    item.position     ||
    item.name         ||
    '';

  const company =
    item.company      ||
    item.companyName  ||
    item.employer     ||
    item.companyInfo?.name ||
    source.name       ||
    '';

  const location =
    item.location     ||
    item.jobLocation  ||
    item.place        ||
    item.city         ||
    '';

  const url =
    item.jobUrl             ||   // misceres/indeed-scraper, naukri actors
    item.externalApplyLink  ||   // misceres/indeed-scraper (external apply)
    item.url                ||
    item.applyUrl           ||
    item.link               ||
    item.applyLink          ||
    '';

  if (!url || !title) return null;
  return { title: title.trim(), company: company.trim(), location: location.trim(), url: url.trim() };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const debug   = args.includes('--debug');   // print first raw item per source
  const sourceFlag = args.indexOf('--source');
  const filterSource = sourceFlag !== -1 ? args[sourceFlag + 1]?.toLowerCase() : null;

  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.error('Error: APIFY_TOKEN not set. Add it to .env or export it in your shell.');
    process.exit(1);
  }

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found.');
    process.exit(1);
  }

  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const sources = (config.apify_sources || []).filter(s => s.enabled !== false);

  if (sources.length === 0) {
    console.error('Error: no enabled apify_sources found in portals.yml.');
    process.exit(1);
  }

  const titleFilter    = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const seenUrls       = loadSeenUrls();

  const filtered = filterSource
    ? sources.filter(s => s.name.toLowerCase().includes(filterSource))
    : sources;

  if (filtered.length === 0) {
    console.error(`No sources matched "${filterSource}".`);
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  const newOffers = [];
  const errors = [];

  let totalRaw = 0;
  let totalFilteredTitle = 0;
  let totalFilteredLocation = 0;
  let totalDupes = 0;

  console.log(`Apify scan — ${date}`);
  console.log(`Sources: ${filtered.map(s => s.name).join(', ')}`);
  if (dryRun) console.log('(dry run — no files will be written)\n');
  else console.log('');

  for (const source of filtered) {
    process.stdout.write(`  ⏳ ${source.name} (${source.actor}) … `);
    try {
      const runId = await startRun(source.actor, source.input || {}, token);
      const datasetId = await waitForRun(runId, token);
      const items = await fetchDataset(datasetId, token, source.limit || 200);

      totalRaw += items.length;
      if (debug && items.length > 0) {
        console.log(`\n  [debug] First raw item from ${source.name}:`);
        console.log(JSON.stringify(items[0], null, 2));
      }
      let added = 0;

      for (const item of items) {
        const norm = normalizeItem(item, source);
        if (!norm) continue;
        if (!titleFilter(norm.title)) { totalFilteredTitle++; continue; }
        if (!locationFilter(norm.location)) { totalFilteredLocation++; continue; }
        if (seenUrls.has(norm.url)) { totalDupes++; continue; }

        seenUrls.add(norm.url);
        newOffers.push({ ...norm, source: `apify-${source.name.toLowerCase().replace(/\s+/g, '-')}` });
        added++;
      }

      console.log(`✅ ${items.length} raw → ${added} new`);
    } catch (err) {
      console.log(`❌ ${err.message}`);
      errors.push({ source: source.name, error: err.message });
    }
  }

  // Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // Summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Apify Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Sources scanned:       ${filtered.length}`);
  console.log(`Total raw results:     ${totalRaw}`);
  console.log(`Filtered by title:     ${totalFilteredTitle} removed`);
  console.log(`Filtered by location:  ${totalFilteredLocation} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.source}: ${e.error}`);
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
