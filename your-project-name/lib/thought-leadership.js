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

async function pickImageForTopic(topic, entry) {
  // Always prefer an image that's actually in the email (real, on-brand).
  const fromEmail = firstImageFrom(entry);
  if (fromEmail) return fromEmail;
  // TODO(prof-gupta): random-image archive intentionally disabled until you
  // choose a provider (Unsplash access key, your own S3 bucket, etc.). See
  // README “Thought Leadership image archive” for the three supported paths.
  return null;
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
    keyPoints:        Array.isArray(parsed.key_points) ? parsed.key_points.slice(0, 3) : [],
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
