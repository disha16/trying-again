'use strict';

const { google }                             = require('googleapis');
const { getGmailTokens, setGmailTokens,
        getEmailCache, setEmailCache,
        getSources }                         = require('./storage');

function buildClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl() {
  return buildClient().generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       ['https://www.googleapis.com/auth/gmail.readonly'],
  });
}

async function handleCallback(code) {
  const client     = buildClient();
  const { tokens } = await client.getToken(code);
  await setGmailTokens(tokens);
  return tokens;
}

async function getAuthenticatedClient() {
  const tokens = await getGmailTokens();
  if (!tokens) throw new Error('Gmail not authorised — visit /auth/setup first');
  const client = buildClient();
  client.setCredentials(tokens);
  client.on('tokens', async newTokens => {
    await setGmailTokens({ ...tokens, ...newTokens });
  });
  return client;
}

// ── Content extraction ───────────────────────────────────────────────────────

function extractHtml(part) {
  if (!part) return '';
  if (part.mimeType === 'text/html' && part.body?.data)
    return Buffer.from(part.body.data, 'base64').toString('utf8');
  if (part.parts) return part.parts.map(extractHtml).join('');
  return '';
}

function extractPlainText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data)
    return Buffer.from(part.body.data, 'base64').toString('utf8');
  if (part.parts) return part.parts.map(extractPlainText).join('\n');
  return '';
}

/**
 * Extract clean readable text from an email — used as input to the AI clusterer.
 * Returns up to maxChars characters of clean prose.
 */
function extractBodyText(msg, maxChars = 2500) {
  // Prefer plain text (compact, no HTML noise)
  let text = extractPlainText(msg.payload);

  if (!text || text.length < 100) {
    // Strip HTML to plain text
    const html = extractHtml(msg.payload);
    text = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, '').replace(/&[a-z]+;/gi, ' ');
  }

  return text
    .replace(/https?:\/\/\S+/g, '')          // strip URLs
    .replace(/\u200C|\u200B|\u00AD|\uFEFF/g, '') // strip zero-width/invisible chars
    .replace(/[^\S\n]{2,}/g, ' ')             // collapse inline spaces
    .replace(/\n{3,}/g, '\n\n')               // max 2 blank lines
    .trim()
    .slice(0, maxChars);
}

/**
 * Extract external image URLs from an email (Exa handles real article images).
 */
function extractImageUrls(msg) {
  const html = extractHtml(msg.payload);
  if (!html) return [];
  const urls = [];
  const re   = /src=["'](https:\/\/[^"']+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^"']*)?)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (/open\.|track|pixel|beacon|spacer|logo|header|padded/i.test(url)) continue;
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= 3) break;
  }
  return urls;
}

// ── 3pm-ET to 3pm-ET window helper ──────────────────────────────────────────
// Returns { startSec, endSec, dateKey } in epoch seconds. The window always
// ends at 3pm ET (19:00 UTC during EDT, 20:00 UTC during EST). If "now" is
// before today's 3pm ET boundary, the window is [yesterday 3pm → today 3pm].
// Otherwise it's [today 3pm → tomorrow 3pm] (we're building the next digest).
function currentNewsletterWindow(now = new Date()) {
  // Use a fixed -4h offset during US-EDT (Mar–Nov). This is deliberate: the
  // newsletter cutoff is "3pm ET", which aligns with the user's 3pm-at-their-desk
  // mental model. (Close enough — for a perfect DST switch we'd use Intl APIs.)
  const ET_OFFSET_HOURS = 4; // EDT → UTC is +4; EST → UTC is +5. EDT is the majority of the year.
  const nowUtc = now.getTime();
  const utc = new Date(nowUtc);
  // Today at 15:00 ET = today 19:00 UTC (during EDT)
  const today15UtcMs = Date.UTC(
    utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(),
    15 + ET_OFFSET_HOURS, 0, 0, 0
  );
  let endMs;
  if (nowUtc < today15UtcMs) {
    // Still before today's 3pm ET — current window ends today at 3pm ET
    endMs = today15UtcMs;
  } else {
    // Past 3pm ET — next window ends tomorrow 3pm ET
    endMs = today15UtcMs + 24 * 60 * 60 * 1000;
  }
  const startMs = endMs - 24 * 60 * 60 * 1000;
  const end     = new Date(endMs);
  const dateKey = `${end.getUTCFullYear()}-${String(end.getUTCMonth()+1).padStart(2,'0')}-${String(end.getUTCDate()).padStart(2,'0')}`;
  return { startSec: Math.floor(startMs / 1000), endSec: Math.floor(endMs / 1000), dateKey };
}

