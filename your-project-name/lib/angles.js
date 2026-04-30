'use strict';

/**
 * Newsletter-first deep-dive angle generator.
 *
 * Used by the digest pipeline to attach { angles[] } to each top_today story.
 * Replaces the standalone topic-clusters.js LLM pass.
 *
 * Design:
 *   1. For each top story, look at its underlying cluster's `excerpt` (verbatim
 *      newsletter passage, attached by clusterer.js) plus `sources[]` count.
 *   2. If the excerpt is substantive (>= 250 chars) AND there are >= 3 sources
 *      OR the excerpt is very rich (>= 450 chars), treat the cluster as
 *      "self-sufficient" — no web search needed.
 *   3. Otherwise, fire one web search (Exa → Serper → Tavily → ...) for that
 *      story to enrich the angle generation context.
 *   4. Once context is gathered for ALL top stories (in parallel), make ONE
 *      batched LLM call that produces 5 angles per story in a single pass.
 *   5. The pipeline calling code attaches `story.angles = result[i]` and the
 *      UI/topic-clusters layer reads from there.
 */

const { _callModel } = require('./digest-generator');
const { search, hasRealSearchProvider } = require('./web-search');

const BAD_DOMAIN = /globenewswire|prnewswire|businesswire|accesswire|notified\.com|einpresswire|prlog/i;
const BAD_IMAGE  = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|profile|placeholder|pixel|tracking|beacon|favicon|sprite/i;

function isGoodImage(imageUrl, sourceUrl) {
  if (!imageUrl) return false;
  if (BAD_IMAGE.test(imageUrl)) return false;
  if (sourceUrl && BAD_DOMAIN.test(sourceUrl)) return false;
  return true;
}

function sourceName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.')[0].replace(/^./, c => c.toUpperCase());
  } catch { return ''; }
}

