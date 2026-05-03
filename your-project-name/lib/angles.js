'use strict';

/**
 * Newsletter-corpus deep-dive angle generator (v2).
 *
 * Replaces the v1 "LLM invents 5 angles from a single excerpt + web snippets"
 * approach, which produced angles that read as paraphrases of the seed
 * headline rather than the genuine perspectives newsletter writers took.
 *
 * v2 design:
 *   1. For each top story, gather ALL newsletter excerpts that cover the topic
 *      (entries[] whose source name appears in cluster.sources[]). Extract the
 *      paragraphs from each entry's bodyText that mention the story's keywords.
 *   2. Build a per-story "corpus": several Newsletter -> excerpt blocks.
 *   3. Ask Haiku to identify 2-5 GENUINELY DISTINCT angles the writers
 *      themselves emphasized — not invented synthesis. Each angle MUST cite
 *      which newsletter (source_badge) said it most strongly.
 *   4. Web search becomes secondary: only used to find clickable URLs and
 *      images for each angle card, never to generate the angle itself.
 *
 * Output shape per story (mutates story.angles):
 *   [{ headline, description, source_badge, source, sourceUrl, image, ... }]
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

// ── Corpus building ─────────────────────────────────────────────────────────

/**
 * Derive search keywords from a story. Prefers explicit keywords[] from the
 * cluster; falls back to substantive tokens from the headline (length >= 4,
 * not a stopword).
 */
const STOPWORDS = new Set([
  'the','and','for','with','from','that','this','have','will','your','are','was','were','been','their','they','them','what','when','where','which','about','into','than','then','some','more','most','over','said','says','here','there','only','also','just','like','very','much','many','other','these','those','still','being','after','before','because','through','among','should','would','could','might','using','used','make','made','take','taken','goes','give','given','want','need','seem','seen','said','says','plan','plans'
]);