// Returns { name, kind } where kind is 'newsletter' | 'thought_leadership'.
// kind is inferred from the configured source's `kind` field when matched.
function getSource(from, configuredSources = []) {
  // 1. Match against user-configured sources by email address
  for (const s of configuredSources) {
    if (s.email && from.toLowerCase().includes(s.email.toLowerCase()))
      return { name: s.name, kind: s.kind || 'newsletter' };
  }
  // 2. Match by domain against configured sources
  const domainMatch = from.match(/@([\w.-]+)/);
  if (domainMatch) {
    const domain = domainMatch[1].toLowerCase();
    for (const s of configuredSources) {
      if (s.email && s.email.toLowerCase().includes(domain.split('.')[0]))
        return { name: s.name, kind: s.kind || 'newsletter' };
    }
  }
  // 3. Fall back to sender display name
  const nameMatch = from.match(/^([^<]+)</);
  if (nameMatch) return { name: nameMatch[1].trim(), kind: 'newsletter' };
  return { name: domainMatch ? domainMatch[1] : from, kind: 'newsletter' };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Returns { entries, cacheHits, cacheMisses }
 * Each entry: { id, source, bodyText: string, imageUrls: string[] }
 */
async function fetchNewsletterHeadlines() {
  const auth             = await getAuthenticatedClient();
  const gmail            = google.gmail({ version: 'v1', auth });
  const [cache, sources] = await Promise.all([getEmailCache(), getSources()]);

  // 1. Get message list (IDs only — very cheap).
  // Strict window: from 3pm ET (previous day) to 3pm ET (today). If the current
  // moment is before 3pm ET, we're still inside the prior window.
  const { startSec, endSec } = currentNewsletterWindow();
  const q = `in:inbox subject:FW after:${startSec} before:${endSec}`;
  console.log(`[gmail] window: ${new Date(startSec*1000).toISOString()} → ${new Date(endSec*1000).toISOString()}`);
  const listRes = await gmail.users.messages.list({
    userId:     'me',
    q,
    maxResults: 40,
  });

  const messages = listRes.data.messages ?? [];
  if (!messages.length) return { entries: [], cacheHits: 0, cacheMisses: 0 };

  let cacheHits = 0, cacheMisses = 0;
  const entries = [];

  await Promise.all(messages.map(async ({ id }) => {
    // Cache hit — check it has bodyText (new format); old headline-only cache entries are re-fetched
    if (cache[id]?.bodyText) {
      cacheHits++;
      entries.push(cache[id]);
      return;
    }

    // Cache miss — fetch full message
    cacheMisses++;
    try {
      const res      = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const msg      = res.data;
      const headers  = msg.payload?.headers ?? [];
      const get      = name => headers.find(h => h.name.toLowerCase() === name)?.value ?? '';
      const from     = get('from');
      const subject  = get('subject');
      const bodyText = extractBodyText(msg);

      // For forwarded emails the outer `from` is the user, not the newsletter.
      // Try to recover the original sender from the forward header in the body.
      let meta = getSource(from, sources);
      const isForward = /^(fw|fwd):/i.test(subject.trim());
      if (isForward && meta.name === getSource(from, []).name) {
        // source fell through to display-name fallback — try the original sender
        const fwFrom = bodyText.match(/^From:\s*(.+)/m)?.[1] ?? '';
        if (fwFrom) meta = getSource(fwFrom, sources);
      }
      const imageUrls = extractImageUrls(msg);

      const entry = { id, source: meta.name, kind: meta.kind, subject, bodyText, imageUrls, cachedAt: new Date().toISOString() };
      cache[id]   = entry;
      entries.push(entry);
    } catch { /* skip failed fetches */ }
  }));

  // Persist updated cache
  await setEmailCache(cache);

  console.log(`[gmail] ${messages.length} emails — ${cacheHits} cached, ${cacheMisses} fetched`);
  return { entries, cacheHits, cacheMisses };
}

module.exports = { getAuthUrl, handleCallback, fetchNewsletterHeadlines, currentNewsletterWindow };
