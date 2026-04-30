'use strict';

/**
 * Issue-report capture.
 *
 * Writes every report to Supabase (`issue_reports` table) so the user has an
 * audit log, then tries to email drawal@mba2027.hbs.edu via Resend if
 * RESEND_API_KEY is set. The recipient address is never exposed to the client.
 */

const { createClient } = require('@supabase/supabase-js');

const ISSUE_RECIPIENT = 'drawal@mba2027.hbs.edu'; // server-side only, never surface to client

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

  if (!error) return data;

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
  return { id, created_at: createdAt, _fallback: true };
}

async function emailIssue({ body, userAgent, url, id, createdAt }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { emailed: false, reason: 'no RESEND_API_KEY configured' };

  const subject = `[Newsletter Digest] Issue reported #${id || ''}`;
  const text = [
    `Body:\n${body}`,
    `URL: ${url || 'n/a'}`,
    `User-Agent: ${userAgent || 'n/a'}`,
    `Logged at: ${createdAt || new Date().toISOString()}`,
  ].join('\n\n');

  const resp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body:    JSON.stringify({
      from:    process.env.RESEND_FROM || 'Newsletter Digest <onboarding@resend.dev>',
      to:      [ISSUE_RECIPIENT],
      subject,
      text,
    }),
  });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => '');
    return { emailed: false, reason: `Resend ${resp.status}: ${msg.slice(0,180)}` };
  }
  return { emailed: true };
}

module.exports = { logIssue, emailIssue };
