'use strict';

/**
 * Newsletter-first deep dives.
 *
 * Workflow:
 *  1. Take the top N (=5) stories from digest.top_today. These are already
 *     newsletter-sourced and editor-ranked.
 *  2. For each, fetch 4-6 article excerpts using the shared web-search layer
 *     (Exa → Tavily → Brave → LLM). This provides additional context so the
 *     LLM can surface DIFFERENT angles.
 *  3. LLM distils the combined newsletter excerpt + web excerpts into exactly
 *     5 distinct angles per cluster.
 *
 * If web search is disabled or out of credits we still produce clusters — they
 * simply carry the newsletter context as a summary, with the deep-dive angles
 * generated purely from the newsletter body.
 */

const { _callModel } = require('./digest-generator');
const { search, hasRealSearchProvider } = require('./web-search');

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

const ANGLES_SYSTEM = `You are a sharp news analyst. Given a topic headline (from the user's newsletter digest) plus excerpts from multiple related articles, identify exactly 5 genuinely distinct, insightful angles on this story. Each angle must teach the reader something different.

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
- Return EXACTLY 5 entries unless the source material truly cannot support 5 distinct dimensions (then return fewer — never repeat).
- The 5 entries MUST come from 5 DIFFERENT dimensions above. Tag the dimension you used in the "dimension" field.
- DO NOT use the same fact in two angles. Each must add something new.
- Prioritise facts from the NEWSLETTER EXCERPT first; use web excerpts to enrich only when they add something new.
- headline: under 90 chars, specific — include names, figures, countries. NOT a rephrasing of the parent topic.
- description: exactly 2 sentences, max 200 chars total. Sentence 1: the specific fact / insight. Sentence 2: why it matters or what changes.
- imageHint: 2-3 words describing what a good photo for this angle would look like.`;

function cleanText(t) {
  return (t || '')
    .replace(/#{1,6}\s*/g, '')
    .replace(/SENSEX[\d\s.,+\-#]+/gi, '')
    .replace(/NIFTY[\d\s.,+\-#]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function distillAngles({ topic, newsletterExcerpt, webResults, model }) {
  const imagePool = (webResults || [])
    .filter(r => isGoodImage(r.image, r.url))
    .map(r => ({ image: r.image, source: sourceName(r.url), sourceUrl: r.url }));

  const webExcerpts = (webResults || [])
    .filter(r => !isBadSource(r.url))
    .slice(0, 10)
    .map((r, i) => {
      const date = r.publishedDate ? new Date(r.publishedDate).toISOString().slice(0, 10) : 'undated';
      return `[Article ${i + 1} | ${date}] ${r.title || ''}\n${cleanText(r.text || r.snippet).slice(0, 700)}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 9000);

  const prompt = `Topic from today's newsletter digest: "${topic}"

NEWSLETTER EXCERPT (primary source — always cite first):
${newsletterExcerpt || '(none provided)'}

${webExcerpts ? `WEB EXCERPTS (use only to add missing context — do NOT contradict the newsletter):\n${webExcerpts}` : '(No web excerpts available — work from the newsletter excerpt only.)'}`;

  let raw;
  try {
    raw = await _callModel(model, prompt, ANGLES_SYSTEM);
  } catch (e) {
    console.warn(`[topic-clusters] LLM distillation failed for "${topic.slice(0, 50)}":`, e.message);
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
      source:         img?.source    || sourceName((webResults?.[0]?.url) || ''),
      sourceUrl:      img?.sourceUrl || (webResults?.[0]?.url) || '',
      image:          img?.image     || null,
      internetSource: true,
    };
  }).filter(a => a.headline);
}

/**
 * Build newsletter-first deep dives.
 *
 * @param {object}   digest             The full digest with top_today already populated.
 * @param {boolean}  useInternet        Web enrichment toggle (from settings.internetFallback).
 * @param {string}   model              LLM to drive distillation.
 * @returns {Promise<Array>}            Array of { topic, summary, image, stories[] }
 */
async function buildTopicClusters(digest, useInternet, model = 'llama-3.3-70b-versatile') {
  // Reduced from 5 → 3 to minimize Tavily/Brave/Exa usage per digest.
  const topStories = (digest.top_today || []).slice(0, 3);
  if (!topStories.length) return [];

  const canWebSearch = useInternet && hasRealSearchProvider();

  const clusters = await Promise.all(topStories.map(async story => {
    const topic             = story.headline;
    const newsletterExcerpt = [story.description, story.context].filter(Boolean).join('\n\n').slice(0, 1500);

    let webResults = [];
    if (canWebSearch) {
      try {
        // Reduced from 10 → 5 results per topic to minimize web search usage.
        webResults = await search(topic.slice(0, 100), {
          numResults:   5,
          text:         { maxCharacters: 600 },
          withContents: true,
          category:     'news',
        });
      } catch (e) {
        console.warn(`[topic-clusters] web search failed for "${topic.slice(0, 50)}":`, e.message);
      }
    }

    const angles = await distillAngles({ topic, newsletterExcerpt, webResults, model });

    console.log(`[topic-clusters] "${topic.slice(0, 50)}" → ${angles.length} angles (${webResults.length} web refs)`);

    return {
      topic,
      summary: newsletterExcerpt.split('\n\n')[0] || '',
      image:   story.image || (webResults.find(r => isGoodImage(r.image, r.url))?.image) || null,
      stories: angles,
    };
  }));

  return clusters.filter(c => c.stories && c.stories.length > 0);
}

module.exports = { buildTopicClusters };
