'use strict';
/**
 * Storage layer — backed entirely by Supabase kv_store table.
 * No local file system, no Vercel KV.
 * Table schema: kv_store(key TEXT primary key, value JSONB, updated_at TIMESTAMPTZ)
 */
const { createClient } = require('@supabase/supabase-js');

let _client = null;
function getClient() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    _client = createClient(url, key, { auth: { persistSession: false } });
  }
  return _client;
}

// ── Generic KV helpers ────────────────────────────────────────────────────────
async function getKey(key) {
  const { data, error } = await getClient()
    .from('kv_store')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw new Error(`[storage.getKey] ${key}: ${error.message}`);
  return data ? data.value : null;
}

async function setKey(key, value) {
  const { error } = await getClient()
    .from('kv_store')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`[storage.setKey] ${key}: ${error.message}`);
}

// ── Public API ────────────────────────────────────────────────────────────────
const getSources = () => getKey('sources').then(v => v ?? []);
const setSources = arr => setKey('sources', arr);

const getLastRun = () => getKey('lastRun');

// Enrichment fields are produced asynchronously; don't wipe them on a new core save.
// On date change, stale enrichment is auto-cleared.
const ENRICHMENT_FIELDS = ['topic_clusters', 'charts'];
async function setLastRun(d, opts = {}) {
  if (opts.replace) return setKey('lastRun', d);
  const existing = (await getKey('lastRun')) || {};
  const merged   = { ...existing, ...d };
  if (existing.date && d.date && existing.date !== d.date) {
    for (const f of ENRICHMENT_FIELDS) {
      if (!(f in d)) delete merged[f];
    }
  }
  return setKey('lastRun', merged);
}

const getInboxSnapshot = () => getKey('inboxSnapshot');
const setInboxSnapshot = s  => setKey('inboxSnapshot', s);
const getGmailTokens   = () => getKey('gmail_tokens');
const setGmailTokens   = t  => setKey('gmail_tokens', t);

const DEFAULT_SETTINGS = {
  clusterModel:     'llama-3.3-70b-versatile',
  digestModel:      'llama-3.3-70b-versatile',
  editorModel:      'llama-3.3-70b-versatile',
  chatModel:        'llama-3.3-70b-versatile',
  internetFallback: true,
  showImages:       true,  // admin-only: when false, skip image fetch + chart-of-day
  timezone:         'America/New_York', // default ET; overridden in Settings
};
const getSettings = () => getKey('settings').then(v => ({ ...DEFAULT_SETTINGS, ...(v ?? {}) }));
const setSettings = s  => setKey('settings', s);

const getClusters = () => getKey('clusters');
const setClusters = c  => setKey('clusters', c);

// Email headline cache — keyed by Gmail message ID
async function getEmailCache() {
  const cache = await getKey('emailCache');
  if (!cache) return {};
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return Object.fromEntries(
    Object.entries(cache).filter(([, v]) => new Date(v.cachedAt).getTime() > cutoff)
  );
}
const setEmailCache = cache => setKey('emailCache', cache);

const getNotes         = ()    => getKey('notes').then(v => v ?? []);
const setNotes         = notes => setKey('notes', notes);
const getDigestHistory = ()    => getKey('digestHistory').then(v => v ?? {});
const setDigestHistory = h     => setKey('digestHistory', h);

// ── Story feedback (stored in kv_store as feedback:YYYY-MM-DD arrays) ──────────
async function getFeedback(dateKey) {
  return getKey(`feedback:${dateKey}`).then(v => v ?? []);
}
async function addFeedback(dateKey, entry) {
  const list = await getFeedback(dateKey);
  const idx = list.findIndex(f => f.headline === entry.headline);
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  await setKey(`feedback:${dateKey}`, list);
}
// ── Quality check note (condensed from prior-day feedback, injected into prompts) ──
const getQualityNote = () => getKey('qualityNote').then(v => v ?? null);
const setQualityNote = note => setKey('qualityNote', note);

module.exports = {
  isVercel: true, // always true now — kept for backward compat
  getKey, setKey,
  // Aliases so newer modules can use getKV/setKV idiom
  getKV: getKey, setKV: setKey,
  getSources, setSources,
  getLastRun, setLastRun,
  getInboxSnapshot, setInboxSnapshot,
  getGmailTokens, setGmailTokens,
  getSettings, setSettings,
  getClusters, setClusters,
  getEmailCache, setEmailCache,
  getNotes, setNotes,
  getDigestHistory, setDigestHistory,
  getFeedback, addFeedback,
  getQualityNote, setQualityNote,
};
