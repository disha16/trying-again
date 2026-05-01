'use strict';

/**
 * Thought Leadership pipeline.
 *
 * Takes email entries tagged with kind='thought_leadership' from the 3pm-to-3pm
 * window and turns each into a 1-minute TL;DR card. Deduplication is handled by
 * the existing read_stories table (keyed by email ID + headline hash).
 *
 * Images: if no image is present in the email, we pick a random topical image
 * via Unsplash's `source.unsplash.com` endpoint (no API key required). If the
 * user configures UNSPLASH_ACCESS_KEY we upgrade to the official API for
 * higher-quality matches. We cache the image URL per email id in Supabase so
 * the same card keeps the same image across refreshes.
 */

const { _callModel } = require('./digest-generator');
const supa           = require('./supabase');

const TLDR_SYSTEM = `You are a business-school tutor. Summarise the attached essay for a senior executive.

Rules:
- Produce a JSON object with: title (string, pithy 6-10 words), tldr (string, 60-90 words, MUST take ~60s to read aloud), key_points (array of 3 short bullets, <12 words each), reading_minutes (integer).
- Do not reference "the author" or "the article"; speak the ideas in active voice.
- No preamble, no markdown, ONLY JSON.`;

function firstImageFrom(entry) {
  return entry.imageUrls?.find(u => /\.(jpe?g|png|webp)(?:\?|$)/i.test(u)) || null;
}

function unsplashSourceUrl(query, width = 800, height = 500) {
  const q = encodeURIComponent(query.split(/\s+/).slice(0, 4).join(','));
  return `https://source.unsplash.com/${width}x${height}/?${q}`;
}

async function unsplashOfficial(query) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=10&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${key}` } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const pool = data.results || [];
    if (!pool.length) return null;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return pick.urls?.regular || pick.urls?.small || null;
  } catch { return null; }
}

/* ──────────────────────────────────────────────────────────────────────
 * Curated "graphic-illustration" archive.
 *
 * 8 flat-style inline SVGs. They ship with the repo (no CDN, no rate
 * limits, no 404s), match the brand palette (cream + terracotta accent),
 * and are selected deterministically by card id so a given card keeps
 * its picture across refreshes.
 *
 * Swap for a real asset library later by replacing ILLUSTRATION_ARCHIVE
 * with URLs pointing at your own S3 bucket or a Bing/Unsplash API call.
 * ────────────────────────────────────────────────────────────────────── */
const ILLO_PALETTE = { bg: '#FAF4EA', ink: '#2F2A26', accent: '#D97B5C', soft: '#F2D8C2', line: '#6B4E3D' };
const ILLO = (svg) =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 280" preserveAspectRatio="xMidYMid slice">${svg}</svg>`
  );
