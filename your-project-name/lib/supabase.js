'use strict';
const { createClient } = require('@supabase/supabase-js');

let _client = null;
function getClient() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    _client = createClient(url, key, { auth: { persistSession: false } });
  }
  return _client;
}

// ── Read history ──────────────────────────────────────────────────────────────

async function markRead(story) {
  const { error } = await getClient()
    .from('read_stories')
    .insert({
      headline:         story.headline,
      cluster_keywords: story.cluster_keywords || [],
      category:         story.category || null,
      source:           story.source || null,
    });
  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
}

async function getReadHistory(days = 3) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await getClient()
    .from('read_stories')
    .select('headline, cluster_keywords, category, source, read_at')
    .gte('read_at', since)
    .order('read_at', { ascending: false });
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  return data || [];
}

async function getClusterReadState() {
  const history = await getReadHistory(1);
  const state   = {};
  for (const row of history) {
    for (const kw of (row.cluster_keywords || [])) {
      if (!state[kw]) state[kw] = [];
      state[kw].push(row.headline);
    }
  }
  return state;
}

// ── Digest cache ──────────────────────────────────────────────────────────────
// Uses the `digest_cache` table: date_key TEXT primary key, digest JSONB, ran_at TIMESTAMPTZ, enriched BOOLEAN

/**
 * Save (or update) the full processed digest for a given date.
 * @param {string} dateKey  e.g. "2026-04-29"
 * @param {object} digest   Full digest object
 * @param {boolean} enriched Whether background enrichment is complete
 */
async function saveDigest(dateKey, digest, enriched = false) {
  const { error } = await getClient()
    .from('digest_cache')
    .upsert(
      { date_key: dateKey, digest, ran_at: new Date().toISOString(), enriched },
      { onConflict: 'date_key' }
    );
  if (error) throw new Error(`[digest_cache.save] ${error.message}`);
}

/**
 * Retrieve the cached digest for a given date.
 * @param {string} dateKey  e.g. "2026-04-29"
 * @returns {{ digest: object, ran_at: string, enriched: boolean } | null}
 */
async function getDigest(dateKey) {
  const { data, error } = await getClient()
    .from('digest_cache')
    .select('digest, ran_at, enriched')
    .eq('date_key', dateKey)
    .maybeSingle();
  if (error) throw new Error(`[digest_cache.get] ${error.message}`);
  return data || null;
}

/**
 * Get the most recent cached digest regardless of date.
 * @returns {{ date_key: string, digest: object, ran_at: string, enriched: boolean } | null}
 */
async function getLatestDigest() {
  const { data, error } = await getClient()
    .from('digest_cache')
    .select('date_key, digest, ran_at, enriched')
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`[digest_cache.getLatest] ${error.message}`);
  return data || null;
}

/**
 * List the most recent N cached digests (metadata only — no payload).
 * Used by the Settings → Last run cache panel.
 */
async function listDigests(limit = 14) {
  const { data, error } = await getClient()
    .from('digest_cache')
    .select('date_key, ran_at, enriched')
    .order('ran_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`[digest_cache.list] ${error.message}`);
  return data || [];
}

/**
 * List recent read-stories rows (used for Thought Leadership dedupe + read map).
 */
async function listReadStories({ limit = 500, days = 365 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data, error } = await getClient()
    .from('read_stories')
    .select('headline, cluster_keywords, category, source, read_at')
    .gte('read_at', since)
    .order('read_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`[read_stories.list] ${error.message}`);
  return data || [];
}

/**
 * Delete digest_cache + read_stories rows older than `days`. Used by the 3pm
 * cron as a lightweight garbage-collection step. Feedback (kv_store rows keyed
 * `feedback:*`) and notebook (`notebook:*`) are NEVER swept here.
 */
async function purgeOldCache({ days = 30 } = {}) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const c = getClient();
  const results = {};
  const a = await c.from('digest_cache').delete().lt('ran_at', cutoff).select('date_key');
  results.digestsDeleted = a.data?.length || 0;
  const b = await c.from('read_stories').delete().lt('read_at', cutoff).select('id');
  results.readStoriesDeleted = b.data?.length || 0;
  // kv_store sweep: anything whose key starts with 'cache:' or 'temp:' AND is older than cutoff
  const d = await c.from('kv_store').delete().lt('updated_at', cutoff)
    .or("key.like.cache:%,key.like.temp:%").select('key');
  results.kvCacheDeleted = d.data?.length || 0;
  return results;
}

/**
 * Remove notebook entries whose last-touched timestamp is older than 365 days.
 * Notebook rows live in kv_store under key `notebook:entries` (a JSON array).
 */
async function purgeIdleNotebook({ days = 365 } = {}) {
  const c = getClient();
  const { data, error } = await c.from('kv_store').select('value').eq('key', 'notebook:entries').maybeSingle();
  if (error || !data?.value) return { purged: 0 };
  const cutoff = Date.now() - days * 864e5;
  const before = Array.isArray(data.value) ? data.value : [];
  const after = before.filter(n => {
    const t = new Date(n.updatedAt || n.createdAt || 0).getTime();
    return isFinite(t) && t > cutoff;
  });
  if (after.length === before.length) return { purged: 0 };
  await c.from('kv_store').upsert({ key: 'notebook:entries', value: after, updated_at: new Date().toISOString() });
  return { purged: before.length - after.length };
}

module.exports = {
  markRead,
  getReadHistory,
  getClusterReadState,
  saveDigest,
  getDigest,
  getLatestDigest,
  listDigests,
  listReadStories,
  purgeOldCache,
  purgeIdleNotebook,
};
