'use strict';

/**
 * Newsletter-corpus deep-dive angle generator (v3).
 *
 * Design (May 2026):
 *   - We only generate angles for the top 5 stories, so spend tokens generously.
 *   - For each story, build a corpus from TWO sources:
 *       (a) FULL bodyText of every newsletter entry whose source matched the
 *           story's cluster (capped at 8000 chars/entry).
 *       (b) Web-article excerpts via Exa-style search with `withContents: true`
 *           — gets 2-3 article bodies (~3000 chars each).
 *   - Total per-story corpus can run 15-25k chars; well within Sonnet's 200k.
 *   - One batched Sonnet call across all 5 stories returns 3-5 angles each,
 *     EXTRACTED (not invented) from the corpus, with a source_badge per angle.
 *   - If the corpus is genuinely thin (<500 chars after both passes), we still
 *     try to return 2 angles based on whatever we have, rather than 0.
 *
 * Output shape per story (mutates story.angles):
 *   [{ headline, description, source_badge, source, sourceUrl, image, ... }]
 */

const { _callModel } = require('./digest-generator');
const { search, hasRealSearchProvider } = require('./web-search');

const BAD_DOMAIN = /globenewswire|prnewswire|businesswire|accesswire|notified\.com|einpresswire|prlog/i;
const BAD_IMAGE  = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|profile|placeholder|pixel|tracking|beacon|favicon|sprite|encrypted-tbn|gstatic\.com/i;

// Sonnet model id used for deep-dive angle extraction. Override with
// ANGLES_MODEL env var if a newer Sonnet alias becomes available.
const SONNET_MODEL = process.env.ANGLES_MODEL || 'claude-sonnet-4-5-20250929';

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

/**
 * Strip HTML to plain text — keep only paragraph-y content.
 * Removes scripts/styles/nav/footer/header before tag stripping.
 */
function _htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch an article URL and return ~3000 chars of plain text body. Used when
 * the search provider's returned snippet is too short to serve as corpus.
 */
async function _fetchArticleText(url) {
  if (!url) return '';
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsletterDigest/1.0; +https://newsletter-digest-psi.vercel.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal:   AbortSignal.timeout(7000),
      redirect: 'follow',
    });
    if (!resp.ok) return '';
    const html = await resp.text();
    // Prefer the largest <article> or <main> block when present, otherwise
    // strip the whole document.
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const mainMatch    = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    const block = (articleMatch && articleMatch[1]) || (mainMatch && mainMatch[1]) || html;
    return _htmlToText(block).slice(0, 4000);
  } catch {
    return '';
  }
}

// ── Corpus building ─────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the','and','for','with','from','that','this','have','will','your','are','was','were','been','their','they','them','what','when','where','which','about','into','than','then','some','more','most','over','said','says','here','there','only','also','just','like','very','much','many','other','these','those','still','being','after','before','because','through','among','should','would','could','might','using','used','make','made','take','taken','goes','give','given','want','need','seem','seen','plan','plans'
]);