const ILLUSTRATION_ARCHIVE = [
  // 0 — Reader with an open book
  ILLO(`<rect width="480" height="280" fill="${ILLO_PALETTE.bg}"/>
    <circle cx="240" cy="150" r="90" fill="${ILLO_PALETTE.soft}"/>
    <rect x="170" y="160" width="140" height="70" rx="6" fill="#fff" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <line x1="240" y1="160" x2="240" y2="230" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <circle cx="240" cy="115" r="22" fill="${ILLO_PALETTE.accent}"/>
    <rect x="215" y="130" width="50" height="35" rx="10" fill="${ILLO_PALETTE.accent}"/>
    <g stroke="${ILLO_PALETTE.line}" stroke-width="1.5" fill="none">
      <line x1="185" y1="180" x2="225" y2="180"/><line x1="185" y1="195" x2="225" y2="195"/><line x1="185" y1="210" x2="215" y2="210"/>
      <line x1="255" y1="180" x2="295" y2="180"/><line x1="255" y1="195" x2="295" y2="195"/><line x1="255" y1="210" x2="285" y2="210"/>
    </g>`),
  // 1 — Lightbulb idea
  ILLO(`<rect width="480" height="280" fill="${ILLO_PALETTE.bg}"/>
    <circle cx="240" cy="130" r="70" fill="#FFE9A8" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <rect x="215" y="195" width="50" height="18" rx="4" fill="${ILLO_PALETTE.line}"/>
    <rect x="220" y="213" width="40" height="14" rx="4" fill="${ILLO_PALETTE.ink}"/>
    <rect x="228" y="227" width="24" height="10" rx="3" fill="${ILLO_PALETTE.ink}"/>
    <g stroke="${ILLO_PALETTE.accent}" stroke-width="3" stroke-linecap="round">
      <line x1="240" y1="35" x2="240" y2="55"/><line x1="155" y1="130" x2="135" y2="130"/><line x1="325" y1="130" x2="345" y2="130"/>
      <line x1="180" y1="70" x2="165" y2="55"/><line x1="300" y1="70" x2="315" y2="55"/>
    </g>
    <path d="M225 130 Q240 105 255 130 L250 155 L230 155 Z" fill="none" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>`),
  // 2 — Upward chart
  ILLO(`<rect width="480" height="280" fill="${ILLO_PALETTE.bg}"/>
    <rect x="60" y="60" width="360" height="180" rx="10" fill="#fff" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <line x1="80" y1="220" x2="400" y2="220" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <line x1="80" y1="220" x2="80"  y2="80"  stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <polyline points="80,210 140,180 200,190 260,140 320,150 380,90" fill="none" stroke="${ILLO_PALETTE.accent}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
    <g fill="${ILLO_PALETTE.accent}"><circle cx="80" cy="210" r="5"/><circle cx="140" cy="180" r="5"/><circle cx="200" cy="190" r="5"/><circle cx="260" cy="140" r="5"/><circle cx="320" cy="150" r="5"/><circle cx="380" cy="90" r="5"/></g>
    <path d="M370 100 L395 75 L395 110 Z" fill="${ILLO_PALETTE.accent}"/>`),
  // 3 — Coffee + notes
  ILLO(`<rect width="480" height="280" fill="${ILLO_PALETTE.bg}"/>
    <circle cx="180" cy="150" r="60" fill="${ILLO_PALETTE.soft}"/>
    <path d="M130 140 Q130 190 180 200 Q230 190 230 140 Z" fill="#fff" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <path d="M220 150 Q255 150 255 170 Q255 190 220 185" fill="none" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <g stroke="${ILLO_PALETTE.accent}" stroke-width="2.5" fill="none" stroke-linecap="round">
      <path d="M170 120 Q175 110 170 100 Q165 90 170 80"/><path d="M190 120 Q195 110 190 100 Q185 90 190 80"/>
    </g>
    <rect x="290" y="110" width="130" height="100" rx="6" fill="#fff" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <g stroke="${ILLO_PALETTE.line}" stroke-width="1.5"><line x1="305" y1="130" x2="395" y2="130"/><line x1="305" y1="150" x2="395" y2="150"/><line x1="305" y1="170" x2="395" y2="170"/><line x1="305" y1="190" x2="370" y2="190"/></g>`),
  // 4 — Network / connected nodes
  ILLO(`<rect width="480" height="280" fill="${ILLO_PALETTE.bg}"/>
    <g stroke="${ILLO_PALETTE.line}" stroke-width="1.5" fill="none">
      <line x1="120" y1="80"  x2="240" y2="140"/><line x1="360" y1="80" x2="240" y2="140"/>
      <line x1="120" y1="200" x2="240" y2="140"/><line x1="360" y1="200" x2="240" y2="140"/>
      <line x1="120" y1="80"  x2="120" y2="200"/><line x1="360" y1="80" x2="360" y2="200"/>
    </g>
    <circle cx="240" cy="140" r="34" fill="${ILLO_PALETTE.accent}"/>
    <circle cx="120" cy="80"  r="22" fill="${ILLO_PALETTE.soft}" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <circle cx="360" cy="80"  r="22" fill="${ILLO_PALETTE.soft}" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <circle cx="120" cy="200" r="22" fill="${ILLO_PALETTE.soft}" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <circle cx="360" cy="200" r="22" fill="${ILLO_PALETTE.soft}" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>`),
  // 5 — Mountain + flag (achievement)
  ILLO(`<rect width="480" height="280" fill="${ILLO_PALETTE.bg}"/>
    <polygon points="60,240 180,80 300,240" fill="${ILLO_PALETTE.soft}" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <polygon points="240,240 340,110 440,240" fill="#fff" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <polygon points="150,140 180,80 210,140" fill="#fff" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <line x1="340" y1="110" x2="340" y2="60" stroke="${ILLO_PALETTE.ink}" stroke-width="3"/>
    <polygon points="340,60 375,70 340,80" fill="${ILLO_PALETTE.accent}"/>
    <circle cx="90" cy="70" r="18" fill="${ILLO_PALETTE.accent}"/>`),
  // 6 — Quote bubble
  ILLO(`<rect width="480" height="280" fill="${ILLO_PALETTE.bg}"/>
    <path d="M100 80 H380 A20 20 0 0 1 400 100 V180 A20 20 0 0 1 380 200 H220 L190 230 L200 200 H100 A20 20 0 0 1 80 180 V100 A20 20 0 0 1 100 80 Z"
          fill="#fff" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <text x="160" y="155" font-family="Georgia, serif" font-size="110" fill="${ILLO_PALETTE.accent}">“</text>
    <g stroke="${ILLO_PALETTE.line}" stroke-width="2"><line x1="225" y1="130" x2="370" y2="130"/><line x1="225" y1="155" x2="370" y2="155"/><line x1="225" y1="180" x2="320" y2="180"/></g>`),
  // 7 — Paper airplane + trail
  ILLO(`<rect width="480" height="280" fill="${ILLO_PALETTE.bg}"/>
    <path d="M100 220 Q200 160 260 170 Q330 180 350 130" fill="none" stroke="${ILLO_PALETTE.accent}" stroke-width="3" stroke-dasharray="6 8" stroke-linecap="round"/>
    <polygon points="340,110 400,90 380,160 355,145 340,170" fill="${ILLO_PALETTE.soft}" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <polygon points="340,110 380,160 355,145" fill="#fff" stroke="${ILLO_PALETTE.line}" stroke-width="2"/>
    <circle cx="100" cy="220" r="6" fill="${ILLO_PALETTE.accent}"/>`),
];
function _hashToIdx(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % ILLUSTRATION_ARCHIVE.length;
}

