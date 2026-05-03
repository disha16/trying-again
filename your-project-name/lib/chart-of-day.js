'use strict';

/**
 * Chart of the Day — v3 (RSS-based).
 *
 * v2 used HTML scraping of NBC + nitter Twitter mirrors, which broke when:
 *   - NBC removed the /economy/economic-indicators page (404)
 *   - All public nitter mirrors went down
 *
 * v3 reads RSS feeds. RSS is stable, well-defined, and most quality chart
 * publishers expose it. Each source returns ONE most-recent chart-bearing
 * post (image extracted from <enclosure>, <media:content>, or first <img>
 * in <content:encoded>).
 *
 * Each source entry:
 *   - name     (display label)
 *   - kind     "rss" (default) | "html" (legacy fallback)
 *   - url      (HTML: page to scrape; RSS: feed URL)
 *   - limit    (max charts per refresh; default 1 per v2 contract)
 *
 * Output:
 *   { charts: [{ title, image, source, sourceUrl, context, postUrl, postedAt }],
 *     fetchedAt, dateKey }
 */

const storage = require('./storage');
const https   = require('https');
const zlib    = require('zlib');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * Curl-style HTTPS GET that follows redirects and decompresses gzip/deflate/br.
 * Used for hosts (e.g., nitter.net) that respond with empty bodies to Node's
 * built-in fetch but work fine with curl-equivalent header sequences.
 */
