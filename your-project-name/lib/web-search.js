'use strict';

/**
 * Shared web-search layer.
 *
 * Primary: Exa (authoritative, structured, with images).
 * Fallback chain (in order):
 *   1. Exa
 *   2. Tavily (if TAVILY_API_KEY is set)
 *   3. Brave Search (if BRAVE_API_KEY is set)
 *   4. LLM "world knowledge" pseudo-search — ask the LLM to produce N recent-ish
 *      article-style JSON results. No real links, but keeps the pipeline alive
 *      when every web source is out of credits.
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

// Treat these as "provider is dead" signals — move on to the next source.
function isProviderFailure(err) {
  if (!err) return false;
  const status = err.status || err.statusCode;
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  if (status && status >= 500 && status < 600) return true;
  const msg = String(err.message || err).toLowerCase();
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

async function searchTavily(query, opts = {}) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY not set');
  const r = await fetch('https://api.tavily.com/search', {
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

async function searchBrave(query, opts = {}) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('BRAVE_API_KEY not set');
  const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=${opts.numResults || 10}&freshness=pd`;
  const r = await fetch(url, { headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' } });
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
async function search(query, opts = {}) {
  const chain = [
    { name: 'exa',    fn: searchExa,    enabled: !!process.env.EXA_API_KEY  },
    { name: 'tavily', fn: searchTavily, enabled: !!process.env.TAVILY_API_KEY },
    { name: 'brave',  fn: searchBrave,  enabled: !!process.env.BRAVE_API_KEY  },
  ];
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
  return !!(process.env.EXA_API_KEY || process.env.TAVILY_API_KEY || process.env.BRAVE_API_KEY);
}

module.exports = { search, searchExa, searchTavily, searchBrave, searchLLM, hasRealSearchProvider, isProviderFailure };
