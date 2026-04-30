'use strict';

const { getClient, callClaudeCLI, callAnthropic, ANTHROPIC_MODELS } = require('./digest-generator');

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      const retryable = err?.status === 429 || err?.status === 529 || err?.message?.includes('overloaded');
      if (retryable && i < retries - 1) {
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
  { "headline": "factual headline you wrote", "sources": ["Source A", "Source B"], "keywords": ["keyword1", "keyword2"], "excerpt": "verbatim 2-4 sentence passage from one of the source emails that explains the story (max 600 chars)" },
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
- excerpt: a verbatim passage of 2-4 sentences pulled DIRECTLY from one of the source newsletter bodies that gives concrete factual context for this story. Max 600 chars. Do NOT paraphrase. Do NOT summarise. Do NOT invent. If multiple sources cover the story, pick the source with the most factual / numeric content. This excerpt is consumed downstream to write deep-dive angles without needing a web search.
- Max 60 stories total`;

async function _callModel(model, prompt) {
  if (model === 'claude-cli') {
    console.log('[cluster] model: claude-cli (subprocess)');
    return callClaudeCLI(SYSTEM, prompt);
  }
  if (ANTHROPIC_MODELS.includes(model)) {
    return callAnthropic(model, SYSTEM, prompt);
  }
  const client = getClient(model);
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

async function clusterHeadlines(entries, model = 'llama-3.3-70b-versatile') {
  if (!entries.length) return [];

  const valid = entries.filter(e => e.bodyText && e.bodyText.trim().length >= 100);
  if (!valid.length) throw new Error('No entries with usable bodyText to cluster');

  const sections = valid.map(({ source, bodyText }) =>
    `=== ${source} ===\n${bodyText}`
  ).join('\n\n');

  // Collect all images from all entries (forwarded emails have mismatched source names)
  const allImages = entries.flatMap(e => e.imageUrls || []).filter(Boolean);

  const srcCounts = valid.reduce((m, e) => { m[e.source] = (m[e.source] || 0) + 1; return m; }, {});
  console.log(`[cluster] ${valid.length}/${entries.length} entries usable | sources: ${JSON.stringify(srcCounts)} | chars: ${sections.length} | images: ${allImages.length}`);

  const text  = await withRetry(() => _callModel(model, `Extract and cluster stories from these newsletters:\n\n${sections}`));
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Clusterer did not return valid JSON array');

  const clusters = JSON.parse(match[0]);

  // Assign images round-robin to clusters (source name matching fails for forwards)
  if (allImages.length) {
    clusters.forEach((c, i) => { c.image = allImages[i % allImages.length]; });
  }

  // Safety net: if the LLM omitted excerpts for any cluster, backfill from the
  // first matching source body. Angle generation needs concrete text to chew on.
  const bodyByName = new Map();
  for (const v of valid) {
    if (!bodyByName.has(v.source)) bodyByName.set(v.source, v.bodyText);
  }
  clusters.forEach(c => {
    if (c.excerpt && c.excerpt.length > 80) return;
    const firstSrc = (c.sources || []).find(s => bodyByName.has(s));
    if (!firstSrc) return;
    const body = bodyByName.get(firstSrc) || '';
    // Pull a slice that ideally contains the headline keywords; fallback to the head of the body.
    const head = (c.headline || '').toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 3);
    let excerpt = '';
    if (head.length) {
      const lower = body.toLowerCase();
      const idx = head.map(w => lower.indexOf(w)).filter(i => i >= 0).sort((a, b) => a - b)[0];
      if (idx != null && idx >= 0) {
        const start = Math.max(0, idx - 80);
        excerpt = body.slice(start, start + 600).trim();
      }
    }
    if (!excerpt) excerpt = body.slice(0, 600).trim();
    c.excerpt = excerpt;
  });

  console.log(`[cluster] → ${clusters.length} unique stories`);
  return clusters;
}

module.exports = { clusterHeadlines };