function httpsGetText(url, { headers = {}, timeoutMs = 12000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = {
      'User-Agent':      UA,
      'Accept':          '*/*',
      'Accept-Encoding': 'gzip, deflate',
      'Connection':      'close',
      ...headers,
    };
    const req = https.get(url, { headers: reqHeaders }, res => {
      // Follow redirects.
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(httpsGetText(next, { headers, timeoutMs, maxRedirects: maxRedirects - 1 }));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip')         stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end',  ()  => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

// Curated list of active chart-bearing publishers (RSS only). Each one is
// verified to (a) be reachable from Vercel, (b) post charts in their hero/inline
// imagery, and (c) have published within the last 30 days at probe time.
//
// chartFirst=true: the post's hero image IS the chart (dedicated chart feeds).
// chartFirst=false: the post is general news; we must scan the article body for
// chart-like imagery before promoting it (drops misleading hero photos).
//
// Recency: at fetch time we filter to posts from the last RECENCY_DAYS days and
// sort by recency, so even with a long source list only fresh content surfaces.
const DEFAULT_SOURCES = [
  { name: 'Charlie Bilello',         kind: 'rss', url: 'https://bilello.blog/feed',                       chartFirst: true  },
  { name: 'Klement on Investing',    kind: 'rss', url: 'https://klementoninvesting.substack.com/feed',    chartFirst: true  },
  { name: 'Joey Politano (Apricitas)', kind: 'rss', url: 'https://www.apricitas.io/feed',                 chartFirst: true  },
  { name: 'Apollo Academy',          kind: 'rss', url: 'https://www.apolloacademy.com/feed/',             chartFirst: true  },
  { name: 'NYT Business',            kind: 'rss', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', chartFirst: false },
];

// Only show charts published within this many days. Anything older is filtered
// out at fetch time so a stale source can't anchor the carousel with old data.
const RECENCY_DAYS = 3;

async function getChartSources() {
  try {
    const settings = await storage.getSettings();
    const configured = settings?.chartSources;
    if (Array.isArray(configured) && configured.length) return configured;
  } catch {}
  return DEFAULT_SOURCES;
}

// ── Article-body chart verification ──────────────────────────────────────────────

// Image hosts/paths that strongly indicate a real data visualization. Used to
// confirm an article actually contains a chart before we promote it as Chart of
// the Day. NOTE: substackcdn.com is intentionally NOT here — both charts and
// stock photos are served from the same path on substack, so we cannot use
// the host alone to distinguish them. We rely on alt-text/filename hints
// (CHART_IMG_HINT_RE) for substack-hosted images.
const CHART_IMG_HOST_RE = /(datawrapper\.dwcdn\.net|cf\.datawrapper\.de|public\.tableau\.com|chartblocks|highcharts|infogram|flourish\.studio|g\.foolcdn\.com\/.*\/chart|static01\.nyt\.com\/[^"']*?(?:graphic|chart|svg))/i;
// Alt-text or filename hints that a given <img> is a chart/graph/figure.
// Includes data words common in chart alt text (yoy, ytd, percent, returns).
const CHART_IMG_HINT_RE = /\b(chart|graph|graphic|figure|trend|infographic|plot|histogram|bar|line|pie|yoy|ytd|cagr|percent|return[s]?|index|spread|yield|cpi|gdp|valuation|earnings)\b/i;

/**
 * Fetch the article HTML and return the URL of an in-body chart image, or null.
 * Looks for: known chart-CDN hosts, chart-named filenames, alt-text hints, and
 * datawrapper/Tableau iframes (in which case we can't easily extract the image
 * URL but we know a chart exists — the function still returns null in that case
 * so caller drops the entry; better to drop than to show a misleading hero shot).
 */
async function findChartImageInArticle(postUrl) {
  if (!postUrl) return null;
  try {
    const resp = await fetch(postUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal:  AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    // Pass 1: <img> whose src matches a known chart CDN.
    const imgRe = /<img\b[^>]+>/gi;
    let m;
    let bestHint = null;
    while ((m = imgRe.exec(html)) !== null) {
      const tag = m[0];
      const src = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1] || '';
      const alt = (tag.match(/\balt=["']([^"']*)["']/i) || [])[1] || '';
      if (!src) continue;
      if (/logo|sprite|avatar|tracking|pixel|favicon/i.test(src)) continue;
      // Strong signal: known chart CDN.
      if (CHART_IMG_HOST_RE.test(src)) {
        return src.startsWith('//') ? 'https:' + src : src;
      }
      // Medium signal: chart-y alt text or filename.
      if (!bestHint && (CHART_IMG_HINT_RE.test(alt) || CHART_IMG_HINT_RE.test(src))) {
        bestHint = src.startsWith('//') ? 'https:' + src : src;
      }
    }
    if (bestHint) return bestHint;

    // Pass 2: chart-bearing iframe (datawrapper/tableau/flourish). We can't
    // screenshot it cheaply, so report "no extractable chart image" — caller
    // drops the entry rather than show a hero photo.
    return null;
  } catch {
    return null;
  }
}

// ── RSS parsing ─────────────────────────────────────────────────────────────────────────
function decodeXml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return decodeXml(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// URLs that look like images but are decorative noise (emoji, sprites,
// tracking pixels, share/social icons, WP smileys, etc.). We skip these so a
// post titled "The Week in Charts 📊" doesn't surface the bar-chart EMOJI as the
// hero image instead of an actual chart from the post body.
const NON_CHART_IMG_RE = /(s\.w\.org\/images\/core\/emoji|\/emoji\/|\/wp-includes\/images\/smilies|\/feedburner|stats\.wp\.com|fls\.doubleclick|tracking|pixel|favicon|sprite|avatar|gravatar|share-?(?:icon|button)|social-?icon|ad-?banner)/i;

function _isUsableImage(url) {
  return !!url && !NON_CHART_IMG_RE.test(url);
}

function extractImage(itemXml) {
  // 1. <enclosure url="…" type="image/…">
  let m = itemXml.match(/<enclosure[^>]+url=["']([^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["'][^>]*>/i);
  if (m && _isUsableImage(m[1])) return m[1];

  // 2. <media:content url="…" medium="image" />
  m = itemXml.match(/<media:content[^>]+url=["']([^"']+)["']/i);
  if (m && /\.(jpg|jpeg|png|webp|gif)/i.test(m[1]) && _isUsableImage(m[1])) return m[1];

  // 3. <media:thumbnail url="…" />
  m = itemXml.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
  if (m && _isUsableImage(m[1])) return m[1];

  // 4. <img src="…"> inside <content:encoded> or <description>: take the
  //    first usable one (skip emoji, smilies, tracking pixels). Bilello's
  //    feed in particular has a bar-chart emoji in title that gets picked
  //    by a naive 'first <img>' approach — we want the actual chart from
  //    further down in the post.
  const body = (itemXml.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i)?.[1])
            || (itemXml.match(/<description>([\s\S]*?)<\/description>/i)?.[1])
            || '';
  const imgRe = /<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/gi;
  let im;
  while ((im = imgRe.exec(body)) !== null) {
    const candidate = decodeXml(im[1]);
    if (_isUsableImage(candidate)) return candidate;
  }

  return null;
}

async function scrapeRss(source) {
  // Use httpsGetText, not built-in fetch — several feeds (bilello.blog/feed,
  // some Substacks) respond with redirects + gzip that undici fetch handles
  // unreliably on Vercel. httpsGetText follows redirects and decompresses.
  const xml = await httpsGetText(source.url, {
    headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    timeoutMs: 15000,
  });

  const chartFirst = source.chartFirst !== false; // default true for back-compat

  // Even on chart-dedicated feeds (Klement, Bilello, Apricitas) some posts
  // lack an actual chart image (life updates, op-eds, photo essays). We
  // validate every entry has a chart-like image before promoting it — a
  // stock-photo hero (e.g. hot-air balloon) is worse than no chart at all.
  const itemRe   = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  const maxScan  = 10;
  const charts   = [];
  let scanned    = 0;
  let m;
  while ((m = itemRe.exec(xml)) !== null && charts.length < 1 && scanned < maxScan) {
    scanned++;
    const block = m[1] || m[2] || '';
    const rssImage = extractImage(block);

    const title   = stripTags(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || 'Chart').slice(0, 140);
    const link    = stripTags(block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || '')
                 || (block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || '');
    const desc    = stripTags(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '').slice(0, 240);
    const pubDate = stripTags(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]
                           || block.match(/<published>([\s\S]*?)<\/published>/i)?.[1] || '');

    // Decide on the image. Order of trust:
    //   (a) RSS hero is on a known chart CDN OR has chart-hinting filename/path
    //       → trust it without fetching the article.
    //   (b) Otherwise scan article body for a chart image.
    //   (c) If body yields nothing, drop the entry entirely — NEVER fall back
    //       to a Substack/Wordpress hero that could be a stock photo.
    let image = null;
    const rssImageOk = rssImage && !/logo|sprite|avatar|tracking|pixel|favicon/i.test(rssImage);
    if (rssImageOk && (CHART_IMG_HOST_RE.test(rssImage) || CHART_IMG_HINT_RE.test(rssImage))) {
      image = rssImage;
    } else {
      const chartImg = await findChartImageInArticle(link);
      if (chartImg) image = chartImg;
    }

    if (!image) {
      console.log(`[chart] ${source.name}: "${title.slice(0, 60)}" — no chart image found, dropping`);
      continue;
    }

    charts.push({
      title,
      image,
      source:    source.name,
      sourceUrl: source.url,
      postUrl:   link || source.url,
      postedAt:  pubDate || null,
      context:   desc,
    });
  }
  return charts;
}

// ── (legacy) Twitter/X scraping via Nitter ─────────────────────────────────────
// Kept for backwards compatibility only — Vercel datacenter IPs are blocked by
// every working Nitter mirror in 2026, so this path consistently times out or
// returns 403/captcha. New deployments should use kind:'rss' sources.
const NITTER_MIRRORS = ['https://nitter.net'];

/** Extract the @handle from any of: "@handle", "handle", "https://twitter.com/handle", "https://x.com/handle/...". */
function extractTwitterHandle(input) {
  if (!input) return null;
  const s = String(input).trim().replace(/^@/, '');
  // Full URL?
  const m = s.match(/(?:twitter\.com|x\.com|nitter\.net)\/([A-Za-z0-9_]{1,15})/i);
  if (m) return m[1];
  // Bare handle?
  if (/^[A-Za-z0-9_]{1,15}$/.test(s)) return s;
  return null;
}

/**
 * Convert a Nitter image-proxy URL into the original pbs.twimg.com URL.
 * e.g. https://nitter.net/pic/media%2FHG26Df9bwAAWapR.png
 *   → https://pbs.twimg.com/media/HG26Df9bwAAWapR.png
 */
function unwrapNitterImage(url) {
  if (!url) return url;
  const m = url.match(/\/pic\/(.+)$/);
  if (!m) return url;
  let path = m[1];
  try { path = decodeURIComponent(path); } catch {}
  // Sometimes Nitter prefixes with "orig/" for full-size variants.
  path = path.replace(/^orig\//, '');
  // The remaining path is e.g. "media/HG26Df9bwAAWapR.png" or "media/...?name=orig"
  return `https://pbs.twimg.com/${path}`;
}

async function fetchNitterRss(handle) {
  let lastErr;
  for (const base of NITTER_MIRRORS) {
    const url = `${base}/${handle}/rss`;
    try {
      // Use httpsGetText, not fetch — Nitter responds with empty bodies to
      // Node's built-in undici fetch but works with curl-style HTTPS GET.
      const xml = await httpsGetText(url, {
        headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        timeoutMs: 12000,
      });
      if (!xml.includes('<item') && !xml.includes('<entry')) {
        lastErr = new Error(`No items in feed from ${base}`); continue;
      }
      return xml;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Nitter mirrors failed');
}

async function scrapeTwitter(source) {
  const handle = extractTwitterHandle(source.url);
  if (!handle) throw new Error(`Cannot extract handle from "${source.url}"`);
  const xml = await fetchNitterRss(handle);

  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const charts = [];
  let scanned = 0;
  const maxScan = 12;
  let m;
  while ((m = itemRe.exec(xml)) !== null && charts.length < 1 && scanned < maxScan) {
    scanned++;
    const block = m[1];

    // Skip retweets so we always show the user's own original chart tweets.
    const titleRaw = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
    if (/^\s*(?:<!\[CDATA\[)?\s*RT by /i.test(titleRaw)) continue;

    // Find an image in the description (Nitter inlines <img> for media tweets).
    const desc = block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '';
    const imgM = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (!imgM) continue;
    const image = unwrapNitterImage(imgM[1].startsWith('//') ? 'https:' + imgM[1] : imgM[1]);
    if (!image || /\/profile_images\//i.test(image)) continue;

    // Drop low-signal social tweets (Follow Friday shoutouts, single-line replies).
    // We want chart-bearing posts: substantive caption text (>= 40 chars) and not
    // dominated by @-mentions / hashtags relative to body length.
    const cleanTitle = stripTags(titleRaw).replace(/\s+/g, ' ').trim();
    if (cleanTitle.length < 40) continue;
    if (/^#FF\b/i.test(cleanTitle)) continue;
    // If the tweet is mostly @mentions (e.g. "FF @x @y, a great follow!"), drop it.
    const mentions = (cleanTitle.match(/@\w+/g) || []).length;
    const words    = cleanTitle.split(/\s+/).length;
    if (mentions >= 2 && mentions / Math.max(1, words) > 0.3) continue;

    const title = stripTags(titleRaw).slice(0, 140) || 'Chart';
    const link  = stripTags(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '');
    // Convert Nitter status link → x.com status link so the user opens the real tweet.
    const tweetUrl = link
      ? link.replace(/https?:\/\/[^/]+/, 'https://x.com').replace(/#m$/, '')
      : `https://x.com/${handle}`;
    const pubDate = stripTags(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || '');

    charts.push({
      title,
      image,
      source:    source.name,
      sourceUrl: `https://x.com/${handle}`,
      postUrl:   tweetUrl,
      postedAt:  pubDate || null,
      context:   title,
    });
  }
  return charts;
}

// ── HTML scraping (legacy / fallback) ────────────────────────────────────

async function scrapeHtmlPage(source) {
  const resp = await fetch(source.url, {
    headers: { 'User-Agent': UA },
    signal:  AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  const charts = [];
  const figureRe = /<figure[^>]*>([\s\S]*?)<\/figure>/gi;
  let fm;
  while ((fm = figureRe.exec(html)) !== null && charts.length < 1) {
    const block = fm[1];
    const imgMatch = block.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i);
    if (!imgMatch) continue;
    const img = imgMatch[1].startsWith('//') ? 'https:' + imgMatch[1] : imgMatch[1];
    if (/logo|sprite|avatar|pixel/i.test(img)) continue;
    const caption = (block.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim();
    const h2 = (block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim();
    charts.push({
      title:     (h2 || caption.split(/[.:]/)[0] || 'Chart').slice(0, 140),
      image:     img,
      source:    source.name,
      sourceUrl: source.url,
      postUrl:   source.url,
      postedAt:  null,
      context:   caption.slice(0, 240),
    });
  }
  return charts;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Pull the most-recent qualifying chart from each configured source, then keep
 * only those posted within the last RECENCY_DAYS, sorted newest-first. This
 * lets us stack a long source list and surface only what's actually fresh.
 */
async function fetchCharts() {
  const sources = await getChartSources();

  // Fan out across sources in parallel — each is independent and we don't want
  // a slow source to delay the others by serializing the whole list.
  const results = await Promise.all(sources.map(async s => {
    if (s.enabled === false) return null;
    try {
      const kind = s.kind || 'rss';
      let charts;
      if (kind === 'twitter')      charts = await scrapeTwitter(s);
      else if (kind === 'html')    charts = await scrapeHtmlPage(s);
      else                          charts = await scrapeRss(s);
      return charts && charts[0] ? charts[0] : null;
    } catch (e) {
      console.warn(`[chart] ${s.name} failed: ${e.message}`);
      return null;
    }
  }));

  const cutoffMs = Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000;
  const fresh    = [];
  const stale    = [];
  for (const c of results) {
    if (!c) continue;
    const t = c.postedAt ? Date.parse(c.postedAt) : NaN;
    if (!isNaN(t) && t >= cutoffMs)      fresh.push({ ...c, _ts: t });
    else if (!isNaN(t))                  stale.push({ ...c, _ts: t });
    else                                  stale.push({ ...c, _ts: 0 }); // unknown date
  }

  // Newest-first within fresh window. If we have any fresh items at all, only
  // ship those — stale entries are silently dropped to keep the carousel current.
  fresh.sort((a, b) => b._ts - a._ts);
  if (fresh.length) {
    return fresh.map(({ _ts, ...rest }) => rest);
  }

  // No fresh items: fall back to the single most-recent stale chart so the
  // section never goes empty when sources are quiet for a few days.
  stale.sort((a, b) => b._ts - a._ts);
  if (stale.length) {
    const { _ts, ...rest } = stale[0];
    return [rest];
  }
  return [];
}

async function getCharts({ dateKey, force = false } = {}) {
  const key      = dateKey || new Date().toISOString().slice(0, 10);
  const cacheKey = `cache:chart-of-day:${key}`;
  if (!force) {
    try {
      const cached = await storage.getKV(cacheKey);
      if (cached?.charts?.length) return cached;
    } catch {}
  }
  const charts  = await fetchCharts();
  const payload = { charts, fetchedAt: new Date().toISOString(), dateKey: key };
  try { await storage.setKV(cacheKey, payload); }
  catch (e) { console.warn('[chart] cache write failed:', e.message); }
  return payload;
}

async function fetchChartOfDay() {
  const { charts } = await getCharts({});
  return charts[0] || null;
}

/**
 * Enrich each chart with a 2-line LLM caption summarising what the chart shows
 * and why it matters. Uses {title, context} as input. Idempotent (skips charts
 * that already have `caption`).
 */
async function summarizeCharts(charts, { model } = {}) {
  if (!Array.isArray(charts) || !charts.length) return charts || [];
  let _callModel;
  try { ({ _callModel } = require('./digest-generator')); }
  catch (e) { console.warn('[chart] digest-generator not available, captions skipped:', e.message); return charts; }
  // Pick a fast model that works on Vercel. Default chain: groq llama → deepseek → qwen.
  // Caller can override with `model`. We let _callModel handle provider fallback.
  const tryModel = model || process.env.CHART_CAPTION_MODEL || 'llama-3.3-70b-versatile';
  const out = [];
  for (const c of charts) {
    if (c.caption) { out.push(c); continue; }
    try {
      const sys    = 'You are a concise financial-chart caption writer. Output exactly 2 short sentences (max ~28 words total). No preamble, no markdown, no quotes.';
      const prompt = `Explain what this chart shows AND why it matters for an investor.\n\nTitle: ${c.title}\nContext: ${c.context || ''}`;
      const text   = await _callModel(tryModel, prompt, sys);
      const caption = String(text || '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
      out.push({ ...c, caption });
    } catch (e) {
      console.warn(`[chart] caption failed for ${c.source}: ${e.message}`);
      out.push(c);
    }
  }
  return out;
}

module.exports = { getCharts, fetchCharts, fetchChartOfDay, getChartSources, summarizeCharts, DEFAULT_SOURCES };