function _storyKeywords(story) {
  if (Array.isArray(story.keywords) && story.keywords.length) {
    return story.keywords.map(k => String(k).toLowerCase()).filter(Boolean);
  }
  const tokens = String(story.headline || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.filter(t => t.length >= 4 && !STOPWORDS.has(t)).slice(0, 6);
}

/** Lowercase, normalised set of source names that covered this story. */
function _storySourceNames(story) {
  const names = Array.isArray(story.sources)
    ? story.sources
    : (typeof story.source === 'string' ? story.source.split(',') : []);
  return new Set(names.map(s => String(s).toLowerCase().trim()).filter(Boolean));
}

/**
 * Pull paragraphs from `bodyText` that contain >=1 keyword. Returns up to
 * `maxChars` worth of relevant content, joining short paragraphs with a blank
 * line between them. If no paragraph matches, returns the leading slice
 * (the email's "headline + opener" usually relates to the lead story).
 */
function _relevantBodySlice(bodyText, keywords, maxChars = 600) {
  const text = String(bodyText || '');
  if (!text) return '';
  const paras = text.split(/\n{2,}|\n(?=[A-Z])/).map(p => p.trim()).filter(p => p.length > 40);
  const kw = keywords.map(k => k.toLowerCase());
  const matched = [];
  for (const p of paras) {
    const lower = p.toLowerCase();
    if (kw.some(k => lower.includes(k))) {
      matched.push(p);
      if (matched.join('\n\n').length >= maxChars) break;
    }
  }
  let out = matched.join('\n\n');
  if (!out) {
    // Fall back to the email's leading prose (first 2 paragraphs).
    out = paras.slice(0, 2).join('\n\n');
  }
  return out.slice(0, maxChars);
}

/**
 * Build a corpus of newsletter excerpts about this story.
 * Returns { corpus: string, contributors: [{ source, excerpt }] }
 *
 * Each contributor block is one newsletter's relevant passage. Total corpus
 * is capped at ~3000 chars so the LLM call stays fast and cheap.
 */
function buildCorpus(story, entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return { corpus: '', contributors: [] };
  }
  const wantedSources = _storySourceNames(story);
  const keywords = _storyKeywords(story);
  const contributors = [];
  let totalChars = 0;
  const MAX_TOTAL = 3000;

  // First pass: entries whose source is in cluster.sources[].
  // Skip if the cluster excerpt is already a substring of the matched passage,
  // or vice versa, to avoid feeding the LLM near-duplicate text.
  const clusterExcerptNorm = (story.excerpt || '').replace(/\s+/g, ' ').trim();
  for (const e of entries) {
    if (totalChars >= MAX_TOTAL) break;
    const src = String(e.source || '').toLowerCase().trim();
    if (!wantedSources.has(src)) continue;
    const passage = _relevantBodySlice(e.bodyText, keywords, 600);
    if (!passage || passage.length < 80) continue;
    if (clusterExcerptNorm) {
      const passageNorm = passage.replace(/\s+/g, ' ').trim();
      if (passageNorm.includes(clusterExcerptNorm) || clusterExcerptNorm.includes(passageNorm)) {
        // Same content as cluster excerpt; the cluster-excerpt path will add it.
        continue;
      }
    }
    contributors.push({ source: e.source, excerpt: passage });
    totalChars += passage.length;
  }

  // Second pass (only if first pass yielded < 2 contributors): ANY entry whose
  // bodyText mentions multiple keywords. Catches cases where the cluster
  // sources[] missed a newsletter that actually covered the topic.
  if (contributors.length < 2 && keywords.length >= 2) {
    const seen = new Set(contributors.map(c => c.source.toLowerCase()));
    for (const e of entries) {
      if (totalChars >= MAX_TOTAL) break;
      const src = String(e.source || '').toLowerCase().trim();
      if (seen.has(src)) continue;
      const text = String(e.bodyText || '').toLowerCase();
      const hits = keywords.filter(k => text.includes(k.toLowerCase())).length;
      if (hits < 2) continue;
      const passage = _relevantBodySlice(e.bodyText, keywords, 500);
      if (!passage || passage.length < 80) continue;
      contributors.push({ source: e.source, excerpt: passage });
      totalChars += passage.length;
      if (contributors.length >= 5) break;
    }
  }

  // Always include the cluster's verbatim excerpt if we have one and it's not
  // already covered (clusterer.js already picked the most factual passage).
  if (story.excerpt && story.excerpt.length > 80 && contributors.length < 5) {
    const ex = story.excerpt.trim();
    const dup = contributors.some(c => c.excerpt.includes(ex.slice(0, 100)));
    if (!dup) {
      const seedSource = (Array.isArray(story.sources) && story.sources[0])
        || story.source
        || 'Newsletter';
      contributors.unshift({ source: seedSource, excerpt: ex });
    }
  }

  const corpus = contributors
    .map(c => `Newsletter: ${c.source}\n${c.excerpt}`)
    .join('\n\n----\n\n');
  return { corpus, contributors };
}

// ── LLM prompt ──────────────────────────────────────────────────────────────

const ANGLES_BATCH_SYSTEM = `You are an analyst preparing the 'Deep Dive' section of a daily intelligence brief. Below each story you will receive a CORPUS — multiple newsletter writers' own words about the story.

Your job: identify 2 to 5 GENUINELY DISTINCT angles the newsletter writers themselves emphasized in the corpus. EXTRACT — DO NOT INVENT.

Hard rules:
- Use ONLY material in the corpus. Do NOT introduce facts, numbers, names, or claims that are not present in the excerpts.
- Each angle MUST be tied to a specific newsletter from the corpus (source_badge).
- If two newsletters made the same point, that's ONE angle, not two — pick the version with the most concrete detail.
- If the corpus only supports 2 distinct angles, return 2. NEVER pad with paraphrases or generic takes.
- An angle is "distinct" when it answers a different QUESTION about the story (what happened vs. who wins vs. what comes next vs. the hidden second-order effect).

For each angle:
- headline: <= 90 chars, declarative, specific. The non-obvious takeaway, not the bare fact. NOT a paraphrase of the parent headline.
- description: 2 sentences, 140–280 chars total. Sentence 1: the specific fact / claim from the corpus. Sentence 2: the synthesis the writer offered (mechanism, comparison, second-order effect).
- source_badge: the EXACT newsletter name as it appeared in the corpus (e.g. "The Information", "Stratechery", "Money Stuff").

Voice rules (Sequoia memo / Stratechery long-form):
- Declarative, fact-dense, names + figures.
- Forbidden words: 'game-changer', 'revolutionary', 'stunning', 'shocking', 'epic', 'dramatic', 'massive', 'unprecedented' (unless literally true), 'watershed', 'sea change', 'paradigm shift', 'this could prove', 'only time will tell', 'quiet', 'hard to miss'.

Return ONLY valid JSON — no markdown, no preamble:
{
  "results": [
    {
      "story_index": 0,
      "angles": [
        { "headline": "...", "description": "...", "source_badge": "..." }
      ]
    },
    ...
  ]
}

Critical:
- One entry per input story, in input order. story_index matches input position.
- If a story has NO usable corpus, return an empty angles array — do not invent content.`;