async function pickImageForTopic(topic, entry) {
  // Always prefer an image that's actually in the email (real, on-brand).
  const fromEmail = firstImageFrom(entry);
  if (fromEmail) return fromEmail;
  // Deterministic fallback: every card keeps the same picture across refreshes.
  const key = String(entry?.id || entry?.source || topic || 'tl');
  return require('./undraw').pick(key);
}

async function summariseOne(entry, model) {
  const subject = (entry.subject || '').replace(/^(fw|fwd|re):\s*/i, '').trim();
  const prompt  = `Subject: ${subject}\nSource: ${entry.source}\n\n---\n${entry.bodyText.slice(0, 6000)}`;
  const raw     = await _callModel(model, prompt, TLDR_SYSTEM);
  const match   = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('model returned no JSON');
  const parsed = JSON.parse(match[0]);
  return {
    id:               `tl:${entry.id}`,
    emailId:          entry.id,
    source:           entry.source,
    title:            parsed.title || subject || 'Untitled',
    tldr:             parsed.tldr || '',
    keyPoints:        Array.isArray(parsed.key_points)
                       ? parsed.key_points.slice(0, 3).map(p => String(p).replace(/\s*\.\s*$/, '').trim())
                       : [],
    readingMinutes:   parsed.reading_minutes || 1,
  };
}

/**
 * Build the Thought Leadership deck from a pre-filtered list of entries (only
 * those with kind === 'thought_leadership'). Dedupes against already-read items.
 *
 * @param {Array<{id, source, subject, bodyText, imageUrls}>} entries
 * @param {string} model
 * @param {Set<string>} alreadyReadIds  – ids already shown to the user
 */
async function buildThoughtLeadershipDeck(entries, model = 'llama-3.3-70b-versatile', alreadyReadIds = new Set()) {
  const fresh = entries.filter(e => !alreadyReadIds.has(`tl:${e.id}`)).slice(0, 8);
  const cards = [];
  for (const e of fresh) {
    try {
      const card = await summariseOne(e, model);
      // Topic keywords for image selection: pull 3-5 nouns from the tldr + title
      const topic = (card.title + ' ' + card.tldr)
        .replace(/[^a-zA-Z\s]/g, ' ')
        .split(/\s+/).filter(w => w.length > 5).slice(0, 3).join(' ') || 'ideas';
      card.image = await pickImageForTopic(topic, e);
      // If we ended up on undraw, try Serper Images using the actual title +
      // publisher name — that usually returns the publisher's own hero image.
      if (card.image && /cdn\.jsdelivr\.net\/gh\/balazser\/undraw/i.test(card.image)) {
        try {
          const { findImage } = require('./image-fallback');
          const better = await findImage(card.title, card.source);
          if (better) card.image = better;
        } catch { /* keep undraw */ }
      }
      cards.push(card);
    } catch (err) {
      console.warn(`[tl] failed to summarise ${e.id}: ${err.message}`);
    }
  }
  return cards;
}

