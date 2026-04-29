'use strict';

const { _callModel } = require('./digest-generator');
const storage = require('./storage');

// ── Synthetic input generators ────────────────────────────────────────────────

const SYNTH_RESEARCHER_SYSTEM = `You are generating a realistic training scenario for a News Researcher AI.

Generate 15 realistic raw news article snippets from today, covering a mix of topics: tech, US business, India business, geopolitics, markets. Include some overlap — 2-3 articles that cover the same underlying story from different angles (e.g. two articles about the same trade deal).

Return ONLY valid JSON:
{
  "articles": [
    { "id": 1, "title": "...", "source": "Reuters/FT/WSJ/Bloomberg/Guardian/etc", "snippet": "2-3 sentence excerpt..." },
    ...
  ]
}

Make the articles feel like real journalism. Include specific names, countries, numbers.`;

const SYNTH_REPORTER_SYSTEM = `You are generating a training scenario for a Reporter AI that turns story clusters into digest entries.

Generate 6 realistic story clusters. Each cluster groups 2-4 related articles about the same event.

Return ONLY valid JSON:
{
  "clusters": [
    {
      "id": 1,
      "category": "tech|us_business|india_business|global_economies|politics|everything_else",
      "headline": "Core event headline",
      "sources": ["Reuters", "FT"],
      "keywords": ["keyword1", "keyword2"],
      "articles": ["Short excerpt 1...", "Short excerpt 2..."]
    },
    ...
  ]
}

Cover a realistic spread: 2 tech, 1 US business, 1 India business, 1 global economies, 1 politics.`;

const SYNTH_EDITOR_SYSTEM = `You are generating a training scenario for an Editor AI that cleans up a news digest.

Generate a flawed digest JSON with these specific problems baked in:
1. One story that appears in BOTH top_today AND its category section (deliberate duplicate)
2. One story in the wrong category (e.g. an international story filed under us_business)
3. Two stories in the same category that cover the same event with slightly different angles
4. One genuinely unique story in each category that is correctly placed

Return ONLY valid JSON — a complete digest object:
{
  "top_today": [{ "headline": "...", "description": "...", "source": "..." }, ...],
  "tech": [...],
  "us_business": [...],
  "india_business": [...],
  "global_economies": [...],
  "politics": [...],
  "everything_else": [...]
}

Use 5-8 items in top_today, 3-5 items per category. Make it feel like real news. Embed the problems naturally — don't make them obvious.`;

async function generateSynthetic(persona, model) {
  const systemMap = {
    researcher: SYNTH_RESEARCHER_SYSTEM,
    reporter:   SYNTH_REPORTER_SYSTEM,
    editor:     SYNTH_EDITOR_SYSTEM,
  };

  const sys = systemMap[persona];
  if (!sys) throw new Error(`Unknown persona: ${persona}`);

  const raw = await _callModel(model, `Generate a training scenario for the ${persona} persona.`, sys);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in synthetic generation response');
  return JSON.parse(match[0]);
}

// ── Run persona on synthetic input ────────────────────────────────────────────

const RESEARCHER_RUN_SYSTEM = `You are a News Researcher. Given a list of raw article snippets, group them into story clusters. Articles about the same underlying event should be in the same cluster.

Return ONLY valid JSON:
{
  "clusters": [
    {
      "headline": "Core event description (under 100 chars)",
      "category": "tech|us_business|india_business|global_economies|politics|everything_else",
      "sources": ["source1", "source2"],
      "keywords": ["keyword1", "keyword2"],
      "articleIds": [1, 3, 7]
    },
    ...
  ]
}`;

const REPORTER_RUN_SYSTEM = `You are a Reporter. Given story clusters, write a polished digest entry for each.

Return ONLY valid JSON:
[
  {
    "clusterId": 1,
    "headline": "Sharp headline under 120 chars",
    "description": "2-3 sentences. Sentence 1: what happened and who. Sentence 2: why it matters or the key number. Max 220 chars total.",
    "source": "comma-separated sources"
  },
  ...
]`;

