'use strict';

const Exa = require('exa-js').default;

const BAD_IMAGE_PATTERNS = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|profile|placeholder|pixel|tracking|beacon/i;

// Press release / wire service domains — images are always their own branding
const BAD_SOURCE_DOMAINS = [
  'globenewswire.com', 'prnewswire.com', 'businesswire.com',
  'accesswire.com', 'notified.com', 'einpresswire.com',
  'newswire.com', 'prlog.org', 'send2press.com', 'openpr.com',
];

// Domain keyword patterns that indicate non-news sites
const BAD_DOMAIN_PATTERNS = /food|recipe|cook|eat|drink|diet|health|wellness|fitness|beauty|fashion|style|travel|lifestyle|sport|game|entertain|celeb|gossip|horoscope/i;

function isGoodResult(r) {
  if (!r.image) return false;
  if (BAD_IMAGE_PATTERNS.test(r.image)) return false;
  if (r.url) {
    const domain = r.url.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
    if (BAD_SOURCE_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return false;
    if (BAD_DOMAIN_PATTERNS.test(domain)) return false;
  }
  return true;
}

async function fetchExaImage(exa, headline) {
  const res = await exa.search(headline, {
    numResults: 8,
    category:   'news',
  });
  const hit = res.results.find(isGoodResult);
  // Fall back to any image only if nothing passed the filter
  return hit?.image || null;
}

async function enrichClustersWithImages(clusters) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) { console.warn('[exa] EXA_API_KEY not set — skipping'); return; }

  const exa = new Exa(apiKey);

  await Promise.all(clusters.map(async c => {
    try {
      const img = await fetchExaImage(exa, c.headline);
      if (img) c.image = img;
    } catch (e) {
      console.warn(`[exa] "${c.headline.slice(0, 50)}":`, e.message);
    }
  }));

  const found = clusters.filter(c => c.image).length;
  console.log(`[exa] images found: ${found}/${clusters.length}`);
}

module.exports = { enrichClustersWithImages };