function _storyKeywords(story) {
  if (Array.isArray(story.keywords) && story.keywords.length) {
    return story.keywords.map(k => String(k).toLowerCase()).filter(Boolean);
  }
  const tokens = String(story.headline || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.filter(t => t.length >= 4 && !STOPWORDS.has(t)).slice(0, 6);
}

function _storySourceNames(story) {
  const names = Array.isArray(story.sources)
    ? story.sources
    : (typeof story.source === 'string' ? story.source.split(',') : []);
  return new Set(names.map(s => String(s).toLowerCase().trim()).filter(Boolean));
}

/** Trim newsletter bodyText to remove footer boilerplate / unsubscribe links. */
function _trimEmailBody(text) {
  if (!text) return '';
  let t = String(text);
  // Cut at common footer markers.
  const footers = [
    /\n[-—=*_]{3,}/,           // ascii rule lines
    /unsubscribe/i,
    /you('?| )re receiving/i,
    /view (this|in) (email|browser)/i,
    /update your preferences/i,
    /\n+sent from /i,
  ];
  for (const re of footers) {
    const m = t.search(re);
    if (m > 200) t = t.slice(0, m);
  }
  return t.trim();
}

/**
 * Build per-story corpus. Combines:
 *   1. Full newsletter bodyText (up to ~8k chars per entry, ~5 entries max)
 *   2. Web-article content via Exa-style search with `withContents: true`
 *      (up to 3 articles, ~3k chars each)
 *
 * Returns { corpus: string, contributors: [{ source, kind, excerpt, url? }] }
 *
 * `kind` is 'newsletter' or 'web' so the prompt can instruct the LLM on how to
 * cite (newsletters by name, web by domain).
 */
async function buildCorpus(story, entries, useInternet) {
  const wantedSources = _storySourceNames(story);
  const keywords = _storyKeywords(story);
  const contributors = [];

  // ── Pass 1: matching newsletter entries (full body).
  if (Array.isArray(entries) && entries.length) {
    for (const e of entries) {
      const src = String(e.source || '').toLowerCase().trim();
      if (!wantedSources.has(src)) continue;
      const body = _trimEmailBody(e.bodyText);
      if (!body || body.length < 200) continue;
      contributors.push({
        source:  e.source,
        kind:    'newsletter',
        excerpt: body.slice(0, 8000),
      });
      if (contributors.length >= 5) break;
    }
  }

  // ── Pass 2: keyword-matched newsletter entries (catches sources[] gaps).
  if (Array.isArray(entries) && entries.length && contributors.length < 3 && keywords.length >= 2) {
    const seen = new Set(contributors.map(c => String(c.source).toLowerCase()));
    for (const e of entries) {
      const src = String(e.source || '').toLowerCase().trim();
      if (seen.has(src)) continue;
      const body = _trimEmailBody(e.bodyText);
      if (!body || body.length < 200) continue;
      const lower = body.toLowerCase();
      const hits = keywords.filter(k => lower.includes(k.toLowerCase())).length;
      if (hits < 2) continue;
      contributors.push({
        source:  e.source,
        kind:    'newsletter',
        excerpt: body.slice(0, 8000),
      });
      seen.add(src);
      if (contributors.length >= 5) break;
    }
  }

  // ── Pass 3: include cluster's verbatim excerpt as a small seed if not
  //    already covered (some stories only have a short excerpt — better than
  //    nothing for the LLM to anchor on).
  if (story.excerpt && story.excerpt.length > 100) {
    const ex = story.excerpt.trim();
    const dup = contributors.some(c => c.excerpt.includes(ex.slice(0, 100)));
    if (!dup) {
      const seedSource = (Array.isArray(story.sources) && story.sources[0])
        || story.source
        || 'Newsletter';
      contributors.unshift({
        source:  String(seedSource).split(',')[0].trim(),
        kind:    'newsletter',
        excerpt: ex,
      });
    }
  }

  // ── Pass 4: web-article content. Skip when newsletter corpus is already
  //    strong (>5000 chars total) — saves ~5s per story. The newsletter
  //    material alone gives Sonnet plenty to extract angles from.
  //
  //    Provider notes: Exa supports withContents (full article text). When the
  //    user has Exa disabled (useExa=false), the chain falls through to GDELT
  //    which returns short snippets (<200 chars). For those we follow up with
  //    a direct HTTP fetch to the article URL to get a real corpus.
  const newsletterChars = contributors.reduce((sum, c) => sum + (c.kind === 'newsletter' ? c.excerpt.length : 0), 0);
  const skipWebSearch = newsletterChars > 5000;
  if (!skipWebSearch && useInternet && hasRealSearchProvider()) {
    try {
      const query = `${story.headline}`.slice(0, 130);
      const results = await search(query, {
        numResults:   3,
        text:         { maxCharacters: 3500 },
        withContents: true,
        category:     'news',
      });
      const arr = Array.isArray(results) ? results : [];
      const candidates = arr.slice(0, 3).filter(r => r.url && !BAD_DOMAIN.test(r.url));

      // Fetch full article body for any candidate whose returned text is too
      // short to be useful (typical for GDELT/Tavily snippets).
      await Promise.all(candidates.map(async r => {
        const initialText = cleanText(r.text || r.snippet || '');
        if (initialText.length >= 800) {
          r._fullText = initialText;
          return;
        }
        try {
          const fetched = await _fetchArticleText(r.url);
          // Prefer fetched body if it's substantially longer than the snippet,
          // otherwise fall back to whatever the search provider returned.
          r._fullText = fetched && fetched.length > initialText.length ? fetched : initialText;
        } catch {
          r._fullText = initialText;
        }
      }));

      for (const r of candidates) {
        const text = r._fullText || '';
        if (text.length < 80) continue;  // truly empty: skip
        contributors.push({
          source:  sourceName(r.url) || 'Web',
          kind:    'web',
          excerpt: text.slice(0, 3500),
          url:     r.url,
          image:   r.image && isGoodImage(r.image, r.url) ? r.image : null,
        });
      }
    } catch (e) {
      console.warn(`[angles] web search for "${story.headline.slice(0, 60)}" failed:`, e.message);
    }
  }

  const corpus = contributors
    .map(c => `[${c.kind === 'newsletter' ? 'NEWSLETTER' : 'WEB'}: ${c.source}]\n${c.excerpt}`)
    .join('\n\n----\n\n');
  return { corpus, contributors };
}

// ── LLM prompt ──────────────────────────────────────────────────────────────

const ANGLES_BATCH_SYSTEM = `You are an analyst preparing the 'Deep Dive' section of a daily intelligence brief. For each top story you receive a CORPUS — a mix of newsletter writers' own words and 1-3 news-article excerpts about the story.

Your job: identify GENUINELY DISTINCT angles that the corpus actually supports. EXTRACT — DO NOT INVENT.

How many angles per story:
- Aim for 3 to 5 angles per story.
- If the corpus is genuinely thin (under ~500 chars total), 2 angles is acceptable.
- 1 angle is a failure case — only return 1 if the corpus contains exactly one substantive claim.
- Maximum 5.

Hard rules:
- Use ONLY material in the corpus. No outside facts, names, or numbers.
- Each angle is tied to a SPECIFIC source from the corpus (source_badge).
- If two sources made the same point, that's ONE angle — pick the version with the most concrete detail (numbers, names, mechanism) and credit that source.
- An angle is "distinct" when it answers a different QUESTION about the story:
    * What specifically happened (the new fact).
    * Who wins / who loses.
    * The mechanism / why this happened.
    * The second-order effect / what comes next.
    * The contrarian read / why the obvious take is wrong.

For each angle:
- headline: <= 90 chars, declarative, specific. The non-obvious takeaway, not a paraphrase of the parent headline. Lead with a noun + verb + specific.
- description: 2 sentences, 140–280 chars total.
    Sentence 1: the specific fact / claim from the corpus (with numbers / names when available).
    Sentence 2: the synthesis the writer offered (mechanism, comparison, or second-order effect).
- source_badge: the EXACT source label as it appeared in the corpus header — newsletter name (e.g. "The Information", "Stratechery") OR web domain label (e.g. "Reuters", "Nytimes"). Take it verbatim from the [NEWSLETTER: ...] or [WEB: ...] tag above the excerpt you used.

Voice rules (Sequoia memo / Stratechery long-form):
- Declarative, fact-dense, names + figures.
- Forbidden words / phrases: 'game-changer', 'revolutionary', 'stunning', 'shocking', 'epic', 'dramatic', 'massive', 'unprecedented' (unless literally true), 'watershed', 'sea change', 'paradigm shift', 'this could prove', 'only time will tell', 'quiet', 'hard to miss', 'looms', 'in the making', 'pivotal moment'.

Return ONLY valid JSON — no markdown, no preamble:
{
  "results": [
    {
      "story_index": 0,
      "angles": [
        { "headline": "...", "description": "...", "source_badge": "..." }
      ]
    }
  ]
}

Critical:
- One entry per input story, in input order. story_index matches input position.
- Aim for 3-5 angles per story. Returning fewer than 3 means the corpus genuinely doesn't support more — but check carefully before settling for 1-2.
- If a story has NO usable corpus (truly empty), return an empty angles array.`;

function _buildBatchPrompt(stories, corpusByIndex) {
  const blocks = stories.map((s, i) => {
    const { corpus } = corpusByIndex[i] || { corpus: '' };
    return `[STORY ${i}] ${s.headline}

CORPUS:
${corpus || '(no corpus available)'}`;
  }).join('\n\n==========\n\n');
  return `Identify 3-5 distinct angles from each story's corpus. Return JSON per the schema.\n\n${blocks}`;
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

// ── Per-angle URL + image attachment ────────────────────────────────────────

/**
 * Find a clickable URL + image for an angle. Synchronous — no new HTTP calls.
 *
 * Strategy (no per-angle web search; that adds 20+ search calls and was the
 * dominant slowdown):
 *   1. If the angle's source_badge matches a Pass-4 contributor, reuse that
 *      contributor's url + image.
 *   2. If the badge matches the parent story's source, use parentUrl.
 *   3. Otherwise pick the FIRST web contributor as a generic article link.
 *   4. Last resort: parentUrl, or null (undraw illustration takes over).
 */
function _findArticleForAngle(angleHeadline, badge, parentSrc, parentUrl, contributors = []) {
  const badgeLower = (badge || '').toLowerCase();
  const badgeFirst = badgeLower.split(/\s+/)[0];

  // 1) reuse contributor URL when badge matches
  if (badgeFirst && contributors.length) {
    const match = contributors.find(c => c.url && String(c.source).toLowerCase().includes(badgeFirst));
    if (match) {
      return { url: match.url, source: match.source, image: match.image || null };
    }
  }

  // 2) parent URL when badge matches parent source
  if (parentUrl && badgeFirst && parentSrc &&
      parentSrc.toLowerCase().includes(badgeFirst)) {
    return { url: parentUrl, source: parentSrc, image: null };
  }

  // 3) any web contributor as a generic source link (better than nothing)
  const firstWeb = contributors.find(c => c.url && c.kind === 'web');
  if (firstWeb) {
    return { url: firstWeb.url, source: firstWeb.source, image: firstWeb.image || null };
  }

  // 4) parent URL as last resort
  if (parentUrl) return { url: parentUrl, source: parentSrc || badge || '', image: null };
  return null;
}

function _attachSourcesAndImages(story, angles, contributors) {
  const parentSrc = (story.source || '').split(',')[0].trim();
  const parentUrl = story.sourceUrl || story.url || '';
  const undraw = require('./undraw');

  // No async work — all URL/image data is reused from corpus contributors.
  return angles.map(a => {
    const badge = a.source_badge || parentSrc;
    const found = _findArticleForAngle(a.headline, badge, parentSrc, parentUrl, contributors);
    return {
      headline:       a.headline,
      description:    a.description,
      source_badge:   badge,
      source:         badge || (found?.source || parentSrc || ''),
      sourceUrl:      found?.url || parentUrl || '',
      image:          found?.image || undraw.pick(a.headline || story.headline || ''),
      internetSource: !!found?.url && found.url !== parentUrl,
    };
  });
}

// ── Fallback synthesis when LLM returns empty ───────────────────────────────

function _fallbackAngles(story, contributors) {
  const out = [];
  for (const c of contributors.slice(0, 3)) {
    const firstSentence = (String(c.excerpt).match(/^[^.!?]{20,260}[.!?]/)?.[0] || c.excerpt.slice(0, 200)).trim();
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
 * @param {string}  model        digestModel (IGNORED — angles always uses Sonnet)
 * @param {Array}   entries      raw newsletter entries (each: { source, bodyText, ... })
 */
async function buildAnglesForTopStories(stories, useInternet, model, entries = []) {
  if (!Array.isArray(stories) || !stories.length) return { topic_clusters: [] };
  const top = stories.slice(0, 5);

  // 1) Build per-story corpus (newsletter + web). Run in parallel.
  const corpusByIndex = await Promise.all(top.map(async (s, i) => {
    const result = await buildCorpus(s, entries, useInternet);
    const nlCount = result.contributors.filter(c => c.kind === 'newsletter').length;
    const webCount = result.contributors.filter(c => c.kind === 'web').length;
    console.log(`[angles] story ${i} "${(s.headline || '').slice(0, 60)}" — corpus: ${result.corpus.length}c | nl=${nlCount} web=${webCount}`);
    return result;
  }));

  // 2) ONE batched Sonnet call for all 5 stories.
  let parsed = null;
  try {
    const prompt = _buildBatchPrompt(top, corpusByIndex);
    console.log(`[angles] calling ${SONNET_MODEL} with batched prompt (${prompt.length}c across ${top.length} stories)`);
    const raw    = await _callModel(SONNET_MODEL, prompt, ANGLES_BATCH_SYSTEM);
    parsed = _parseBatchResponse(raw, top.length);
    if (!parsed) console.warn('[angles] batched LLM call returned no parseable JSON. Raw head:', (raw || '').slice(0, 300));
  } catch (e) {
    console.warn('[angles] batched LLM call failed:', e.message);
  }

  // 3) For each story, attach URLs/images synchronously — no new HTTP calls.
  //    Use _fallbackAngles only if LLM returned nothing AND we have at least
  //    one contributor.
  const finalAngles = top.map((s, i) => {
    const llmAngles = parsed?.[i] || [];
    const contributors = corpusByIndex[i].contributors;
    const angles = llmAngles.length
      ? llmAngles
      : (contributors.length ? _fallbackAngles(s, contributors) : []);
    if (!angles.length) return [];
    return _attachSourcesAndImages(s, angles, contributors);
  });

  // 4) Mutate each top story + build topic_clusters[] for UI.
  const topic_clusters = top.map((s, i) => {
    const angles = finalAngles[i];
    s.angles = angles;
    const firstNewsletterContrib = corpusByIndex[i].contributors.find(c => c.kind === 'newsletter');
    return {
      topic:   s.headline,
      summary: (firstNewsletterContrib?.excerpt || corpusByIndex[i].contributors[0]?.excerpt || '')
                 .split(/\n\n/)[0]
                 .slice(0, 280),
      image:   (s.image && !BAD_IMAGE.test(s.image) ? s.image : null)
               || require('./undraw').pick(s.headline),
      stories: angles,
    };
  }).filter(c => c.stories && c.stories.length > 0);

  // 5) Image upgrade: OG-scrape + Serper Images cascade for any undraw fallbacks.
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

  console.log(`[angles] produced ${topic_clusters.length} deep-dive clusters with ${finalAngles.reduce((n, a) => n + a.length, 0)} total angles (corpus-grounded, sonnet)`);
  return { topic_clusters };
}

module.exports = { buildAnglesForTopStories, buildCorpus };
