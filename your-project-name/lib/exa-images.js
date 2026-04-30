'use strict';

/**
 * Card-image enrichment.
 *
 * Per latest product call: NO web image lookup (no Exa, no Tavily, no Brave).
 * If a card already has an image from the source newsletter, keep it.
 * Otherwise: assign a deterministic unDraw illustration so every card has
 * *some* visual.
 *
 * unDraw illustrations are open-source SVGs hosted via jsDelivr — fast,
 * cacheable, no API key, no rate limits, no credits. Fully cacheable on the CDN.
 *
 * File name kept (`exa-images.js`) for back-compat — many call sites still
 * `require('./exa-images')`. Function name `enrichClustersWithImages` is the
 * public entry point used by server.js and topic-clusters.js.
 */

const undraw = require('./undraw');

function placeholderForHeadline(headline) {
  return undraw.pick(headline || 'card');
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
    console.log(`[card-images] assigned unDraw placeholders: ${placed}/${clusters.length}`);
  }
}

// Helper exported for any other call site (e.g. earnings, deep-dive angles)
function getPlaceholderImage(seedText) {
  return placeholderForHeadline(String(seedText || 'card'));
}

module.exports = { enrichClustersWithImages, getPlaceholderImage, placeholderForHeadline };
