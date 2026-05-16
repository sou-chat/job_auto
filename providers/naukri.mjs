// @ts-check
// Naukri provider — scrapes Naukri's SSR search pages directly.
// No API key, no Apify. Naukri's search pages are server-side rendered
// and publicly indexed by Google, so they're accessible via plain HTTP.
//
// portals.yml entry:
//   - name: Naukri — Product Manager
//     provider: naukri
//     keyword: "product-manager"   # kebab-case, used in URL path
//     location: "india"            # used in URL path
//     pages: 5                     # pages to fetch (default 3)
//     enabled: true

const BASE = 'https://www.naukri.com';
const PER_PAGE = 20;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Referer': 'https://www.naukri.com/',
};

// Naukri SSR pages embed job data in a JSON blob assigned to window.__INITIAL_STATE__
// or as JSON-LD, or as data in script tags. We extract job listing URLs using regex.
function extractJobsFromHtml(html, fallbackLocation) {
  const jobs = [];
  const seen = new Set();

  // Pattern 1: href to /job-listings-*.html (most reliable)
  // Naukri job URLs: /job-listings-senior-product-manager-company-3-6-years-bangalore-12345678.html
  const urlRe = /href="(https?:\/\/www\.naukri\.com\/job-listings-[^"?#]+\.html[^"]*)"/gi;
  // Also match relative paths
  const relRe = /href="(\/job-listings-[^"?#]+\.html[^"]*)"/gi;

  let m;
  while ((m = urlRe.exec(html)) !== null) {
    const url = m[1].split('?')[0]; // strip query params
    if (!seen.has(url)) { seen.add(url); jobs.push({ url, title: '', company: '', location: '' }); }
  }
  while ((m = relRe.exec(html)) !== null) {
    const url = BASE + m[1].split('?')[0];
    if (!seen.has(url)) { seen.add(url); jobs.push({ url, title: '', company: '', location: '' }); }
  }

  // Pattern 2: JSON-LD structured data — JobPosting schema
  const jsonLdRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = jsonLdRe.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] !== 'JobPosting') continue;
        const url = item.url || item.mainEntityOfPage?.['@id'] || '';
        const title = item.title || '';
        const company = item.hiringOrganization?.name || '';
        const location = item.jobLocation?.address?.addressLocality || fallbackLocation;
        if (url && !seen.has(url)) {
          seen.add(url);
          // Update existing stub or add new entry
          const existing = jobs.find(j => j.url === url);
          if (existing) { Object.assign(existing, { title, company, location }); }
          else { jobs.push({ url, title, company, location }); }
        }
      }
    } catch {}
  }

  // Pattern 3: Fill in missing titles from nearby anchor text
  // <a ... href="/job-listings-...">Title</a>
  const anchorRe = /href="(\/job-listings-[^"?#]+\.html)[^"]*"[^>]*>([^<]{5,120})</gi;
  while ((m = anchorRe.exec(html)) !== null) {
    const url = BASE + m[1];
    const title = m[2].replace(/&amp;/g, '&').replace(/&#\d+;/g, '').trim();
    const existing = jobs.find(j => j.url === url);
    if (existing && !existing.title) existing.title = title;
  }

  return jobs.filter(j => j.url); // must have URL at minimum
}

/** @type {import('./_types.js').Provider} */
export default {
  id: 'naukri',

  detect(_entry) {
    return null; // explicit provider: naukri only
  },

  async fetch(entry, ctx) {
    const keyword  = (entry.keyword  || 'product-manager').toLowerCase().replace(/\s+/g, '-');
    const location = (entry.location || 'india').toLowerCase().replace(/\s+/g, '-');
    const pages    = entry.pages || 3;
    const jobs     = [];
    const seenUrls = new Set();

    for (let page = 1; page <= pages; page++) {
      // Naukri pagination: page 1 = /keyword-jobs-in-location
      //                    page 2 = /keyword-jobs-in-location-2
      const suffix = page === 1 ? '' : `-${page}`;
      const url = `${BASE}/${keyword}-jobs-in-${location}${suffix}`;

      let html;
      try {
        html = await ctx.fetchText(url, { headers: HEADERS, timeoutMs: 20_000 });
      } catch (err) {
        if (err.status === 404) break; // no more pages
        throw new Error(`naukri page ${page}: ${err.message}`);
      }

      const pageJobs = extractJobsFromHtml(html, location);
      let added = 0;
      for (const job of pageJobs) {
        if (seenUrls.has(job.url)) continue;
        seenUrls.add(job.url);
        jobs.push(job);
        added++;
      }

      if (added === 0) break; // no new listings → stop
    }

    return jobs;
  },
};
