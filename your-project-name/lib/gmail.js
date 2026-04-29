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

function getSource(from, configuredSources = []) {
  // 1. Match against user-configured sources by email address
  for (const s of configuredSources) {
    if (s.email && from.toLowerCase().includes(s.email.toLowerCase())) return s.name;
  }
  // 2. Match by domain against configured sources
  const domainMatch = from.match(/@([\w.-]+)/);
  if (domainMatch) {
    const domain = domainMatch[1].toLowerCase();
    for (const s of configuredSources) {
      if (s.email && s.email.toLowerCase().includes(domain.split('.')[0])) return s.name;
    }
  }
  // 3. Fall back to sender display name
  const nameMatch = from.match(/^([^<]+)</);
  if (nameMatch) return nameMatch[1].trim();
  return domainMatch ? domainMatch[1] : from;
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

  // 1. Get message list (IDs only — very cheap)
  const listRes = await gmail.users.messages.list({
    userId:     'me',
    q:          'in:inbox newer_than:1d subject:FW',
    maxResults: 20,
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
      let source = getSource(from, sources);
      const isForward = /^(fw|fwd):/i.test(subject.trim());
      if (isForward && source === getSource(from, [])) {
        // source fell through to display-name fallback — try the original sender
        const fwFrom = bodyText.match(/^From:\s*(.+)/m)?.[1] ?? '';
        if (fwFrom) source = getSource(fwFrom, sources);
      }
      const imageUrls = extractImageUrls(msg);

      const entry = { id, source, bodyText, imageUrls, cachedAt: new Date().toISOString() };
      cache[id]   = entry;
      entries.push(entry);
    } catch { /* skip failed fetches */ }
  }));

  // Persist updated cache
  await setEmailCache(cache);

  console.log(`[gmail] ${messages.length} emails — ${cacheHits} cached, ${cacheMisses} fetched`);
  return { entries, cacheHits, cacheMisses };
}

module.exports = { getAuthUrl, handleCallback, fetchNewsletterHeadlines };