function cleanText(t) {
  return (t || '')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const ANGLES_BATCH_SYSTEM = `You are a Sequoia-memo style analyst. You receive an array of top news stories with rich source material (newsletter excerpt + optional web articles). For EACH story you must produce exactly 5 distinct angles.

Return ONLY valid JSON — no markdown, no preamble:
{
  "results": [
    {
      "story_index": 0,
      "angles": [
        { "headline": "...", "description": "...", "dimension": "..." },
        { "headline": "...", "description": "...", "dimension": "..." },
        { "headline": "...", "description": "...", "dimension": "..." },
        { "headline": "...", "description": "...", "dimension": "..." },
        { "headline": "...", "description": "...", "dimension": "..." }
      ]
    },
    ...
  ]
}

Required dimensions — each story's 5 angles MUST come from 5 DIFFERENT dimensions below:
- WHAT_HAPPENED: bare facts, names, numbers, dates
- ECONOMIC_IMPACT: market, trade, jobs, prices, GDP consequences
- POLITICAL_REACTION: who said what, who's pushing back, alliances shifting
- WHO_WINS_LOSES: specific named beneficiaries and victims, with why
- HISTORICAL_PARALLEL: prior precedent or pattern this fits
- WHAT_HAPPENS_NEXT: concrete next steps, decision points, deadlines
- HIDDEN_SECOND_ORDER_EFFECT: a non-obvious downstream consequence
- KEY_NUMBER_OR_DATA: the single statistic that captures the story
- COMPETITIVE_READTHROUGH: what this implies for adjacent companies / sectors
- USER_OR_CONSUMER_BEHAVIOUR: how end-user / customer / audience behaviour changes

Voice rules (Sequoia-memo, Stratechery long-form):
- DECLARATIVE. Lead with what happened, the number, the mechanism.
- FACT-DENSE. Every angle headline must be specific — names, figures, countries.
- ONE DEGREE OF SYNTHESIS per angle: the description gives the reader one non-obvious connection.
- Forbidden words: "game-changer", "revolutionary", "stunning", "shocking", "epic", "dramatic", "massive", "unprecedented" (unless literally true), "watershed", "sea change", "paradigm shift", "this could prove", "only time will tell".
- headline: under 90 chars, specific, NOT a rephrase of the parent headline.
- description: exactly 2 sentences, max 220 chars total. Sentence 1: the specific fact / claim. Sentence 2: the synthesis — pattern, comparison, mechanism, or non-obvious consequence.

Critical:
- Output ONE entry per input story, in the same order. story_index matches input position.
- Use the NEWSLETTER_EXCERPT as the primary source. Use WEB_EXCERPTS only to add what the newsletter doesn't cover.
- Do NOT contradict the newsletter excerpt; do NOT invent numbers or quotes.
- If a story's source material genuinely cannot support 5 distinct dimensions, return fewer angles for that one (never duplicate dimensions).`;

function _shouldSkipWebSearch(story) {
  const excerpt = (story.excerpt || '').trim();
  const numSources = Array.isArray(story.sources)
    ? story.sources.length
    : (typeof story.source === 'string' ? story.source.split(',').filter(Boolean).length : 1);
  // Self-sufficient: rich excerpt + plural sources, OR very rich excerpt alone.
  if (excerpt.length >= 450) return true;
  if (excerpt.length >= 250 && numSources >= 3) return true;
  return false;
}

async function _gatherWebContext(story, useInternet) {
  if (!useInternet || !hasRealSearchProvider()) return [];
  try {
    const results = await search(story.headline.slice(0, 100), {
      numResults:   5,
      text:         { maxCharacters: 600 },
      withContents: true,
      category:     'news',
    });
    return Array.isArray(results) ? results : [];
  } catch (e) {
    console.warn(`[angles] web search failed for "${story.headline.slice(0, 50)}":`, e.message);
    return [];
  }
}

function _buildBatchPrompt(stories, contextByIndex) {
  const blocks = stories.map((s, i) => {
    const ctx = contextByIndex[i] || { newsletterExcerpt: '', webResults: [] };
    const webText = (ctx.webResults || [])
      .filter(r => !BAD_DOMAIN.test(r.url || ''))
      .slice(0, 5)
      .map((r, j) => {
        const date = r.publishedDate ? new Date(r.publishedDate).toISOString().slice(0, 10) : 'undated';
        return `  [Web ${j + 1} | ${date}] ${r.title || ''}\n    ${cleanText(r.text || r.snippet).slice(0, 500)}`;
      })
      .join('\n');
    return `[STORY ${i}] ${s.headline}
NEWSLETTER_EXCERPT:
${ctx.newsletterExcerpt || '(no excerpt available — work from the headline and any web excerpts below)'}

WEB_EXCERPTS:
${webText || '(none)'}`;
  }).join('\n\n----------\n\n');
  return `Generate 5 angles for each of the following ${stories.length} stories. Return JSON per the schema in the system prompt.\n\n${blocks}`;
}

function _parseBatchResponse(raw, storiesLen) {
  if (!raw) return null;
  // Try fenced object first, then bare object.
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  let parsed;
  try { parsed = JSON.parse(objMatch[0]); } catch { return null; }
  const results = Array.isArray(parsed.results) ? parsed.results : null;
  if (!results) return null;
  // Build a positional array; each slot defaults to [].
  const out = Array.from({ length: storiesLen }, () => []);
  for (const r of results) {
    const idx = Number(r.story_index);
    if (!Number.isFinite(idx) || idx < 0 || idx >= storiesLen) continue;
    if (!Array.isArray(r.angles)) continue;
    out[idx] = r.angles
      .filter(a => a && a.headline)
      .slice(0, 5)
      .map(a => ({
        headline:    String(a.headline || '').trim().slice(0, 110),
        description: String(a.description || '').trim().slice(0, 240),
        dimension:   String(a.dimension || '').trim(),
      }));
  }
  return out;
}

function _fallbackAngles(story, ctx) {
  const out = [];
  const seen = new Set();
  const push = (headline, description) => {
    const key = (headline || '').toLowerCase().trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      headline:    headline.slice(0, 110),
      description: (description || '').slice(0, 240),
      dimension:   '',
    });
  };
  if (ctx.newsletterExcerpt) {
    push(`${story.headline} — the core update`, ctx.newsletterExcerpt.slice(0, 240));
  }
  for (const r of (ctx.webResults || []).slice(0, 4)) {
    if (!r.title) continue;
    push(r.title, cleanText(r.text || r.snippet).slice(0, 240));
  }
  return out;
}

