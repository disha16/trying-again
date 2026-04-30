'use strict';

/**
 * unDraw illustration helper.
 *
 * Returns a stable jsDelivr-hosted unDraw SVG URL for a given key string.
 * The same key always maps to the same illustration, so re-renders are
 * deterministic and visually consistent.
 *
 * Source: github.com/balazser/undraw-svg-collection (1,362 SVGs, MIT).
 * Served via jsDelivr CDN — fast, cacheable, no API call from the server.
 *
 * Usage:
 *   const undraw = require('./lib/undraw');
 *   const img = undraw.pick('Apple Q4 earnings beat');           // any string
 *   const img = undraw.pick('startup', { theme: 'business' });   // bias topic
 */

const CDN = 'https://cdn.jsdelivr.net/gh/balazser/undraw-svg-collection@main/svgs';

// Curated, business / news / data-themed illustrations (verified 200 OK).
// Add more freely — list is just shuffled deterministically per key.
const SLUGS = [
  // Business & finance
  'business-deal', 'business-decisions', 'business-plan', 'business-analytics',
  'finance', 'financial-data', 'investment', 'investing', 'invest',
  'investor-update', 'investment-data', 'revenue', 'shared-goals',
  'stocks-rising', 'stockholm', 'startup-life', 'savings',
  // Data & analytics
  'data-trends', 'data-report', 'data-reports', 'data-points', 'data-processing',
  'analytics', 'growth-analytics', 'mobile-analytics', 'dark-analytics',
  'dashboard', 'charts', 'growth-chart', 'growth-curve', 'all-the-data',
  // News & ideas
  'happy-news', 'exciting-news', 'breaking-barriers', 'press-play',
  'newspaper', 'reading-time', 'reading', 'reading-a-book',
  'ideas-flow', 'forming-ideas', 'ideation', 'conceptual-idea', 'ideas',
  // Tech & product
  'launch-day', 'launching', 'maker-launch', 'in-the-office',
  'engineering-team', 'dev-productivity', 'design-data', 'design-team',
  'mobile-marketing', 'marketing', 'product-tour', 'product-iteration',
  // Teams & meetings
  'meet-the-team', 'meeting', 'team-spirit', 'team-collaboration',
  'connecting-teams', 'good-team', 'creative-team', 'content-team',
  // Misc clean illustrations
  'world', 'progress-overview', 'progress-data', 'metrics', 'visionary-technology',
  'predictive-analytics', 'positive-attitude', 'organizing-projects'
];

function _hash(s) {
  let h = 2166136261;
  s = String(s || 'undraw');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function urlFor(slug) {
  return `${CDN}/${slug}.svg`;
}

/**
 * Pick a deterministic unDraw URL for the given key.
 * @param {string} key  any string (headline, ID, etc.)
 * @param {object} [opts]
 * @param {string[]} [opts.subset]  optional pool to pick from instead of full SLUGS
 */
function pick(key, opts = {}) {
  const pool = opts.subset && opts.subset.length ? opts.subset : SLUGS;
  return urlFor(pool[_hash(key) % pool.length]);
}

module.exports = { pick, urlFor, SLUGS, CDN };