async function runPersonaOnSynthetic(persona, syntheticInput, model) {
  let prompt, systemOverride;

  if (persona === 'researcher') {
    const articles = syntheticInput.articles
      .map(a => `[${a.id}] ${a.source}: ${a.title}\n${a.snippet}`)
      .join('\n\n');
    prompt = `Group these articles into story clusters:\n\n${articles}`;
    systemOverride = RESEARCHER_RUN_SYSTEM;
  } else if (persona === 'reporter') {
    const clusters = syntheticInput.clusters
      .map(c => `[Cluster ${c.id}] ${c.headline}\nSources: ${c.sources.join(', ')}\nArticles:\n${c.articles.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}`)
      .join('\n\n---\n\n');
    prompt = `Write digest entries for these clusters:\n\n${clusters}`;
    systemOverride = REPORTER_RUN_SYSTEM;
  } else if (persona === 'editor') {
    // Editor reviews the full synthetic digest
    const { editDigest } = require('./editor');
    const result = await editDigest(JSON.parse(JSON.stringify(syntheticInput)), model);
    return result; // returns the cleaned digest directly
  }

  const raw = await _callModel(model, prompt, systemOverride);
  const match = raw.match(/[\[{][\s\S]*[\]}]/);
  if (!match) throw new Error('No JSON in persona run response');
  return JSON.parse(match[0]);
}

// ── Feedback storage ──────────────────────────────────────────────────────────

async function getTrainingData(persona) {
  const all = await storage.getKey('personaTraining') || {};
  return all[persona] || { examples: [], rules: [] };
}

async function saveTrainingExample(persona, { syntheticInput, personaOutput, userFeedback, approvedOutput }) {
  const all     = await storage.getKey('personaTraining') || {};
  const data    = all[persona] || { examples: [], rules: [] };

  data.examples.push({
    id:             Date.now(),
    createdAt:      new Date().toISOString(),
    syntheticInput,
    personaOutput,
    userFeedback,   // free text or structured edits
    approvedOutput, // what the user approved/edited
  });

  // Keep last 50 examples per persona
  if (data.examples.length > 50) data.examples = data.examples.slice(-50);

  all[persona] = data;
  await storage.setKey('personaTraining', all);
  return data;
}

// ── Rule distillation ─────────────────────────────────────────────────────────
// Given collected examples, ask LLM to distill them into concise rules

const DISTILL_SYSTEM = `You are summarising a set of user feedback examples into concise, actionable rules for a news digest AI persona.

Given a list of training examples (each with what the AI did and what the user corrected/approved), extract 5-10 concrete rules that capture the user's preferences.

Return ONLY valid JSON:
{
  "rules": [
    "Rule 1: ...",
    "Rule 2: ...",
    ...
  ]
}

Rules should be specific and actionable, not vague. E.g.:
- "Remove a story from a category section if it also appears in top_today" (not "avoid duplicates")
- "Headlines should lead with the number or statistic, not the company name"
- "Prefer Reuters and FT sources over PR wire services"`;

async function distillRules(persona, model) {
  const data = await getTrainingData(persona);
  if (data.examples.length < 2) return data.rules || [];

  const examplesText = data.examples.slice(-20).map((ex, i) => {
    return `[Example ${i + 1}]\nFeedback: ${ex.userFeedback || 'N/A'}\nApproved output: ${JSON.stringify(ex.approvedOutput).slice(0, 400)}`;
  }).join('\n\n---\n\n');

  const raw = await _callModel(model, `Distil rules from these ${data.examples.length} training examples:\n\n${examplesText}`, DISTILL_SYSTEM);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return data.rules || [];

  const parsed = JSON.parse(match[0]);
  const rules  = parsed.rules || [];

  // Persist distilled rules
  const all  = await storage.getKey('personaTraining') || {};
  all[persona] = { ...data, rules };
  await storage.setKey('personaTraining', all);

  return rules;
}

// ── Rule injection (used by editor/reporter/researcher at runtime) ─────────────

async function getInjectedRules(persona) {
  const data = await getTrainingData(persona);
  if (!data.rules || !data.rules.length) return '';
  return `\nLEARNED PREFERENCES (from user feedback — follow these):\n${data.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`;
}

module.exports = {
  generateSynthetic,
  runPersonaOnSynthetic,
  getTrainingData,
  saveTrainingExample,
  distillRules,
  getInjectedRules,
};