function _buildBatchPrompt(stories, corpusByIndex) {
  const blocks = stories.map((s, i) => {
    const { corpus } = corpusByIndex[i] || { corpus: '' };
    return `[STORY ${i}] ${s.headline}

CORPUS:
${corpus || '(no newsletter corpus available)'}`;
  }).join('\n\n==========\n\n');
  return `Identify 2–5 distinct angles from the corpus for each of the following ${stories.length} stories. Return JSON per the schema.\n\n${blocks}`;
}

function _parseBatchResponse(raw, storiesLen) {
  if (!raw) return null;
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  let parsed;
  try { parsed = JSON.parse(objMatch[0]); } catch { return null; }
  const results = Array.isArray(parsed.results) ? parsed.results : null;
  if (!results) return null;
  const out = Array.from({ length: storiesLen }, () => []);
  for (const r of results) {
    const idx = Number(r.story_index);
    if (!Number.isFinite(idx) || idx < 0 || idx >= storiesLen) continue;
    if (!Array.isArray(r.angles)) continue;
    out[idx] = r.angles
      .slice(0, 5)
      .map(a => ({
        headline:     String(a.headline || '').trim().slice(0, 110),
        description:  String(a.description || '').trim().slice(0, 280),
        source_badge: String(a.source_badge || '').trim().slice(0, 60),
      }))
      .filter(a => a.headline && a.description);
  }
  return out;
}

// ── Per-angle URL + image attachment (web search is secondary) ──────────────

/**
 * For an angle whose source_badge is a known newsletter, attach a clickable URL
 * + image. Strategy:
 *   1. If we have a parent cluster URL whose host matches the badge, use that.
 *   2. Otherwise fire a small web search for `${badge} ${angle.headline}` to
 *      find the badge's article on this story.
 *   3. Fall back to undraw illustration if both fail.
 */
async function _findArticleForAngle(angleHeadline, badge, parentSrc, parentUrl, useInternet) {
  // 1) parent URL when badge matches
  if (parentUrl && badge && parentSrc &&
      parentSrc.toLowerCase().includes(badge.toLowerCase().split(/\s+/)[0])) {
    return { url: parentUrl, source: parentSrc, image: null, snippet: '' };
  }

  if (!useInternet || !hasRealSearchProvider()) {
    // Without web search, return parent URL as a last resort.
    if (parentUrl) return { url: parentUrl, source: parentSrc || badge, image: null, snippet: '' };
    return null;
  }

  try {
    const query = badge ? `${badge} ${angleHeadline}` : angleHeadline;
    const results = await search(query.slice(0, 130), {
      numResults:   3,
      text:         { maxCharacters: 300 },
      withContents: true,
      category:     'news',
    });
    const arr = Array.isArray(results) ? results : [];
    const r = arr.find(x => x.url && !BAD_DOMAIN.test(x.url));
    if (!r) {
      if (parentUrl) return { url: parentUrl, source: parentSrc || badge, image: null, snippet: '' };
      return null;
    }
    return {
      url:     r.url,
      source:  badge || sourceName(r.url),
      image:   r.image && isGoodImage(r.image, r.url) ? r.image : null,
      snippet: cleanText(r.text || r.snippet).slice(0, 240),
    };
  } catch {
    if (parentUrl) return { url: parentUrl, source: parentSrc || badge, image: null, snippet: '' };
    return null;
  }
}

async function _attachSourcesAndImages(story, angles, useInternet) {
  const parentSrc = (story.source || '').split(',')[0].trim();
  const parentUrl = story.sourceUrl || story.url || '';

  const enriched = await Promise.all(angles.map(async a => {
    const badge = a.source_badge || parentSrc;
    const found = await _findArticleForAngle(a.headline, badge, parentSrc, parentUrl, useInternet);
    return {
      headline:       a.headline,
      description:    a.description,
      source_badge:   badge,
      source:         badge || (found?.source || parentSrc || ''),
      sourceUrl:      found?.url || parentUrl || '',
      image:          found?.image || require('./undraw').pick(a.headline || story.headline || ''),
      internetSource: !!found?.url && found.url !== parentUrl,
    };
  }));

  return enriched;
}

