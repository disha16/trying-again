'use strict';

const { google }                     = require('googleapis');
const { getGmailTokens, setGmailTokens } = require('./storage');

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
  const client         = buildClient();
  const { tokens }     = await client.getToken(code);
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

function extractPlainText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64').toString('utf8');
  }
  if (part.parts) return part.parts.map(extractPlainText).join('\n\n');
  return '';
}

function parseMessage(msg) {
  const headers = msg.payload?.headers ?? [];
  const get     = name => headers.find(h => h.name.toLowerCase() === name)?.value ?? '';
  return {
    subject: get('subject'),
    from:    get('from'),
    date:    get('date'),
    body:    extractPlainText(msg.payload).slice(0, 8000),
  };
}

async function fetchNewsletterEmails() {
  const auth  = await getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId:     'me',
    q:          'in:inbox newer_than:3d',
    maxResults: 15,
  });

  const messages = listRes.data.messages ?? [];
  if (!messages.length) return [];

  const emails = await Promise.all(
    messages.map(({ id }) =>
      gmail.users.messages.get({ userId: 'me', id, format: 'full' })
        .then(r => parseMessage(r.data))
        .catch(() => null)
    )
  );

  return emails.filter(Boolean);
}

module.exports = { getAuthUrl, handleCallback, fetchNewsletterEmails };
