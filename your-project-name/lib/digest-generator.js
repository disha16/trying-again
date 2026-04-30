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
const ALL_MODELS       = [...CLI_MODELS, ...ANTHROPIC_MODELS, ...GROQ_MODELS, ...DEEPSEEK_MODELS, ...QWEN_MODELS];

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

const SYSTEM_BASE = `You are a senior news editor. You receive a list of deduplicated news story clusters (each with headline, sources, and keywords) and produce a structured JSON daily digest.

Each item: { "headline": "...", "description": "...", "source": "<comma-separated sources>", "keywords": ["topic1", "topic2"] }

CRITICAL RULES:
- Use EVERY cluster you are given. Do not drop clusters because they don't match your taste — every cluster must appear in EXACTLY ONE section.
- Use the cluster's headline as-is (they are already factual and non-editorial)
- description: 2-4 complete sentences, 120-320 chars total. Sentence 1: what happened and who. Sentence 2: why it matters or the key number/outcome. Sentences 3-4 (optional): what to watch next and any relevant context. End every sentence with proper punctuation — NEVER leave a thought trailing or unfinished. Neutral tone — no hype, no editorial opinion.
- source field: list all sources from the cluster, comma-separated
- Headlines under 120 chars

SECTION RULES:
- STRICT NO REPEATS: every cluster appears in exactly ONE section.
- top_today is the most important section. Place the 10 most important stories here. If a story belongs in top_today, it does NOT also appear in its category section.
- Each remaining cluster (not in top_today) goes into the single best-fit category section.
- us_business: US-headquartered company news, US domestic economy. global_economies: non-US countries, international trade, foreign central banks, emerging markets.
- everything_else: catches anything that doesn't fit a named category — DO NOT drop clusters from the digest.`;

function personaInstructions(persona) {
  if (!persona || typeof persona !== 'object') return '';
  const lines = [];
  // Persona is a TIEBREAKER LAYER ONLY. It influences ordering and description style,
  // never which clusters are included. The CRITICAL RULES above always win.
  if (persona.scope === 'global') lines.push('- When ranking within top_today, give a slight edge to globally significant events over domestic-only stories');
  if (persona.scope === 'us') lines.push('- When ranking within top_today, give a slight edge to US-centric stories');
  if (persona.angle === 'investing') lines.push('- In descriptions, emphasise market impact, earnings, central-bank moves, and macro data when relevant');
  if (persona.angle === 'general') lines.push('- Keep descriptions accessible to a general reader');
  if (persona.tech === 'heavy') lines.push('- When ranking, give a slight edge to AI/software/semiconductor stories — but still include all other clusters');
  if (persona.tech === 'light') lines.push('- When ranking, deprioritise niche tech stories — but still include them in their category');
  if (persona.politics === 'lots') lines.push('- When ranking top_today, include significant geopolitical/policy stories alongside business stories');
  if (persona.politics === 'minimal') lines.push('- When ranking top_today, deprioritise pure-politics stories without market consequences — but still include them in the politics section');
  if (persona.speed === 'analysis') lines.push('- In descriptions, lean toward consequences and context over the bare event');
  if (persona.speed === 'brief') lines.push('- In descriptions, keep sentences tight and scannable');
  if (persona.format === 'numbers') lines.push('- In descriptions, include specific numbers/percentages/figures when the cluster mentions them');
  // Inject quality note from prior-day feedback if available
  if (persona._qualityNote && persona._qualityNote.text) {
    lines.push(`\n--- Quality note from yesterday's feedback (apply these preferences) ---\n${persona._qualityNote.text}\n---`);
  }
  if (!lines.length) return '';
  return `\nReader-preference layer (use these to break ties and shape DESCRIPTIONS, never to drop clusters):\n${lines.join('\n')}`;
}

function buildSystemPrompt(customSections = [], persona = null) {
  const customJson = customSections.length
    ? '\n' + customSections.map(s => `  "${s.id}": [ ...up to 10 ${s.label} stories... ],`).join('\n')
    : '';
  const customRules = customSections.length
    ? '\nCustom sections — populate only if relevant content exists:\n' +
      customSections.map(s => `- ${s.id}: stories specifically about ${s.label}`).join('\n')
    : '';

  return `${SYSTEM_BASE}${personaInstructions(persona)}${customRules}

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

  const sys = (customSections.length || persona) ? buildSystemPrompt(customSections, persona) : SYSTEM;

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
  for (const cat of allCats) {
    if (!Array.isArray(digest[cat])) continue;
    for (const item of digest[cat]) {
      const match = headlineMap[item.headline?.toLowerCase().trim()];
      if (match) {
        if (!item.image    && match.image)    item.image    = match.image;
        if (!item.keywords && match.keywords) item.keywords = match.keywords;
      }
    }
  }

  return digest;
}

module.exports = { generateDigest, buildSystemPrompt, getClient, callClaudeCLI, callAnthropic, _callModel, ALL_MODELS, CLI_MODELS, ANTHROPIC_MODELS, GROQ_MODELS, DEEPSEEK_MODELS, QWEN_MODELS };