function _attachSourcesAndImages(story, angles, ctx) {
  const parentSrc = (story.source || '').split(',')[0].trim();
  const parentUrl = story.sourceUrl || story.url || '';
  const imagePool = (ctx.webResults || [])
    .filter(r => isGoodImage(r.image, r.url))
    .map(r => ({ image: r.image, source: sourceName(r.url), sourceUrl: r.url }));
  const usedImages = new Set();
  return angles.map(a => {
    const img = imagePool.find(p => !usedImages.has(p.image));
    if (img) usedImages.add(img.image);
    return {
      headline:       a.headline,
      description:    a.description,
      dimension:      a.dimension,
      source:         img?.source    || parentSrc || '',
      sourceUrl:      img?.sourceUrl || parentUrl || '',
      image:          img?.image     || require('./undraw').pick(a.headline || story.headline || ''),
      internetSource: !!img,
    };
  });
}

/**
 * Attach `angles[]` to each story in `stories` (mutates).
 * Also returns a `topic_clusters[]` shape compatible with the existing UI:
 *   [{ topic, summary, image, stories[] }]
 *
 * @param {Array}  stories      digest.top_today (each with .headline, .source, .excerpt?, .sources[]?)
 * @param {boolean} useInternet  settings.internetFallback
 * @param {string}  model        digestModel
 */
async function buildAnglesForTopStories(stories, useInternet, model) {
  if (!Array.isArray(stories) || !stories.length) return { topic_clusters: [] };
  const top = stories.slice(0, 5); // 5 deep-dive cards is the UI cap

  // 1) Gather context per story in parallel (cluster excerpt → web fallback when thin)
  const contextByIndex = await Promise.all(top.map(async (s, i) => {
    const newsletterExcerpt = (s.excerpt || s.context || s.description || '').slice(0, 1500);
    const skipWeb = _shouldSkipWebSearch(s);
    const webResults = skipWeb ? [] : await _gatherWebContext(s, useInternet);
    console.log(`[angles] story ${i} "${(s.headline || '').slice(0, 60)}" — excerpt: ${newsletterExcerpt.length}c | sources: ${(s.sources || []).length || 1} | webSearched: ${!skipWeb} | webResults: ${webResults.length}`);
    return { newsletterExcerpt, webResults };
  }));

  // 2) ONE batched LLM call across all top stories
  let parsed = null;
  try {
    const prompt = _buildBatchPrompt(top, contextByIndex);
    const raw    = await _callModel(model, prompt, ANGLES_BATCH_SYSTEM);
    parsed = _parseBatchResponse(raw, top.length);
    if (!parsed) console.warn('[angles] batched LLM call returned no parseable JSON. Raw head:', (raw || '').slice(0, 200));
  } catch (e) {
    console.warn('[angles] batched LLM call failed:', e.message);
  }

  // 3) For any story with no LLM angles, fall back to deterministic synthesis
  const finalAngles = top.map((s, i) => {
    const ctx = contextByIndex[i];
    const llmAngles = parsed?.[i] || [];
    const angles = llmAngles.length ? llmAngles : _fallbackAngles(s, ctx);
    return _attachSourcesAndImages(s, angles, ctx);
  });

  // 4) Mutate each top story in place + build topic_clusters[] for UI
  const topic_clusters = top.map((s, i) => {
    const angles = finalAngles[i];
    s.angles = angles;
    return {
      topic:   s.headline,
      summary: contextByIndex[i].newsletterExcerpt.split('\n\n')[0] || '',
      image:   s.image || (contextByIndex[i].webResults.find(r => isGoodImage(r.image, r.url))?.image) || require('./undraw').pick(s.headline),
      stories: angles,
    };
  }).filter(c => c.stories && c.stories.length > 0);

  console.log(`[angles] produced ${topic_clusters.length} deep-dive clusters with ${finalAngles.reduce((n, a) => n + a.length, 0)} total angles`);
  return { topic_clusters };
}

module.exports = { buildAnglesForTopStories };
