'use strict';

const OpenAI    = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

const FALLBACK_MODEL = 'qwen-turbo';

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const overloaded = err?.status === 529 || err?.message?.includes('overloaded');
      if (overloaded && i < retries - 1) {
        const wait = (i + 1) * 3000;
        console.log(`[retry] Overloaded — waiting ${wait/1000}s (attempt ${i+1}/${retries})`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

const SYSTEM = `You are a senior news editor. You receive a list of deduplicated news story clusters (each with headline, sources, and keywords) and produce a structured JSON daily digest.

Return ONLY a valid JSON object — no markdown, no extra text:
{
  "date": "<today's date, e.g. April 16, 2026>",
  "top_today": [ ...exactly 10 items — most important stories, one per major topic, no topic repeated... ],
  "tech": [ ...up to 10 items... ],
  "us_business": [ ...up to 10 items... ],
  "india_business": [ ...up to 10 items... ],
  "global_economies": [ ...up to 10 items... ],
  "politics": [ ...up to 10 items... ],
  "everything_else": [ ...up to 10 items... ]
}

Each item: { "headline": "...", "description": "...", "source": "<comma-separated sources>" }

Rules:
- Use the cluster's headline as-is (they are already factual and non-editorial)
- description: 2-3 sentences, 80-220 chars total. Sentence 1: what happened and who. Sentence 2: why it matters or the key number/outcome. Sentence 3 (optional): what to watch next. Neutral tone — no hype, no editorial opinion.
- source field: list all sources from the cluster, comma-separated
- top_today: one per major topic, no topic repeated
- Omit categories with no relevant content
- Headlines under 120 chars`;

const QWEN_MODELS      = ['qwen-plus', 'qwen-turbo', 'qwen-max'];
const ANTHROPIC_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6'];

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
        console.log(`[fallback] ${model} unavailable (${err.status}) — switching to ${FALLBACK_MODEL}`);
        return _callModel(FALLBACK_MODEL, prompt);
      }
      throw err;
    }
  }
  return withRetry(() => _callModel(model, prompt));
}

async function _callModel(model, prompt) {
  let text, inputTokens, outputTokens;

  if (QWEN_MODELS.includes(model)) {
    const client   = new OpenAI({
      apiKey:  process.env.QWEN_API_KEY,
      baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    });
    const response = await client.chat.completions.create({
      model,
      max_tokens: 6000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: prompt },
      ],
    });
    inputTokens  = response.usage.prompt_tokens;
    outputTokens = response.usage.completion_tokens;
    text         = response.choices[0].message.content.trim();

  } else if (ANTHROPIC_MODELS.includes(model)) {
    const client   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model,
      max_tokens: 6000,
      system:     SYSTEM,
      messages:   [{ role: 'user', content: prompt }],
    });
    inputTokens  = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
    text         = response.content[0].text.trim();

  } else {
    throw new Error(`Unknown model: ${model}`);
  }

  console.log(`[digest] model: ${model} | in: ${inputTokens}, out: ${outputTokens}, total: ${inputTokens + outputTokens}`);
  return text;
}

/**
 * @param {Array<{headline, sources, keywords}>} clusters
 * @param {string} model
 * @param {Object} readState - map of keyword → [already-read headlines]
 */
async function generateDigest(clusters, model = 'qwen-turbo', readState = {}) {
  if (!clusters.length) throw new Error('No story clusters to summarise');

  // Annotate clusters with what the user has already read
  const clusterText = clusters.map((c, i) => {
    const readInCluster = (c.keywords || [])
      .flatMap(kw => readState[kw] || [])
      .filter((v, i, a) => a.indexOf(v) === i); // dedupe

    const readNote = readInCluster.length
      ? ` [USER HAS ALREADY READ: ${readInCluster.join(' | ')} — prioritise newer developments beyond this]`
      : '';
    const imageNote = c.image ? ` [image: ${c.image}]` : '';
    return `${i + 1}. ${c.headline} [sources: ${c.sources.join(', ')}] [keywords: ${c.keywords.join(', ')}]${imageNote}${readNote}`;
  }).join('\n');

  const text  = await callModel(model, `Generate today's digest from these ${clusters.length} story clusters:\n\n${clusterText}`);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Model did not return valid JSON');

  const digest = JSON.parse(match[0]);
  if (!digest.date || !Array.isArray(digest.top_today)) throw new Error('Digest JSON missing required fields');
  return digest;
}

module.exports = { generateDigest, QWEN_MODELS, ANTHROPIC_MODELS };
