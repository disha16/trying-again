'use strict';

/**
 * Issue-report capture — Supabase only.
 *
 * Writes every report to the `issue_reports` table (or falls back to
 * `kv_store` if that table doesn't exist yet). No email path.
 */

const { createClient } = require('@supabase/supabase-js');

let _client = null;
function getClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

async function logIssue({ body, userAgent, url }) {
  if (!body || typeof body !== 'string') throw new Error('body required');
  const client = getClient();

  // Preferred path: dedicated issue_reports table.
  const { data, error } = await client
    .from('issue_reports')
    .insert({ body, user_agent: userAgent || null, url: url || null })
    .select('id, created_at')
    .single();

  if (!error) return { ...data, stored: 'issue_reports' };

  // Fallback: table doesn't exist yet — write to kv_store so submissions
  // still succeed before supabase-migration-v2.sql is applied.
  const msg = (error.message || '').toLowerCase();
  const missing = msg.includes("could not find the table")
               || msg.includes('does not exist')
               || msg.includes('schema cache');
  if (!missing) throw new Error(`[issue.log] ${error.message}`);

  const id        = `issue:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const record    = { id, body, user_agent: userAgent || null, url: url || null, created_at: createdAt };
  const { error: kvErr } = await client
    .from('kv_store')
    .upsert({ key: id, value: record }, { onConflict: 'key' });
  if (kvErr) throw new Error(`[issue.log.fallback] ${kvErr.message}`);
  return { id, created_at: createdAt, stored: 'kv_store' };
}

module.exports = { logIssue };
