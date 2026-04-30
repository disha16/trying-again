'use strict';
/* ────────────────────────────────────────────────────────────────────────────
 * ROLLING PREFERENCES
 *
 * A single bounded "preferences" block (~1500 char cap) that captures every
 * signal the user has given us about how the digest should be shaped.
 *
 * Signal sources fed in:
 *   1. Persona quiz answers (settings.persona)
 *   2. Persona-trainer learned rules (personaTraining[*].rules)
 *   3. Yesterday's thumbs-up / thumbs-down feedback
 *
 * One Supabase key — `compactedPreferences` — holds:
 *   { text, lastUpdated, sources[] }
 *
 * Update triggers (all run the same compactor):
 *   - 2:30 PM cron (after thumbs feedback for yesterday)
 *   - On persona quiz save
 *   - On persona-trainer "approve" click
 *
 * Runtime: Researcher / Reporter / Editor read .text and inject it
 * verbatim into their system prompts.
 * ──────────────────────────────────────────────────────────────────────────── */

const storage = require('./storage');
const { _callModel } = require('./digest-generator');

const MAX_CHARS = 1500;

const COMPACTOR_SYSTEM = `You are maintaining a rolling preferences block for an investor-focused news-digest AI.

You will receive:
  - The CURRENT preferences block (may be empty on first run)
  - NEW SIGNALS from the user (quiz answers, trainer feedback, thumbs ratings)

Your job: produce an UPDATED preferences block that merges new signals while preserving still-relevant old ones.

OUTPUT RULES:
- Hard cap: ${MAX_CHARS} characters total. Be ruthless.
- Single block of plain text, organised into three labelled sections:
    TOPICS:       which sectors / companies / themes to lean into or de-emphasise
    EDITORIAL:    length, level of detail, numbers vs context, writing voice
    HARD RULES:   things to always or never do (e.g. "never repeat the same source twice in top 10")
- If a new signal contradicts an old one, the new one wins. Drop the old one entirely.
- Drop redundant items. Drop items more than 14 days old unless reinforced by recent signals.
- Be specific and actionable: "prioritise semiconductor supply-chain" beats "more tech".
- DO NOT add filler. DO NOT explain your work. Output the block directly.
- DO NOT undermine the baseline investor-tone voice — if the user upvoted a sensational headline, treat it as a TOPIC signal, not a request for sensational language.

The output goes verbatim into tomorrow's digest reporter prompt. Make it count.`;

/**
 * Compact existing preferences + new signals into an updated bounded block.
 *
 * @param {string} existingText - current preferences block (may be '')
 * @param {string} newSignalsText - free-form text describing new signals
 * @param {string[]} sourceLabels - labels for what signals were merged
 * @param {string} model - LLM model id
 * @returns {Promise<{text:string,lastUpdated:string,sources:string[]}>}
 */
async function compact(existingText, newSignalsText, sourceLabels, model) {
  const prompt = [
    'CURRENT PREFERENCES BLOCK:',
    existingText ? existingText : '(empty — this is the first run)',
    '',
    '---',
    '',
    'NEW SIGNALS (merge these in):',
    newSignalsText,
    '',
    '---',
    '',
    `Produce the updated preferences block now. Hard cap ${MAX_CHARS} chars. No preamble.`
  ].join('\n');

  let raw = '';
  try {
    raw = await _callModel(model, prompt, COMPACTOR_SYSTEM);
  } catch (e) {
    console.warn('[preferences] compactor LLM call failed:', e.message);
    // Best-effort fallback: just append new signals tail-trimmed to cap
    const merged = (existingText + '\n\n' + newSignalsText).trim().slice(-MAX_CHARS);
    return { text: merged, lastUpdated: new Date().toISOString(), sources: sourceLabels };
  }

  // Trim hard to MAX_CHARS in case the LLM ignored the cap
  const trimmed = (raw || '').trim().slice(0, MAX_CHARS);
  return { text: trimmed, lastUpdated: new Date().toISOString(), sources: sourceLabels };
}

/** Read current rolling preferences (or null). */
async function getPreferences() {
  try { return await storage.getKey('compactedPreferences') || null; }
  catch { return null; }
}

/** Read just the .text portion (or empty string). */
async function getPreferenceText() {
  const p = await getPreferences();
  return (p && p.text) ? p.text : '';
}

/** Save preferences (overwrite). */
async function savePreferences(p) {
  await storage.setKey('compactedPreferences', p);
}

/* ─── Signal collectors ─────────────────────────────────────────────────────── */

