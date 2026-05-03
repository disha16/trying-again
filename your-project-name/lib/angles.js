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
const BAD_IMAGE  = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|profile|placeholder|pixel|tracking|beacon|favicon|sprite|encrypted-tbn|gstatic\.com/i;

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

const ANGLES_BATCH_SYSTEM = `You are a Sequoia-memo / Stratechery analyst writing the 'Deep Dive' section of a daily intelligence brief for senior investors.

You receive an array of top news stories. For EACH story produce 2-5 distinct angles. PREFER FEWER, BETTER ANGLES OVER MORE, WEAKER ANGLES.

!!! HARD RULE — PARAPHRASE TEST !!!
If two of your angles for the same story can be summarised in the SAME 5-word sentence, they are paraphrases and you MUST drop one. Different angles must answer DIFFERENT QUESTIONS about the news. They are not 'five ways to say the same thing'.

GOOD example for a story 'Google in talks with Marvell to build new AI inference chips':
  Angle 1 (KEY_NUMBER_OR_DATA): 'Google plans 1M Ironwood TPUs in 2026 — Marvell deal could 4× that' — specific volume + read-through.
  Angle 2 (WHO_WINS_LOSES): 'Broadcom loses its only hyperscaler custom-silicon partner' — specific named loser + why.
  Angle 3 (COMPETITIVE_READTHROUGH): 'Why this is OpenAI's Nvidia problem in disguise' — second-order industry impact.
  Angle 4 (HIDDEN_SECOND_ORDER_EFFECT): 'TSMC capacity reallocation is the real story' — supply-chain knock-on.
  Angle 5 (WHAT_HAPPENS_NEXT): 'Watch Q1 2026 earnings for the first chip-revenue line item' — concrete tripwire.

BAD example for the same story (REJECT — these are 5 paraphrases):
  'Google in talks with Marvell to build new AI inference chips'
  'Google in Talks With Marvell to Build New AI Chips for Inference'
  'Google in talks with Marvell to build new AI chips, The Information reports'
  'Google is in talks with Marvell to build custom AI inference chips'
  'Google Reportedly Pulls Marvell Into a Two-Chip TPU Plan'

Return ONLY valid JSON — no markdown, no preamble:
{
  "results": [
    {
      "story_index": 0,
      "angles": [
        { "headline": "...", "description": "...", "dimension": "..." }
      ]
    },
    ...
  ]
}

Dimensions to draw from (each angle MUST use a different one; pick the 2-5 that genuinely apply to the story):
- WHAT_HAPPENED: bare facts, names, numbers, dates (use this for AT MOST one angle, and only if needed)
- ECONOMIC_IMPACT: market, trade, jobs, prices, GDP consequences
- POLITICAL_REACTION: who said what, who's pushing back, alliances shifting
- WHO_WINS_LOSES: specific named beneficiaries / victims, with why
- HISTORICAL_PARALLEL: prior precedent or pattern this fits
- WHAT_HAPPENS_NEXT: concrete next steps, decision points, deadlines
- HIDDEN_SECOND_ORDER_EFFECT: non-obvious downstream consequence
- KEY_NUMBER_OR_DATA: the single statistic that captures the story
- COMPETITIVE_READTHROUGH: what this implies for adjacent companies / sectors
- USER_OR_CONSUMER_BEHAVIOUR: how end-user / customer / audience behaviour changes
- POLICY_OR_REGULATION: regulatory angle, antitrust, compliance read-through
- PEOPLE_TO_WATCH: specific named individuals whose moves matter

Voice rules (Sequoia memo, Stratechery long-form):
- DECLARATIVE. Lead with what happened, the number, the mechanism.
- FACT-DENSE. Every angle headline must be specific — names, figures, countries.
- ONE DEGREE OF SYNTHESIS per angle: the description gives the reader one non-obvious connection.
- Forbidden words: 'game-changer', 'revolutionary', 'stunning', 'shocking', 'epic', 'dramatic', 'massive', 'unprecedented' (unless literally true), 'watershed', 'sea change', 'paradigm shift', 'this could prove', 'only time will tell'.
- headline: under 90 chars, specific, MUST NOT be a rephrase of the parent headline.
- description: 2-3 sentences, 140-280 chars. Sentence 1: the specific fact / claim. Sentence 2: the synthesis — pattern, comparison, mechanism, or non-obvious consequence.

Critical:
- Output ONE entry per input story, in the same order. story_index matches input position.
- Use NEWSLETTER_EXCERPT as primary source. Use WEB_EXCERPTS to add what the newsletter doesn't cover.
- Do NOT contradict the newsletter excerpt; do NOT invent numbers or quotes.
- If a story can only support 2 strong angles, return 2 — NEVER pad to 5 with paraphrases.
- Prefer 3 strong, distinct angles over 5 weak, overlapping ones.`;

