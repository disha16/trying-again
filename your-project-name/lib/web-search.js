'use strict';

/**
 * Shared web-search layer.
 *
 * Primary: Exa (authoritative, structured, with images).
 * Fallback chain (in order):
 *   1. Exa            (if EXA_API_KEY is set AND user toggle is on)
 *   2. Serper         (if SERPER_API_KEY is set — 2,500 free Google SERP queries on signup)
 *   3. Tavily         (if TAVILY_API_KEY is set)
 *   4. LangSearch     (if LANGSEARCH_API_KEY is set)
 *   5. GDELT          (always; keyless, free, real news with images, ~5s rate limit)
 *   6. Mojeek         (if MOJEEK_API_KEY is set — independent index, small free dev tier)
 *   7. SearXNG        (only if SEARXNG_URL is set — most public instances block bots,
 *                     so this expects a self-hosted instance)
 *   8. Brave Search   (if BRAVE_API_KEY is set)
 *   9. LLM pseudo-search — ask the LLM to produce N recent-ish article-style JSON
 *                     results. No real links, but keeps the pipeline alive.
 *
 * If Exa is OFF (EXA_API_KEY missing OR user toggle off), the chain starts from Serper.
 *
 * All results are normalised to the same shape:
 *   { title, url, publishedDate?, text?, snippet?, image?, source? }
 */

const { _callModel } = require('./digest-generator');

let _exa = null;
function getExa() {
  if (_exa) return _exa;
  const key = process.env.EXA_API_KEY;
  if (!key) return null;
  const Exa = require('exa-js').default;
  _exa = new Exa(key);
  return _exa;
}

// Helper: fetch with a hard timeout — slow providers shouldn't bottleneck the chain.
async function fetchWithTimeout(url, init = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// Treat these as "provider is dead" signals — move on to the next source.
function isProviderFailure(err) {
  if (!err) return false;
  const status = err.status || err.statusCode;
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  if (status && status >= 500 && status < 600) return true;
  const msg = String(err.message || err).toLowerCase();
  if (err.name === 'AbortError' || /aborted|timed?\s*out/.test(msg)) return true;
  return /api.?key|unauthori|forbidden|credits?|quota|insufficient|balance|rate.?limit|overload|unavailable|billing|payment|out of|exhaust/.test(msg);
}

async function searchExa(query, opts = {}) {
  const exa = getExa();
  if (!exa) throw new Error('EXA_API_KEY not set');
  const args = {
    numResults: opts.numResults || 10,
    category:   opts.category   || 'news',
  };
  if (opts.text) args.text = opts.text;
  if (opts.startPublishedDate) args.startPublishedDate = opts.startPublishedDate;
  if (opts.includeDomains)     args.includeDomains     = opts.includeDomains;
  const fn = opts.withContents !== false && opts.text ? 'searchAndContents' : 'search';
  const res = await exa[fn](query, args);
  return (res.results || []).map(r => ({
    title:         r.title,
    url:           r.url,
    publishedDate: r.publishedDate,
    text:          r.text || '',
    snippet:       r.snippet || '',
    image:         r.image || null,
    source:        safeHost(r.url),
  }));
}

async function searchLangSearch(query, opts = {}) {
  const key = process.env.LANGSEARCH_API_KEY;
  if (!key) throw new Error('LANGSEARCH_API_KEY not set');
  // LangSearch supports freshness: oneDay | oneWeek | oneMonth | oneYear | noLimit
  // Map the optional opts.startPublishedDate hint to the closest bucket.
  let freshness = 'noLimit';
  if (opts.startPublishedDate) {
    const ms = Date.now() - new Date(opts.startPublishedDate).getTime();
    if      (ms <= 1.5 * 24 * 3600 * 1000) freshness = 'oneDay';
    else if (ms <=   7 * 24 * 3600 * 1000) freshness = 'oneWeek';
    else if (ms <=  31 * 24 * 3600 * 1000) freshness = 'oneMonth';
    else                                   freshness = 'oneYear';
  }
  const r = await fetchWithTimeout('https://api.langsearch.com/v1/web-search', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      query,
      freshness,
      summary: true,
      count:   Math.min(opts.numResults || 10, 50),
    }),
  });
  if (!r.ok) { const err = new Error(`LangSearch ${r.status}: ${await r.text().catch(() => '')}`); err.status = r.status; throw err; }
  const data = await r.json();
  if (data && data.code && data.code !== 200) { const err = new Error(`LangSearch ${data.code}: ${data.msg || ''}`); err.status = data.code; throw err; }
  const value = data?.data?.webPages?.value || [];
  return value.map(hit => ({
    title:         hit.name,
    url:           hit.url,
    publishedDate: hit.datePublished || hit.dateLastCrawled || null,
    text:          hit.summary || hit.snippet || '',
    snippet:       hit.snippet || hit.summary || '',
    image:         null, // LangSearch web results don't include thumbnails
    source:        safeHost(hit.url),
  }));
}