// ── Fallback synthesis when LLM fails completely ────────────────────────────

function _fallbackAngles(story, contributors) {
  const out = [];
  for (const c of contributors.slice(0, 3)) {
    const firstSentence = (c.excerpt.match(/^[^.!?]{20,260}[.!?]/)?.[0] || c.excerpt.slice(0, 200)).trim();
    out.push({
      headline:     `${c.source}'s read on ${story.headline.split(/[,—–:]/)[0].trim().slice(0, 60)}`.slice(0, 110),
      description:  firstSentence.slice(0, 280),
      source_badge: c.source,
    });
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {Array}   stories      digest.top_today
 * @param {boolean} useInternet  settings.internetFallback
 * @param {string}  model        digestModel (Haiku is fine; corpus extraction is light)
 * @param {Array}   entries      raw newsletter entries (each: { source, bodyText, ... })
 */
async function buildAnglesForTopStories(stories, useInternet, model, entries = []) {
  if (!Array.isArray(stories) || !stories.length) return { topic_clusters: [] };
  const top = stories.slice(0, 5);

  // 1) Build per-story newsletter corpus.
  const corpusByIndex = top.map((s, i) => {
    const { corpus, contributors } = buildCorpus(s, entries);
    console.log(`[angles] story ${i} "${(s.headline || '').slice(0, 60)}" — corpus: ${corpus.length}c | contributors: ${contributors.length} (${contributors.map(c => c.source).join(', ')})`);
    return { corpus, contributors };
  });

  // 2) ONE batched LLM call. Haiku is sufficient — task is extractive, not generative.
  let parsed = null;
  try {
    const prompt = _buildBatchPrompt(top, corpusByIndex);
    const raw    = await _callModel(model, prompt, ANGLES_BATCH_SYSTEM);
    parsed = _parseBatchResponse(raw, top.length);
    if (!parsed) console.warn('[angles] batched LLM call returned no parseable JSON. Raw head:', (raw || '').slice(0, 200));
  } catch (e) {
    console.warn('[angles] batched LLM call failed:', e.message);
  }

  // 3) For any story whose LLM angles are empty, fall back to deterministic
  //    extraction from contributors. Ensures every cluster gets at least
  //    one card (rather than a blank slot).
  const finalAngles = await Promise.all(top.map(async (s, i) => {
    const llmAngles = parsed?.[i] || [];
    const angles = llmAngles.length
      ? llmAngles
      : _fallbackAngles(s, corpusByIndex[i].contributors);
    return _attachSourcesAndImages(s, angles, useInternet);
  }));

  // 4) Mutate each top story + build topic_clusters[] for UI compatibility.
  const topic_clusters = top.map((s, i) => {
    const angles = finalAngles[i];
    s.angles = angles;
    return {
      topic:   s.headline,
      summary: corpusByIndex[i].contributors[0]?.excerpt?.split('\n\n')[0]?.slice(0, 280) || '',
      image:   (s.image && !BAD_IMAGE.test(s.image) ? s.image : null)
               || require('./undraw').pick(s.headline),
      stories: angles,
    };
  }).filter(c => c.stories && c.stories.length > 0);

  // 5) Image upgrade: OG-scrape parent + per-angle search hosts, then Serper
  //    Images for anything still on undraw. Same cascade as before.
  try {
    const { attachOgImages } = require('./og-image');
    const { findImage } = require('./image-fallback');

    topic_clusters.forEach((c, idx) => {
      if (!c.sourceUrl) c.sourceUrl = top[idx].sourceUrl || top[idx].url || '';
    });

    const allTargets = [
      ...topic_clusters,
      ...topic_clusters.flatMap(c => c.stories),
    ];

    await attachOgImages(allTargets, { concurrency: 10 });

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

  console.log(`[angles] produced ${topic_clusters.length} deep-dive clusters with ${finalAngles.reduce((n, a) => n + a.length, 0)} total angles (corpus-grounded)`);
  return { topic_clusters };
}

module.exports = { buildAnglesForTopStories, buildCorpus };
