'use strict';

/**
 * Helpers that sit between the clusterer and the digest reporter:
 *
 *   1. dropReadSources(clusters, sourceReadState)
 *      For each cluster, remove from `cluster.sources` any source the user has
 *      already read recently (matched by any cluster_keyword overlap). If a
 *      cluster ends up with zero unread sources, drop the whole cluster.
 *
 *   2. topUpFromWeb(clusters, target = 30)
 *      If the cluster count is below `target`, fetch fresh news headlines from
 *      the unified web-search chain (Exa → Serper → Tavily → ...) and append
 *      them as new clusters until we hit the target (or run out of fresh
 *      results). Web-sourced clusters are flagged `internetSource: true` so
 *      downstream code can treat them differently if needed.
 */

function _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').trim(); }

// Reject low-quality image URLs (Google thumbnail proxy, branding chrome, trackers).
// Mirrors the regex in image-fallback.js / internet-fallback.js so the whole
// pipeline applies the same filter.
const BAD_IMAGE = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|profile|placeholder|pixel|tracking|beacon|favicon|sprite|encrypted-tbn|gstatic\.com/i;
function _filterImage(url) {
  if (!url || typeof url !== 'string') return null;
  if (!/^https?:\/\//.test(url)) return null;
  if (BAD_IMAGE.test(url)) return null;
  return url;
}

function dropReadSources(clusters, sourceReadState) {
  if (!Array.isArray(clusters) || !clusters.length) return clusters || [];
  if (!sourceReadState || typeof sourceReadState !== 'object') return clusters;

  // Build a quick lookup: for each cluster keyword, the Set of read sources.
  // sourceReadState shape: { keyword → Set<source> }
  const byKw = sourceReadState;
  let droppedClusters = 0;
  let droppedSources  = 0;

  const surviving = [];
  for (const c of clusters) {
    const sources  = Array.isArray(c.sources) ? [...c.sources] : [];
    const keywords = Array.isArray(c.keywords) ? c.keywords : [];

    // Union of all sources read for any of this cluster's keywords
    const readSrc = new Set();
    for (const kw of keywords) {
      const set = byKw[kw];
      if (set && typeof set.forEach === 'function') {
        set.forEach(s => readSrc.add(_norm(s)));
      } else if (Array.isArray(set)) {
        set.forEach(s => readSrc.add(_norm(s)));
      }
    }

    const fresh = sources.filter(s => !readSrc.has(_norm(s)));
    droppedSources += (sources.length - fresh.length);

    if (fresh.length === 0) {
      droppedClusters++;
      continue;   // every source already read — drop the whole cluster
    }
    surviving.push({ ...c, sources: fresh });
  }

  if (droppedSources || droppedClusters) {
    console.log(`[dedupe] dropped ${droppedSources} read-source listings; ${droppedClusters} clusters fully read → removed (${surviving.length}/${clusters.length} clusters survived)`);
  }
  return surviving;
}

/**
 * Top up the cluster pool from the web until we have at least `target`
 * clusters. Skips silently if no real web-search provider is configured or if
 * we already have enough clusters.
 *
 * Queries are intentionally broad ("top business news today", etc.) so we
 * grab a healthy spread across categories.
 */
async function topUpFromWeb(clusters, { target = 30, model = 'qwen-plus' } = {}) {
  if (!Array.isArray(clusters)) return clusters || [];
  const need = target - clusters.length;
  if (need <= 0) return clusters;

  let search, hasRealSearchProvider;
  try {
    ({ search, hasRealSearchProvider } = require('./web-search'));
  } catch (e) {
    console.warn('[topup] web-search unavailable:', e.message);
    return clusters;
  }
  if (!hasRealSearchProvider || !hasRealSearchProvider()) {
    console.warn('[topup] no real web-search provider — skipping');
    return clusters;
  }

  const QUERIES = [
    { q: 'top business news today',          keywords: ['business'] },
    { q: 'top tech news today',              keywords: ['tech'] },
    { q: 'top US politics news today',       keywords: ['politics'] },
    { q: 'top world economy news today',     keywords: ['economy', 'global'] },
    { q: 'top US stock market news today',   keywords: ['markets', 'us-business'] },
    { q: 'top India business news today',    keywords: ['india', 'business'] },
    { q: 'top AI news today',                keywords: ['ai', 'tech'] },
    { q: 'top financial markets news today', keywords: ['markets', 'finance'] },
  ];

  const seenTitles = new Set(clusters.map(c => _norm(c.headline)));
  const fresh = [];

  // Run queries serially so we can stop once we have enough.
  for (const { q, keywords } of QUERIES) {
    if (fresh.length >= need) break;
    let results = [];
    try {
      results = await search(q, { numResults: 8 });
    } catch (e) {
      console.warn(`[topup] search "${q}" failed: ${e.message}`);
      continue;
    }
    for (const r of results) {
      if (fresh.length >= need) break;
      const title = (r.title || '').trim();
      if (!title) continue;
      const key = _norm(title);
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);

      // Synthesize a cluster row in the same shape the clusterer produces.
      const sourceName = r.source || (r.url ? (() => { try { return new URL(r.url).hostname.replace(/^www\./,'').split('.')[0]; } catch { return 'web'; } })() : 'web');
      fresh.push({
        headline:        title.slice(0, 120),
        sources:         [sourceName],
        keywords:        keywords,
        image:           _filterImage(r.image),
        sourceUrl:       r.url || '',
        snippet:         (r.text || r.snippet || '').slice(0, 400),
        internetSource:  true,
      });
    }
  }

  if (fresh.length) {
    console.log(`[topup] added ${fresh.length} web clusters (target: ${target}, was ${clusters.length}, now ${clusters.length + fresh.length})`);
  } else {
    console.log(`[topup] no fresh web clusters added (had ${clusters.length}, target ${target})`);
  }
  return [...clusters, ...fresh];
}

module.exports = { dropReadSources, topUpFromWeb };
