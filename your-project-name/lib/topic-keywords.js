'use strict';

/**
 * Built-in keyword/scope expansion for common single-word custom-section names.
 *
 * When a user creates a custom digest section called "Entertainment" without
 * writing a description, we still want a strong web query and a sensible LLM
 * scope. This module ships a small library of common topics; for unknown names
 * we just fall back to the label itself.
 */

const TOPICS = {
  entertainment: {
    query: 'entertainment news today films streaming TV music celebrity',
    scope: 'films, TV shows, streaming services, music, celebrity news, awards, gaming, sports, books, theatre — culture and pop culture, NOT business, tech, AI, or politics unless they centre on an entertainment story',
    domains: ['variety.com','hollywoodreporter.com','deadline.com','rollingstone.com','billboard.com','vulture.com','indiewire.com','ew.com','collider.com','thewrap.com','pitchfork.com','consequence.net','spin.com'],
  },
  sports: {
    query: 'sports news today football cricket basketball tennis',
    scope: 'sports — football/soccer, cricket, basketball, tennis, F1, golf, NFL, NBA, MLB, NHL, etc. Match results, transfers, injuries, league news. NOT business of sports unless story-shaped.',
    domains: ['espn.com','bbc.com/sport','skysports.com','theathletic.com','si.com','bleacherreport.com','goal.com','espncricinfo.com','formula1.com','nba.com','nfl.com'],
  },
  health: {
    query: 'health medical news today disease research treatment',
    scope: 'health, medicine, public health, pharma, biotech research, disease outbreaks, FDA approvals, clinical trials, mental health.',
    domains: ['statnews.com','medscape.com','nih.gov','who.int','cdc.gov','nejm.org','thelancet.com','nature.com/articles','bmj.com'],
  },
  science: {
    query: 'science research discovery news today physics biology space',
    scope: 'scientific research and discoveries — physics, chemistry, biology, astronomy, climate science, archaeology, math. Peer-reviewed findings or major announcements.',
    domains: ['nature.com','science.org','newscientist.com','scientificamerican.com','arstechnica.com/science','quantamagazine.org','phys.org'],
  },
  climate: {
    query: 'climate change environment news today emissions energy policy',
    scope: 'climate change, environmental policy, emissions, renewable energy transition, conservation, biodiversity, weather extremes.',
    domains: ['climate.gov','grist.org','insideclimatenews.com','carbonbrief.org','theguardian.com/environment','nytimes.com/section/climate'],
  },
  ai: {
    query: 'artificial intelligence AI news today models research products',
    scope: 'artificial intelligence, machine learning, LLMs, AI products and research — OpenAI, Anthropic, Google DeepMind, Meta AI, open-source models, benchmarks, regulation.',
    domains: ['arstechnica.com','techcrunch.com','theverge.com','venturebeat.com','wired.com','technologyreview.com'],
  },
  startups: {
    query: 'startup news today funding launch product venture capital',
    scope: 'early/growth-stage startups — funding rounds, product launches, founders, VCs, M&A under $1B, accelerators.',
    domains: ['techcrunch.com','crunchbase.com','sifted.eu','axios.com/pro','strictlyvc.com','techcrunch.com/category/startups'],
  },
  crypto: {
    query: 'cryptocurrency news today bitcoin ethereum blockchain',
    scope: 'cryptocurrency, blockchain, bitcoin, ethereum, DeFi, stablecoins, exchange news, regulation, on-chain analysis.',
    domains: ['coindesk.com','theblock.co','decrypt.co','cointelegraph.com','blockworks.co'],
  },
  movies: {
    query: 'movie news today films Hollywood box office release',
    scope: 'films and the film industry — releases, box office, trailers, casting, reviews, festivals, studios, streamers.',
    domains: ['variety.com','hollywoodreporter.com','deadline.com','indiewire.com','collider.com','ew.com','rogerebert.com'],
  },
  music: {
    query: 'music news today album release artist tour song',
    scope: 'music — album releases, artists, tours, charts, labels, festivals, streaming numbers.',
    domains: ['rollingstone.com','billboard.com','pitchfork.com','consequence.net','spin.com','nme.com'],
  },
  gaming: {
    query: 'video games news today release esports console',
    scope: 'video games — releases, esports, console news, studios, indie titles, reviews, industry layoffs.',
    domains: ['ign.com','gamespot.com','polygon.com','kotaku.com','rockpapershotgun.com','eurogamer.net'],
  },
  fashion: {
    query: 'fashion news today designer runway brand luxury',
    scope: 'fashion industry — runway shows, designers, brand collections, luxury houses, retail trends, fashion business news.',
    domains: ['voguebusiness.com','wwd.com','businessoffashion.com','vogue.com','elle.com','harpersbazaar.com'],
  },
  food: {
    query: 'food news today restaurant chef cuisine industry',
    scope: 'food and restaurants — restaurant openings, chef news, food industry, cuisine trends, food policy, agriculture stories.',
    domains: ['eater.com','bonappetit.com','foodandwine.com','restaurantbusinessonline.com'],
  },
  travel: {
    query: 'travel news today airline hotel destination tourism',
    scope: 'travel industry — airlines, hotels, destinations, tourism trends, cruise lines, airport news, travel disruptions.',
    domains: ['skift.com','thepointsguy.com','condenasttraveler.com','travelandleisure.com'],
  },
  realestate: {
    query: 'real estate news today housing market property mortgage',
    scope: 'real estate — housing market, property prices, mortgage rates, commercial real estate, REITs, major deals, construction.',
    domains: ['realtor.com','redfin.com','bisnow.com','therealdeal.com','housingwire.com'],
  },
  energy: {
    query: 'energy news today oil gas renewables grid power',
    scope: 'energy markets — oil, gas, renewables, grid, utilities, electric vehicles, battery storage, OPEC, regulation.',
    domains: ['ogj.com','spglobal.com','rystadenergy.com','greentechmedia.com','utilitydive.com'],
  },
};

