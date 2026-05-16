// @ts-check
// WebSearch provider — Bing HTML search for job boards that block direct API
// access (Naukri, IIMjobs, Hirist, Instahyre).
//
// portals.yml entry:
//   - name: Naukri — PM
//     provider: websearch
//     search_query: "site:naukri.com/job-listings product manager india"
//     url_pattern: "naukri.com/job-listings"   # only keep URLs matching this
//     pages: 3                                  # Bing pages (10 results each)
//     enabled: true

const BING = 'https://www.bing.com/search';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
};

/** @type {import('./_types.js').Provider} */
export default {
  id: 'websearch',

  detect(_entry) {
    return null; // explicit `provider: websearch` only
  },

  async fetch(entry, ctx) {
    const query      = entry.search_query;
    if (!query) throw new Error('websearch: missing search_query in portals.yml entry');

    const urlPattern = entry.url_pattern || '';
    const pages      = entry.pages      || 2;
    const jobs       = [];
    const seen       = new Set();

    for (let page = 0; page < pages; page++) {
      const params = new URLSearchParams({
        q:     query,
        first: String(page * 10 + 1),  // Bing pagination: first=1, 11, 21 …
        count: '10',
      });

      const html = await ctx.fetchText(`${BING}?${params}`, {
        headers: HEADERS,
        timeoutMs: 20_000,
      });

      // Bing result links: <h2><a href="https://...">Title</a></h2>
      // They appear as direct absolute URLs in href (no redirect wrapper).
      const resultRe = /<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]{3,150})<\/a>/gi;
      // Fallback: any absolute href in result blocks
      const hrefRe   = /href="(https?:\/\/(?!www\.bing\.com)[^"]+)"/gi;

      let m;
      const candidates = new Map(); // url → title

      while ((m = resultRe.exec(html)) !== null) {
        const url   = m[1].split('?')[0].split('#')[0];
        const title = m[2].replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/<[^>]+>/g, '').trim();
        if (!candidates.has(url)) candidates.set(url, title);
      }
      // Fallback if h2 pattern matched nothing
      if (candidates.size === 0) {
        while ((m = hrefRe.exec(html)) !== null) {
          const url = m[1].split('?')[0].split('#')[0];
          if (!candidates.has(url)) candidates.set(url, '');
        }
      }

      let pageHits = 0;
      for (const [url, title] of candidates) {
        if (urlPattern && !url.includes(urlPattern)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        jobs.push({ title, company: '', location: '', url });
        pageHits++;
      }

      if (pageHits === 0) break;
    }

    return jobs;
  },
};
