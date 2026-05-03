'use strict';

const OpenAI    = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const storage   = require('./storage');
const { spawn } = require('child_process');
const fs        = require('fs');
const os        = require('os');
const path      = require('path');

const GROQ_MODELS      = ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama-3.1-8b-instant'];
const DEEPSEEK_MODELS  = ['deepseek-chat', 'deepseek-reasoner'];
const QWEN_MODELS      = ['qwen-plus', 'qwen-turbo', 'qwen-max'];
const ANTHROPIC_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-opus-4-5-20251101',
];
const CLI_MODELS       = ['claude-cli'];
const MANUS_MODELS     = ['manus'];
const ALL_MODELS       = [...CLI_MODELS, ...MANUS_MODELS, ...ANTHROPIC_MODELS, ...GROQ_MODELS, ...DEEPSEEK_MODELS, ...QWEN_MODELS];

// Resolve Anthropic API key: prefer settings (UI input) over env var
async function getAnthropicKey() {
  try {
    const s = await storage.getSettings();
    if (s?.anthropicApiKey) return s.anthropicApiKey;
  } catch {}
  return process.env.ANTHROPIC_API_KEY || '';
}

function getClient(model) {
  if (GROQ_MODELS.includes(model))
    return new OpenAI({ apiKey: process.env.GROQ_API_KEY,     baseURL: 'https://api.groq.com/openai/v1' });
  if (DEEPSEEK_MODELS.includes(model))
    return new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  if (QWEN_MODELS.includes(model))
    return new OpenAI({ apiKey: process.env.QWEN_API_KEY,     baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' });
  throw new Error(`Unknown model: ${model}`);
}

async function callAnthropic(model, system, userPrompt) {
  const apiKey = await getAnthropicKey();
  if (!apiKey) throw new Error('Anthropic API key not set — add it in Settings or set ANTHROPIC_API_KEY in .env');
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const u = resp.usage || {};
  console.log(`[digest] model: ${model} | in: ${u.input_tokens || '?'}, out: ${u.output_tokens || '?'}`);
  // Concat text blocks
  return resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

function callClaudeCLI(system, userPrompt, timeoutMs = 600000) {
  const fullPrompt = `${system}\n\n---\n\n${userPrompt}`;
  // Write to temp file to avoid OS arg length limits with large newsletter bodies
  const tmpFile = path.join(os.tmpdir(), `claude-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, fullPrompt, 'utf8');

  return new Promise((resolve, reject) => {
    const claudeBin = process.env.CLAUDE_BIN || 'claude';
    // Scrub env so claude-cli uses the user's own saved auth, not a leaked parent-session token
    const cleanEnv = { ...process.env };
    for (const k of Object.keys(cleanEnv)) {
      if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE' || k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'ANTHROPIC_API_KEY') {
        delete cleanEnv[k];
      }
    }
    const proc = spawn('sh', ['-c', `cat "${tmpFile}" | "${claudeBin}" --print --dangerously-skip-permissions`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`Claude CLI timed out after ${Math.round(timeoutMs/60000)} min`)); }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      clearTimeout(timer);
      fs.unlink(tmpFile, () => {});
      if (code !== 0) {
        const out = stdout.trim();
        const err = stderr.trim();
        const msg = out || err || `Claude CLI exited with code ${code}`;
        console.error(`[claude-cli] exit ${code} | stderr: ${JSON.stringify(err.slice(0, 500))} | stdout: ${JSON.stringify(out.slice(0, 300))}`);
        const e = new Error(msg);
        // Tag transient Anthropic API errors so the caller can retry
        if (/API Error:\s*5\d\d|Internal server error|overloaded|rate.?limit/i.test(out)) e.transient = true;
        reject(e);
      } else {
        resolve(stdout.trim());
      }
    });
    proc.on('error', err => { clearTimeout(timer); fs.unlink(tmpFile, () => {}); reject(new Error(`Could not start Claude CLI: ${err.message}`)); });
  });
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err?.status === 429 || err?.status === 529 || err?.message?.includes('overloaded');
      if (retryable && i < retries - 1) {
        const wait = (i + 1) * 3000;
        console.log(`[retry] Waiting ${wait/1000}s (attempt ${i+1}/${retries})`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

function _isClaude(model) {
  const m = String(model || '').toLowerCase();
  return m.startsWith('claude') || m.startsWith('anthropic') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku');
}

// Strict no-repeat rule (Claude only): every cluster appears in exactly one section.
const SECTION_RULES_STRICT = `SECTION RULES:
- STRICT NO REPEATS: every cluster appears in exactly ONE section.
- top_today is the most important section. Place the 10 most important stories here. If a story belongs in top_today, it does NOT also appear in its category section.
- Each remaining cluster (not in top_today) goes into the single best-fit category section.
- us_business: US-headquartered company news, US domestic economy. global_economies: non-US countries, international trade, foreign central banks, emerging markets.
- everything_else: catches anything that doesn't fit a named category — DO NOT drop clusters from the digest.`;

// Relaxed rule for non-Claude models (Qwen, GPT-mini, etc.): allow top_today
// stories to ALSO appear in their category tab, so non-top tabs aren't empty
// when there are fewer than 10 strong clusters.
const SECTION_RULES_RELAXED = `SECTION RULES:
- top_today: the 10 most important stories of the day, one per major topic, no topic repeated WITHIN top_today.
- EVERY cluster MUST also appear in its single best-fit CATEGORY section (tech / us_business / india_business / global_economies / politics / everything_else). This applies even to clusters already in top_today — they MUST be duplicated into their category. The only section that obeys uniqueness is top_today itself.
- us_business: US-headquartered company news, US domestic economy. global_economies: non-US countries, international trade, foreign central banks, emerging markets.
- everything_else: catches anything that doesn't fit a named category — DO NOT drop clusters from the digest.
- Each cluster appears AT MOST ONCE per category section (no within-category duplicates), but it MAY appear in both top_today AND its category section.`;

function _systemBase(model) {
  // Default to RELAXED for every model. Empty category tabs (which the strict
  // "top_today eats every cluster" rule was producing on small cluster sets)
  // are far worse UX than letting top_today and category tabs share a story.
  // Strict mode is still available via env if a user wants it: STRICT_SECTIONS=1.
  const rules = process.env.STRICT_SECTIONS === '1' && _isClaude(model)
    ? SECTION_RULES_STRICT
    : SECTION_RULES_RELAXED;

  // Haiku tends to revert to neutral wire-service prose and ignore long
  // stylistic instructions. Prepend an aggressive, example-driven intensifier
  // so even Haiku produces fact-dense, synthesised descriptions.
  const isHaiku = String(model || '').toLowerCase().includes('haiku');
  const haikuKick = isHaiku
    ? `\n\n!!! CRITICAL VOICE OVERRIDE — READ FIRST !!!\nYou are NOT a wire-service summariser. You are a smart-friend explainer who lays out the news AND tells the reader why it matters in the same breath.\n\nEvery description MUST contain:\n  (1) the central fact / number / mechanism ("what")\n  (2) one non-obvious read-through, comparison, or second-order effect ("so what") — written naturally, not as a bullet\n\nDo NOT write: "X has signed a deal with Y to do Z. The deal involves..."\nDO    write: "X has signed a $X bn deal with Y to do Z, reversing its 2018 promise to never do Z. The signal: every major frontier-model lab now has a defence-customer pipeline, which changes hiring math more than the headlines suggest."\n\nIf you find yourself writing "this could be significant", "the deal marks", "this represents a major step", or "the move highlights" — DELETE that sentence and replace it with a specific fact, number, or comparison.\n\nLength: 2-4 sentences, 140-320 chars. Density check: if a sentence could appear verbatim in a Reuters wire summary, REWRITE it.\n\n--- end of voice override ---\n`
    : '';

  return `${haikuKick}You are a senior news editor. You receive a list of deduplicated news story clusters (each with headline, sources, and keywords) and produce a structured JSON daily digest.

Each item: { "headline": "...", "description": "...", "source": "<comma-separated sources>", "keywords": ["topic1", "topic2"] }

=========================================================
PART A — SELECTION & PLACEMENT (tone-neutral)
=========================================================
These rules govern WHICH clusters end up in WHICH section. They DO NOT depend on audience tone, voice, or any reader-preference signal. Apply them first, before you write a single description.

- Use EVERY cluster you are given. Do not drop a cluster because of subject matter, tone, or perceived sophistication. Every cluster must appear in the digest (see SECTION RULES below for placement).
- Selection criteria, in order: (1) topical fit with the section, (2) recency, (3) cluster strength (more sources = more important), (4) topic breadth across the digest as a whole — do not let one topic dominate.
- Audience preference is NOT a selection criterion at this stage. A celebrity story, a sports story, an entertainment story, or a soft-news story is just as eligible for placement as a market-moving story — it goes in the section that fits its topic.
- Use the cluster's headline as-is (it is already factual and non-editorial). Trim only if it exceeds 120 chars.
- The source field lists all sources from the cluster, comma-separated.

=========================================================
PART B — DESCRIPTION WRITING (voice & tone)
=========================================================
Once you have selected a cluster and placed it in a section, write its description in this specific voice. This voice applies to EVERY description, regardless of section or topic.

VOICE: Sequoia internal memo. Stratechery long-form. Bessemer State of the Cloud. Matt Levine's Money Stuff at its driest. The reader is smart, time-poor, and wants the facts plus exactly one degree of synthesis.

What that means concretely:
- DECLARATIVE. Lead with what happened. "The company added 14,000 net-new customers" — not "an impressive performance".
- FACT-DENSE. Numbers, names, dates, mechanism. Every sentence should contain at least one specific fact you couldn't get from the headline alone.
- ONE DEGREE OF SYNTHESIS. After the facts, give the reader one non-obvious connection: a read-through to another company, an analogous moment from another industry, a second-order effect, a pattern this fits, or a hidden incentive. ONE. Not three.
- WRITERLY BUT NOT FLOWERY. Short, declarative sentences that build on each other. No "however," cascades. No "in conclusion". No "this could prove to be a watershed moment".
- POINT OF VIEW WITHOUT EDITORIALISING. The voice has a perspective — it shows up in WHAT YOU CHOOSE TO INCLUDE and WHAT YOU EMPHASISE. It does NOT show up in adjectives. "Stunning" tells the reader nothing. "The 14% gross margin compares with Snowflake's 75%" tells the reader something.
- Length: 2-4 complete sentences, 120-320 chars total. End every sentence with a full stop — never leave a thought trailing.

Structure (flexible, not formulaic):
- Sentence 1: what happened + the key fact / number.
- Sentence 2: the synthesis — why it matters in the form of a pattern, comparison, mechanism, or non-obvious consequence.
- Sentences 3-4 (optional): a follow-on fact, a name to watch, or a deadline / event the reader should hold in their head.

Forbidden words and phrases (they signal lazy writing): "game-changer", "revolutionary", "stunning", "shocking", "epic", "dramatic", "massive", "unprecedented" (unless literally true), "insanely", "crazy", "wild", "jaw-dropping", "watershed", "sea change", "paradigm shift", "this could prove", "only time will tell".

Apply this voice to ALL topics, not just business / finance. For entertainment, sports, science, lifestyle, etc., the voice is the same — the synthesis frame just shifts from "market impact" to whatever frame actually fits (industry shift, audience behaviour, scientific implication, cultural pattern). DO NOT force a financial frame onto a non-financial story; force a Sequoia-memo frame instead, which is broader.

Good examples of the voice:
- "Apple posted Services revenue of $24.2bn, up 14% y/y, taking the segment past Mac + iPad combined for the first time. The mix shift continues a five-year pattern: hardware unit growth has plateaued, but the installed base monetisation curve has not. Watch the App Store antitrust ruling in Europe in May for the first real test of pricing power."
- "Netflix's KPop Demon Hunters has crossed 240m hours viewed in eight weeks, the platform's biggest animated original ever. The signal isn't K-pop fandom — it's that Netflix has finally built a mid-budget animation engine that doesn't need a sequel franchise to break out. Next data point: whether the soundtrack performs on Spotify."

Bad examples (do not write like this):
- "Apple stunned investors with a massive Services beat, in what could prove a game-changing quarter." (vague, hyped, no facts.)
- "Netflix scored a major hit with KPop Demon Hunters, an unprecedented success for the streaming giant." (no number, no synthesis, lazy adjectives.)

${rules}`;
}
// Backwards compat: SYSTEM_BASE used by static SYSTEM constant. Defaults to strict
// (Claude rule) since it's only used when no model-specific prompt is built.
const SYSTEM_BASE = _systemBase('claude-default');

function personaInstructions(persona) {
  if (!persona || typeof persona !== 'object') return '';
  const lines = [];
  // Persona is a TIEBREAKER LAYER ONLY. It influences ordering and description style,
  // never which clusters are included. The CRITICAL RULES above always win.
  if (persona.scope === 'global') lines.push('- When ranking within top_today, give a slight edge to globally significant events over domestic-only stories');
  if (persona.scope === 'us') lines.push('- When ranking within top_today, give a slight edge to US-centric stories');
  if (persona.angle === 'investing') lines.push('- In descriptions only (not selection): emphasise market impact, earnings, central-bank moves, and macro data when the story actually has that angle. Do NOT use this preference to skip non-financial stories.');
  if (persona.angle === 'general') lines.push('- In descriptions, keep language accessible to a general reader');
  if (persona.tech === 'heavy') lines.push('- When ranking, give a slight edge to AI/software/semiconductor stories — but still include all other clusters');
  if (persona.tech === 'light') lines.push('- When ranking, deprioritise niche tech stories — but still include them in their category');
  if (persona.politics === 'lots') lines.push('- When ranking top_today, include significant geopolitical/policy stories alongside business stories');
  if (persona.politics === 'minimal') lines.push('- When ranking top_today, deprioritise pure-politics stories without market consequences — but still include them in the politics section');
  if (persona.speed === 'analysis') lines.push('- In descriptions, lean toward consequences and context over the bare event');
  if (persona.speed === 'brief') lines.push('- In descriptions, keep sentences tight and scannable');
  if (persona.format === 'numbers') lines.push('- In descriptions, include specific numbers/percentages/figures when the cluster mentions them');
  // Inject the rolling compacted preferences block (preferred) or legacy quality note (fallback)
  if (persona._preferenceText && typeof persona._preferenceText === 'string' && persona._preferenceText.trim()) {
    lines.push(`\n--- Rolling preferences (apply these — merged from persona quiz, trainer feedback, and thumbs ratings) ---\n${persona._preferenceText.trim()}\n---`);
  } else if (persona._qualityNote && persona._qualityNote.text) {
    lines.push(`\n--- Quality note from yesterday's feedback (apply these preferences) ---\n${persona._qualityNote.text}\n---`);
  }
  if (!lines.length) return '';
  return `\nReader-preference layer (use these to break ties and shape DESCRIPTIONS, never to drop clusters):\n${lines.join('\n')}`;
}

function buildSystemPrompt(customSections = [], persona = null, model = null) {
  const customJson = customSections.length
    ? '\n' + customSections.map(s => `  "${s.id}": [ ...up to 10 ${s.label} stories... ],`).join('\n')
    : '';
  const { expandTopic } = require('./topic-keywords');
  const customRules = customSections.length
    ? '\nCUSTOM SECTIONS — STRICT FILTERING (READ CAREFULLY):\n' +
      customSections.map(s => {
        // Use the keyword library to derive a sensible scope when the user
        // hasn't written one. The library returns a richer description than
        // the bare label so the LLM has something concrete to filter on.
        const exp = expandTopic(s.label, s.description);
        const def = `Scope: ${exp.scope}`;
        return `- ${s.id} ("${s.label}")\n  ${def}\n  RULES for ${s.id}:\n    (a) Only include a cluster if its primary subject CLEARLY matches the scope above.\n    (b) Return an EMPTY array \`[]\` when no clusters truly fit — it is BETTER to return [] than to fill with leftover stories.\n    (c) NEVER pad this section with tech, business, or politics stories that don't match the scope.\n    (d) A passing mention of "${s.label}" is NOT enough — the cluster must be primarily about it.`;
      }).join('\n')
    : '';
  const base = model ? _systemBase(model) : SYSTEM_BASE;

  return `${base}${personaInstructions(persona)}${customRules}

Return ONLY a valid JSON object — no markdown, no extra text:
{
  "date": "<today's date, e.g. April 16, 2026>",
  "top_today": [ ...exactly 10 items — most important stories, one per major topic, no topic repeated... ],
  "tech": [ ...up to 10 items... ],
  "us_business": [ ...up to 10 items... ],
  "india_business": [ ...up to 10 items... ],
  "global_economies": [ ...up to 10 items... ],
  "politics": [ ...up to 10 items... ],
  "everything_else": [ ...up to 10 items... ]${customJson}}`;
}

const SYSTEM = buildSystemPrompt();

// Direct single-provider dispatch (no fallback). Use _callModel for safe calls with fallback.
async function _callModelDirect(model, prompt, systemOverride) {
  const sys = systemOverride || SYSTEM;
  if (model === 'manus') {
    const { callManus, hasManusKey } = require('./manus');
    if (!hasManusKey()) {
      const err = new Error('Manus selected but MANUS_API_KEY env var not set');
      err.status = 401;
      throw err;
    }
    console.log('[digest] model: manus (agent task)');
    return callManus(sys, prompt);
  }
  if (model === 'claude-cli') {
    console.log('[digest] model: claude-cli (subprocess)');
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await callClaudeCLI(sys, prompt); }
      catch (err) {
        lastErr = err;
        if (!err.transient || attempt === 3) throw err;
        const wait = attempt * 5000;
        console.warn(`[claude-cli] transient error (attempt ${attempt}/3), retrying in ${wait/1000}s: ${err.message.slice(0, 100)}`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }
  if (ANTHROPIC_MODELS.includes(model)) {
    return callAnthropic(model, sys, prompt);
  }
  const client   = getClient(model);
  const response = await client.chat.completions.create({
    model,
    max_tokens: 6000,
    messages: [
      { role: 'system', content: sys },
      { role: 'user',   content: prompt },
    ],
  });
  const u = response.usage;
  console.log(`[digest] model: ${model} | in: ${u.prompt_tokens}, out: ${u.completion_tokens}`);
  return response.choices[0].message.content.trim();
}

// Build a cross-provider fallback chain starting from `primary`.
// Order: primary → sibling models in same family → Anthropic Haiku → Qwen Turbo → Groq Llama → claude-cli.
// Only includes providers whose credentials are available.
function buildFallbackChain(primary) {
  const chain = [];
  const seen = new Set();
  const add = (m) => { if (m && !seen.has(m)) { chain.push(m); seen.add(m); } };

  // 1. Primary first (or sensible default)
  add(primary || 'claude-haiku-4-5-20251001');

  // 2. Same-family siblings as primary
  const families = [
    { list: ANTHROPIC_MODELS, envKey: 'ANTHROPIC_API_KEY' },
    { list: GROQ_MODELS,      envKey: 'GROQ_API_KEY'      },
    { list: QWEN_MODELS,      envKey: 'QWEN_API_KEY'      },
    { list: DEEPSEEK_MODELS,  envKey: 'DEEPSEEK_API_KEY'  },
  ];

  // 3. Cross-provider defaults — fastest / cheapest per family, only if key is available
  const defaults = [
    { model: 'claude-haiku-4-5-20251001', envKey: 'ANTHROPIC_API_KEY' },
    { model: 'qwen-turbo',                envKey: 'QWEN_API_KEY'      },
    { model: 'llama-3.3-70b-versatile',   envKey: 'GROQ_API_KEY'      },
    { model: 'llama-3.1-8b-instant',      envKey: 'GROQ_API_KEY'      },
  ];
  for (const { model, envKey } of defaults) {
    if (process.env[envKey]) add(model);
  }

  return chain;
}

// True when an error indicates the provider is unavailable (credits/auth/quota/5xx),
// so we should move to the next model in the fallback chain instead of crashing.
function isProviderFailure(err) {
  if (!err) return false;
  const status = err.status || err.statusCode;
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  if (status && status >= 500 && status < 600) return true;
  const msg = String(err.message || err).toLowerCase();
  return /api.?key|unauthori|forbidden|credits?|quota|insufficient|balance|rate.?limit|overload|internal server|service unavailable|unavailable|billing|payment|no.?api.?key|not.?set/.test(msg);
}

// Safe LLM dispatch with cross-provider fallback chain.
async function _callModel(model, prompt, systemOverride) {
  const chain = buildFallbackChain(model);
  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const m = chain[i];
    try {
      if (i > 0) console.warn(`[llm-fallback] trying #${i+1}/${chain.length}: ${m}`);
      return await _callModelDirect(m, prompt, systemOverride);
    } catch (err) {
      lastErr = err;
      if (!isProviderFailure(err)) throw err; // non-recoverable (bad prompt, etc.)
      console.warn(`[llm-fallback] ${m} failed (${err.status || ''} ${String(err.message || '').slice(0,120)}). Falling back…`);
    }
  }
  throw lastErr || new Error('All LLM providers failed');
}

async function generateDigest(clusters, model = 'llama-3.3-70b-versatile', readState = {}, customSections = [], persona = null) {
  if (!clusters.length) throw new Error('No story clusters to summarise');

  // Always rebuild prompt so the section-rule branch follows the chosen model.
  const sys = buildSystemPrompt(customSections, persona, model);

  const clusterText = clusters.map((c, i) => {
    const readInCluster = (c.keywords || [])
      .flatMap(kw => readState[kw] || [])
      .filter((v, i, a) => a.indexOf(v) === i);
    const readNote  = readInCluster.length ? ` [USER HAS ALREADY READ: ${readInCluster.join(' | ')} — prioritise newer developments]` : '';
    const imageNote = c.image ? ` [image: ${c.image}]` : '';
    return `${i + 1}. ${c.headline} [sources: ${c.sources.join(', ')}] [keywords: ${c.keywords.join(', ')}]${imageNote}${readNote}`;
  }).join('\n');

  const text  = await withRetry(() => _callModel(model, `Generate today's digest from these ${clusters.length} story clusters:\n\n${clusterText}`, sys));
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Model did not return valid JSON');

  let digest;
  try {
    digest = JSON.parse(match[0]);
  } catch (e) {
    // Attempt to repair truncated JSON by trimming to last complete object
    let raw = match[0];
    const lastComma = raw.lastIndexOf('},');
    if (lastComma > 0) {
      raw = raw.substring(0, lastComma + 1);
      // Re-close open arrays and object
      let opens = 0, openBraces = 0;
      for (const ch of raw) {
        if (ch === '[') opens++; else if (ch === ']') opens--;
        if (ch === '{') openBraces++; else if (ch === '}') openBraces--;
      }
      while (opens > 0) { raw += ']'; opens--; }
      while (openBraces > 0) { raw += '}'; openBraces--; }
    }
    try {
      digest = JSON.parse(raw);
      console.log('[digest] Repaired truncated JSON successfully');
    } catch (e2) {
      throw new Error('Model returned invalid JSON: ' + e.message);
    }
  }
  if (!digest.date || !Array.isArray(digest.top_today)) throw new Error('Digest JSON missing required fields');

  // Match clusters to digest items by headline (digest uses cluster headlines as-is)
  const headlineMap = {};
  for (const c of clusters) {
    const key = c.headline.toLowerCase().trim();
    headlineMap[key] = { image: c.image, keywords: c.keywords };
  }
  const defaultCats = ['top_today','tech','us_business','india_business','global_economies','politics','everything_else'];
  const allCats = [...defaultCats, ...customSections.map(s => s.id)];
  const undraw = require('./undraw');

  // BAD_IMAGE filter mirrors og-image / image-fallback so the entire pipeline
  // treats the same set of URLs (gstatic thumbnails, banners, trackers) as
  // "missing".
  const BAD_IMAGE = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|profile|placeholder|pixel|tracking|beacon|favicon|sprite|encrypted-tbn|gstatic\.com/i;

  // First pass: copy through cluster-attached images / keywords by headline match.
  // We REJECT cluster images that match BAD_IMAGE so we re-derive them below.
  const allItems = [];
  for (const cat of allCats) {
    if (!Array.isArray(digest[cat])) continue;
    for (const item of digest[cat]) {
      const match = headlineMap[item.headline?.toLowerCase().trim()];
      if (match) {
        if (!item.image    && match.image && !BAD_IMAGE.test(match.image)) item.image    = match.image;
        if (!item.keywords && match.keywords) item.keywords = match.keywords;
      }
      // If item already has an image but it's a known-bad URL, drop it so it
      // gets re-resolved by OG / Serper below.
      if (item.image && BAD_IMAGE.test(item.image)) item.image = null;
      allItems.push(item);
    }
  }

  // PRIMARY: scrape <meta property="og:image"> from each article's sourceUrl.
  // This gives us the publisher's own hero image at full resolution. Bounded
  // concurrency=12; only runs on items lacking a usable image.
  try {
    const { attachOgImages } = require('./og-image');
    await attachOgImages(allItems, { concurrency: 12 });
  } catch (e) {
    console.warn('[digest] og-image scrape failed:', e.message);
  }

  const stillMissing = allItems.filter(it => !it.image || BAD_IMAGE.test(it.image));

  // SECONDARY: Serper Images for anything OG didn't resolve. Capped at 30
  // lookups per digest run to keep Serper quota usage predictable.
  if (stillMissing.length) {
    try {
      const { attachImages } = require('./image-fallback');
      await attachImages(stillMissing, { maxLookups: 30 });
    } catch (e) {
      console.warn('[digest] image-fallback failed:', e.message);
    }
  }

  // FINAL: undraw illustration for any item that *still* has no image.
  for (const cat of allCats) {
    if (!Array.isArray(digest[cat])) continue;
    for (const item of digest[cat]) {
      if (!item.image || BAD_IMAGE.test(item.image)) item.image = undraw.pick(item.headline || '');
    }
  }

  return digest;
}

module.exports = { generateDigest, buildSystemPrompt, getClient, callClaudeCLI, callAnthropic, _callModel, ALL_MODELS, CLI_MODELS, MANUS_MODELS, ANTHROPIC_MODELS, GROQ_MODELS, DEEPSEEK_MODELS, QWEN_MODELS };
