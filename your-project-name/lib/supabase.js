'use strict';

const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getClient() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY required');
    _client = createClient(url, key);
  }
  return _client;
}

/**
 * Mark a story as read
 * @param {{ headline, cluster_keywords, category, source }} story
 */
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

/**
 * Get read history from the last N days
 * @param {number} days
 * @returns {Array<{headline, cluster_keywords, category, source, read_at}>}
 */
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

/**
 * Get what user has read within each cluster keyword group
 * Returns a map: keyword → [headlines read]
 */
async function getClusterReadState() {
  const history = await getReadHistory(1); // just today
  const state   = {};
  for (const row of history) {
    for (const kw of (row.cluster_keywords || [])) {
      if (!state[kw]) state[kw] = [];
      state[kw].push(row.headline);
    }
  }
  return state;
}

module.exports = { markRead, getReadHistory, getClusterReadState };
