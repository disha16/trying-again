require('dotenv').config({ override: true, path: require('path').join(__dirname, '.env') });
const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const storage   = require('./lib/storage');
const gmail     = require('./lib/gmail');
const clusterer = require('./lib/clusterer');
const digestGen = require('./lib/digest-generator');
const exaImages    = require('./lib/exa-images');
const storyEnricher     = require('./lib/story-enricher');
const internetFallback  = require('./lib/internet-fallback');
const topicClusters     = require('./lib/topic-clusters');
const charts            = require('./lib/charts');
const editor            = require('./lib/editor');
const supa          = require('./lib/supabase');

const app  = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

let digestRunning = false;

// ─── Sources ───────────────────────────────────────────────────────────────────

app.get('/sources', async (req, res) => {
  res.json(await storage.getSources());
});

app.post('/sources', async (req, res) => {
  const { name, email, url } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const sources = await storage.getSources();
  const src = { id: Date.now(), name: name.trim(), email: (email || '').trim(), url: (url || '').trim(), enabled: true };
  sources.push(src);
  await storage.setSources(sources);
  res.json(src);
});

app.patch('/sources/:id', async (req, res) => {
  const sources = await storage.getSources();
  const src = sources.find(s => s.id == req.params.id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  if (req.body.enabled !== undefined) src.enabled = req.body.enabled;
  if (req.body.email   !== undefined) src.email   = req.body.email.trim();
  if (req.body.url     !== undefined) src.url     = req.body.url.trim();
  await storage.setSources(sources);
  res.json(src);
});

app.delete('/sources/:id', async (req, res) => {
  const sources = await storage.getSources();
  await storage.setSources(sources.filter(s => s.id != req.params.id));
  res.json({ success: true });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

app.get('/api/settings', async (req, res) => {
  const s = await storage.getSettings();
  // Don't echo the raw API key back to the client; just signal whether it's set
  if (s && s.anthropicApiKey) {
    s.anthropicApiKeyConfigured = true;
    s.anthropicApiKey = ''; // mask
  } else {
    s.anthropicApiKeyConfigured = false;
  }
  res.json(s);
});

app.post('/api/settings', async (req, res) => {
  const validModels = digestGen.ALL_MODELS;
  const modelKeys   = ['clusterModel', 'digestModel', 'chatModel', 'editorModel'];
  const update = {};
  for (const key of modelKeys) {
    if (req.body[key] === undefined) continue;
    if (!validModels.includes(req.body[key])) return res.status(400).json({ error: `Invalid model for ${key}` });
    update[key] = req.body[key];
  }
  if (req.body.internetFallback !== undefined) update.internetFallback = !!req.body.internetFallback;
  if (req.body.persona   !== undefined) update.persona   = req.body.persona;
  if (req.body.sections  !== undefined) update.sections  = req.body.sections;
  if (req.body.anthropicApiKey !== undefined) {
    const k = String(req.body.anthropicApiKey || '').trim();
    update.anthropicApiKey = k; // stored as-is; can be empty to clear
  }
  const current = await storage.getSettings();
  await storage.setSettings({ ...current, ...update });
  res.json({ success: true });
});

// ─── Digest cache ──────────────────────────────────────────────────────────────
// /last-run: serve from Supabase digest_cache (most recent) then fall back to kv_store lastRun
app.get('/last-run', async (req, res) => {
  try {
    const cached = await supa.getLatestDigest();
    if (cached) return res.json(cached.digest);
  } catch (e) {
    console.warn('[last-run] digest_cache read failed, falling back to kv_store:', e.message);
  }
  res.json(await storage.getLastRun());
});
app.get('/api/clusters',  async (req, res) => res.json(await storage.getClusters()));
app.get('/api/digest-history', async (req, res) => {
  const h       = await storage.getDigestHistory();
  const lastRun = await storage.getLastRun();

  // Backfill using client's local today key (avoids UTC vs local timezone mismatch)
  const clientToday = req.query.today; // e.g. "2026-04-27"
  if (lastRun?.ranAt) {
    // Store under both the client's local date AND the server UTC date
    const keys = [lastRun.ranAt.slice(0, 10)];
    if (clientToday && !keys.includes(clientToday)) keys.push(clientToday);
    for (const k of keys) {
      if (!h[k]) { h[k] = lastRun; await storage.setDigestHistory(h); }
    }
  }

  const index = Object.fromEntries(Object.entries(h).map(([date, d]) => [date, { date: d.date, ranAt: d.ranAt }]));
  res.json(index);
});

app.get('/api/digest/:date', async (req, res) => {
  const h = await storage.getDigestHistory();
  let d = h[req.params.date];
  // Fallback: if requesting today and it's in lastRun but not history yet
  if (!d) {
    const lastRun = await storage.getLastRun();
    if (lastRun?.ranAt?.startsWith(req.params.date)) d = lastRun;
  }
  if (!d) return res.status(404).json({ error: 'No digest for this date' });
  res.json(d);
});

app.get('/api/charts',    async (req, res) => {
  const last = await storage.getLastRun();
  res.json({ charts: last?.charts || [] });
});

// ─── Chart of the Day (Exa + LLM → Chart.js data) ────────────────────────────
const chartOfDay = require('./lib/chart-of-day');

let chartInFlight = null;

app.get('/api/chart-of-day', async (req, res) => {
  try {
    const now = new Date();
    const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,'0'), d = String(now.getDate()).padStart(2,'0');
    const dateKey = `${y}-${m}-${d}`;

    // Return cached chart for today if available
    const lastRun = await storage.getLastRun();
    if (lastRun?.chartOfDay?.[dateKey]) {
      return res.json(lastRun.chartOfDay[dateKey]);
    }

    // In-flight deduplication: concurrent callers share one subprocess
    if (chartInFlight) {
      const chart = await chartInFlight;
      return res.json(chart);
    }

    const settings = await storage.getSettings();
    const model    = settings.digestModel || 'llama-3.3-70b-versatile';
    chartInFlight  = chartOfDay.fetchChartOfDay(model)
      .finally(() => { chartInFlight = null; });
    const chart    = await chartInFlight;

    // Cache today's chart
    const updated = lastRun ? { ...lastRun } : {};
    if (!updated.chartOfDay) updated.chartOfDay = {};
    updated.chartOfDay[dateKey] = chart;
    await storage.setLastRun(updated);

    res.json(chart);
  } catch (e) {
    console.error('[chart-of-day]', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/images',    async (req, res) => {
  const cache = await storage.getEmailCache();
  const urls  = Object.values(cache).flatMap(e => e.imageUrls || []).filter(Boolean);
  res.json({ urls: [...new Set(urls)] });
});

app.post('/api/mark-read', async (req, res) => {
  const { headline, cluster_keywords, category, source } = req.body;
  if (!headline) return res.status(400).json({ error: 'headline required' });
  try {
    await supa.markRead({ headline, cluster_keywords, category, source });
    res.json({ success: true });
  } catch (err) {
    console.error('[mark-read]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── Story feedback ────────────────────────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  try {
    const { headline, category, source, vote, dateKey } = req.body;
    if (!headline || !['up','down'].includes(vote))
      return res.status(400).json({ error: 'headline and vote (up/down) required' });
    const now = new Date();
    const dk = dateKey || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    await storage.addFeedback(dk, { headline, category, source, vote, at: now.toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/read-history', async (req, res) => {
  try {
    const history = await supa.getReadHistory(3);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/push-digest', async (req, res) => {
  const { digest } = req.body;
  if (!digest) return res.status(400).json({ error: 'digest required' });
  const now2 = new Date();
  const todayLabel2 = now2.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const stored = { ...digest, date: todayLabel2, ranAt: now2.toISOString() };
  await storage.setLastRun(stored);
  // Also archive to history
  const dateKey2 = now2.toISOString().slice(0, 10);
  const hist2 = await storage.getDigestHistory();
  hist2[dateKey2] = stored;
  await storage.setDigestHistory(hist2);
  console.log(`[push-digest] Stored digest for ${todayLabel2}`);
  res.json({ success: true });
});

// ─── Notebook ──────────────────────────────────────────────────────────────────

app.get('/api/notes', async (req, res) => res.json(await storage.getNotes()));

app.post('/api/notes', async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  const notes = await storage.getNotes();
  const note  = { id: Date.now(), title: title.trim(), summary: '', entries: [], createdAt: new Date().toISOString() };
  notes.push(note);
  await storage.setNotes(notes);
  res.json(note);
});

app.post('/api/notes/:id/entries', async (req, res) => {
  const notes = await storage.getNotes();
  const note  = notes.find(n => n.id == req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  const entry = { id: Date.now(), addedAt: new Date().toISOString(), ...req.body };
  note.entries.push(entry);
  note.summary = ''; // invalidate so it gets regenerated
  await storage.setNotes(notes);
  res.json(entry);
});

app.post('/api/notes/:id/summary', async (req, res) => {
  const notes = await storage.getNotes();
  const note  = notes.find(n => n.id == req.params.id);
  if (!note || !note.entries.length) return res.status(400).json({ error: 'No entries' });
  const { chatModel } = await storage.getSettings();
  const entriesText = note.entries.map((e, i) =>
    `${i+1}. ${e.headline} — ${e.description || ''}`
  ).join('\n');
  const prompt = `These are entries in a notebook titled "${note.title}":\n\n${entriesText}\n\nWrite 2-3 sharp sentences summarising the key learnings and patterns across these entries. Be specific, cite figures where present. No filler.`;
  try {
    let summary;
    if (chatModel === 'claude-cli') {
      summary = await digestGen.callClaudeCLI('You are a sharp analyst.', prompt);
    } else {
      const client = digestGen.getClient(chatModel);
      const r = await client.chat.completions.create({ model: chatModel, max_tokens: 200, messages: [{ role: 'user', content: prompt }] });
      summary = r.choices[0].message.content.trim();
    }
    note.summary = summary;
    await storage.setNotes(notes);
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/notes/:id', async (req, res) => {
  const notes = await storage.getNotes();
  const note  = notes.find(n => n.id == req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  if (req.body.title !== undefined) note.title = req.body.title.trim();
  await storage.setNotes(notes);
  res.json({ success: true });
});

app.patch('/api/notes/:id/entries/:eid', async (req, res) => {
  const notes = await storage.getNotes();
  const note  = notes.find(n => n.id == req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  const entry = note.entries.find(e => e.id == req.params.eid);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  if (req.body.description !== undefined) entry.description = req.body.description;
  await storage.setNotes(notes);
  res.json({ success: true });
});

app.delete('/api/notes/:id', async (req, res) => {
  const notes = await storage.getNotes();
  await storage.setNotes(notes.filter(n => n.id != req.params.id));
  res.json({ success: true });
});

app.get('/api/notes/:id/similar', async (req, res) => {
  const notes = await storage.getNotes();
  const note  = notes.find(n => n.id == req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  if (!process.env.EXA_API_KEY) return res.json({ stories: [] });
  try {
    const Exa = require('exa-js').default;
    const exa = new Exa(process.env.EXA_API_KEY);
    const query = note.title + (note.entries[0] ? ' ' + note.entries[0].headline.slice(0, 60) : '');
    const BAD_IMAGE  = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|placeholder|pixel|tracking|beacon/i;
    const BAD_DOMAIN = /globenewswire|prnewswire|businesswire|accesswire|notified\.com|food|recipe|cook|lifestyle|wellness|fitness/i;
    const res2 = await exa.searchAndContents(query, { numResults: 10, category: 'news', text: { maxCharacters: 400 } });
    const existingHeadlines = new Set(note.entries.map(e => e.headline?.toLowerCase()));
    const stories = res2.results
      .filter(r => r.title && !existingHeadlines.has(r.title.toLowerCase()))
      .filter(r => !r.image || (!BAD_IMAGE.test(r.image) && !BAD_DOMAIN.test(r.url || '')))
      .slice(0, 8)
      .map(r => {
        const host = (() => { try { return new URL(r.url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return ''; } })();
        const cleanDesc = (r.text || '')
        .replace(/#{1,6}\s*/g, '')
        .replace(/SENSEX[\d\s.,+\-#]+/gi, '')
        .replace(/NIFTY[\d\s.,+\-#]+/gi, '')
        .replace(/CRUDEOIL[\d\s.,+\-#]+/gi, '')
        .replace(/Ministry of \w[\w\s&]+ \d{1,2}[-–]\w+,?\s*\d{4}\s*\d{1,2}:\d{2}\s*IST/gi, '')
        .replace(/^English Releases?\s*/i, '')
        .replace(/\s{2,}/g, ' ').trim().slice(0, 200);
      return {
          headline:  r.title.replace(/^English Releases?\s*/i,'').trim().slice(0, 120),
          description: cleanDesc,
          source:    host.charAt(0).toUpperCase() + host.slice(1),
          sourceUrl: r.url,
          image:     (!BAD_IMAGE.test(r.image || '') && !BAD_DOMAIN.test(r.url || '')) ? r.image : null,
        };
      });
    res.json({ stories });
  } catch (e) {
    console.warn('[notes/similar]', e.message);
    res.json({ stories: [] });
  }
});

app.delete('/api/notes/:id/entries/:eid', async (req, res) => {
  const notes = await storage.getNotes();
  const note  = notes.find(n => n.id == req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  note.entries = note.entries.filter(e => e.id != req.params.eid);
  await storage.setNotes(notes);
  res.json({ success: true });
});

// ─── Inbox snapshot ────────────────────────────────────────────────────────────

app.get('/last-inbox', async (req, res) => {
  const snap = await storage.getInboxSnapshot();
  res.json(snap ? { fetchedAt: snap.fetchedAt, count: snap.emails.length } : null);
});

app.post('/api/push-inbox', async (req, res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails array required' });
  await storage.setInboxSnapshot({ fetchedAt: new Date().toISOString(), emails });
  console.log(`[push-inbox] Stored ${emails.length} emails`);
  res.json({ success: true, count: emails.length });
});

// ─── Chat ──────────────────────────────────────────────────────────────────────

async function fetchChatWebContext(query) {
  if (!process.env.EXA_API_KEY) return '';
  try {
    const Exa = require('exa-js').default;
    const exa = new Exa(process.env.EXA_API_KEY);
    const res = await exa.searchAndContents(query, {
      numResults: 3,
      category:   'news',
      text:       { maxCharacters: 1000 },
    });
    const snippets = res.results
      .map(r => `[${r.title}](${r.url})\n${r.text || ''}`)
      .filter(Boolean)
      .join('\n\n---\n\n');
    return snippets ? `\n\nLIVE WEB CONTEXT (from Exa search for "${query}"):\n${snippets}` : '';
  } catch (e) {
    console.warn('[chat/exa]', e.message);
    return '';
  }
}

app.post('/chat', async (req, res) => {
  const { messages: chatMessages } = req.body;
  const { chatModel } = await storage.getSettings();

  const lastRun       = await storage.getLastRun();
  const inboxSnapshot = await storage.getInboxSnapshot();

  // Use the last user message as the web search query
  const lastUserContent = chatMessages.filter(m => m.role === 'user').at(-1)?.content ?? '';
  const webContext = await fetchChatWebContext(lastUserContent.slice(0, 300));

  let digestContext = 'No newsletter digest has been run yet.';
  if (lastRun) {
    digestContext = `Newsletter digest (${lastRun.date}):\n`;
    for (const cat of ['top_today','tech','us_business','india_business','global_economies','politics','everything_else']) {
      const items = lastRun[cat];
      if (items?.length) {
        digestContext += `\n${cat.replace(/_/g,' ').toUpperCase()}:\n`;
        items.forEach(i => { digestContext += `- [${i.source}] ${i.headline}${i.description ? ' — ' + i.description : ''}\n`; });
      }
    }
  }

  let inboxContext = '';
  if (inboxSnapshot?.emails?.length) {
    const fetchedAt = new Date(inboxSnapshot.fetchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    inboxContext = `\n\nFULL INBOX SNAPSHOT (synced ${fetchedAt}, ${inboxSnapshot.emails.length} emails):\n`;
    inboxSnapshot.emails.forEach(e => {
      inboxContext += `- From: ${e.from} | Date: ${e.date} | Subject: ${e.subject}`;
      if (e.snippet) inboxContext += ` | Preview: ${e.snippet}`;
      inboxContext += '\n';
    });
  }

  const CHAT_SYSTEM = `You are a sharp, well-informed personal assistant with full access to the user's email inbox, newsletter digest, and live web search results. Answer with precision and depth.

FORMAT RULES (always follow):
- Use **bold** for key names, figures, and terms
- Use bullet points for lists of 3+ items
- Use ### headings when covering multiple topics in one answer
- Keep answers tight — no filler phrases, no "certainly!", no lengthy preambles
- Lead with the most important point; add context only if it adds value
- Max 3-4 sentences per topic unless asked for more detail
- If asked about a specific email or sender, search the inbox snapshot data
- Prioritise live web context when answering factual questions about people or events
- If data is missing, say so clearly

${digestContext}${inboxContext}${webContext}`;

  try {
    let reply;
    if (chatModel === 'claude-cli') {
      const lastUserMsg = chatMessages.filter(m => m.role === 'user').at(-1)?.content ?? '';
      reply = await digestGen.callClaudeCLI(CHAT_SYSTEM, lastUserMsg);
    } else {
      const client   = digestGen.getClient(chatModel);
      const response = await client.chat.completions.create({
        model: chatModel,
        max_tokens: 1024,
        messages: [{ role: 'system', content: CHAT_SYSTEM }, ...chatMessages],
      });
      reply = response.choices[0].message.content;
    }
    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Gmail OAuth ───────────────────────────────────────────────────────────────

app.get('/auth/setup', (req, res) => {
  res.redirect(gmail.getAuthUrl());
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code)  return res.status(400).send('Missing code');
  try {
    await gmail.handleCallback(code);
    res.send('<h2>✅ Gmail connected!</h2><p>The daily digest will now run automatically at 9am ET. You can close this tab.</p>');
  } catch (err) {
    console.error('[auth/callback]', err.message);
    res.status(500).send(`Auth failed: ${err.message}`);
  }
});

// ─── Cron — auto digest ────────────────────────────────────────────────────────

app.get('/api/cron/digest', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (digestRunning) {
    send('error', { error: 'Already running — please wait a moment and try again.' });
    res.flush?.();
    setTimeout(() => res.end(), 100);
    return;
  }
  digestRunning = true;

  // ── Smart caching: after 3 PM ET, serve from digest_cache if available ──────
  const _now = new Date();
  const _etHour = (_now.getUTCHours() - 4 + 24) % 24; // UTC-4 (EDT)
  const _todayKey = `${_now.getUTCFullYear()}-${String(_now.getUTCMonth()+1).padStart(2,'0')}-${String(_now.getUTCDate()).padStart(2,'0')}`;
  if (_etHour >= 15) {
    try {
      const _cached = await supa.getDigest(_todayKey);
      if (_cached && _cached.digest) {
        send('status', { message: 'Serving from cache (post-3 PM)\u2026' });
        send('done', _cached.digest);
        res.end();
        digestRunning = false;
        return;
      }
    } catch (_e) { console.warn('[cron/digest] cache check failed, running fresh:', _e.message); }
  }

  try {
    const settings     = await storage.getSettings();
    const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
    const digestModel  = settings.digestModel  || DEFAULT_MODEL;
    const clusterModel = settings.clusterModel || DEFAULT_MODEL;
    const editorModel  = settings.editorModel  || digestModel;
    // Extract enabled custom sections from settings
    const customSections = (settings.sections || []).filter(s => s.custom && s.enabled !== false);
    console.log(`[cron/digest] cluster: ${clusterModel}, digest: ${digestModel}, editor: ${editorModel}, custom: ${customSections.map(s=>s.label).join(',') || 'none'}`);

    send('status', { message: 'Fetching emails…' });
    const { entries, cacheHits, cacheMisses } = await gmail.fetchNewsletterHeadlines();
    console.log(`[cron/digest] entries: ${entries.length}`);
    send('status', { message: `${entries.length} newsletters (${cacheHits} cached, ${cacheMisses} new). Clustering…` });

    console.log('[cron/digest] starting clustering…');
    const clusters = await clusterer.clusterHeadlines(entries, clusterModel);
    console.log(`[cron/digest] clustering done: ${clusters.length} clusters`);
    send('status', { message: `${clusters.length} unique stories. Fetching article images…` });
    await exaImages.enrichClustersWithImages(clusters);
    await storage.setClusters({ clusters, generatedAt: new Date().toISOString() });
    send('status', { message: `${clusters.length} unique stories. Checking read history…` });

    let readState = {};
    try { readState = await supa.getClusterReadState(); } catch (e) { console.warn('[read-state]', e.message); }

    send('status', { message: 'Generating digest…' });
    // Inject quality note from prior-day feedback if available
    let _qualityNote = null;
    try { _qualityNote = await storage.getQualityNote(); } catch (_e) {}
    const _personaWithNote = { ...(settings.persona || {}), _qualityNote };
    const digest = await digestGen.generateDigest(clusters, digestModel, readState, customSections, _personaWithNote);

    send('status', { message: 'Editor reviewing for duplicates…' });
    await editor.editDigest(digest, editorModel, customSections, settings.persona || null);

    // ── Deterministic promotion to top_today (mutually exclusive) ───────────
    // top_today is the most important section. If it has < 10 newsletter items,
    // pull the top items from category sections (in priority order) and REMOVE
    // them from those categories — strict mutual exclusion, top_today wins.
    {
      const CATEGORY_PRIORITY = ['us_business', 'global_economies', 'tech', 'india_business', 'politics', 'everything_else'];
      const top = digest.top_today = digest.top_today || [];
      const seenInTop = new Set(top.map(i => (i.headline || '').toLowerCase().trim()));
      let promoted = 0;
      // Round-robin: take the top remaining newsletter item from each category
      let madeProgress = true;
      while (top.length < 10 && madeProgress) {
        madeProgress = false;
        for (const cat of CATEGORY_PRIORITY) {
          if (top.length >= 10) break;
          const items = digest[cat] || [];
          // Find the first newsletter item not already in top_today
          const idx = items.findIndex(i => !i.internetSource && !seenInTop.has((i.headline || '').toLowerCase().trim()));
          if (idx === -1) continue;
          const [item] = items.splice(idx, 1);   // MOVE: remove from category
          seenInTop.add((item.headline || '').toLowerCase().trim());
          top.push(item);
          promoted++;
          madeProgress = true;
        }
      }
      console.log(`[cron/digest] promoted ${promoted} newsletter items to top_today (now ${top.length} total)`);
    }

    // Internet fallback runs SYNCHRONOUSLY before 'done' — it directly affects
    // what categories the user sees, and it's fast (Exa searches, no LLM).
    if (settings.internetFallback) {
      send('status', { message: 'Filling thin categories from web…' });
      try {
        await internetFallback.applyInternetFallback(digest, customSections, digestModel);
      } catch (e) {
        console.error('[cron/digest] internet fallback error:', e.message);
      }
    }

    // ── Save core digest immediately so user sees results fast ──────────────
    const now = new Date();
    const todayLabel = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    digest.date = todayLabel;
    digest.ranAt = now.toISOString();
    digest.clusterModel = clusterModel;
    digest.digestModel  = digestModel;
    await storage.setLastRun(digest);
    // Compute dateKey for digest_cache
    const _dcY = now.getFullYear(), _dcM = String(now.getMonth()+1).padStart(2,'0'), _dcD = String(now.getDate()).padStart(2,'0');
    const dateKey = `${_dcY}-${_dcM}-${_dcD}`;
    // Persist core digest to Supabase digest_cache immediately
    await supa.saveDigest(dateKey, digest, false).catch(e => console.error('[cron/digest] digest_cache core save:', e.message));
    const merged = await storage.getLastRun(); // includes carried-over enrichment
    send('done', merged); // Unblock the UI immediately

    // ── Background enrichment (doesn't block SSE response) ──────────────────
    const enrichAsync = async () => {
      try {
        // Run topic clusters and story enricher in parallel — deep dives appear ASAP
        const [clusters_result] = await Promise.all([
          topicClusters.buildTopicClusters(digest, settings.internetFallback, digestModel)
            .then(tc => {
              digest.topic_clusters = tc;
              return storage.setLastRun(digest); // save as soon as deep dives are ready
            })
            .catch(e => console.error('[cron/digest] topic clusters error:', e.message)),

          storyEnricher.enrichTopStories(digest.top_today, digestModel)
            .catch(e => console.error('[cron/digest] story enricher error:', e.message)),
        ]);

        if (settings.internetFallback) {
          const topHeadlines  = (digest.top_today || []).map(s => s.headline);
          const lastRun2      = await storage.getLastRun();
          const seenChartUrls = new Set((lastRun2?.charts || []).map(c => c.sourceUrl).filter(Boolean));
          digest.charts = await charts.fetchChartsOfDay(topHeadlines, seenChartUrls, digestModel)
            .catch(e => { console.error('[cron/digest] charts error:', e.message); return []; });
        }

        await storage.setLastRun(digest);
        // Persist fully-enriched digest to Supabase digest_cache
        await supa.saveDigest(dateKey, digest, true).catch(e => console.error('[cron/digest] digest_cache enriched save:', e.message));
        // Re-archive history with the enriched digest so /api/digest/<date> matches /last-run
        const histAfter = await storage.getDigestHistory();
        histAfter[dateKey] = digest;
        await storage.setDigestHistory(histAfter);
        console.log('[cron/digest] background enrichment complete');
      } catch (e) {
        console.error('[cron/digest] background enrichment error:', e.message);
      }
    };
    // Archive core digest to history immediately (will be re-archived when enrichment finishes)
    const history = await storage.getDigestHistory();
    history[dateKey] = digest;
    const keys = Object.keys(history).sort().slice(-30);
    const pruned = {};
    keys.forEach(k => { pruned[k] = history[k]; });
    await storage.setDigestHistory(pruned);

    enrichAsync(); // fire-and-forget — enriches in background, updates lastRun again when done

    console.log(`[cron/digest] Core done — ${digest.date} | ${clusters.length} clusters → digest`);
  } catch (err) {
    console.error('[cron/digest] Error:', err.message);
    send('error', { error: err.message });
  } finally {
    digestRunning = false;
    res.end();
  }
});


// ─── Cron — quality check (2:30 PM ET = 18:30 UTC) ───────────────────────────
app.get('/api/cron/quality-check', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    // Get yesterday's date key
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dk = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
    const feedback = await storage.getFeedback(dk);
    if (!feedback.length) {
      return res.json({ ok: true, note: null, message: 'No feedback for yesterday' });
    }
    const ups   = feedback.filter(f => f.vote === 'up').map(f => `👍 "${f.headline}" (${f.category})`);
    const downs = feedback.filter(f => f.vote === 'down').map(f => `👎 "${f.headline}" (${f.category})`);
    const feedbackText = [...ups, ...downs].join('\n');
    const settings = await storage.getSettings();
    const model = (settings.digestModel === 'claude-cli' ? 'llama-3.3-70b-versatile' : settings.digestModel) || 'llama-3.3-70b-versatile';
    const system = `You are a quality analyst for a newsletter digest app. The user has rated stories from yesterday's digest with thumbs up/down. Condense their feedback into 3-5 concise, actionable instructions that can be injected into tomorrow's digest generation prompts to better match their preferences. Be specific. Output only the instructions as a short paragraph, no preamble.`;
    const prompt = `Yesterday's feedback (${dk}):\n${feedbackText}\n\nCondense into 3-5 actionable instructions for the digest generator:`;
    const note = await digestGen._callModel(model, prompt, system);
    await storage.setQualityNote({ text: note.trim(), generatedAt: new Date().toISOString(), basedOn: dk, feedbackCount: feedback.length });
    console.log('[quality-check] note saved:', note.slice(0, 120));
    res.json({ ok: true, note: note.trim(), feedbackCount: feedback.length });
  } catch (e) {
    console.error('[quality-check] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Persona Trainer ───────────────────────────────────────────────────────────

const trainer = require('./lib/persona-trainer');
const VALID_PERSONAS = ['researcher', 'reporter', 'editor'];

// Generate synthetic input + run persona on it
app.post('/api/train/:persona/generate', async (req, res) => {
  const { persona } = req.params;
  if (!VALID_PERSONAS.includes(persona)) return res.status(400).json({ error: 'Unknown persona' });
  try {
    const settings       = await storage.getSettings();
    // Never use claude-cli for trainer — it's too slow and interactive; fall back to Groq
    const rawModel = settings[`${persona === 'researcher' ? 'cluster' : persona}Model`] || settings.digestModel;
    const model    = rawModel === 'claude-cli' ? 'llama-3.3-70b-versatile' : rawModel;
    const syntheticInput = await trainer.generateSynthetic(persona, model);
    const personaOutput  = await trainer.runPersonaOnSynthetic(persona, syntheticInput, model);
    res.json({ syntheticInput, personaOutput });
  } catch (e) {
    console.error(`[trainer/${persona}] generate error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Save user feedback on a training scenario
app.post('/api/train/:persona/feedback', async (req, res) => {
  const { persona } = req.params;
  if (!VALID_PERSONAS.includes(persona)) return res.status(400).json({ error: 'Unknown persona' });
  const { syntheticInput, personaOutput, userFeedback, approvedOutput } = req.body;
  try {
    const settings = await storage.getSettings();
    const model    = settings.digestModel;
    const data     = await trainer.saveTrainingExample(persona, { syntheticInput, personaOutput, userFeedback, approvedOutput });
    // Distill rules after every 3 examples
    let rules = data.rules || [];
    if (data.examples.length % 3 === 0) rules = await trainer.distillRules(persona, model);
    res.json({ saved: true, totalExamples: data.examples.length, rules });
  } catch (e) {
    console.error(`[trainer/${persona}] feedback error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get current training data + rules for a persona
app.get('/api/train/:persona', async (req, res) => {
  const { persona } = req.params;
  if (!VALID_PERSONAS.includes(persona)) return res.status(400).json({ error: 'Unknown persona' });
  const data = await trainer.getTrainingData(persona);
  res.json({ examples: data.examples.length, rules: data.rules || [] });
});

// Manually trigger rule distillation
app.post('/api/train/:persona/distill', async (req, res) => {
  const { persona } = req.params;
  if (!VALID_PERSONAS.includes(persona)) return res.status(400).json({ error: 'Unknown persona' });
  const settings = await storage.getSettings();
  const rules    = await trainer.distillRules(persona, settings.digestModel);
  res.json({ rules });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Newsletter Digest running at http://localhost:${PORT}`);
  });
}

module.exports = app;