// Mark a TL card as read (mirrors the read_stories flow)
async function markTLRead(cardId) {
  try {
    await supa.markRead({
      headline:  cardId,                 // using the id directly so dedupe is exact
      keywords:  [],
      category:  'thought_leadership',
      source:    'thought_leadership',
    });
  } catch (e) { console.warn('[tl] markRead failed:', e.message); }
}

async function getReadTLIds() {
  try {
    const items = await supa.listReadStories({ limit: 500 });
    return new Set(items.filter(r => r.category === 'thought_leadership').map(r => r.headline));
  } catch { return new Set(); }
}

module.exports = { buildThoughtLeadershipDeck, markTLRead, getReadTLIds };

/**
 * Fallback: when the user has no kind='thought_leadership' senders (or none
 * delivered in the last 7 days), generate 3-5 short TL-style cards distilled
 * from the day's top stories using the chosen LLM. Pure LLM — no web search.
 *
 * @param {Array} topStories  digest.top_today (each has headline, summary, source, url)
 * @param {string} model
 */
async function buildLLMFallbackDeck(topStories, model = 'gpt-4.1-mini') {
  if (!Array.isArray(topStories) || !topStories.length) return [];
  const compact = topStories.slice(0, 10).map((s, i) =>
    `${i + 1}. ${s.headline}\n   ${(s.summary || '').slice(0, 220)}\n   (${s.source || ''})`
  ).join('\n\n');

  const SYSTEM = `You are a senior strategist. Read today's top business/tech headlines and produce 3-5 *thought-leadership cards*: each one a sharp, framework-style takeaway that an executive could use in a meeting tomorrow.

Output ONLY a JSON array. Each item:
{
  "title":           "<6-10 words, punchy>",
  "tldr":            "<60-90 words, ~60s read aloud, active voice, no 'the article' references>",
  "key_points":      ["<bullet 1, <12 words>", "<bullet 2>", "<bullet 3>"],
  "reading_minutes": 1,
  "source_label":    "<which 1-2 headlines this synthesises, comma-separated, max 60 chars>"
}

Rules:
- Synthesise across multiple headlines when there is a pattern; don't just rephrase one story.
- No preamble, no markdown fences, just the JSON array.`;

  let raw;
  try {
    raw = await _callModel(model, compact, SYSTEM);
  } catch (e) {
    console.warn('[tl-fallback] LLM call failed:', e.message);
    return [];
  }
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return []; }
  if (!Array.isArray(parsed)) return [];

  return parsed.slice(0, 5).map((p, idx) => {
    const id = `tl:llm:${new Date().toISOString().slice(0, 10)}:${idx}`;
    const topic = (p.title || '') + ' ' + (p.tldr || '');
    const imgKey = id;
    return {
      id,
      emailId:        null,
      source:         p.source_label || 'Today\u2019s headlines',
      title:          p.title || 'Untitled',
      tldr:           p.tldr || '',
      keyPoints:      Array.isArray(p.key_points)
                       ? p.key_points.slice(0, 3).map(s => String(s).replace(/\s*\.\s*$/, '').trim())
                       : [],
      readingMinutes: p.reading_minutes || 1,
      image:          require('./undraw').pick(imgKey),  // overridden below if Serper finds a real image
      isLLMFallback:  true,
      _imgQuery:      `${p.title || ''} ${p.source_label || ''}`.trim(),
    };
  });
}

// LLM-fallback cards: try to upgrade undraw to a real publisher image via Serper.
module.exports.upgradeLLMFallbackImages = async function (cards) {
  if (!Array.isArray(cards) || !cards.length) return cards;
  const { findImage } = require('./image-fallback');
  await Promise.all(cards.map(async c => {
    if (!c?._imgQuery) return;
    try {
      const img = await findImage(c._imgQuery);
      if (img) c.image = img;
    } catch { /* keep undraw */ }
    delete c._imgQuery;
  }));
  return cards;
};

module.exports.buildLLMFallbackDeck = buildLLMFallbackDeck;