async function searchTavily(query, opts = {}) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY not set');
  const r = await fetchWithTimeout('https://api.tavily.com/search', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      api_key:        key,
      query,
      max_results:    opts.numResults || 10,
      include_images: true,
      search_depth:   'basic',
      topic:          'news',
      days:           2,
    }),
  });
  if (!r.ok) { const err = new Error(`Tavily ${r.status}: ${await r.text().catch(() => '')}`); err.status = r.status; throw err; }
  const data = await r.json();
  return (data.results || []).map(hit => ({
    title:         hit.title,
    url:           hit.url,
    publishedDate: hit.published_date || null,
    text:          hit.content || '',
    snippet:       hit.content || '',
    image:         (data.images && data.images[0]) || null,
    source:        safeHost(hit.url),
  }));
}

async function searchGDELT(query, opts = {}) {
  // GDELT DOC 2.0 ArtList — keyless, free, global news with social-media images.
  // Polite rate-limit ~ 1 req per 5 seconds; we space digest pre-fetches accordingly.
  // Time bucketing maps to GDELT's `timespan` parameter (in minutes).
  const params = new URLSearchParams({
    query:      query,
    mode:       'ArtList',
    maxrecords: String(opts.numResults || 10),
    format:     'json',
    sort:       'DateDesc',
  });
  if (opts.startPublishedDate) {
    const minsBack = Math.max(60, Math.floor((Date.now() - new Date(opts.startPublishedDate).getTime()) / 60000));
    params.set('timespan', `${minsBack}min`);
  } else {
    // Default to last 7 days for a useful recency signal.
    params.set('timespan', '10080min');
  }
  const r = await fetchWithTimeout(`https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (newsletter-digest)' },
  }, 6000);
  if (!r.ok) { const err = new Error(`GDELT ${r.status}: ${await r.text().catch(() => '')}`); err.status = r.status; throw err; }
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); }
  catch { const err = new Error(`GDELT non-JSON: ${text.slice(0, 120)}`); err.status = 502; throw err; }
  return (data.articles || []).map(a => ({
    title:         a.title,
    url:           a.url,
    publishedDate: a.seendate ? `${a.seendate.slice(0,4)}-${a.seendate.slice(4,6)}-${a.seendate.slice(6,8)}` : null,
    text:          '', // GDELT only returns title; body must come from a fetcher
    snippet:       '',
    image:         a.socialimage || null,
    source:        a.domain ? a.domain.replace(/^www\./,'').split('.')[0] : safeHost(a.url),
  }));
}

async function searchSerper(query, opts = {}) {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error('SERPER_API_KEY not set');
  // Use the news endpoint for fresh, news-flavoured SERP results.
  const r = await fetchWithTimeout('https://google.serper.dev/news', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: opts.numResults || 10 }),
  });
  if (!r.ok) { const err = new Error(`Serper ${r.status}: ${await r.text().catch(() => '')}`); err.status = r.status; throw err; }
  const data = await r.json();
  const items = data.news || data.organic || [];
  return items.slice(0, opts.numResults || 10).map(hit => ({
    title:         hit.title,
    url:           hit.link,
    publishedDate: hit.date || null,
    text:          hit.snippet || '',
    snippet:       hit.snippet || '',
    image:         hit.imageUrl || null,
    source:        hit.source || safeHost(hit.link),
  }));
}

async function searchMojeek(query, opts = {}) {
  const key = process.env.MOJEEK_API_KEY;
  if (!key) throw new Error('MOJEEK_API_KEY not set');
  // Mojeek API endpoint returns JSON when fmt=json.
  const params = new URLSearchParams({
    api_key: key,
    q:       query,
    fmt:     'json',
    t:       String(opts.numResults || 10),
  });
  const r = await fetchWithTimeout(`https://www.mojeek.com/search?${params.toString()}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (newsletter-digest)' },
  });
  if (!r.ok) { const err = new Error(`Mojeek ${r.status}: ${await r.text().catch(() => '')}`); err.status = r.status; throw err; }
  const data = await r.json();
  const results = (data.response && data.response.results) || [];
  return results.slice(0, opts.numResults || 10).map(hit => ({
    title:         hit.title,
    url:           hit.url,
    publishedDate: hit.date || null,
    text:          hit.desc || '',
    snippet:       hit.desc || '',
    image:         null,
    source:        safeHost(hit.url),
  }));
}

