'use strict';

/**
 * Chart of the Day — v2.
 *
 * Previous versions hit Exa + Anthropic web_search to synthesise a single chart.
 * That was brittle (credit-sensitive, frequently wrong). v2 instead scrapes a
 * small set of authoritative sources configured by the user under
 * Settings → Chart sources, and reproduces the chart imagery 1:1 in the UI.
 *
 * Each source entry:
 *   - name    (display label)
 *   - kind    ("html" | "twitter")
 *   - url     (HTML: page to scrape. Twitter: https://twitter.com/<handle>)
 *   - limit   (max charts to pull from this source per refresh; default 2)
 *
 * Output:
 *   { charts: [{ title, image, source, sourceUrl, context }], fetchedAt, dateKey }
 *
 * Up to 5 charts total, round-robined across configured sources so no single
 * source dominates the view.
 */

const storage = require('./storage');

const DEFAULT_SOURCES = [
  {
    name:  'NBC News — Economic Indicators',
    kind:  'html',
    url:   'https://www.nbcnews.com/business/economy/economic-indicators',
    limit: 3,
  },
  // Example Twitter/X accounts — user can replace these in Settings.
  // We scrape via nitter mirrors so we don't need Twitter API credentials.
  { name: '@charliebilello',    kind: 'twitter', url: 'https://twitter.com/charliebilello',    limit: 2 },
  { name: '@lisaabramowicz1',   kind: 'twitter', url: 'https://twitter.com/lisaabramowicz1',   limit: 2 },
];

async function getChartSources() {
  try {
    const settings = await storage.getSettings();
    const configured = settings?.chartSources;
    if (Array.isArray(configured) && configured.length) return configured;
  } catch {}
  return DEFAULT_SOURCES;
}

// ── HTML scraping ─────────────────────────────────────────────────────────────

async function scrapeHtmlPage(source) {
  const resp = await fetch(source.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (newsletter-digest/1.0)' },
    signal:  AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const charts = [];
  const figureRe = /<figure[^>]*>([\s\S]*?)<\/figure>/gi;
  let fm;
  while ((fm = figureRe.exec(html)) !== null && charts.length < (source.limit || 2)) {
    const block = fm[1];
    const imgMatch = block.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i)
                  || block.match(/<img[^>]+srcset=["']([^"',\s]+)/i);
    if (!imgMatch) continue;
    let img = imgMatch[1];
    if (img.startsWith('//')) img = 'https:' + img;
    if (/logo|sprite|avatar|pixel/i.test(img)) continue;
    const caption = (block.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] || '')
      .replace(/<[^>]+>/g, '').trim();
    const h2 = (block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i)?.[1] || '')
      .replace(/<[^>]+>/g, '').trim();
    const title = (h2 || caption.split(/[.:]/)[0] || 'Chart').slice(0, 140);
    charts.push({
      title,
      image:     img,
      source:    source.name,
      sourceUrl: source.url,
      context:   caption.slice(0, 240),
    });
  }

  // Fallback: generic <img alt="…"> if <figure> scraping came up empty.
  if (!charts.length) {
    const imgRe = /<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["'][^>]*alt=["']([^"']*)["']/gi;
    let im;
    while ((im = imgRe.exec(html)) !== null && charts.length < (source.limit || 2)) {
      if (/logo|sprite|avatar|pixel|icon/i.test(im[1])) continue;
      charts.push({
        title:     (im[2] || 'Chart').slice(0, 140),
        image:     im[1].startsWith('//') ? 'https:' + im[1] : im[1],
        source:    source.name,
        sourceUrl: source.url,
        context:   '',
      });
    }
  }

  return charts;
}

// ── Twitter/X scraping (via nitter mirrors) ───────────────────────────────────

const NITTER_MIRRORS = [
  'https://nitter.net',
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
];

async function scrapeTwitter(source) {
  const handle = source.url
    .replace(/^https?:\/\/(?:www\.|mobile\.)?(twitter|x)\.com\//, '')
    .split(/[?/]/)[0];
  if (!handle) return [];
  for (const mirror of NITTER_MIRRORS) {
    try {
      const resp = await fetch(`${mirror}/${encodeURIComponent(handle)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (newsletter-digest/1.0)' },
        signal:  AbortSignal.timeout(7000),
      });
      if (!resp.ok) continue;
      const html  = await resp.text();
      const charts = [];
      const itemRe = /<div class="timeline-item"[^>]*>([\s\S]*?)<div class="tweet-stats/g;
      let fm;
      while ((fm = itemRe.exec(html)) !== null && charts.length < (source.limit || 2)) {
        const block = fm[1];
        if (!/class="attachment image"/.test(block) && !/class="attachments"/.test(block)) continue;
        const img = block.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
        if (!img) continue;
        const txt = (block.match(/<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const fullImg = img.startsWith('/') ? `${mirror}${img}` : img;
        charts.push({
          title:     (txt.split(/[.!?]/)[0] || `Post by @${handle}`).slice(0, 140),
          image:     fullImg,
          source:    source.name,
          sourceUrl: source.url,
          context:   txt.slice(0, 240),
        });
      }
      if (charts.length) return charts;
    } catch { continue; }
  }
  return [];
}

// ── Public API ───────────────────────────────────────────────────────────────

async function fetchCharts({ max = 5 } = {}) {
  const sources = await getChartSources();
  const perSource = [];
  for (const s of sources) {
    try {
      const charts = s.kind === 'twitter' ? await scrapeTwitter(s) : await scrapeHtmlPage(s);
      perSource.push(charts);
    } catch (e) {
      console.warn(`[chart] ${s.name} failed: ${e.message}`);
      perSource.push([]);
    }
  }
  const out = [];
  let idx = 0;
  const total = perSource.reduce((n, a) => n + a.length, 0);
  while (out.length < max && out.length < total) {
    const arr = perSource[idx % perSource.length];
    if (arr && arr.length) out.push(arr.shift());
    idx++;
    if (idx > max * Math.max(1, perSource.length)) break;
  }
  return out;
}

/**
 * Fetch (or retrieve from cache) the chart-of-day payload for a given date.
 * Cache is keyed `cache:chart-of-day:YYYY-MM-DD` in kv_store.
 */
async function getCharts({ dateKey, force = false } = {}) {
  const key      = dateKey || new Date().toISOString().slice(0, 10);
  const cacheKey = `cache:chart-of-day:${key}`;
  if (!force) {
    try {
      const cached = await storage.getKV(cacheKey);
      if (cached?.charts?.length) return cached;
    } catch {}
  }
  const charts  = await fetchCharts({ max: 5 });
  const payload = { charts, fetchedAt: new Date().toISOString(), dateKey: key };
  try { await storage.setKV(cacheKey, payload); }
  catch (e) { console.warn('[chart] cache write failed:', e.message); }
  return payload;
}

// Kept for backwards compatibility with any old imports.
async function fetchChartOfDay() {
  const { charts } = await getCharts({});
  return charts[0] || null;
}

module.exports = { getCharts, fetchCharts, fetchChartOfDay, getChartSources, DEFAULT_SOURCES };
