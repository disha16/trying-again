'use strict';

const Exa            = require('exa-js').default;
const { _callModel } = require('./digest-generator');

// Image URL must look like it contains a chart/graph/data-viz — not a news photo
const CHART_IMG_PATTERNS = /chart|graph|figure|plot|infographic|statistic|viz|data[\-_]|trend[\-_]/i;

// These domains are trusted sources of actual data charts
const CHART_DOMAINS = [
  'ourworldindata.org', 'statista.com', 'visualcapitalist.com',
  'tradingeconomics.com', 'macrotrends.net',
];

const BAD_IMAGE = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|promo|newsletter|header|footer|icon|avatar|placeholder|pixel|tracking|beacon/i;

function isGoodImage(imageUrl, sourceUrl) {
  if (!imageUrl) return false;
  if (BAD_IMAGE.test(imageUrl)) return false;

  // Trusted chart-specialist domains — accept any image
  try {
    const domain = new URL(sourceUrl || '').hostname.replace(/^www\./, '');
    if (CHART_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return true;
  } catch {}

  // For general news sites, only accept if the image URL itself suggests a chart
  return CHART_IMG_PATTERNS.test(imageUrl);
}

function sourceName(url) {
  try {
    const host  = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    const label = parts.length > 2 ? parts[1] : parts[0];
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch { return url; }
}

const GATE_SYSTEM = `You are a ruthless gatekeeper for a "Charts of the Day" section.

APPROVE only if ALL of these are true:
1. The story describes something genuinely chartable: a specific % change, price level, ranking, trend over time, or statistical comparison — with real numbers.
2. The image is almost certainly an actual chart, graph, or data visualisation — NOT a news photo of a person, building, product, commodity, protest, etc.
3. It is not a promotional teaser, paywall pitch, or platform ad.

REJECT anything where:
- The image looks like a news photograph (a gold scoop, a politician, a factory, etc.)
- There are no specific numbers or data points in the description
- It is vague ("markets moved", "prices rose") without hard figures

Return ONLY valid JSON — no markdown:
[{ "index": 0, "description": "Sentence 1: the exact data point (include numbers). Sentence 2: why it matters." }]

Include only approved items. If nothing qualifies, return [].`;

async function fetchChartsOfDay(topHeadlines, seenUrls = new Set(), model = 'llama-3.3-70b-versatile') {
  try {
    const storage = require('./storage');
    if (!(await storage.isExaEnabled())) { console.log('[charts] useExa=false — skipping'); return []; }
  } catch {}
  if (!process.env.EXA_API_KEY) return [];

  const exa = new Exa(process.env.EXA_API_KEY);

  // Search specifically for chart/data content
  const queries = [
    'economic data chart graph statistics 2026 site:ourworldindata.org OR site:visualcapitalist.com OR site:statista.com',
    'markets data chart today 2026 GDP inflation tariffs',
    'data visualization chart infographic 2026',
  ];

  const candidates = [];
  const usedUrls   = new Set(seenUrls);

  for (const query of queries) {
    if (candidates.length >= 9) break;
    try {
      const res = await exa.searchAndContents(query, {
        numResults: 6,
        text:       { maxCharacters: 500 },
      });
      for (const r of res.results) {
        if (candidates.length >= 9) break;
        if (usedUrls.has(r.url)) continue;
        if (!r.image) continue;
        if (!isGoodImage(r.image, r.url)) continue;
        usedUrls.add(r.url);
        candidates.push({
          headline:    (r.title || '').trim().slice(0, 100),
          description: (r.text || '').replace(/\s+/g, ' ').trim().slice(0, 400),
          image:       r.image,
          imageUrl:    r.image,   // passed to LLM for inspection
          source:      sourceName(r.url),
          sourceUrl:   r.url,
        });
      }
    } catch (e) {
      console.warn(`[charts] Exa failed:`, e.message);
    }
  }

  if (!candidates.length) return [];
  console.log(`[charts] ${candidates.length} candidates — running LLM gate`);

  const prompt = candidates.map((c, i) =>
    `[${i}] HEADLINE: ${c.headline}\nDESCRIPTION: ${c.description}\nIMAGE URL: ${c.imageUrl}\nSOURCE: ${c.source}`
  ).join('\n\n---\n\n');

  try {
    const raw   = await _callModel(model, `Review these ${candidates.length} chart candidates:\n\n${prompt}`, GATE_SYSTEM);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) { console.log('[charts] LLM returned no JSON — 0 approved'); return []; }

    const results = JSON.parse(match[0]);
    const approved = results
      .filter(r => typeof r.index === 'number' && r.index >= 0 && r.index < candidates.length)
      .map(r => ({ ...candidates[r.index], description: r.description || candidates[r.index].description }))
      .slice(0, 3);

    console.log(`[charts] ${approved.length} approved after LLM gate`);
    return approved;
  } catch (e) {
    console.warn('[charts] LLM gate failed:', e.message);
    return []; // fail closed — never show unapproved content
  }
}

module.exports = { fetchChartsOfDay };
