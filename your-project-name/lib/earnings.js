'use strict';

/**
 * Scrape "Latest Earnings Articles" from MarketBeat's earnings hub.
 * Returns up to N most recent items as plain card-friendly objects:
 *   { title, url, image, author, dateLabel, source }
 *
 * No HTML-parser dependency: targeted regex over a stable section.
 * Cached once per digest run (called from the cron) and stored on the digest
 * JSON as `earnings`. Frontend renders them inside the US Business tab.
 */

const URL = 'https://www.marketbeat.com/earnings/';
const UA  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function stripTags(s) {
  return decodeEntities((s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

async function fetchEarnings(limit = 5) {
  let html;
  try {
    const r = await fetch(URL, {
      headers: {
        'User-Agent':                UA,
        'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language':           'en-US,en;q=0.9',
        'Accept-Encoding':           'gzip, deflate, br',
        'Cache-Control':             'no-cache',
        'Pragma':                    'no-cache',
        'Sec-Ch-Ua':                 '"Chromium";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile':          '?0',
        'Sec-Ch-Ua-Platform':        '"macOS"',
        'Sec-Fetch-Dest':            'document',
        'Sec-Fetch-Mode':            'navigate',
        'Sec-Fetch-Site':            'none',
        'Sec-Fetch-User':            '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    html = await r.text();
  } catch (e) {
    console.warn('[earnings] fetch failed:', e.message);
    return [];
  }

  // Narrow to the "Latest Earnings Articles" section to avoid grabbing
  // unrelated MarketBeat link-boxes elsewhere on the page.
  const startIdx = html.search(/Latest Earnings Articles/i);
  if (startIdx === -1) {
    console.warn('[earnings] section not found in HTML');
    return [];
  }
  // Take the next ~12,000 chars after the heading; covers the sidebar list
  // generously without bleeding into footer link blocks.
  const slice = html.slice(startIdx, startIdx + 12_000);

  // Each article is wrapped in <a class="linkbox …" href="…"> … </a>.
  const linkboxRe = /<a\s+class="linkbox[^"]*"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  const items = [];
  let match;
  while ((match = linkboxRe.exec(slice)) && items.length < limit) {
    const url   = match[1];
    const inner = match[2];

    // Title — prefer the .title-line text, fall back to img alt.
    const titleMatch =
      inner.match(/class="title-line[^"]*"[^>]*>([\s\S]*?)<\//) ||
      inner.match(/<img[^>]*alt="([^"]+)"/);
    const title = titleMatch ? stripTags(titleMatch[1]) : null;

    const imgMatch = inner.match(/<img[^>]*src="([^"]+)"/);
    const image    = imgMatch ? imgMatch[1] : null;

    // upper-note is a <div> containing 'By <author> <span>|</span> <date>'.
    // Match the whole div content (greedy-ish until the next <div or end of <a>).
    const noteMatch = inner.match(/class="upper-note[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const note      = noteMatch ? stripTags(noteMatch[1]) : '';
    // "By Thomas Hughes | April 29, 2026"
    const m = note.match(/^By\s+(.+?)\s*\|\s*(.+)$/i);
    const author    = m?.[1] || null;
    const dateLabel = m?.[2] || note || null;

    if (!title || !url) continue;
    const finalImage = image || require('./undraw').pick(title);
    items.push({ title, url, image: finalImage, author, dateLabel, source: 'MarketBeat' });
  }

  console.log(`[earnings] fetched ${items.length} articles from MarketBeat`);
  return items;
}

/**
 * Add a sharp 2-line insightful summary (`description` field) to each earnings
 * article via the digest LLM. Falls back to the existing description / a
 * generic line on any failure so the cron never blocks on this.
 */
async function summarizeEarnings(items, model) {
  if (!Array.isArray(items) || !items.length) return items || [];
  let _callModel;
  try { ({ _callModel } = require('./digest-generator')); }
  catch { return items; }

  const targetModel = model || 'claude-haiku-4-5-20251001';
  const prompt =
    `For each of the following ${items.length} earnings news headlines, write a sharp, ` +
    `insightful TWO-LINE summary (max ~40 words). Focus on what an investor or ` +
    `business reader should take away — beats/misses, guidance, sector signal, ` +
    `or competitive read-through. Avoid restating the headline.\n\n` +
    items.map((it, i) => `${i + 1}. ${it.title}` + (it.author ? ` (by ${it.author})` : '')).join('\n') +
    `\n\nReturn ONLY a JSON array of ${items.length} strings in the same order, no prose.`;

  let parsed = null;
  try {
    const raw   = await _callModel(targetModel, prompt, 'You are a concise financial editor. Return strict JSON only.');
    const match = raw && raw.match(/\[[\s\S]*\]/);
    if (match) parsed = JSON.parse(match[0]);
  } catch (e) {
    console.warn('[earnings] summary LLM failed:', e.message);
  }

  return items.map((it, i) => ({
    ...it,
    description: (parsed && typeof parsed[i] === 'string' && parsed[i].trim()) || it.description || '',
  }));
}

module.exports = { fetchEarnings, summarizeEarnings };
