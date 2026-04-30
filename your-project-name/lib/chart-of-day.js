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

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const DEFAULT_SOURCES = [
  { name: 'Charlie Bilello',   kind: 'rss', url: 'https://bilello.blog/category/chart-of-the-day/feed/' },
  { name: 'Apollo Academy',    kind: 'rss', url: 'https://www.apolloacademy.com/feed/' },
  { name: 'NYT Business',      kind: 'rss', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml' },
];

async function getChartSources() {
  try {
    const settings = await storage.getSettings();
    const configured = settings?.chartSources;
    if (Array.isArray(configured) && configured.length) return configured;
  } catch {}
  return DEFAULT_SOURCES;
}

// ── RSS parsing ──────────────────────────────────────────────────────────────

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

function extractImage(itemXml) {
  // 1. <enclosure url="…" type="image/…">
  let m = itemXml.match(/<enclosure[^>]+url=["']([^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["'][^>]*>/i);
  if (m) return m[1];

  // 2. <media:content url="…" medium="image" />
  m = itemXml.match(/<media:content[^>]+url=["']([^"']+)["']/i);
  if (m && /\.(jpg|jpeg|png|webp|gif)/i.test(m[1])) return m[1];

  // 3. <media:thumbnail url="…" />
  m = itemXml.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
  if (m) return m[1];

  // 4. <img src="…"> inside <content:encoded> or <description>
  const body = (itemXml.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i)?.[1])
            || (itemXml.match(/<description>([\s\S]*?)<\/description>/i)?.[1])
            || '';
  m = body.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i);
  if (m) return decodeXml(m[1]);

  return null;
}

async function scrapeRss(source) {
  const resp = await fetch(source.url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal:  AbortSignal.timeout(25000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const xml = await resp.text();

  // Items / entries
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  const charts = [];
  let m;
  while ((m = itemRe.exec(xml)) !== null && charts.length < 1) {
    const block = m[1] || m[2] || '';
    const image = extractImage(block);
    if (!image) continue;
    if (/logo|sprite|avatar|tracking|pixel|favicon/i.test(image)) continue;

    const title   = stripTags(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || 'Chart').slice(0, 140);
    const link    = stripTags(block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || '')
                 || (block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || '');
    const desc    = stripTags(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '').slice(0, 240);
    const pubDate = stripTags(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]
                           || block.match(/<published>([\s\S]*?)<\/published>/i)?.[1] || '');

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

// ── HTML scraping (legacy / fallback) ────────────────────────────────────────

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

async function fetchCharts() {
  const sources = await getChartSources();
  const out = [];
  for (const s of sources) {
    if (s.enabled === false) continue;
    try {
      const kind = s.kind || 'rss';
      const charts = kind === 'html' ? await scrapeHtmlPage(s) : await scrapeRss(s);
      if (charts && charts.length) out.push(charts[0]);
    } catch (e) {
      console.warn(`[chart] ${s.name} failed: ${e.message}`);
    }
  }
  return out;
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
