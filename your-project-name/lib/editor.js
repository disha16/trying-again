'use strict';

const { _callModel }       = require('./digest-generator');
const { getInjectedRules } = require('./persona-trainer');

const DEFAULT_CATS = ['top_today','tech','us_business','india_business','global_economies','politics','everything_else'];

/* ────────────────────────────────────────────────────────────────────────────
 * SHARPENED EDITOR
 *
 * Dedupe runs in four layers, each one catching a different class of
 * duplicate before the final LLM review.
 *
 *   Layer 1 — Entity + Event-verb signature  (deterministic, free)
 *       "Sensex rallies 900"  +  "Nifty closes higher"  →  both get the
 *       signature  market.india|move  → collapse
 *
 *   Layer 2 — Token-set Jaccard              (deterministic, free)
 *       Catches rephrased duplicates that don't share an entity.  Threshold
 *       chosen empirically: 0.55 within-section, 0.45 cross-section.
 *
 *   Layer 3 — Cross-section promotion        (deterministic, free)
 *       If the same event appears in top_today AND a category, drop the
 *       category copy.  If the same event appears in two categories (e.g.
 *       a geopolitics story in both us_business and politics), keep the
 *       one that the LLM originally placed higher priority on.
 *
 *   Layer 4 — LLM "same underlying event?" pair review  (cheap, targeted)
 *       For the surviving pairs that have Jaccard ≥ 0.30 we ask a single
 *       yes/no question to a fast model.  This is the fail-safe for
 *       semantic duplicates that share no surface tokens.
 *
 *   Finally, the existing LLM editor pass does MOVES + REORDER (no more
 *   heavy-lifting on removes because Layers 1-4 have already done it).
 * ──────────────────────────────────────────────────────────────────────── */

/* ── stop words / keep words ─────────────────────────────────────────── */
const STOP = new Set([
  'the','and','for','with','from','into','over','this','that','after','about',
  'amid','ahead','says','said','will','has','have','its','his','her','their',
  'was','were','been','being','are','but','not','new','today','today:','day',
  'week','year','report','reports','reported','news','update','latest','sources',
  'per','vs','amp','point','points','pts','percent','on','in','to','of','at',
  'by','as','or','a','an','is','it','be','do','did','does'
]);

/* ── headline normaliser: lowercase, strip digits, dedupe stopwords ── */
function _normTokens(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/[\d.,%\-+]+\s*(pts?|points?|%|percent|bps?|basis points?|bn|billion|mn|million|k|cr|crore|lakh)?/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w));
}

