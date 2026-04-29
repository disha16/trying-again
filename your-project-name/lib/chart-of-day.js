'use strict';

const Exa            = require('exa-js').default;
const { _callModel } = require('./digest-generator');

const CHART_TOPICS = [
  { name: 'S&P 500 Performance',         query: 'S&P 500 index weekly price levels recent' },
  { name: 'US Inflation Rate (CPI)',      query: 'US CPI inflation rate monthly data latest' },
  { name: 'US 10-Year Treasury Yield',   query: 'US 10-year treasury yield history latest' },
  { name: 'Federal Funds Rate',          query: 'Federal Reserve interest rate Fed funds latest' },
  { name: 'WTI Crude Oil Price',         query: 'WTI crude oil price history monthly latest' },
  { name: 'Gold Price',                  query: 'gold price per ounce USD monthly latest' },
  { name: 'Bitcoin Price',               query: 'bitcoin BTC USD price monthly latest' },
  { name: 'US Unemployment Rate',        query: 'US unemployment rate monthly BLS latest' },
  { name: 'India Nifty 50',              query: 'India Nifty 50 index weekly performance latest' },
  { name: 'EUR/USD Exchange Rate',       query: 'euro dollar EUR USD exchange rate monthly latest' },
  { name: 'US GDP Growth Rate',          query: 'US GDP growth rate quarterly latest' },
  { name: 'China GDP Growth',            query: 'China GDP growth rate quarterly latest' },
  { name: 'Nasdaq 100',                  query: 'Nasdaq 100 QQQ performance weekly latest' },
  { name: 'US Housing Starts',           query: 'US housing starts monthly census bureau latest' },
  { name: 'VIX Volatility Index',        query: 'VIX fear index level history latest' },
  { name: 'US Retail Sales',             query: 'US retail sales monthly growth latest' },
  { name: 'Yield Curve (2Y-10Y Spread)', query: 'US yield curve 2 year 10 year spread latest' },
  { name: 'US Dollar Index (DXY)',       query: 'US dollar index DXY monthly latest' },
  { name: 'Emerging Markets ETF',        query: 'emerging markets EEM ETF performance latest' },
  { name: 'US Consumer Confidence',      query: 'Conference Board consumer confidence index latest' },
  { name: 'USD/JPY (Yen Rate)',          query: 'USD JPY Japanese yen exchange rate monthly latest' },
  { name: 'Brent Crude Oil',            query: 'Brent crude oil price monthly OPEC latest' },
  { name: 'Silver Price',               query: 'silver price per ounce USD latest' },
  { name: 'US ISM Manufacturing PMI',   query: 'ISM manufacturing PMI index monthly latest' },
  { name: 'Apple Stock (AAPL)',          query: 'Apple AAPL stock price weekly latest' },
  { name: 'MSCI World Index',           query: 'MSCI world index performance monthly latest' },
  { name: 'Natural Gas Price',          query: 'US natural gas Henry Hub price latest' },
  { name: 'US Trade Deficit',           query: 'US trade deficit monthly data billion latest' },
  { name: 'Global Inflation Trends',    query: 'global inflation rate G7 countries comparison latest' },
  { name: 'Sensex Performance',         query: 'BSE Sensex index weekly performance latest' },
];

const CHART_SYSTEM = `You are a financial data analyst. You have been given several articles about a financial topic, each tagged with its publish date. Extract real data points and return a Chart.js-ready JSON object.

Return ONLY valid JSON — no markdown, no explanation:
{
  "headline": "Short punchy headline with the most recent value or trend",
  "insight": "One crisp sentence explaining what this data means for investors or the economy",
  "explanation": "2-3 sentences: what drove the trend, key context, what to watch next",
  "chartType": "line",
  "chartTitle": "Axis label (e.g. 'Price per ounce (USD)')",
  "labels": ["Apr 2025", "May 2025", ...],
  "data": [3.2, 3.4, ...],
  "unit": "USD"
}

Rules:
- The articles are sorted newest-first. Look at the TOP article's publish date to determine the latest period available.
- labels: 6-10 data points in CHRONOLOGICAL ORDER (oldest → newest). The LAST label MUST be the most recent period found in any article.
- All labels MUST share the same period type — either all monthly ("Jan 2026", "Feb 2026") OR all quarterly ("Q1 2025", "Q2 2025"). DO NOT mix months with quarters.
- All labels MUST be contiguous — no skipping months/quarters in the middle.
- data: real numbers extracted from article text matching each label. Do NOT fabricate. Do NOT carry numbers from one period to another.
- If the most recent article is from 2026, the chart MUST include 2026 data points. Do not produce a chart that ends in 2025 if 2026 data is available.
- The headline should reference the LAST data point's actual value (e.g. "Inflation at 3.4% in March 2026").
- If you cannot extract at least 4 real, contiguous data points, return { "error": "insufficient data" }`;

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff  = date - start;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

