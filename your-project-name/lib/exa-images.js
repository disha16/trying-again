'use strict';

/**
 * Card-image enrichment.
 *
 * Per latest product call: NO web image lookup (no Exa, no Tavily, no Brave).
 * If a card already has an image from the source newsletter, keep it.
 * Otherwise: assign a deterministic placeholder so every card has *some* image.
 *
 * The placeholder uses picsum.photos with a seed derived from the headline,
 * which gives a stable, decent-looking generic image per card across reloads
 * (no API key, no rate limits, no credits). Fully cacheable on the CDN.
 *
 * File name kept (`exa-images.js`) for back-compat — many call sites still
 * `require('./exa-images')`. Function name `enrichClustersWithImages` is the
 * public entry point used by server.js and topic-clusters.js.
 */

function placeholderForHeadline(headline) {
  // Stable hash → seed; identical headlines get identical placeholders.
  let h = 0;
  for (let i = 0; i < headline.length; i++) {
    h = ((h << 5) - h) + headline.charCodeAt(i);
    h |= 0;
  }
  const seed = Math.abs(h);
  // 800x420 = roughly 16:9; matches our card aspect.
  return `https://picsum.photos/seed/${seed}/800/420`;
}

async function enrichClustersWithImages(clusters /* opts ignored */) {
  if (!Array.isArray(clusters) || !clusters.length) return;
  let placed = 0;
  for (const c of clusters) {
    if (!c || c.image) continue;
    const seedText = c.headline || c.title || c.id || 'card';
    c.image = placeholderForHeadline(String(seedText));
    placed++;
  }
  if (placed) {
    console.log(`[card-images] assigned placeholders: ${placed}/${clusters.length}`);
  }
}

// Helper exported for any other call site (e.g. earnings, deep-dive angles)
function getPlaceholderImage(seedText) {
  return placeholderForHeadline(String(seedText || 'card'));
}

module.exports = { enrichClustersWithImages, getPlaceholderImage, placeholderForHeadline };