async function searchSearXNG(query, opts = {}) {
  // SearXNG is a self-hosted/public meta-search engine — no API key required.
  // Defaults to https://searx.be (a long-running public instance). Override via
  // SEARXNG_URL env var (e.g. https://search.brave4u.com or your own host).
  const base = (process.env.SEARXNG_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('SEARXNG_URL not set');
  const params = new URLSearchParams({
    q:        query,
    format:   'json',
    safesearch: '0',
    language: 'en',
    categories: 'news',
  });
  if (opts.startPublishedDate) {
    const ms = Date.now() - new Date(opts.startPublishedDate).getTime();
    let bucket;
    if      (ms <= 1.5 * 24 * 3600 * 1000) bucket = 'day';
    else if (ms <=   7 * 24 * 3600 * 1000) bucket = 'week';
    else if (ms <=  31 * 24 * 3600 * 1000) bucket = 'month';
    else                                   bucket = 'year';
    params.set('time_range', bucket);
  }
  const r = await fetchWithTimeout(`${base}/search?${params.toString()}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (newsletter-digest)' },
  });
  if (!r.ok) { const err = new Error(`SearXNG ${r.status}: ${await r.text().catch(() => '')}`); err.status = r.status; throw err; }
  let data;
  try { data = await r.json(); }
  catch (e) { const err = new Error(`SearXNG returned non-JSON (instance may have JSON disabled): ${e.message}`); err.status = 502; throw err; }
  const results = (data.results || []).slice(0, opts.numResults || 10);
  return results.map(hit => ({
    title:         hit.title,
    url:           hit.url,
    publishedDate: hit.publishedDate || null,
    text:          hit.content || '',
    snippet:       hit.content || '',
    image:         hit.thumbnail || hit.img_src || null,
    source:        safeHost(hit.url),
  }));
}

async function searchBrave(query, opts = {}) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('BRAVE_API_KEY not set');
  const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=${opts.numResults || 10}&freshness=pd`;
  const r = await fetchWithTimeout(url, { headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' } });
  if (!r.ok) { const err = new Error(`Brave ${r.status}: ${await r.text().catch(() => '')}`); err.status = r.status; throw err; }
  const data = await r.json();
  return ((data.results || [])).map(hit => ({
    title:         hit.title,
    url:           hit.url,
    publishedDate: hit.age || hit.page_age || null,
    text:          hit.description || '',
    snippet:       hit.description || '',
    image:         (hit.thumbnail && hit.thumbnail.src) || null,
    source:        safeHost(hit.url),
  }));
}

// Last-resort pseudo search: ask the LLM to hallucinate N plausible recent
// articles. We DO NOT surface fake URLs to end users — callers should inspect
// .internetSource and treat pseudo hits as "LLM world knowledge" context only.
async function searchLLM(query, opts = {}) {
  const system = `You are a research assistant. You will be given a news topic. Produce JSON listing up to N recent, factual, likely-real news developments. Each entry MUST include a concrete fact (number, name, date). Do NOT fabricate URLs — set url to null.

Return ONLY a valid JSON array:
[{ "title": "...", "url": null, "publishedDate": "2026-04-28", "snippet": "<2 sentences of the actual reported fact>" }]`;
  const n = opts.numResults || 5;
  const prompt = `Topic: "${query}"\nReturn up to ${n} distinct recent developments as JSON.`;
  const raw = await _callModel(opts.model || 'claude-haiku-4-5-20251001', prompt, system);
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let arr;
  try { arr = JSON.parse(match[0]); } catch { return []; }
  return arr.filter(a => a && a.title).map(a => ({
    title:         a.title,
    url:           a.url || null,
    publishedDate: a.publishedDate || null,
    text:          a.snippet || '',
    snippet:       a.snippet || '',
    image:         null,
    source:        'llm',
    llmSourced:    true,
  }));
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; }
  catch { return ''; }
}

// Unified search. Tries providers in order; returns the first non-empty response.
// When opts.useExa is false (or absent and storage.isExaEnabled() returns false),
// Exa is skipped entirely — fall straight to Tavily/Brave/LLM.
async function search(query, opts = {}) {
  let exaAllowed = opts.useExa;
  if (exaAllowed === undefined) {
    try { const storage = require('./storage'); exaAllowed = await storage.isExaEnabled(); }
    catch { exaAllowed = !!process.env.EXA_API_KEY; }
  }
  const chain = [
    { name: 'exa',        fn: searchExa,        enabled: exaAllowed && !!process.env.EXA_API_KEY },
    { name: 'serper',     fn: searchSerper,     enabled: !!process.env.SERPER_API_KEY },
    { name: 'tavily',     fn: searchTavily,     enabled: !!process.env.TAVILY_API_KEY },
    { name: 'langsearch', fn: searchLangSearch, enabled: !!process.env.LANGSEARCH_API_KEY },
    // GDELT is keyless and free — always enabled unless explicitly disabled.
    { name: 'gdelt',      fn: searchGDELT,      enabled: process.env.GDELT_DISABLED !== '1' },
    { name: 'mojeek',     fn: searchMojeek,     enabled: !!process.env.MOJEEK_API_KEY },
    // SearXNG is keyless but most public instances block bot/server traffic.
    // Only enabled when the user supplies their own self-hosted SEARXNG_URL.
    { name: 'searxng',    fn: searchSearXNG,    enabled: !!process.env.SEARXNG_URL && process.env.SEARXNG_URL !== 'disabled' },
    { name: 'brave',      fn: searchBrave,      enabled: !!process.env.BRAVE_API_KEY  },
  ];
  // If Exa is disabled by the user, auto-enable the LLM pseudo-search fallback
  // so callers that relied on Exa still get SOMETHING back.
  if (!exaAllowed && opts.allowLLM === undefined) opts = { ...opts, allowLLM: true };
  let lastErr;
  for (const { name, fn, enabled } of chain) {
    if (!enabled) continue;
    try {
      const results = await fn(query, opts);
      if (results.length) { if (opts.verbose) console.log(`[web-search] ${name}: ${results.length} hits`); return results; }
    } catch (e) {
      lastErr = e;
      if (isProviderFailure(e)) {
        console.warn(`[web-search] ${name} out of service (${e.status || ''}): ${String(e.message).slice(0, 120)} — trying next`);
        continue;
      }
      throw e;
    }
  }
  // LLM fallback (optional — off unless allowLLM is true). This is useful for
  // enrichment/background scenarios, not for user-visible "live web" results.
  if (opts.allowLLM) {
    try {
      const results = await searchLLM(query, opts);
      if (results.length) { console.log(`[web-search] llm-fallback: ${results.length} hits`); return results; }
    } catch (e) { lastErr = e; }
  }
  if (lastErr) console.warn(`[web-search] all providers failed for "${query}": ${lastErr.message}`);
  return [];
}

// Convenience: is any real search provider configured?
function hasRealSearchProvider() {
  // GDELT is keyless and free — we always have at least one provider unless the
  // operator explicitly disables it.
  if (process.env.GDELT_DISABLED !== '1') return true;
  return !!(
    process.env.EXA_API_KEY ||
    process.env.TAVILY_API_KEY ||
    process.env.SERPER_API_KEY ||
    process.env.LANGSEARCH_API_KEY ||
    process.env.MOJEEK_API_KEY ||
    (process.env.SEARXNG_URL && process.env.SEARXNG_URL !== 'disabled') ||
    process.env.BRAVE_API_KEY
  );
}

module.exports = { search, searchExa, searchLangSearch, searchTavily, searchSerper, searchGDELT, searchMojeek, searchSearXNG, searchBrave, searchLLM, hasRealSearchProvider, isProviderFailure };