// Aliases / common alt names → canonical key
const ALIASES = {
  'showbiz':       'entertainment',
  'pop culture':   'entertainment',
  'culture':       'entertainment',
  'tv':            'entertainment',
  'film':          'movies',
  'cinema':        'movies',
  'sport':         'sports',
  'fitness':       'health',
  'wellness':      'health',
  'medicine':      'health',
  'tech':          'ai',
  'artificial intelligence': 'ai',
  'machine learning': 'ai',
  'startup':       'startups',
  'venture':       'startups',
  'vc':            'startups',
  'web3':          'crypto',
  'bitcoin':       'crypto',
  'environment':   'climate',
  'sustainability':'climate',
  'video games':   'gaming',
  'esports':       'gaming',
  'restaurants':   'food',
  'cuisine':       'food',
  'property':      'realestate',
  'real-estate':   'realestate',
  'housing':       'realestate',
};

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[\s_-]+/g, ' ')
    .replace(/^the\s+/, '');
}

/**
 * Given a section label and (optional) description, return:
 *   { query, scope, domains? }
 *
 * - If description is non-empty, it always wins for `scope`; query is built
 *   from label + description.
 * - If description is empty, look up the label in TOPICS / ALIASES.
 * - For unknown labels, return a generic fallback derived from the label itself.
 */
function expandTopic(label, description) {
  const desc = (description || '').trim();
  const norm = normalize(label);
  const key  = ALIASES[norm] || norm.replace(/\s+/g, '');
  const meta = TOPICS[key] || null;

  // With description: use desc verbatim for scope, build a sharp query
  if (desc) {
    return {
      query:   `${label.toLowerCase()} news today — ${desc}`,
      scope:   desc,
      domains: meta?.domains,
    };
  }

  // Without description: rely on built-in expansion or fall back to the label
  if (meta) {
    return { query: meta.query, scope: meta.scope, domains: meta.domains };
  }

  // Unknown label — generic query/scope. We deliberately keep scope a bit
  // looser than the strict default so the LLM doesn't return [] just because
  // nothing in the inbox is "primarily" about the topic.
  return {
    query: `${label.toLowerCase()} news today latest`,
    scope: `stories about ${label} or closely related to ${label} as a subject area (not just passing mentions).`,
  };
}

module.exports = { expandTopic, TOPICS, ALIASES };
