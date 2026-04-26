'use strict';
require('dotenv').config({ override: true, path: require('path').join(__dirname, '.env') });

const { fetchNewsletterHeadlines } = require('./lib/gmail');
const { clusterHeadlines }         = require('./lib/clusterer');
const { generateDigest }           = require('./lib/digest-generator');
const { setLastRun, getSettings }  = require('./lib/storage');

(async () => {
  const { model } = await getSettings();

  console.log('Fetching emails…');
  const { entries, cacheHits, cacheMisses } = await fetchNewsletterHeadlines();
  console.log(`${entries.length} newsletters (${cacheHits} cached, ${cacheMisses} new)`);

  console.log('Clustering…');
  const clusters = await clusterHeadlines(entries, model);
  console.log(`${clusters.length} unique stories`);

  console.log('Generating digest…');
  const start = Date.now();
  const timer = setInterval(() => process.stdout.write(`\r  ${Math.round((Date.now()-start)/1000)}s elapsed…`), 1000);
  const digest = await generateDigest(clusters, model);
  clearInterval(timer);
  process.stdout.write(`\r  Done in ${Math.round((Date.now()-start)/1000)}s\n`);

  await setLastRun({ ...digest, ranAt: new Date().toISOString(), model });
  console.log('✓ Digest ready —', digest.date);
})().catch(e => { console.error(e.message); process.exit(1); });
