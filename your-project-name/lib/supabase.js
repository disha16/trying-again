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

module.exports = {
  markRead,
  getReadHistory,
  getClusterReadState,
  saveDigest,
  getDigest,
  getLatestDigest,
};
