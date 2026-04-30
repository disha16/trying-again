'use strict';

/**
 * Image fallback chain — used when a digest item ends up without a real
 * inline image (no RSS thumbnail, no Tavily image, no Exa image).
 *
 * Order mirrors the unified search chain (Exa → Serper → Tavily) but only
 * touches the *image* endpoints / image fields:
 *   1. Exa     (already happens in the main search step; nothing extra here)
 *   2. Serper  (Google Images via google.serper.dev/images)
 *   3. Tavily  (already in main search; the `images[]` array)
 *
 * Fall through to undraw when nothing returns a usable image.
 *
 * Cached in memory per-process so the same headline doesn't hit Serper twice.
 */

const cache = new Map(); // headline → image URL (or null for "tried, found nothing")

const BAD_IMAGE = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|profile|placeholder|pixel|tracking|beacon|favicon|sprite/i;

async function fetchWithTimeout(url, init = {}, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

function isUsable(imgUrl) {
  if (!imgUrl) return false;
  if (BAD_IMAGE.test(imgUrl)) return false;
  if (!/^https?:\/\//.test(imgUrl)) return false;
  return true;
}

async function serperImage(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return null;
  try {
    const r = await fetchWithTimeout('https://google.serper.dev/images', {
      method:  'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q: query, num: 5 }),
    }, 4000);
    if (!r.ok) return null;
    const data  = await r.json();
    const items = data.images || [];
    for (const it of items) {
      const url = it.imageUrl || it.thumbnailUrl;
      if (isUsable(url)) return url;
    }
    return null;
  } catch { return null; }
}

/**
 * Try to find a real image for a given headline. Returns null if nothing works.
 *
 * @param {string} headline
 * @param {string=} sourceHint  Optional source name to add specificity (e.g., "Reuters")
 * @returns {Promise<string|null>}
 */
async function findImage(headline, sourceHint) {
  const key = `${(headline || '').slice(0, 200)}|${sourceHint || ''}`;
  if (cache.has(key)) return cache.get(key);
  if (!headline) { cache.set(key, null); return null; }

  // Build a focused image query
  const q = sourceHint
    ? `${headline} ${sourceHint}`
    : headline;

  // Right now the only image-only provider we wire in is Serper. (Exa images
  // come back attached to the main search results; Tavily images come back
  // in the same response as well.) If Serper isn't configured we just return
  // null and the caller falls through to undraw.
  const img = await serperImage(q);
  cache.set(key, img);
  return img;
}

/**
 * Bulk attach images to a list of items in parallel, capped at maxLookups
 * Serper calls per run so we don't blow through quota.
 */
async function attachImages(items, { maxLookups = 30, sourceField = 'source' } = {}) {
  const need = items.filter(it => it && !it.image && it.headline);
  const slice = need.slice(0, maxLookups);
  await Promise.all(slice.map(async it => {
    const img = await findImage(it.headline, it[sourceField]);
    if (img) it.image = img;
  }));
  return items;
}

module.exports = { findImage, attachImages };
