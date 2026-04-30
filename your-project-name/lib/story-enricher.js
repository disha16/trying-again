'use strict';

const Exa        = require('exa-js').default;
const { _callModel } = require('./digest-generator');

const CONTEXT_SYSTEM = `You are a sharp senior analyst. Given a news headline and article excerpts, write 2-3 punchy sentences of background context.

Return ONLY a valid JSON array — no markdown, no extra text:
[{ "headline": "...", "context": "..." }, ...]

Rules for each context:
- Sentence 1: Historical background — what led to this moment, concrete facts/figures
- Sentence 2: Why it matters now — the stakes, who is affected, implications
- Sentence 3 (optional only if genuinely adds value): What to watch next
- Tone: sharp analyst, zero filler, no "this is significant" clichés
- Max 240 chars total per context
- Use the exact headline string from the input`;

async function enrichTopStories(topStories, model) {
  if (!topStories?.length) return;
  // Exa master switch — if disabled, we skip the source-excerpt fetch and let
  // the LLM generate context purely from the headline (which it's already
  // willing to do).
  let useExa = false;
  try { useExa = await require('./storage').isExaEnabled(); } catch {}
  const apiKey = process.env.EXA_API_KEY;
  if (!useExa || !apiKey) {
    console.log(`[enricher] Exa ${useExa ? 'key missing' : 'disabled by useExa'} — LLM-only context fallback`);
    const contents = topStories.map(s => ({ headline: s.headline, text: '' }));
    return runLLMContext(contents, topStories, model);
  }

  const exa = new Exa(apiKey);

  // Fetch article content for all stories in parallel
  const contents = await Promise.all(topStories.map(async story => {
    try {
      const res = await exa.searchAndContents(story.headline, {
        numResults:  3,
        category:    'news',
        text:        { maxCharacters: 1200 },
      });
      const text = res.results.map(r => r.text).filter(Boolean).join('\n---\n').slice(0, 3600);
      return { headline: story.headline, text };
    } catch (e) {
      console.warn(`[enricher] Exa fetch failed for "${story.headline.slice(0, 50)}":`, e.message);
      return { headline: story.headline, text: '' };
    }
  }));

  return runLLMContext(contents, topStories, model);
}

// Batched LLM call that turns { headline, text } tuples into 1-2 sentence
// context strings and attaches them to the matching stories in place.
// `text` may be empty (Exa-off path) — the LLM will then rely on headline alone.
async function runLLMContext(contents, topStories, model) {
  const prompt = contents.map((c, i) =>
    `STORY ${i + 1}: ${c.headline}\n${c.text ? `SOURCE EXCERPTS:\n${c.text}` : '(no source content found — use your own knowledge)'}`
  ).join('\n\n===\n\n');

  let raw;
  try {
    raw = await _callModel(model, `Write context for these ${topStories.length} stories:\n\n${prompt}`);
  } catch (e) {
    console.warn('[enricher] LLM call failed:', e.message);
    return;
  }

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) { console.warn('[enricher] No JSON array in response'); return; }

  let contexts;
  try { contexts = JSON.parse(match[0]); } catch { console.warn('[enricher] JSON parse failed'); return; }

  const map = {};
  for (const c of contexts) {
    if (c.headline && c.context) map[c.headline.toLowerCase().trim()] = c.context;
  }

  let attached = 0;
  for (const story of topStories) {
    const ctx = map[story.headline?.toLowerCase().trim()];
    if (ctx) { story.context = ctx; attached++; }
  }
  console.log(`[enricher] context attached to ${attached}/${topStories.length} top stories`);
}

module.exports = { enrichTopStories };