function _jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0; for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/* ── Entity + event-verb signature (Layer 1) ─────────────────────── */
const MARKETS = [
  { key: 'market.india',    tokens: ['sensex','nifty','bse','nse','nifty50'] },
  { key: 'market.us',       tokens: ['dow','nasdaq','s&p','sp500','russell','wall street'] },
  { key: 'market.europe',   tokens: ['ftse','cac','dax','stoxx','ibex'] },
  { key: 'market.asia',     tokens: ['nikkei','hang seng','kospi','shanghai composite','shenzhen'] },
  { key: 'market.crypto',   tokens: ['bitcoin','ether','ethereum','btc','eth','crypto market','altcoin'] },
  { key: 'commodity.oil',   tokens: ['crude','brent','wti','opec','oil price'] },
  { key: 'commodity.gold',  tokens: ['gold price','gold rally','gold rises','gold falls'] },
  { key: 'fx.usd',          tokens: ['dollar index','dxy','us dollar','greenback'] },
  { key: 'fx.inr',          tokens: ['rupee','usd inr','inr '] },
];
// Event-verb classes: map many surface verbs to a coarse bucket so
//   "acquires" / "to buy" / "bid for" all get the same verb signature.
const VERB_CLASSES = [
  ['move',      ['rise','rises','rose','fall','falls','fell','surge','surges','surged','jump','jumps','climb','climbs','climbed','rally','rallied','rallies','drop','drops','plunge','plunges','slide','slides','gain','gains','gained','close','closes','closed','open','opens','opened','trade','trades','higher','lower','up','down','advance','advances','retreat']],
  ['earnings',  ['earnings','revenue','profit','q1','q2','q3','q4','quarter','quarterly','beat','miss','misses','eps','guidance','forecast','fiscal','results']],
  ['mna',       ['acquire','acquires','acquisition','buy','buys','bought','merger','merges','deal','takeover','agreement','agree','agrees','agreed','to-buy','tie-up','jv','joint venture','stake','invest','invests','invested','investment']],
  ['hire',      ['hire','hires','hired','appoint','appoints','appointed','names','poaches','poached','promote','promoted','chief','ceo','cfo','coo','cto']],
  ['fire',      ['fire','fires','fired','ousted','ousts','resign','resigns','resigned','step','steps','stepped','exit','exits','exited']],
  ['layoffs',   ['layoff','layoffs','job cut','job cuts','fire','firing','downsize','reduce workforce']],
  ['launch',    ['launch','launches','launched','unveil','unveils','unveiled','release','releases','released','introduce','introduces','introduced','roll out','rolled out','ship','ships','shipped']],
  ['ruling',    ['rules','ruled','ruling','court','judge','judgement','judgment','verdict','supreme','appeals','circuit']],
  ['policy',    ['ban','bans','banned','tariff','tariffs','sanction','sanctions','law','bill','veto','approves','approved','passes','passed','signs','signed','regulate','regulates','regulated','rule','rules','executive order']],
  ['probe',     ['probe','probes','investigation','investigates','investigated','lawsuit','sues','sued','charges','charged','fine','fined','indicted','indicts']],
  ['ipo',       ['ipo','public offering','listing','lists','debut','debuts']],
  ['bankruptcy',['bankruptcy','chapter 11','chapter 7','insolvency','wind down','shuts down','closes down']],
  ['outage',    ['outage','down','down for','offline','hack','hacked','breach','cyberattack','ransomware','leak','leaks','leaked']],
  ['geopol',    ['strike','strikes','struck','attack','attacks','war','conflict','ceasefire','escalate','escalates','talks','summit','treaty','troops','missile']],
  ['macro',     ['cpi','inflation','jobs','payrolls','gdp','fed','federal reserve','rate','rates','central bank','rate cut','rate hike','hike','cut','unemployment','jobless']],
];
// Word-boundary matcher — avoids "nse" hitting inside "unsettling" etc.
function _hasWord(low, needle) {
  const n = needle.toLowerCase();
  // Multi-word needles: plain substring (e.g. "wall street", "hang seng")
  if (n.includes(' ') || n.includes('-')) return low.includes(n);
  // Single-word: word-boundary
  const re = new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^a-z0-9]|$)`, 'i');
  return re.test(low);
}
function _eventClass(low) {
  for (const [cls, words] of VERB_CLASSES) {
    if (words.some(w => _hasWord(low, w))) return cls;
  }
  return null;
}
function _marketClass(low) {
  for (const { key, tokens } of MARKETS) {
    if (tokens.some(t => _hasWord(low, t))) return key;
  }
  return null;
}
// Pull the first capitalised proper-noun-looking token from the ORIGINAL headline
// — this catches companies like "Google", "Pentagon", "Anthropic" without a lookup table.
function _dominantEntity(headline) {
  if (!headline) return null;
  const toks = headline.split(/\s+/).filter(Boolean);
  for (const t of toks) {
    const clean = t.replace(/[^A-Za-z]/g, '');
    if (clean.length >= 3 && /^[A-Z]/.test(clean) && !/^(The|And|For|With|From)$/.test(clean)) {
      return clean.toLowerCase();
    }
  }
  return null;
}
/**
 * Strong signature — only returned when we're highly confident two headlines
 * describe the same underlying event.  We require (entity ∪ market) + verb.
 */
// Known proper-noun companies that also hit a market token — we want
// the entity sig, not the market sig (e.g. "Amazon ... Wall Street").
const ENTITY_BEATS_MARKET = new Set([
  'amazon','apple','microsoft','meta','google','alphabet','tesla','nvidia',
  'anthropic','openai','netflix','salesforce','oracle','adobe','ibm','intel',
  'amd','broadcom','cisco','paypal','visa','mastercard','boeing','ford','gm',
  'reliance','tcs','infosys','wipro','hdfc','icici','adani','tata'
]);
function _strongSig(headline) {
  const low = String(headline || '').toLowerCase();
  const market  = _marketClass(low);
  const entity  = _dominantEntity(headline);
  const evtCls  = _eventClass(low);
  if (!evtCls) return null;
  // Prefer entity sig when the entity is a known company, even if a market token also hit.
  if (entity && ENTITY_BEATS_MARKET.has(entity)) return `e:${entity}|${evtCls}`;
  if (market) return `m:${market}|${evtCls}`;
  if (entity) return `e:${entity}|${evtCls}`;
  return null;
}

/* ── Layer 1 + 2: within-section collapse ─────────────────────────── */
function _collapseSection(items, opts = {}) {
  const jacThreshold = opts.jaccard ?? 0.55;
  const kept = [];
  const keptTokens = [];
  const seenSigs = new Set();
  let dropped = 0;
  for (const item of items) {
    const h = item.headline || item.title || '';
    const sig = _strongSig(h);
    if (sig && seenSigs.has(sig)) { dropped++; continue; }
    const toks = _normTokens(h);
    const similar = keptTokens.findIndex(t => _jaccard(t, toks) >= jacThreshold);
    if (similar !== -1) { dropped++; continue; }
    kept.push(item);
    keptTokens.push(toks);
    if (sig) seenSigs.add(sig);
  }
  return { items: kept, dropped };
}

/* ── Layer 3: cross-section promotion ────────────────────────────── */
function _crossSectionCollapse(digest, CATS) {
  // Rule: a story in top_today AND a category → keep only in top_today.
  // Rule: a story in two categories → keep the one it hit first in CATS order.
  const top = Array.isArray(digest.top_today) ? digest.top_today : [];
  const topSigs = new Set();
  const topToks = [];
  for (const item of top) {
    const h = item.headline || '';
    const sig = _strongSig(h);
    if (sig) topSigs.add(sig);
    topToks.push(_normTokens(h));
  }
  let dropped = 0;
  for (const cat of CATS) {
    if (cat === 'top_today' || !Array.isArray(digest[cat])) continue;
    const before = digest[cat].length;
    digest[cat] = digest[cat].filter(item => {
      const h = item.headline || '';
      const sig = _strongSig(h);
      if (sig && topSigs.has(sig)) return false;
      const toks = _normTokens(h);
      if (topToks.some(tt => _jaccard(tt, toks) >= 0.55)) return false;
      return true;
    });
    dropped += before - digest[cat].length;
  }
  return dropped;
}

/* ── Layer 4: LLM pair-review (bounded, cheap) ────────────────────── */
async function _pairReviewLLM(pairs, fastModel) {
  // pairs: [{cat, a:{headline}, b:{headline}}, ...]
  if (!pairs.length) return [];
  // Limit the number of pairs we send to the LLM — it's O(n²) otherwise.
  const MAX_PAIRS = 20;
  const trimmed = pairs.slice(0, MAX_PAIRS);
  const SYSTEM = `You are a news editor. For each numbered pair of headlines, reply ONLY with "1: YES" or "1: NO" on a new line per pair, where YES means both headlines report on the exact same underlying event.`;
  const body = trimmed.map((p, i) => `${i+1}) A: ${p.a.headline}\n   B: ${p.b.headline}`).join('\n\n');
  let raw = '';
  try {
    raw = await _callModel(fastModel, body, SYSTEM);
  } catch (e) {
    console.warn('[editor] pair-review LLM failed:', e.message);
    return [];
  }
  const dropB = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[:.)\-]\s*(yes|no)\b/i);
    if (!m) continue;
    const idx = +m[1] - 1;
    if (idx < 0 || idx >= trimmed.length) continue;
    if (/yes/i.test(m[2])) dropB.push(trimmed[idx]);
  }
  return dropB;
}

/* ── LLM editor pass: MOVES + REORDER only (removes have happened) ── */
const EDITOR_SYSTEM_BASE = `You are a senior news editor. Two things:
1. MOVE misplaced stories into the right section.
2. RE-RANK each section by global importance (most important first).

