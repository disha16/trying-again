'use strict';

const { _callModel } = require('./digest-generator');

const JUDGE_SYSTEM = `You are a news editor reviewing search results to decide which ones are real, individual news articles vs garbage (homepage banners, section index pages, navigation lists, sponsor pages, login walls, calendar/program-listing pages).

You will receive a numbered list of candidates with title and description. For each, return a verdict.

A REAL ARTICLE is about ONE specific event, story, or development. It has a coherent narrative or single subject.

JUNK includes:
- Homepage / section landing pages ("Breaking News | Site Name", "Latest News - Site")
- Navigation / index pages (descriptions full of "next page of results", "show: all posts", pipe-separated category lists)
- Generic standing trackers without a specific story (e.g. raw data dashboards, "live updates" pages with no specific event)
- TV listings, program guides, calendar pages
- Login pages, paywalls without article preview, login-required content
- Vague "what to know" pages that aren't tied to a current event
- Aggregator landing pages

Return ONLY a valid JSON array with one entry per candidate, in order:
[{ "i": 1, "verdict": "article" | "junk", "reason": "<6 words max>" }, ...]`;

async function judgeCandidates(candidates, model) {
  if (!candidates.length) return candidates.map(() => true);
  const list = candidates
    .map((c, i) => `[${i + 1}] TITLE: ${c.headline}\nDESC: ${(c.description || '').slice(0, 200)}`)
    .join('\n\n');
  const prompt = `Classify each candidate as "article" or "junk":\n\n${list}`;
  let raw;
  try {
    raw = await _callModel(model, prompt, JUDGE_SYSTEM);
  } catch (e) {
    console.warn('[internet-fallback] judge call failed, accepting all:', e.message);
    return candidates.map(() => true);
  }
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return candidates.map(() => true);
  let verdicts;
  try { verdicts = JSON.parse(match[0]); } catch { return candidates.map(() => true); }
  // Build a verdict map by index
  const keep = candidates.map(() => true);
  for (const v of verdicts) {
    if (typeof v.i === 'number' && v.i >= 1 && v.i <= candidates.length) {
      keep[v.i - 1] = v.verdict === 'article';
    }
  }
  return keep;
}

const CATEGORY_QUERIES = {
  top_today:        'biggest breaking news today major outlets',
  tech:             'technology AI software startup news today',
  us_business:      'US business economy Wall Street corporate earnings news today',
  india_business:   'India business economy Sensex startup Nifty news today',
  global_economies: 'global economy international trade central bank emerging markets news today',
  politics:         'politics government policy elections news today',
  everything_else:  'top world news today',
};

const MIN_ITEMS = 10;

const BAD_IMAGE = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|profile|placeholder|pixel|tracking|beacon/i;
// PR wire services only — not government/official sources like PIB
const BAD_DOMAIN = /globenewswire|prnewswire|businesswire|accesswire|notified\.com|einpresswire|prlog|send2press|openpr|food|recipe|cook|lifestyle|wellness|fitness/i;

function isBadSource(url) {
  if (!url) return true;
  if (BAD_DOMAIN.test(url)) return true;
  // Reject homepages / section landing pages — they're not articles
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, ''); // strip trailing slashes
    if (path === '' || path === '/') return true;
    // Section pages like /news, /world, /business with no article slug
    if (/^\/(news|world|business|politics|tech|markets|sports)\/?$/i.test(path)) return true;
  } catch { /* ignore parse failures */ }
  return false;
}

