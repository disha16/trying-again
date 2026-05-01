'use strict';

/**
 * OG-image scraper.
 *
 * For a given article URL we fetch the HTML head and pull the publisher's
 * canonical hero image from one of (in order):
 *   1. <meta property="og:image"> / <meta property="og:image:secure_url">
 *   2. <meta name="twitter:image">
 *   3. <link rel="image_src">
 *   4. JSON-LD `image` (string or first array element)
 *
 * This is the highest-quality image source we have because it's literally
 * what the publisher chose to show in social embeds. No gstatic, no thumbs.
 *
 * Results are cached in-process for the lifetime of the run so a single
 * digest never hits the same URL twice.
 */

const cache = new Map(); // url -> string|null (resolved or "tried-empty")

const BAD_IMAGE = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|profile|placeholder|pixel|tracking|beacon|favicon|sprite|encrypted-tbn|gstatic\.com/i;

function _isUsable(u) {
  if (!u || typeof u !== 'string') return false;
  if (!/^https?:\/\//i.test(u)) return false;
  if (BAD_IMAGE.test(u)) return false;
  // Reject tiny obvious thumbnails by URL hint
  if (/[?&](w|width)=([0-9]{1,2})\b/i.test(u)) return false;
  return true;
}

function _abs(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

async function _fetch(url, ms = 4500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        // Pretend to be a real desktop browser — some publishers gate OG tags behind UA checks
        'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept':           'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':  'en-US,en;q=0.9',
      },
    });
    if (!r.ok) return null;
    // Only read first 200KB of HTML — head metadata is always within the first few KB.
    const reader = r.body?.getReader?.();
    if (!reader) return await r.text();
    let html = '';
    const dec = new TextDecoder();
    let total = 0;
    while (total < 200_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      total += value.byteLength;
      if (/<\/head\s*>/i.test(html)) break; // stop early once </head> is reached
    }
    try { reader.cancel(); } catch {}
    return html;
  } catch { return null; }
  finally { clearTimeout(t); }
}

function _extractFromHtml(html, baseUrl) {
  if (!html) return null;
  const head = html.split(/<\/head\s*>/i)[0] || html;

  // 1) og:image variants
  const ogPatterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ];
  for (const re of ogPatterns) {
    const m = head.match(re);
    if (m && m[1]) {
      const abs = _abs(m[1].trim(), baseUrl);
      if (abs && _isUsable(abs)) return abs;
    }
  }

  // 2) twitter:image
  const twitter = head.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i)
               || head.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i);
  if (twitter && twitter[1]) {
    const abs = _abs(twitter[1].trim(), baseUrl);
    if (abs && _isUsable(abs)) return abs;
  }

  // 3) <link rel="image_src">
  const linkSrc = head.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
  if (linkSrc && linkSrc[1]) {
    const abs = _abs(linkSrc[1].trim(), baseUrl);
    if (abs && _isUsable(abs)) return abs;
  }

  // 4) JSON-LD <script type="application/ld+json"> with "image"
  const ldMatches = head.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const blk of ldMatches) {
    const inner = blk.replace(/^[\s\S]*?>/, '').replace(/<\/script>\s*$/, '');
    try {
      const parsed = JSON.parse(inner);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of candidates) {
        const img = obj?.image;
        let url = null;
        if (typeof img === 'string') url = img;
        else if (Array.isArray(img) && img.length) url = (typeof img[0] === 'string') ? img[0] : img[0]?.url;
        else if (img && typeof img === 'object') url = img.url;
        if (url) {
          const abs = _abs(String(url).trim(), baseUrl);
          if (abs && _isUsable(abs)) return abs;
        }
      }
    } catch { /* ignore unparseable LD blocks */ }
  }

  return null;
}

/**
 * Fetch a single article URL and return its OG image, or null if nothing useable found.
 */
async function fetchOgImage(articleUrl) {
  if (!articleUrl) return null;
  if (cache.has(articleUrl)) return cache.get(articleUrl);
  const html  = await _fetch(articleUrl);
  const image = _extractFromHtml(html, articleUrl);
  cache.set(articleUrl, image || null);
  return image;
}

/**
 * Bulk-attach OG images to items in parallel. Mutates `items` in place, only
 * setting `item.image` when (a) it's currently empty / a known undraw fallback
 * and (b) we found a usable OG image. Caller can pass `force=true` to overwrite
 * existing low-quality images.
 *
 * @param {Array<{image?:string, sourceUrl?:string, url?:string}>} items
 * @param {{ concurrency?:number, force?:boolean, urlField?:string }} opts
 */
async function attachOgImages(items, { concurrency = 12, force = false, urlField = 'sourceUrl' } = {}) {
  if (!Array.isArray(items) || !items.length) return items;

  const targets = items.filter(it => {
    const url = it && it[urlField] || it?.url;
    if (!url) return false;
    if (force) return true;
    if (!it.image) return true;
    // Replace cdn.jsdelivr.net/...undraw fallback if present and we can do better
    if (/cdn\.jsdelivr\.net\/gh\/balazser\/undraw/i.test(it.image)) return true;
    if (BAD_IMAGE.test(it.image)) return true;
    return false;
  });

  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const idx = i++;
      const it  = targets[idx];
      const url = it[urlField] || it.url;
      try {
        const og = await fetchOgImage(url);
        if (og) it.image = og;
      } catch { /* swallow */ }
    }
  }
  const n = Math.max(1, Math.min(concurrency, targets.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return items;
}

module.exports = { fetchOgImage, attachOgImages };
