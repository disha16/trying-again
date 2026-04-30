'use strict';

/**
 * Card-image enrichment.
 *
 * History: this module was Exa-only; file name + export kept for back-compat.
 *
 * Current behaviour:
 *   • If useExa=true AND EXA_API_KEY set, try Exa first (best editorial quality).
 *   • Else try Tavily news search (TAVILY_API_KEY) — returns lead images per article
 *     when `include_images=true`.
 *   • Else try Brave news (BRAVE_API_KEY) — thumbnails, lower quality.
 *   • Else silently skip.
 *
 * Top-10 cards now get images whenever ANY provider is configured, not just Exa.
 */

const BAD_IMAGE_PATTERNS = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|profile|placeholder|pixel|tracking|beacon/i;

const BAD_SOURCE_DOMAINS = [
  'globenewswire.com', 'prnewswire.com', 'businesswire.com',
  'accesswire.com', 'notified.com', 'einpresswire.com',
  'newswire.com', 'prlog.org', 'send2press.com', 'openpr.com',
];

const BAD_DOMAIN_PATTERNS = /food|recipe|cook|eat|drink|diet|health|wellness|fitness|beauty|fashion|style|travel|lifestyle|sport|game|entertain|celeb|gossip|horoscope/i;

function isGoodResult(r) {
  if (!r.image) return false;
  if (BAD_IMAGE_PATTERNS.test(r.image)) return false;
  if (r.url) {
    const domain = r.url.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
    if (BAD_SOURCE_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return false;
    if (BAD_DOMAIN_PATTERNS.test(domain)) return false;
  }
  return true;
}

// ── Exa ─────────────────────────────────────────────────────────────────────
let _exaClient = null;
function getExa() {
  if (_exaClient) return _exaClient;
  if (!process.env.EXA_API_KEY) return null;
  const Exa = require('exa-js').default;
  _exaClient = new Exa(process.env.EXA_API_KEY);
  return _exaClient;
}

async function fetchViaExa(headline) {
  const exa = getExa();
  if (!exa) return null;
  const res = await exa.search(headline, { numResults: 8, category: 'news' });
  const hit = (res.results || []).find(isGoodResult);
  return hit?.image || null;
}

// ── Tavily ──────────────────────────────────────────────────────────────────
async function fetchViaTavily(headline) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  const r = await fetch('https://api.tavily.com/search', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      api_key:        key,
      query:          headline,
      max_results:    8,
      include_images: true,
      search_depth:   'basic',
      topic:          'news',
      days:           3,
    }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}`);
  const data = await r.json();
  // Tavily returns a top-level `images` array. Return the first non-branded one.
  for (const imgUrl of (data.images || [])) {
    if (typeof imgUrl !== 'string') continue;
    if (BAD_IMAGE_PATTERNS.test(imgUrl)) continue;
    return imgUrl;
  }
  return null;
}

// ── Brave ───────────────────────────────────────────────────────────────────
async function fetchViaBrave(headline) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return null;
  const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(headline)}&count=8&freshness=pw`;
  const r = await fetch(url, { headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`Brave ${r.status}`);
  const data = await r.json();
  const results = (data.results || []).map(hit => ({
    image: hit.thumbnail?.src || null,
    url:   hit.url,
  }));
  const hit = results.find(isGoodResult);
  return hit?.image || null;
}

async function fetchCardImage(headline, providers) {
  for (const [name, fn] of providers) {
    try {
      const img = await fn(headline);
      if (img) return { image: img, via: name };
    } catch (e) {
      console.warn(`[card-images] ${name} for "${headline.slice(0, 40)}…":`, e.message);
    }
  }
  return { image: null, via: null };
}

async function enrichClustersWithImages(clusters, opts = {}) {
  let useExa = opts.useExa;
  if (useExa === undefined) useExa = opts.showImages === true;
  if (useExa === undefined) {
    try { useExa = await require('./storage').isExaEnabled(); } catch { useExa = false; }
  }

  const providers = [];
  if (useExa && process.env.EXA_API_KEY) providers.push(['exa',    fetchViaExa]);
  if (process.env.TAVILY_API_KEY)        providers.push(['tavily', fetchViaTavily]);
  if (process.env.BRAVE_API_KEY)         providers.push(['brave',  fetchViaBrave]);

  if (!providers.length) {
    console.log(`[card-images] no providers available (useExa=${useExa}) — skipping`);
    return;
  }

  const tallies = {};
  await Promise.all(clusters.map(async c => {
    const { image, via } = await fetchCardImage(c.headline, providers);
    if (image) {
      c.image = image;
      tallies[via] = (tallies[via] || 0) + 1;
    }
  }));

  const found = clusters.filter(c => c.image).length;
  const breakdown = Object.entries(tallies).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  console.log(`[card-images] images found: ${found}/${clusters.length} (${breakdown})`);
}

module.exports = { enrichClustersWithImages };