async function fetchChartOfDay(model = 'llama-3.3-70b-versatile') {
  // Try Anthropic with web_search first (if key is set)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await fetchChartAnthropicWebSearch(model);
    } catch (e) {
      console.warn('[chart-of-day] Anthropic web_search failed, falling back to Exa+Groq:', e.message);
    }
  }

  return fetchChartExaGroq(model);
}

async function fetchChartAnthropicWebSearch(model) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const now   = new Date();
  const topic = CHART_TOPICS[dayOfYear(now) % CHART_TOPICS.length];

  const prompt = `Find current data for the financial topic: "${topic.name}". Search for recent monthly or weekly data points for 2025-2026. Then return a Chart.js JSON object with the data you found. Topic hint: ${topic.query}`;

  const messages = [{ role: 'user', content: prompt }];
  let raw = '';

  for (let round = 0; round < 6; round++) {
    const resp = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system:     CHART_SYSTEM,
      tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
      messages,
    });

    const textBlock = resp.content.find(b => b.type === 'text');
    if (resp.stop_reason === 'end_turn' && textBlock) {
      raw = textBlock.text;
      break;
    }

    if (resp.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults = resp.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: b.output || '' }));
      if (toolResults.length) messages.push({ role: 'user', content: toolResults });
      continue;
    }

    if (textBlock) { raw = textBlock.text; break; }
    break;
  }

  return parseChartJson(raw, topic.name);
}

async function fetchChartExaGroq(model) {
  if (!process.env.EXA_API_KEY) throw new Error('EXA_API_KEY not set');

  const exa   = new Exa(process.env.EXA_API_KEY);
  const now   = new Date();
  const topic = CHART_TOPICS[dayOfYear(now) % CHART_TOPICS.length];

  console.log(`[chart-of-day] Topic: ${topic.name}`);

  // Build a recent-period qualifier from the current and previous month
  // so Exa biases toward articles reporting current data, not historical.
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const cur  = now;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const recencyTokens = `${months[cur.getMonth()]} ${cur.getFullYear()} ${months[prev.getMonth()]} ${prev.getFullYear()}`;
  const dynamicQuery  = `${topic.query} ${recencyTokens}`;

  // Constrain to articles published in the last 90 days (3 months) so we get
  // current reporting, not historical-overview pieces from previous years.
  const startPublishedDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

  let results = [];
  try {
    const res = await exa.searchAndContents(dynamicQuery, {
      numResults: 15,
      category:   'news',
      text:       { maxCharacters: 1200 },
      startPublishedDate,
    });
    results = res.results || [];
  } catch (e) {
    console.warn('[chart-of-day] Exa search failed:', e.message);
    throw e;
  }

  if (!results.length) throw new Error('No Exa results for chart topic');

  // Sort by publish date (newest first) so the LLM gets fresh data first
  results.sort((a, b) => {
    const da = a.publishedDate ? new Date(a.publishedDate).getTime() : 0;
    const db = b.publishedDate ? new Date(b.publishedDate).getTime() : 0;
    return db - da;
  });

  const excerpts = results.slice(0, 8)
    .map((r, i) => {
      const date = r.publishedDate ? new Date(r.publishedDate).toISOString().slice(0, 10) : 'unknown date';
      return `[Article ${i + 1} | published ${date}] ${r.title || ''}\n${(r.text || '').replace(/\s{2,}/g, ' ').slice(0, 1000)}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 8000);

  const prompt = `Topic: "${topic.name}"\n\n${excerpts}`;
  const raw    = await _callModel(model, prompt, CHART_SYSTEM);

  return parseChartJson(raw, topic.name);
}

function parseChartJson(raw, topicName) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in chart response');

  const data = JSON.parse(match[0]);
  if (data.error) throw new Error(data.error);
  if (!Array.isArray(data.labels) || !Array.isArray(data.data)) throw new Error('Invalid chart structure');
  if (data.data.length < 3) throw new Error('Too few data points');
  if (data.labels.length !== data.data.length) throw new Error('labels/data length mismatch');

  // Reject mixed-period labels (e.g. quarters mixed with months)
  const hasQuarter = data.labels.some(l => /^Q[1-4]\b/i.test(String(l)));
  const hasMonth   = data.labels.some(l => /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(String(l)));
  if (hasQuarter && hasMonth) throw new Error('Chart mixes quarterly and monthly periods');

  data.topic    = topicName;
  data.fetchedAt = new Date().toISOString();
  return data;
}

module.exports = { fetchChartOfDay, CHART_TOPICS, dayOfYear };
