'use strict';

const Exa            = require('exa-js').default;
const { _callModel } = require('./digest-generator');

const BAD_IMAGE  = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|profile|placeholder|pixel|tracking|beacon/i;
const BAD_DOMAIN = /globenewswire|prnewswire|businesswire|accesswire|notified\.com|einpresswire|prlog|food|recipe|cook|lifestyle|wellness|fitness/i;

function isGoodImage(imageUrl, sourceUrl) {
  if (!imageUrl) return false;
  if (BAD_IMAGE.test(imageUrl)) return false;
  if (sourceUrl && BAD_DOMAIN.test(sourceUrl)) return false;
  return true;
}

function isBadSource(url) {
  if (!url) return true;
  return BAD_DOMAIN.test(url);
}

function sourceName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.')[0].replace(/^./, c => c.toUpperCase());
  } catch { return url; }
}

// Step 1: Ask Exa what the biggest breaking stories are from major outlets today
const IDENTIFY_SYSTEM = `You are a senior editor at a world-class newspaper. Given a list of recent headlines from major publications (Guardian, FT, WSJ, NYT, Reuters, Bloomberg), pick the 5 most important, genuinely breaking stories of the day.

Rules:
- Pick stories that are BIG — geopolitical events, wars, major elections, market shocks, landmark policy decisions, major crimes or disasters
- Do NOT pick evergreen features, opinion pieces, or routine earnings reports
- Each story must be a distinct event — no two entries about the same underlying situation
- CRITICAL: Use the EXACT headline string from the numbered list provided. Do NOT abbreviate, rewrite, invent, or embellish. Copy it verbatim.
- For each story, generate a 5-7 word search query to find multiple angles on that same event

Return ONLY valid JSON — no markdown:
[
  { "topic": "<EXACT headline copied from the list>", "query": "5-7 word search query for angles" },
  ...
]`;

