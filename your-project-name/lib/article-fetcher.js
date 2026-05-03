'use strict';

/**
 * Article fetcher: given a URL, fetch the page, strip boilerplate, and return a
 * clean text excerpt of the article body suitable for LLM summarisation.
 *
 * Used by internet-fallback to upgrade web-sourced article descriptions from
 * Google-snippet quality to real "what happened + why it matters" content.
 */

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function fetchText(rawUrl, { timeout = 8000, maxBytes = 350 * 1024, redirectsLeft = 3 } = {}) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(rawUrl); } catch { resolve(''); return; }
    const lib = url.protocol === 'http:' ? http : https;

    const req = lib.get(url, {
      headers: {
        'User-Agent':       UA,
        'Accept':           'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':  'en-US,en;q=0.9',
        'Accept-Encoding':  'gzip, deflate',
        'Cache-Control':    'no-cache',
        'Pragma':           'no-cache',
      },
      timeout,
    }, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(fetchText(next, { timeout, maxBytes, redirectsLeft: redirectsLeft - 1 }));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        resolve('');
        return;
      }

      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      let total = 0;
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy();
          resolve(Buffer.concat(chunks).toString('utf8'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', () => resolve(''));
    });

    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

/**
 * Extract the main article body from raw HTML. Tries multiple strategies in
 * order — JSON-LD article body, <article> tag, schema.org main content
 * heuristics, and finally a generic <p>-tag concatenation.
 *
 * Returns plain-text content, no HTML tags, normalised whitespace.
 */
function extractArticleText(html) {
  if (!html || typeof html !== 'string') return '';

  // 1) JSON-LD: many publishers ship NewsArticle structured data with articleBody
  const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = jsonLdRe.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      const items = Array.isArray(obj) ? obj : (obj['@graph'] || [obj]);
      for (const it of items) {
        if (it && typeof it.articleBody === 'string' && it.articleBody.length > 200) {
          return cleanText(it.articleBody).slice(0, 4000);
        }
      }
    } catch { /* ignore */ }
  }

  // 2) <article> tag — strip nested scripts/styles and extract paragraph text
  const artMatch = html.match(/<article[\s\S]*?<\/article>/i);
  let scope = artMatch ? artMatch[0] : null;

  // 3) Common content wrappers
  if (!scope) {
    const candidates = [
      /<div[^>]+class=["'][^"']*(article-body|article__body|story-body|post-content|entry-content|content__article-body|main-content)[^"']*["'][\s\S]*?<\/div>/i,
      /<main[^>]*>[\s\S]*?<\/main>/i,
    ];
    for (const re of candidates) {
      const c = html.match(re);
      if (c) { scope = c[0]; break; }
    }
  }

  // 4) Fallback to whole document
  if (!scope) scope = html;

  // Strip scripts, styles, asides, navs, footers, figures captions
  const cleaned = scope
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '');

  // Extract <p> contents
  const paras = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pm;
  while ((pm = pRe.exec(cleaned)) !== null) {
    const text = stripTags(pm[1]).trim();
    if (text.length >= 40) paras.push(text); // skip tiny stubs
  }

  if (paras.length) return cleanText(paras.join('\n\n')).slice(0, 4000);

  // Final fallback: strip ALL tags
  return cleanText(stripTags(cleaned)).slice(0, 4000);
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&[a-z0-9#]+;/gi, ' ');
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Fetch article body for a URL. Returns up to 4000 chars of clean text, or
 * empty string on any failure.
 */
async function fetchArticleBody(url) {
  if (!url) return '';
  const html = await fetchText(url);
  if (!html) return '';
  return extractArticleText(html);
}

/**
 * Fetch many articles in parallel with bounded concurrency.
 *
 * @param {string[]} urls
 * @param {number}   concurrency
 * @returns {Promise<string[]>} same-length array of body texts ('' on failure)
 */
async function fetchArticleBodies(urls, concurrency = 8) {
  const results = new Array(urls.length).fill('');
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (cursor < urls.length) {
      const i = cursor++;
      try { results[i] = await fetchArticleBody(urls[i]); } catch { results[i] = ''; }
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { fetchArticleBody, fetchArticleBodies, extractArticleText };
