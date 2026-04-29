'use strict';

const { _callModel }       = require('./digest-generator');
const { getInjectedRules } = require('./persona-trainer');

const DEFAULT_CATS = ['top_today','tech','us_business','india_business','global_economies','politics','everything_else'];

const EDITOR_SYSTEM_BASE = `You are a senior news editor. Your job is to:
1. Eliminate repetition within and across sections (each story appears in EXACTLY ONE section)
2. Move misplaced stories to the right category
3. Re-rank stories within each section in order of global importance (most important first)

RULES:
1. CROSS-SECTION DUPLICATES: If the same story appears in multiple sections, keep it in the MOST IMPORTANT section and remove it from the others. top_today > all category sections, so a story in top_today + a category should remain only in top_today.
2. WITHIN-SECTION NEAR-DUPLICATES: If two stories in the SAME section cover the same event (even with different angles), remove the weaker one.
3. SECTION DISCIPLINE:
   - top_today: the 10 most globally important stories of the day, one per distinct major topic
   - tech: technology companies, AI, software, hardware — NOT general business
   - us_business: US-headquartered companies, US domestic economy, Wall Street — NOT international
   - india_business: India-specific business, Sensex, Indian companies, Indian economy
   - global_economies: non-US international economies, trade between countries, foreign central banks, EM markets — NOT US company news
   - politics: government, elections, policy, geopolitics — NOT pure business unless policy-driven
   - everything_else: genuine miscellany that doesn't fit above
4. ORDERING: Within each section, rank by importance — macro market moves, geopolitical events, and landmark decisions before routine company news.
5. Do NOT remove a story just because it's similar in topic — only remove true repetition of the SAME EVENT.

Return ONLY valid JSON — no markdown, no explanation:
{
  "remove": {
    "top_today": ["exact headline to remove", ...],
    "tech": [],
    "us_business": [],
    "india_business": [],
    "global_economies": [],
    "politics": [],
    "everything_else": []
  },
  "move": [
    { "headline": "exact headline", "from": "us_business", "to": "global_economies" }
  ],
  "reorder": {
    "us_business": ["headline in priority order", "second most important", ...],
    "tech": [],
    "india_business": [],
    "global_economies": [],
    "politics": [],
    "everything_else": [],
    "top_today": []
  }
}

Use exact headline strings. "move" and "reorder" are optional — only include if needed.`;

// Soft persona layer for editor: only used to break ties when re-ranking, never to remove items
function editorPersonaLayer(persona) {
  if (!persona || typeof persona !== 'object') return '';
  const lines = [];
  if (persona.scope === 'global')   lines.push('- When two stories tie on importance, prefer the more globally significant one');
  if (persona.scope === 'us')       lines.push('- When two stories tie on importance, prefer the US-centric one');
  if (persona.angle === 'investing')lines.push('- When two stories tie, prefer the one with clearer market/portfolio impact');
  if (persona.tech === 'heavy')     lines.push('- When two stories tie, prefer AI/software/semiconductor angles');
  if (persona.tech === 'light')     lines.push('- When two stories tie, prefer non-tech angles');
  if (persona.politics === 'lots')  lines.push('- Keep significant geopolitical/policy stories visible in top_today');
  if (persona.politics === 'minimal') lines.push('- Push pure-politics stories down in top_today, but DO NOT remove them — they belong in the politics section');
  if (!lines.length) return '';
  return `\n\nREADER PREFERENCE LAYER (tiebreaker only — never use this to remove stories):\n${lines.join('\n')}`;
}

async function editDigest(digest, model, customSections = [], persona = null) {
  // Inject learned rules from persona trainer
  let learnedRules = '';
  try { learnedRules = await getInjectedRules('editor'); } catch {}

  const personaLayer = editorPersonaLayer(persona);
  const system = `${EDITOR_SYSTEM_BASE}${learnedRules ? `\n${learnedRules}` : ''}${personaLayer}`;

  const CATS = [...DEFAULT_CATS, ...customSections.map(s => s.id)];

  // Build compact view of all sections for the LLM
  const sections = {};
  for (const cat of CATS) {
    const items = digest[cat];
    if (!Array.isArray(items) || !items.length) continue;
    sections[cat] = items.map((item, i) => `  [${i}] ${item.headline}`).join('\n');
  }

  const sectionText = Object.entries(sections)
    .map(([cat, lines]) => `${cat.toUpperCase()}:\n${lines}`)
    .join('\n\n');

  const prompt = `Review this digest — remove duplicates, fix misplaced stories, and re-rank each section by importance:\n\n${sectionText}`;

  let raw;
  try {
    raw = await _callModel(model, prompt, system);
  } catch (e) {
    console.warn('[editor] LLM call failed:', e.message);
    return digest;
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) { console.warn('[editor] No JSON in response'); return digest; }

  let edits;
  try { edits = JSON.parse(match[0]); } catch { console.warn('[editor] JSON parse failed'); return digest; }

  let totalRemoved = 0;
  let totalMoved   = 0;
  let totalReordered = 0;

  // Apply removals
  if (edits.remove && typeof edits.remove === 'object') {
    for (const cat of CATS) {
      const toRemove = edits.remove[cat];
      if (!Array.isArray(toRemove) || !toRemove.length) continue;
      const removeSet = new Set(toRemove.map(h => h.toLowerCase().trim()));
      const before = (digest[cat] || []).length;
      digest[cat] = (digest[cat] || []).filter(item => !removeSet.has((item.headline || '').toLowerCase().trim()));
      totalRemoved += before - digest[cat].length;
    }
  }

  // Apply moves
  if (Array.isArray(edits.move)) {
    for (const { headline, from, to } of edits.move) {
      if (!headline || !CATS.includes(from) || !CATS.includes(to)) continue;
      const key = headline.toLowerCase().trim();
      const idx = (digest[from] || []).findIndex(i => i.headline?.toLowerCase().trim() === key);
      if (idx === -1) continue;
      const [item] = digest[from].splice(idx, 1);
      digest[to] = digest[to] || [];
      digest[to].push(item);
      totalMoved++;
    }
  }

  // Apply reordering — match by headline, rebuild array in priority order
  if (edits.reorder && typeof edits.reorder === 'object') {
    for (const cat of CATS) {
      const order = edits.reorder[cat];
      if (!Array.isArray(order) || !order.length) continue;
      const current = digest[cat] || [];
      const byHeadline = new Map(current.map(item => [item.headline?.toLowerCase().trim(), item]));
      const reordered = [];
      for (const h of order) {
        const item = byHeadline.get(h.toLowerCase().trim());
        if (item) { reordered.push(item); byHeadline.delete(h.toLowerCase().trim()); }
      }
      // Append any stories the LLM didn't mention in the reorder list
      reordered.push(...byHeadline.values());
      if (reordered.length) { digest[cat] = reordered; totalReordered++; }
    }
  }

  console.log(`[editor] removed ${totalRemoved} duplicates, moved ${totalMoved}, reordered ${totalReordered} sections`);
  return digest;
}

module.exports = { editDigest };
