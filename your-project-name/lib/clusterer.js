'use strict';

const OpenAI    = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { QWEN_MODELS, ANTHROPIC_MODELS } = require('./digest-generator');

const FALLBACK_MODEL = 'qwen-turbo';

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      const overloaded = err?.status === 529 || err?.message?.includes('overloaded');
      if (overloaded && i < retries - 1) {
        const wait = (i + 1) * 3000;
        console.log(`[cluster retry] waiting ${wait/1000}s`);
        await new Promise(r => setTimeout(r, wait));
      } else throw err;
    }
  }
}

const SYSTEM = `You receive newsletter email bodies grouped by source. Your job is to:
1. Extract distinct news stories from each email
2. Merge stories from different sources that cover the SAME event
3. Write a clear, factual, non-editorial headline for each story

Return ONLY a JSON array — no markdown, no extra text:
[
  { "headline": "factual headline you wrote", "sources": ["Source A", "Source B"], "keywords": ["keyword1", "keyword2"] },
  ...
]

Rules for headlines:
- Write YOUR OWN headline — do not copy the newsletter's editorial headline
- Be specific and factual: include the who, what, and key number/outcome if present
- GOOD: "Apple Reports 8% Revenue Drop Amid US Tariff Headwinds"
- GOOD: "Fed Holds Rates at 5.25%, Signals One Cut Possible in 2025"
- BAD: "The Apple Crisis" / "What's really going on" / "Markets in Turmoil" / "What this means"
- No jargon, no editorializing, no clickbait, no vague teasers
- Under 120 characters
- Merge same stories across sources; list ALL sources that covered it
- keywords: 2-4 words capturing the topic (used for categorisation later)
- Max 60 stories total`;

function isAnthropicUnavailable(err) {
  return err?.status === 529
    || err?.message?.includes('overloaded')
    || (err?.status === 400 && err?.message?.includes('credit balance'));
}

async function callModel(model, prompt) {
  if (ANTHROPIC_MODELS.includes(model)) {
    try {
      return await withRetry(() => _callModel(model, prompt));
    } catch (err) {
      if (isAnthropicUnavailable(err)) {
        console.log(`[cluster fallback] ${model} unavailable (${err.status}) — switching to ${FALLBACK_MODEL}`);
        return _callModel(FALLBACK_MODEL, prompt);
      }
      throw err;
    }
  }
  return withRetry(() => _callModel(model, prompt));
}

async function _callModel(model, prompt) {
  if (QWEN_MODELS.includes(model)) {
    const client   = new OpenAI({
      apiKey:  process.env.QWEN_API_KEY,
      baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    });
    const res = await client.chat.completions.create({
      model,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: prompt },
      ],
    });
    const u = res.usage;
    console.log(`[cluster] model: ${model} | in: ${u.prompt_tokens}, out: ${u.completion_tokens}`);
    return res.choices[0].message.content.trim();
  }

  if (ANTHROPIC_MODELS.includes(model)) {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res    = await client.messages.create({
      model,
      max_tokens: 4096,
      system:     SYSTEM,
      messages:   [{ role: 'user', content: prompt }],
    });
    const u = res.usage;
    console.log(`[cluster] model: ${model} | in: ${u.input_tokens}, out: ${u.output_tokens}`);
    return res.content[0].text.trim();
  }

  throw new Error(`Unknown model: ${model}`);
}

/**
 * @param {Array<{source: string, bodyText: string, imageUrls?: string[]}>} entries
 * @param {string} model
 * @returns {Array<{headline, sources, keywords, image?}>}
 */
async function clusterHeadlines(entries, model = 'qwen-turbo') {
  if (!entries.length) return [];

  // Build input: one section per source with its body text
  const sections = entries.map(({ source, bodyText }) =>
    `=== ${source} ===\n${bodyText}`
  ).join('\n\n');

  // Build a quick image map: source → first imageUrl
  const imageMap = {};
  for (const { source, imageUrls } of entries) {
    if (imageUrls?.length && !imageMap[source]) imageMap[source] = imageUrls[0];
  }

  console.log(`[cluster] input chars: ${sections.length}`);

  const text  = await callModel(model, `Extract and cluster stories from these newsletters:\n\n${sections}`);
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Clusterer did not return valid JSON array');

  const clusters = JSON.parse(match[0]);

  // Attach first available image from the cluster's sources
  for (const c of clusters) {
    for (const src of (c.sources || [])) {
      if (imageMap[src]) { c.image = imageMap[src]; break; }
    }
  }

  console.log(`[cluster] → ${clusters.length} unique stories`);
  return clusters;
}

module.exports = { clusterHeadlines };