// Reject titles that are obviously site banners / index pages
function isHomepageTitle(title) {
  if (!title) return true;
  const t = title.toLowerCase().trim();
  // "Breaking News | <Site>" / "<Site> | Breaking News, Latest News..."
  if (/^(breaking news|latest news|top stories|headlines|home)\s*[|–\-:]/i.test(t)) return true;
  if (/[|–\-:]\s*(breaking news|latest news|top stories|headlines|home page|homepage)\b/i.test(t)) return true;
  // "<Site>: Breaking News, Latest..." / "<Site> - Breaking News, top stories"
  if (/^[\w\s.&|'\-]{0,40}[:|–\-]\s*(breaking news|latest news|top stories|headlines|video reports|news, weather|news \&|breaking headlines)/i.test(title)) return true;
  // Tagline phrases that appear in site banners
  if (/(the web's best|web's best|breaking international|news, top stories & today|breaking headlines and video|comprehensive up-to-date|breaking news, latest|news \| video|news \| analysis)/i.test(t)) return true;
  return false;
}

// Reject if the description looks like site nav / index page content rather than an article
function isJunkDescription(desc) {
  if (!desc) return false;          // empty desc isn't necessarily junk
  const d = desc.toLowerCase();
  // Pagination & section-list giveaways
  if (/next page of results|previous page|show:\s*(all|posts|topics)|all posts\s*\|/i.test(d)) return true;
  if (/rants\s*&\s*reviews\|.*interviews\|/i.test(d)) return true;
  if (/click here to|sign up for|subscribe to (our|the)|browse by|jump to (section|category)/i.test(d)) return true;
  // Long pipe-separated nav lists ("foo | bar | baz | qux")
  if ((d.match(/\s\|\s/g) || []).length >= 3) return true;
  return false;
}

// Reputable news outlets allowed for top_today fallback
const NEWS_OUTLET_DOMAINS = [
  'reuters.com','apnews.com','bloomberg.com','wsj.com','nytimes.com','ft.com',
  'theguardian.com','washingtonpost.com','bbc.com','bbc.co.uk','cnn.com','nbcnews.com',
  'cbsnews.com','abcnews.go.com','axios.com','politico.com','economist.com',
  'aljazeera.com','npr.org','cnbc.com','foxnews.com','time.com','theatlantic.com',
  'thehindu.com','indianexpress.com','hindustantimes.com','livemint.com','business-standard.com',
  'moneycontrol.com','economictimes.indiatimes.com','timesofindia.indiatimes.com',
];

// Strip markdown artifacts, ticker noise, and press release boilerplate from text
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/#{1,6}\s*/g, '')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/SENSEX[\d\s.,+\-#]+/gi, '')
    .replace(/NIFTY[\d\s.,+\-#]+/gi, '')
    .replace(/CRUDEOIL[\d\s.,+\-#]+/gi, '')
    .replace(/Ministry of \w[\w\s&]+ \d{1,2}[-–]\w+,?\s*\d{4}\s*\d{1,2}:\d{2}\s*IST/gi, '') // strip "Ministry of X 16-March, 2026 15:54 IST"
    .replace(/Press Information Bureau[^.]*\./gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 220);
}

// Clean up a headline that reads like a press release title
function cleanHeadline(title) {
  if (!title) return '';
  return title
    .replace(/^English Releases?\s*/i, '')     // "English Releases Ministry of..."
    .replace(/^Press Release[:\s]*/i, '')
    .replace(/^PIB[:\s]*/i, '')
    .trim()
    .slice(0, 120);
}

function pickImage(r) {
  if (!r.image) return null;
  if (BAD_IMAGE.test(r.image)) return null;
  if (r.url && BAD_DOMAIN.test(r.url)) return null;
  return r.image;
}

function sourceName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const label = host.split('.')[0];
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch { return url; }
}

async function applyInternetFallback(digest, customSections = [], model = 'qwen-plus') {
  // Use the unified search layer so we get the full provider chain
  // (Exa → LangSearch → Tavily → Brave) with one call. This automatically
  // respects the user's Exa toggle and any provider keys present.
  const { search, hasRealSearchProvider } = require('./web-search');
  if (!hasRealSearchProvider()) {
    console.warn('[internet-fallback] no real web-search provider configured — skipping');
    return;
  }
  async function searchProvider(query, opts = {}) {
    const results = await search(query, {
      numResults:         opts.numResults,
      category:           opts.category,
      startPublishedDate: opts.startPublishedDate,
      includeDomains:     opts.includeDomains,
      // The fallback flow tolerates LangSearch-style results (no images, etc.)
      allowLLM:           false,
    });
    return { results: (results || []).map(r => ({
      title:         r.title,
      url:           r.url,
      snippet:       r.snippet,
      text:          r.text,
      image:         r.image,
      publishedDate: r.publishedDate,
    })) };
  }
  const CATS = ['top_today', 'tech', 'us_business', 'india_business', 'global_economies', 'politics', 'everything_else'];

  // Add custom sections with auto-generated queries (use description if present
  // for sharper Tavily targeting; otherwise fall back to label).
  const customQueries = {};
  for (const s of (customSections || [])) {
    if (!CATS.includes(s.id)) {
      CATS.push(s.id);
      const desc = (s.description || '').trim();
      customQueries[s.id] = desc
        ? `${s.label.toLowerCase()} news — ${desc}`
        : `${s.label.toLowerCase()} news today`;
    }
  }
  const QUERIES = { ...CATEGORY_QUERIES, ...customQueries };

  // Tokenize a headline into meaningful words (drop stopwords + short words)
  const STOPWORDS = new Set(['the','a','an','of','to','in','on','and','or','for','at','by','with','from','as','is','are','was','were','be','been','will','would','can','says','said','after','before','over','out','up','down','new','this','that','these','those','it','its','his','her','their','about','amid','into','than','then']);
  const tokenize = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w));

  // Build a list of token-sets for already-covered topics so we can detect
  // semantic overlap, not just exact headline matches.
  const seen = new Set();              // exact-headline dedup
  const seenTokenSets = [];            // token-set similarity dedup
  for (const cat of CATS) {
    for (const item of (digest[cat] || [])) {
      const h = (item.headline || '').toLowerCase().trim();
      seen.add(h);
      seenTokenSets.push(new Set(tokenize(h)));
    }
  }

  // True if at least N significant tokens overlap with any already-covered topic
  const isTopicCovered = (headline) => {
    const toks = new Set(tokenize(headline));
    if (toks.size < 2) return false;
    for (const set of seenTokenSets) {
      let overlap = 0;
      for (const t of toks) if (set.has(t)) overlap++;
      // ≥3 shared tokens, OR ≥50% of the smaller set
      const minSize = Math.min(toks.size, set.size);
      if (overlap >= 3 || (minSize > 0 && overlap / minSize >= 0.5)) return true;
    }
    return false;
  };

  let totalAdded = 0;

  await Promise.all(CATS.map(async cat => {
    const existing = digest[cat] || [];
    const needed   = MIN_ITEMS - existing.length;
    if (needed <= 0) return;

    const query = QUERIES[cat];
    // top_today specifically: only fetch from the last 48 hours so it's actually breaking news,
    // and restrict to real news outlets so we don't get TheFutonCritic-style index pages.
    const startPublishedDate = cat === 'top_today'
      ? new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      : undefined;
    const includeDomains = cat === 'top_today' ? NEWS_OUTLET_DOMAINS : undefined;
    try {
      const res = await searchProvider(query, {
        numResults: Math.max(needed * 4, 25),
        category:   'news',
        ...(startPublishedDate ? { startPublishedDate } : {}),
        ...(includeDomains    ? { includeDomains }    : {}),
      });
      // Sort newest-first so we get the freshest articles first
      const sorted = [...res.results].sort((a, b) => {
        const da = a.publishedDate ? new Date(a.publishedDate).getTime() : 0;
        const db = b.publishedDate ? new Date(b.publishedDate).getTime() : 0;
        return db - da;
      });
      // First pass: build a candidate list using rule-based filters
      const candidates = [];
      for (const r of sorted) {
        if (candidates.length >= needed * 3) break; // gather extras for the LLM judge
        if (isBadSource(r.url)) continue;
        const headline = cleanHeadline(r.title || '');
        if (!headline) continue;
        if (isHomepageTitle(headline)) continue;
        const rawDesc = r.snippet || r.text || '';
        if (isJunkDescription(rawDesc)) continue;
        const lc = headline.toLowerCase();
        if (seen.has(lc)) continue;
        if (isTopicCovered(headline)) continue;

        candidates.push({
          headline,
          description:    cleanText(rawDesc),
          source:         sourceName(r.url),
          sourceUrl:      r.url,
          image:          pickImage(r),
          keywords:       [],
          internetSource: true,
          _lcKey:         lc,
        });
      }

      // Second pass: LLM judge filters out homepage/junk/aggregator pages that rule-based filters miss
      const verdicts = await judgeCandidates(candidates, model);
      const added = [];
      for (let i = 0; i < candidates.length && added.length < needed; i++) {
        if (!verdicts[i]) continue;
        const c = candidates[i];
        seen.add(c._lcKey);
        seenTokenSets.push(new Set(tokenize(c._lcKey)));
        delete c._lcKey;
        added.push(c);
      }

      if (added.length) {
        digest[cat] = [...existing, ...added];
        totalAdded += added.length;
        const rejected = candidates.length - added.length;
        console.log(`[internet-fallback] ${cat}: added ${added.length} (judge rejected ${rejected})`);
      }
    } catch (e) {
      console.warn(`[internet-fallback] ${cat}:`, e.message);
    }
  }));

  console.log(`[internet-fallback] total added: ${totalAdded}`);
}

module.exports = { applyInternetFallback };