/**
 * Decide whether to skip web search for a story.
 *
 * Previously this skipped any story with a >=250-char newsletter excerpt + 3 sources,
 * which optimised cost but produced angle cards where every angle attributed to
 * the seed publisher (e.g., 5 angles all labelled "The Information") with empty
 * sourceUrls. We now skip ONLY when the cluster is overwhelmingly self-sufficient
 * (>= 600 chars excerpt) AND has >=4 sources — most clusters will go through web
 * search, giving us per-angle publisher diversity and clickable links.
 */
function _shouldSkipWebSearch(story) {
  const excerpt = (story.excerpt || '').trim();
  const numSources = Array.isArray(story.sources)
    ? story.sources.length
    : (typeof story.source === 'string' ? story.source.split(',').filter(Boolean).length : 1);
  return excerpt.length >= 600 && numSources >= 4;
}

async function _gatherWebContext(story, useInternet) {
  if (!useInternet || !hasRealSearchProvider()) return [];
  try {
    // Bumped from 5 → 10 so we have enough publisher diversity to assign one
    // distinct article per angle (5 angles per cluster).
    const results = await search(story.headline.slice(0, 100), {
      numResults:   10,
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

/**
 * Per-angle web search: for one LLM-generated angle headline, find an article
 * whose title best matches it. Used when the cluster's primary search didn't
 * surface enough distinct publishers, or to disambiguate which web result
 * supports each angle.
 *
 * Returns { url, source, image, snippet } | null.
 */
async function _findArticleForAngle(angleHeadline, useInternet) {
  if (!useInternet || !hasRealSearchProvider()) return null;
  if (!angleHeadline) return null;
  try {
    const results = await search(angleHeadline.slice(0, 110), {
      numResults:   3,
      text:         { maxCharacters: 400 },
      withContents: true,
      category:     'news',
    });
    const arr = Array.isArray(results) ? results : [];
    const r = arr.find(x => x.url && !BAD_DOMAIN.test(x.url));
    if (!r) return null;
    return {
      url:     r.url,
      source:  sourceName(r.url),
      image:   r.image && isGoodImage(r.image, r.url) ? r.image : null,
      snippet: cleanText(r.text || r.snippet).slice(0, 240),
    };
  } catch (e) {
    return null;
  }
}

/**
 * Token-overlap similarity between two headlines. Used to match LLM-generated
 * angle headlines to web search results when we already have webResults from
 * the cluster-level search and want to avoid additional per-angle searches.
 */
function _headlineSimilarity(a, b) {
  if (!a || !b) return 0;
  const tokenize = s => new Set(
    String(s).toLowerCase().match(/[a-z0-9]+/g)?.filter(t => t.length > 3) || []
  );
  const ta = tokenize(a), tb = tokenize(b);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.min(ta.size, tb.size);
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

/**
 * Attach per-angle source attribution + image. Each angle gets matched to a
 * distinct web result by headline similarity (preferred) or filled in by
 * per-angle web search (fallback). Each angle gets a unique sourceUrl/source
 * label/image, so deep-dive cards no longer all share the seed publisher.
 */
async function _attachSourcesAndImages(story, angles, ctx, useInternet) {
  const parentSrc = (story.source || '').split(',')[0].trim();
  const parentUrl = story.sourceUrl || story.url || '';

  // Build pool of available web results, deduped by host (one publisher slot per host).
  const pool = [];
  const seenHosts = new Set();
  for (const r of (ctx.webResults || [])) {
    if (!r.url || BAD_DOMAIN.test(r.url)) continue;
    let host = '';
    try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    pool.push({
      url:     r.url,
      title:   r.title || '',
      image:   isGoodImage(r.image, r.url) ? r.image : null,
      source:  sourceName(r.url),
      snippet: cleanText(r.text || r.snippet).slice(0, 240),
    });
  }

  // Pass 1: match each angle to its best webResult by headline similarity.
  // We greedily assign — each web result can only be used by one angle.
  const assignments = new Array(angles.length).fill(null);
  const usedPoolIdx = new Set();
  for (let i = 0; i < angles.length; i++) {
    let bestIdx = -1, bestScore = 0;
    for (let j = 0; j < pool.length; j++) {
      if (usedPoolIdx.has(j)) continue;
      const sim = _headlineSimilarity(angles[i].headline, pool[j].title);
      if (sim > bestScore) { bestScore = sim; bestIdx = j; }
    }
    // Require at least minimal token overlap (>=0.15) to consider it a real match.
    if (bestIdx >= 0 && bestScore >= 0.15) {
      assignments[i] = pool[bestIdx];
      usedPoolIdx.add(bestIdx);
    }
  }

  // Pass 2: for any unassigned angle, try a per-angle web search.
  await Promise.all(assignments.map(async (assigned, i) => {
    if (assigned) return;
    const found = await _findArticleForAngle(angles[i].headline, useInternet);
    if (found) assignments[i] = found;
  }));

  // Pass 3: any still-unassigned angles fall back to UNUSED pool entries (any host),
  // so we don't end up assigning the parent's url/source to multiple angles.
  const unusedPool = pool.filter((_, idx) => !usedPoolIdx.has(idx));
  let unusedCursor = 0;
  for (let i = 0; i < assignments.length; i++) {
    if (assignments[i]) continue;
    if (unusedCursor < unusedPool.length) {
      assignments[i] = unusedPool[unusedCursor++];
    }
  }

  // Pass 4: if seed url is empty, look at the cluster's pool for a fallback url
  // (so cards are at least clickable to a related publisher).
  let fallbackPoolUrl = '';
  let fallbackPoolSource = '';
  if (!parentUrl && pool.length) {
    fallbackPoolUrl = pool[0].url;
    fallbackPoolSource = pool[0].source;
  }

  return angles.map((a, i) => {
    const r = assignments[i];
    const src = r?.source || parentSrc || fallbackPoolSource || '';
    const url = r?.url    || parentUrl || fallbackPoolUrl    || '';
    return {
      headline:       a.headline,
      description:    a.description,
      dimension:      a.dimension,
      source:         src,
      sourceUrl:      url,
      image:          r?.image     || require('./undraw').pick(a.headline || story.headline || ''),
      internetSource: !!r,
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

  // 2) ONE batched LLM call across all top stories.
  // ALWAYS use Sonnet for angles regardless of digestModel — Haiku reliably
  // produces 5 paraphrases of the seed headline rather than 5 distinct
  // dimensional takes. The cost is one Sonnet call per refresh; worth it for
  // the most-visible 'Deep Dive' surface.
  const SONNET_MODEL = 'claude-sonnet-4-5-20250929';
  const angleModel = process.env.ANTHROPIC_API_KEY ? SONNET_MODEL : model;
  let parsed = null;
  try {
    const prompt = _buildBatchPrompt(top, contextByIndex);
    const raw    = await _callModel(angleModel, prompt, ANGLES_BATCH_SYSTEM);
    parsed = _parseBatchResponse(raw, top.length);
    if (!parsed) console.warn('[angles] batched LLM call returned no parseable JSON. Raw head:', (raw || '').slice(0, 200));
  } catch (e) {
    console.warn('[angles] batched LLM call failed:', e.message);
  }

  // 3) For any story with no LLM angles, fall back to deterministic synthesis.
  //    _attachSourcesAndImages is now async (does per-angle web search) so
  //    fan out across stories in parallel.
  const finalAngles = await Promise.all(top.map(async (s, i) => {
    const ctx = contextByIndex[i];
    const llmAngles = parsed?.[i] || [];
    const angles = llmAngles.length ? llmAngles : _fallbackAngles(s, ctx);
    return _attachSourcesAndImages(s, angles, ctx, useInternet);
  }));

  // 4) Mutate each top story in place + build topic_clusters[] for UI
  const topic_clusters = top.map((s, i) => {
    const angles = finalAngles[i];
    s.angles = angles;
    return {
      topic:   s.headline,
      summary: contextByIndex[i].newsletterExcerpt.split('\n\n')[0] || '',
      image:   (s.image && !BAD_IMAGE.test(s.image) ? s.image : null)
               || (contextByIndex[i].webResults.find(r => isGoodImage(r.image, r.url))?.image)
               || require('./undraw').pick(s.headline),
      stories: angles,
    };
  }).filter(c => c.stories && c.stories.length > 0);

  // PRIMARY image upgrade: per-item cascade OG → Serper Images → (keep undraw).
  // Runs in parallel for covers AND every angle story. Replaces undraw
  // fallbacks when a real publisher image is found.
  try {
    const { attachOgImages, fetchOgImage } = require('./og-image');
    const { findImage } = require('./image-fallback');

    // Attach a sourceUrl to each cluster from its parent story so OG can fetch it
    topic_clusters.forEach((c, idx) => {
      if (!c.sourceUrl) c.sourceUrl = top[idx].sourceUrl || top[idx].url || '';
    });

    const allTargets = [
      ...topic_clusters,
      ...topic_clusters.flatMap(c => c.stories),
    ];

    // Pass 1: OG-image scrape for everything with a sourceUrl.
    await attachOgImages(allTargets, { concurrency: 10 });

    // Pass 2: For anything still on undraw / missing, try Serper Images.
    const stillNeed = allTargets.filter(it => {
      const im = it.image || '';
      return !im || /cdn\.jsdelivr\.net\/gh\/balazser\/undraw/i.test(im) || BAD_IMAGE.test(im);
    });
    const SERPER_CAP = 25;
    const slice = stillNeed.slice(0, SERPER_CAP);
    await Promise.all(slice.map(async it => {
      const headline = it.title || it.topic || it.headline || '';
      if (!headline) return;
      try {
        const img = await findImage(headline);
        if (img) it.image = img;
      } catch { /* ignore */ }
    }));
  } catch (e) {
    console.warn('[angles] og/serper image attach failed:', e.message);
  }

  console.log(`[angles] produced ${topic_clusters.length} deep-dive clusters with ${finalAngles.reduce((n, a) => n + a.length, 0)} total angles`);
  return { topic_clusters };
}

module.exports = { buildAnglesForTopStories };