async function identifyBigStories(exa, model) {
  // Search major outlets for today's top coverage
  let allResults = [];
  const searches = [
    'site:theguardian.com OR site:ft.com top news today',
    'site:wsj.com OR site:nytimes.com breaking news today',
    'site:reuters.com OR site:bloomberg.com top story today',
  ];

  for (const q of searches) {
    try {
      const res = await exa.search(q, { numResults: 12, category: 'news' });
      allResults = allResults.concat(res.results || []);
    } catch (e) {
      console.warn('[topic-clusters] Exa identify search failed:', e.message);
    }
  }

  if (!allResults.length) return [];

  // Sort newest-first so the LLM picks from current articles, not stale indexed ones
  allResults.sort((a, b) => {
    const da = a.publishedDate ? new Date(a.publishedDate).getTime() : 0;
    const db = b.publishedDate ? new Date(b.publishedDate).getTime() : 0;
    return db - da;
  });

  // Deduplicate and filter press-release sites before sending to LLM
  const seen = new Set();
  const unique = allResults.filter(r => {
    if (!r.title) return false;
    if (isBadSource(r.url)) return false;
    const key = r.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!unique.length) return [];

  // Only consider the 30 most recent unique results (already date-sorted above)
  const recent = unique.slice(0, 30);
  const headlineList = recent
    .map((r, i) => {
      const date = r.publishedDate ? new Date(r.publishedDate).toISOString().slice(0, 10) : 'undated';
      return `[${i + 1}] (${date}) ${r.title}`;
    })
    .join('\n');

  const prompt = `Here are recent headlines from major publications, sorted newest first. Each is tagged with its publish date.

${headlineList}

Pick the 5 biggest breaking stories from THE MOST RECENT entries (top of the list). Reject any headline more than 30 days older than the freshest one in the list. Copy the exact headline string from the numbered list — do not rewrite or abbreviate.`;

  let raw;
  try {
    raw = await _callModel(model, prompt, IDENTIFY_SYSTEM);
  } catch (e) {
    console.warn('[topic-clusters] Story identification LLM failed:', e.message);
    return [];
  }

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try { return JSON.parse(match[0]); } catch { return []; }
}

const ANGLES_SYSTEM = `You are a sharp news analyst. Given a topic headline and excerpts from multiple articles, identify exactly 5 genuinely distinct, insightful angles on this story. Each angle must teach the reader something different.

Return ONLY valid JSON — no markdown:
[
  { "headline": "...", "description": "...", "imageHint": "...", "dimension": "..." },
  ...
]

Required dimensions — each angle MUST be drawn from a DIFFERENT one of these (pick 5 different dimensions):
- WHAT_HAPPENED: the bare facts, names, numbers, dates
- ECONOMIC_IMPACT: market, trade, jobs, prices, GDP consequences
- POLITICAL_REACTION: who said what, who's pushing back, alliances shifting
- WHO_WINS_LOSES: specific named beneficiaries and victims, with why
- HISTORICAL_PARALLEL: prior precedent or pattern this fits
- WHAT_HAPPENS_NEXT: concrete next steps, decision points, deadlines
- HIDDEN_SECOND_ORDER_EFFECT: a non-obvious downstream consequence
- KEY_NUMBER_OR_DATA: the single statistic that captures the story

Rules:
- Return EXACTLY 5 entries unless the source articles truly cannot support 5 distinct dimensions (then return fewer — never repeat).
- The 5 entries MUST come from 5 DIFFERENT dimensions above. Tag the dimension you used in the "dimension" field.
- DO NOT use the same fact in two angles. Each must add something new.
- headline: under 90 chars, specific — include names, figures, countries. NOT a rephrasing of the parent topic.
- description: exactly 2 sentences, max 200 chars total. Sentence 1: the specific fact / insight. Sentence 2: why it matters or what changes.
- imageHint: 2-3 words describing what a good photo for this angle would look like.`;

async function fetchAndDistillSubStories(exa, model, topic, query) {
  const searchQuery = query || topic.slice(0, 80);

  let results = [];
  try {
    const res = await exa.searchAndContents(searchQuery, {
      numResults: 20,
      category:   'news',
      text:       { maxCharacters: 800 },
    });
    results = res.results;
  } catch (e) {
    console.warn(`[topic-clusters] Exa failed for "${topic.slice(0, 50)}":`, e.message);
    return [];
  }

  // Filter out press release sites before anything else
  results = results.filter(r => !isBadSource(r.url));
  if (!results.length) return [];

  // Sort newest-first and keep only the most recent 12
  results.sort((a, b) => {
    const da = a.publishedDate ? new Date(a.publishedDate).getTime() : 0;
    const db = b.publishedDate ? new Date(b.publishedDate).getTime() : 0;
    return db - da;
  });
  results = results.slice(0, 12);

  const imagePool = results
    .filter(r => isGoodImage(r.image, r.url))
    .map(r => ({ image: r.image, source: sourceName(r.url), sourceUrl: r.url }));

  // Clean scraped text of markdown/ticker artifacts
  const cleanText = t => (t || '').replace(/#{1,6}\s*/g, '').replace(/SENSEX[\d\s.,+\-#]+/gi, '').replace(/NIFTY[\d\s.,+\-#]+/gi, '').replace(/\s{2,}/g, ' ').trim();

  const excerpts = results
    .map((r, i) => {
      const date = r.publishedDate ? new Date(r.publishedDate).toISOString().slice(0, 10) : 'undated';
      return `[Article ${i + 1} | published ${date}] ${r.title || ''}\n${cleanText(r.text).slice(0, 700)}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 10000);

  const prompt = `Topic: "${topic}"\n\nArticles below are sorted newest-first. Prefer angles drawn from the freshest articles. Skip any article more than 30 days older than the freshest one in the list.\n\n${excerpts}`;

  let raw;
  try {
    raw = await _callModel(model, prompt, ANGLES_SYSTEM);
  } catch (e) {
    console.warn(`[topic-clusters] LLM failed for "${topic.slice(0, 50)}":`, e.message);
    return [];
  }

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];

  let angles;
  try { angles = JSON.parse(match[0]); } catch { return []; }

  const usedImages = new Set();
  return angles.slice(0, 5).map(a => {
    const img = imagePool.find(p => !usedImages.has(p.image));
    if (img) usedImages.add(img.image);
    return {
      headline:       (a.headline || '').trim().slice(0, 110),
      description:    (a.description || '').trim().slice(0, 220),
      source:         img?.source  || sourceName(results[0]?.url || ''),
      sourceUrl:      img?.sourceUrl || results[0]?.url || '',
      image:          img?.image   || null,
      internetSource: true,
    };
  }).filter(a => a.headline);
}

async function buildTopicClusters(digest, useInternet, model = 'llama-3.3-70b-versatile') {
  if (!useInternet || !process.env.EXA_API_KEY) {
    // Fallback: use top_today stories as cluster topics (no internet)
    return (digest.top_today || []).slice(0, 5).map(s => ({
      topic:   s.headline,
      summary: s.description || '',
      image:   s.image || null,
      stories: [],
    }));
  }

  const exa = new Exa(process.env.EXA_API_KEY);

  // First identify the real big stories of the day from major outlets
  console.log('[topic-clusters] Identifying big stories from major outlets…');
  const bigStories = await identifyBigStories(exa, model);

  let clusters;
  if (bigStories.length >= 3) {
    clusters = bigStories.slice(0, 5).map(s => ({
      topic:   s.topic,
      query:   s.query,
      summary: '',
      image:   null,
      stories: [],
    }));
    console.log(`[topic-clusters] ${clusters.length} major stories identified from outlets`);
  } else {
    // Fallback to top_today if outlet search fails
    console.log('[topic-clusters] Outlet search failed, falling back to top_today');
    clusters = (digest.top_today || []).slice(0, 5).map(s => ({
      topic:   s.headline,
      query:   s.headline.slice(0, 60),
      summary: s.description || '',
      image:   s.image || null,
      stories: [],
    }));
  }

  // Fetch sub-angles for all clusters in parallel.
  // If a cluster's primary query returns no angles, retry with a simpler topic-only query.
  await Promise.all(clusters.map(async c => {
    c.stories = await fetchAndDistillSubStories(exa, model, c.topic, c.query);
    if (!c.stories.length && c.query !== c.topic) {
      // Retry without the LLM-suggested query — fall back to the topic itself
      c.stories = await fetchAndDistillSubStories(exa, model, c.topic, c.topic.slice(0, 80));
    }
    console.log(`[topic-clusters] "${c.topic.slice(0, 50)}" → ${c.stories.length} angles`);
  }));

  // Drop clusters that came up completely empty so the UI never shows "no results"
  const nonEmpty = clusters.filter(c => c.stories && c.stories.length > 0);
  // If everything failed, fall back to top_today summaries (so deep dives still appears)
  if (!nonEmpty.length) {
    return (digest.top_today || []).slice(0, 5).map(s => ({
      topic:   s.headline,
      summary: s.description || '',
      image:   s.image || null,
      stories: [],
    }));
  }
  return nonEmpty.slice(0, 5);
}

module.exports = { buildTopicClusters };