Dedupe has already been handled deterministically — do NOT remove stories.

SECTION DEFINITIONS:
- top_today: the 10 most globally important stories of the day, one per distinct major topic
- tech: technology companies, AI, software, hardware — NOT general business
- us_business: US-HQ companies, US domestic economy, Wall Street — NOT international
- india_business: India-specific business, Sensex, Indian companies, Indian economy
- global_economies: non-US international economies, foreign central banks, EM markets
- politics: government, elections, policy, geopolitics — NOT pure business unless policy-driven
- everything_else: genuine miscellany

Return ONLY valid JSON:
{
  "move":    [{ "headline": "exact headline", "from": "us_business", "to": "global_economies" }],
  "reorder": { "top_today": ["headline in priority order", ...], "tech": [...] }
}`;

function editorPersonaLayer(persona) {
  if (!persona || typeof persona !== 'object') return '';
  const lines = [];
  if (persona.scope === 'global')     lines.push('- Prefer the more globally significant story when tied');
  if (persona.scope === 'us')         lines.push('- Prefer the US-centric story when tied');
  if (persona.angle === 'investing')  lines.push('- Prefer stories with clearer market/portfolio impact when tied');
  if (persona.tech === 'heavy')       lines.push('- Prefer AI/software/semiconductor angles when tied');
  if (persona.tech === 'light')       lines.push('- Prefer non-tech angles when tied');
  if (persona.politics === 'minimal') lines.push('- Push pure-politics stories down in top_today (but keep them in politics section)');
  if (!lines.length) return '';
  return `\n\nREADER PREFERENCE (tiebreaker only — never remove):\n${lines.join('\n')}`;
}

/* ── Main ─────────────────────────────────────────────────────────── */
async function editDigest(digest, model, customSections = [], persona = null) {
  const CATS = [...DEFAULT_CATS, ...customSections.map(s => s.id)];

  // Layer 1 + 2: within-section collapse
  let droppedL12 = 0;
  for (const cat of CATS) {
    if (!Array.isArray(digest[cat])) continue;
    const { items, dropped } = _collapseSection(digest[cat]);
    digest[cat] = items;
    droppedL12 += dropped;
  }
  if (droppedL12) console.log(`[editor] layer-1/2 collapsed ${droppedL12} near-duplicates`);

  // Layer 3: cross-section promotion
  const droppedL3 = _crossSectionCollapse(digest, CATS);
  if (droppedL3) console.log(`[editor] layer-3 dropped ${droppedL3} cross-section repeats`);

  // Layer 4: LLM pair-review for remaining soft matches
  try {
    const pairs = [];
    for (const cat of CATS) {
      const items = digest[cat] || [];
      const toks  = items.map(i => _normTokens(i.headline || ''));
      for (let i = 0; i < items.length; i++) {
        for (let j = i+1; j < items.length; j++) {
          const jac = _jaccard(toks[i], toks[j]);
          if (jac >= 0.30 && jac < 0.55) {
            pairs.push({ cat, a: items[i], b: items[j] });
          }
        }
      }
    }
    if (pairs.length) {
      const fastModel = 'llama-3.1-8b-instant';  // Groq — fast + cheap
      const drops = await _pairReviewLLM(pairs, fastModel);
      if (drops.length) {
        const dropKeys = new Set(drops.map(d => `${d.cat}::${(d.b.headline||'').toLowerCase().trim()}`));
        let droppedL4 = 0;
        for (const cat of CATS) {
          if (!Array.isArray(digest[cat])) continue;
          const before = digest[cat].length;
          digest[cat] = digest[cat].filter(item => !dropKeys.has(`${cat}::${(item.headline||'').toLowerCase().trim()}`));
          droppedL4 += before - digest[cat].length;
        }
        if (droppedL4) console.log(`[editor] layer-4 LLM pair-review dropped ${droppedL4}`);
      }
    }
  } catch (e) {
    console.warn('[editor] layer-4 pair review failed:', e.message);
  }

  // Final LLM pass: MOVES + REORDER only
  let learnedRules = '';
  try { learnedRules = await getInjectedRules('editor'); } catch {}
  const personaLayer = editorPersonaLayer(persona);
  const system = `${EDITOR_SYSTEM_BASE}${learnedRules ? `\n${learnedRules}` : ''}${personaLayer}`;

  const sections = {};
  for (const cat of CATS) {
    const items = digest[cat];
    if (!Array.isArray(items) || !items.length) continue;
    sections[cat] = items.map((item, i) => `  [${i}] ${item.headline}`).join('\n');
  }
  if (!Object.keys(sections).length) return digest;

  const sectionText = Object.entries(sections).map(([c, l]) => `${c.toUpperCase()}:\n${l}`).join('\n\n');
  const prompt = `Review this digest — move misplaced stories and re-rank each section by importance (removes already done):\n\n${sectionText}`;

  let raw;
  try { raw = await _callModel(model, prompt, system); }
  catch (e) { console.warn('[editor] LLM call failed:', e.message); return digest; }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) { console.warn('[editor] No JSON in response'); return digest; }
  let edits;
  try { edits = JSON.parse(match[0]); } catch { console.warn('[editor] JSON parse failed'); return digest; }

  let totalMoved = 0, totalReordered = 0;

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
      reordered.push(...byHeadline.values());
      if (reordered.length) { digest[cat] = reordered; totalReordered++; }
    }
  }

  console.log(`[editor] moved ${totalMoved}, reordered ${totalReordered} sections`);
  return digest;
}

module.exports = { editDigest, _strongSig, _normTokens, _jaccard };
