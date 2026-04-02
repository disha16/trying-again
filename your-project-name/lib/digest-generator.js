'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM = `You are a senior news editor. You receive forwarded newsletter emails and produce a structured JSON daily digest.

Newsletters are forwarded from drawal@mba2027.hbs.edu — subjects start with "FW:". The actual newsletter content is in the email body. Sources include Financial Times, TechCrunch, and New York Times.

Return ONLY a valid JSON object — no markdown, no extra text:
{
  "date": "<today's date, e.g. April 2, 2026>",
  "top_today": [ ...exactly 10 items, one per major topic, no topic repeated... ],
  "tech": [ ...up to 10 items... ],
  "us_business": [ ...up to 10 items... ],
  "india_business": [ ...up to 10 items... ],
  "global_economies": [ ...up to 10 items... ],
  "politics": [ ...up to 10 items... ],
  "everything_else": [ ...up to 10 items... ]
}

Each item: { "headline": "...", "description": "...", "source": "Financial Times" | "TechCrunch" | "New York Times" }

Rules:
- top_today: 10 most important stories across all sources — one per major topic, no topic may appear twice
- Headlines under 120 chars, descriptions under 180 chars
- Do not invent content — use only what is in the emails`;

async function generateDigest(emails) {
  if (!emails.length) throw new Error('No emails to summarise');

  const emailsText = emails.map((e, i) =>
    `--- EMAIL ${i + 1} ---\nSubject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\n\n${e.body}`
  ).join('\n\n');

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response  = await anthropic.messages.create({
    model:     'claude-opus-4-6',
    max_tokens: 4096,
    system:     SYSTEM,
    messages:  [{ role: 'user', content: `Generate today's digest from these emails:\n\n${emailsText}` }],
  });

  const text  = response.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Model did not return valid JSON');

  const digest = JSON.parse(match[0]);
  if (!digest.date || !Array.isArray(digest.top_today)) {
    throw new Error('Digest JSON missing required fields');
  }
  return digest;
}

module.exports = { generateDigest };