function summarisePersonaQuiz(persona) {
  if (!persona || typeof persona !== 'object') return '';
  const lines = [];
  if (persona.angle)  lines.push(`- Reading angle: ${persona.angle}`);
  if (persona.role)   lines.push(`- Role: ${persona.role}`);
  if (persona.depth)  lines.push(`- Preferred depth: ${persona.depth}`);
  if (persona.speed)  lines.push(`- Preferred speed: ${persona.speed}`);
  if (persona.format) lines.push(`- Format preference: ${persona.format}`);
  if (Array.isArray(persona.topics) && persona.topics.length) lines.push(`- Topics emphasised: ${persona.topics.join(', ')}`);
  if (Array.isArray(persona.avoidTopics) && persona.avoidTopics.length) lines.push(`- Topics to avoid: ${persona.avoidTopics.join(', ')}`);
  return lines.length ? `From persona quiz:\n${lines.join('\n')}` : '';
}

async function summariseTrainerRules() {
  try {
    const all = await storage.getKey('personaTraining') || {};
    const sections = [];
    for (const persona of ['researcher', 'reporter', 'editor']) {
      const rules = all[persona]?.rules;
      if (Array.isArray(rules) && rules.length) {
        sections.push(`From persona-trainer (${persona}):\n` + rules.map((r, i) => `- ${r}`).join('\n'));
      }
    }
    return sections.join('\n\n');
  } catch { return ''; }
}

function summariseThumbsFeedback(feedback, dateKey) {
  if (!Array.isArray(feedback) || !feedback.length) return '';
  const ups   = feedback.filter(f => f.vote === 'up')  .map(f => `- 👍 "${f.headline}" (${f.category})`);
  const downs = feedback.filter(f => f.vote === 'down').map(f => `- 👎 "${f.headline}" (${f.category})`);
  const parts = [`From thumbs feedback on ${dateKey}:`];
  if (ups.length)   parts.push(...ups);
  if (downs.length) parts.push(...downs);
  return parts.join('\n');
}

/* ─── Public update helpers ─────────────────────────────────────────────────── */

/**
 * Recompact after an event. Pulls all current signals and merges into the
 * existing preferences block.
 *
 * @param {string} reason - "persona-quiz" | "trainer-approve" | "daily-2:30pm"
 * @param {object} opts - { feedbackDateKey?, model? }
 */
async function recompact(reason, opts = {}) {
  const settings = await storage.getSettings();
  const model = opts.model
    || (settings.digestModel === 'claude-cli' ? 'llama-3.3-70b-versatile' : settings.digestModel)
    || 'llama-3.3-70b-versatile';

  // Collect every current signal so the compactor sees the FULL picture
  // and can drop stale items as needed.
  const signals = [];
  const sourceLabels = [];

  const quizSummary = summarisePersonaQuiz(settings.persona);
  if (quizSummary) { signals.push(quizSummary); sourceLabels.push('persona-quiz'); }

  const trainerSummary = await summariseTrainerRules();
  if (trainerSummary) { signals.push(trainerSummary); sourceLabels.push('trainer-rules'); }

  if (opts.feedbackDateKey) {
    try {
      const fb = await storage.getFeedback(opts.feedbackDateKey);
      const fbSummary = summariseThumbsFeedback(fb, opts.feedbackDateKey);
      if (fbSummary) { signals.push(fbSummary); sourceLabels.push(`feedback-${opts.feedbackDateKey}`); }
    } catch (e) { console.warn('[preferences] feedback fetch failed:', e.message); }
  }

  const newSignalsText = signals.length ? signals.join('\n\n') : `(No new signals — triggered by ${reason}; just compacting/cleaning existing block.)`;

  const existing = await getPreferences();
  const existingText = (existing && existing.text) ? existing.text : '';

  // If there's literally nothing to work with, don't waste an LLM call
  if (!existingText && !signals.length) {
    console.log(`[preferences] recompact skipped (${reason}): no signals, no existing block`);
    return null;
  }

  const updated = await compact(existingText, newSignalsText, sourceLabels, model);
  await savePreferences(updated);
  console.log(`[preferences] recompacted (${reason}): ${updated.text.length} chars, sources=[${sourceLabels.join(', ')}]`);
  return updated;
}

module.exports = {
  getPreferences,
  getPreferenceText,
  savePreferences,
  recompact,
  // exported for tests / debug
  compact,
  summarisePersonaQuiz,
  summariseTrainerRules,
  summariseThumbsFeedback,
};
