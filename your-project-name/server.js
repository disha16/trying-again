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
const issueReports  = require('./lib/issue-reports');

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

// Curated list of well-known Thought Leadership newsletters surfaced in the
// admin-only Settings accordion. Returns the static catalog plus a flag for
// whether the user already has each one.
app.get('/api/suggested-tl', async (_req, res) => {
  try {
    const { SUGGESTED_TL } = require('./lib/suggested-tl');
    const sources = await storage.getSources();
    const existing = new Set(
      sources.map(s => (s.name || '').toLowerCase().trim()).filter(Boolean)
    );
    res.json(SUGGESTED_TL.map(s => ({ ...s, alreadyAdded: existing.has(s.name.toLowerCase().trim()) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One-click add: subscribes the named entry from the curated TL catalog and
// tags it kind=thought_leadership so the TL pipeline picks it up.
app.post('/api/suggested-tl/add', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const { SUGGESTED_TL } = require('./lib/suggested-tl');
    const tpl = SUGGESTED_TL.find(s => s.name.toLowerCase() === String(name).toLowerCase());
    if (!tpl) return res.status(404).json({ error: 'not in suggested list' });
    const sources = await storage.getSources();
    const existing = sources.find(s => (s.name || '').toLowerCase().trim() === tpl.name.toLowerCase());
    if (existing) {
      // Already there — just upgrade its kind to thought_leadership and ensure enabled.
      existing.kind    = 'thought_leadership';
      existing.enabled = true;
      if (!existing.email && tpl.email) existing.email = tpl.email;
      if (!existing.url   && tpl.url)   existing.url   = tpl.url;
      await storage.setSources(sources);
      return res.json({ ok: true, source: existing, action: 'updated' });
    }
    const src = {
      id:      Date.now(),
      name:    tpl.name,
      email:   tpl.email || '',
      url:     tpl.url   || '',
      kind:    'thought_leadership',
      enabled: true,
    };
    sources.push(src);
    await storage.setSources(sources);
    res.json({ ok: true, source: src, action: 'added' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk add all suggestions the user doesn't already have.
app.post('/api/suggested-tl/add-all', async (_req, res) => {
  try {
    const { SUGGESTED_TL } = require('./lib/suggested-tl');
    const sources = await storage.getSources();
    const existing = new Map(
      sources.map(s => [(s.name || '').toLowerCase().trim(), s])
    );
    let added = 0, updated = 0;
    for (const tpl of SUGGESTED_TL) {
      const key = tpl.name.toLowerCase().trim();
      const cur = existing.get(key);
      if (cur) {
        if (cur.kind !== 'thought_leadership' || !cur.enabled) {
          cur.kind    = 'thought_leadership';
          cur.enabled = true;
          updated++;
        }
      } else {
        sources.push({
          id:      Date.now() + added,
          name:    tpl.name,
          email:   tpl.email || '',
          url:     tpl.url   || '',
          kind:    'thought_leadership',
          enabled: true,
        });
        added++;
      }
    }
    await storage.setSources(sources);
    res.json({ ok: true, added, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sources', async (req, res) => {
  const { name, email, url, kind } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const safeKind = kind === 'thought_leadership' ? 'thought_leadership' : 'newsletter';
  const sources  = await storage.getSources();
  const src = {
    id:      Date.now(),
    name:    name.trim(),
    email:   (email || '').trim(),
    url:     (url || '').trim(),
    kind:    safeKind,
    enabled: true,
  };
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
  if (req.body.kind    !== undefined) src.kind    = req.body.kind === 'thought_leadership' ? 'thought_leadership' : 'newsletter';
  await storage.setSources(sources);
  res.json(src);
});

app.delete('/sources/:id', async (req, res) => {
  const sources = await storage.getSources();
  await storage.setSources(sources.filter(s => s.id != req.params.id));
  res.json({ success: true });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

// ─── Temporary debug: check Supabase storage keys ─────────────────────────────
app.get('/api/debug-storage', async (req, res) => {
  try {
    const tokens = await storage.getGmailTokens();
    const settings = await storage.getSettings();
    const storedKey = settings.anthropicApiKey || '';
    const envKey = process.env.ANTHROPIC_API_KEY || '';
    res.json({
      gmail_tokens_present: !!(tokens && tokens.access_token),
      gmail_email: tokens ? tokens.email || 'unknown' : null,
      settings_model: settings.clusterModel,
      settings_anthropic_key_set: !!(settings.anthropicApiKey),
      stored_key_preview: storedKey ? storedKey.slice(0,20) + '...' + storedKey.slice(-6) : 'NOT SET',
      env_key_preview: envKey ? envKey.slice(0,20) + '...' + envKey.slice(-6) : 'NOT SET',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Clear email cache (forces re-fetch of all emails next run) ───────────────
app.post('/api/clear-email-cache', async (req, res) => {
  try {
    await storage.setKey('emailCache', {});
    res.json({ ok: true, message: 'Email cache cleared' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


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
  // Accept either `useExa` or legacy `showImages`; mirror both for back-compat.
  if (req.body.useExa !== undefined) {
    update.useExa     = !!req.body.useExa;
    update.showImages = !!req.body.useExa;
  } else if (req.body.showImages !== undefined) {
    update.showImages = !!req.body.showImages;
    update.useExa     = !!req.body.showImages;
  }
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
app.get('/api/digest-history', async (_req, res) => {
  // Canonical source of date-picker dates: Supabase digest_cache.
  // Falls back to the legacy kv digestHistory for any pre-migration rows.
  const index = {};
  try {
    const list = await supa.listDigests(60);
    for (const r of list) {
      index[r.date_key] = { date: r.digest?.date || r.date_key, ranAt: r.ran_at };
    }
  } catch (e) { console.warn('[digest-history] supa:', e.message); }
  try {
    const legacy = await storage.getDigestHistory();
    for (const [k, d] of Object.entries(legacy)) {
      if (!index[k]) index[k] = { date: d.date, ranAt: d.ranAt };
    }
  } catch {}
  res.json(index);
});

app.get('/api/digest/:date', async (req, res) => {
  const dateKey = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return res.status(400).json({ error: 'bad date' });

  // 1) Prefer Supabase digest_cache (the canonical 3pm-run store)
  try {
    const row = await supa.getDigest(dateKey);
    if (row?.digest) return res.json(row.digest);
  } catch (e) { console.warn('[digest.get] supa:', e.message); }

  // 2) Fallback to legacy kv digestHistory (older rows)
  const h = await storage.getDigestHistory();
  let d = h[dateKey];

  // 3) If asking for today and it's still in the in-memory lastRun, serve it
  if (!d) {
    const lastRun = await storage.getLastRun();
    if (lastRun?.ranAt?.startsWith(dateKey)) d = lastRun;
  }
  if (!d) return res.status(404).json({ error: 'No digest for this date' });
  res.json(d);
});

app.get('/api/charts',    async (req, res) => {
  const last = await storage.getLastRun();
  res.json({ charts: last?.charts || [] });
});

// ─── Chart of the Day (Exa + LLM → Chart.js data) ────────────────────────────
const chartOfDay       = require('./lib/chart-of-day');
const thoughtLeadership = require('./lib/thought-leadership');
const earningsLib      = require('./lib/earnings');

let chartInFlight = null;

app.get('/api/chart-of-day', async (req, res) => {
  try {
    // Chart-of-day v3 uses public RSS feeds (Exa-independent), so always allow.
    // Accept an optional ?date=YYYY-MM-DD so the date-picker can request a cached run.
    const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
      ? req.query.date
      : undefined;

    // Coalesce concurrent callers.
    let payload;
    if (chartInFlight) {
      payload = await chartInFlight;
    } else {
      chartInFlight = chartOfDay.getCharts({ dateKey }).finally(() => { chartInFlight = null; });
      payload = await chartInFlight;
    }
    // Add 2-line LLM caption to each chart on the fly if missing, then persist
    // back to KV so subsequent calls don't re-run the LLM.
    if (Array.isArray(payload?.charts) && payload.charts.some(c => !c.caption)) {
      try {
        payload.charts = await chartOfDay.summarizeCharts(payload.charts);
        const key = `cache:chart-of-day:${payload.dateKey || (dateKey || new Date().toISOString().slice(0,10))}`;
        try { await require('./lib/storage').setKV(key, payload); } catch (e) { console.warn('[chart] caption cache write failed:', e.message); }
      } catch (e) {
        console.warn('[chart] inline caption enrich failed:', e.message);
      }
    }
    res.json(payload);
  } catch (e) {
    console.error('[chart-of-day]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Expose chart-source configuration so the settings panel can list/edit them.
app.get('/api/chart-sources', async (_req, res) => {
  try { res.json(await chartOfDay.getChartSources()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/chart-sources', async (req, res) => {
  try {
    const sources = Array.isArray(req.body?.sources) ? req.body.sources : [];
    const cleaned = sources.map(s => ({
      name:  String(s.name || '').slice(0, 80),
      kind:  s.kind === 'twitter' ? 'twitter' : 'html',
      url:   String(s.url || ''),
      limit: Math.min(5, Math.max(1, Number(s.limit) || 2)),
    })).filter(s => s.name && /^https?:\/\//.test(s.url));
    const current = await storage.getSettings();
    await storage.setSettings({ ...current, chartSources: cleaned });
    res.json({ ok: true, count: cleaned.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// ─── Last run cache (Supabase digest_cache) ─────────────────────────────────
// Powers the Settings → "Last run cache" panel, so the user can see exactly
// which digests are currently cached and when each was generated.

// ─── Report an issue — Supabase-only ──────────────────────────────────────
app.post('/api/report-issue', async (req, res) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'body required' });
    if (body.length > 4000) return res.status(400).json({ error: 'body too long' });
    const userAgent = req.get('user-agent') || null;
    const url       = String(req.body?.url || '').slice(0, 500) || null;
    const logged    = await issueReports.logIssue({ body, userAgent, url });
    res.json({ ok: true, id: logged.id, stored: logged.stored });
  } catch (e) {
    console.error('[report-issue]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cache-index', async (req, res) => {
  try {
    const list = await supa.listDigests(14);
    res.json(list.map(r => ({ dateKey: r.date_key, ranAt: r.ran_at, enriched: !!r.enriched })));
  } catch (e) {
    console.error('[cache-index]', e.message);
    res.status(500).json({ error: e.message });
  }
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
  const _tz2 = (await storage.getSettings())?.timezone || 'America/New_York';
  const todayLabel2 = now2.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: _tz2 });
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
    } else if (digestGen.ANTHROPIC_MODELS.includes(chatModel)) {
      summary = await digestGen.callAnthropic(chatModel, 'You are a sharp analyst.', prompt);
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
  const exaOn   = (await storage.isExaEnabled()) && !!process.env.EXA_API_KEY;
  const tavilyOn = !!process.env.TAVILY_API_KEY;
  if (!exaOn && !tavilyOn) return res.json({ stories: [] });
  try {
    const query = note.title + (note.entries[0] ? ' ' + note.entries[0].headline.slice(0, 60) : '');
    const BAD_IMAGE  = /sponsor|supported[_-]by|partner|adverti|banner|logo[_-]|brand|promo|newsletter|header|footer|icon|avatar|placeholder|pixel|tracking|beacon/i;
    const BAD_DOMAIN = /globenewswire|prnewswire|businesswire|accesswire|notified\.com|food|recipe|cook|lifestyle|wellness|fitness/i;
    let rawResults = [];
    // Prefer Exa when admin has it on; otherwise (or on Exa failure) use Tavily.
    if (exaOn) {
      try {
        const Exa = require('exa-js').default;
        const exa = new Exa(process.env.EXA_API_KEY);
        const r = await exa.searchAndContents(query, { numResults: 10, category: 'news', text: { maxCharacters: 400 } });
        rawResults = (r.results || []).map(x => ({ title: x.title, url: x.url, image: x.image || null, text: x.text || '' }));
      } catch (e) { console.warn('[notes/similar] exa failed, falling back to tavily:', e.message); }
    }
    if (!rawResults.length && tavilyOn) {
      try {
        const { searchTavily } = require('./lib/web-search');
        const hits = await searchTavily(query, { numResults: 10 });
        rawResults = hits.map(x => ({ title: x.title, url: x.url, image: x.image || null, text: x.snippet || x.text || '' }));
      } catch (e) { console.warn('[notes/similar] tavily failed:', e.message); }
    }
    const existingHeadlines = new Set(note.entries.map(e => e.headline?.toLowerCase()));
    const stories = rawResults
      .filter(r => r.title && !existingHeadlines.has(r.title.toLowerCase()))
      .filter(r => !r.image || (!BAD_IMAGE.test(r.image) && !BAD_DOMAIN.test(r.url || '')))
      .slice(0, 8)
      .map(r => {
        const host = (() => { try { return new URL(r.url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return ''; } })();
        let img = r.image;
        if (!img) { try { img = require('./lib/undraw').pick(r.title || host); } catch {} }
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
          image:     (!BAD_IMAGE.test(img || '') && !BAD_DOMAIN.test(r.url || '')) ? img : null,
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

// Heuristic: does the user want us to hit the live web for this turn?
// Triggered by explicit phrases ("search", "look up", "use the internet", "web",
// "google", "latest", "news on") OR by question words combined with a year/date.
function wantsWebSearch(text) {
  if (!text) return false;
  const s = text.toLowerCase();
  const explicit = /\b(search|look\s*(?:up|it\s*up)|use\s+the\s+(?:internet|web)|on\s+the\s+web|google\s+it|browse|fetch|find\s+(?:online|on\s+the\s+web))\b/.test(s);
  if (explicit) return true;
  // "latest" / "current" / "today" / "this week" + question
  const recency = /\b(latest|current|today|tonight|this\s+(?:week|month)|right\s+now|breaking|news\s+on)\b/.test(s);
  const isQuestion = /\?$/.test(s.trim()) || /^(what|who|when|where|why|how|did|is|was|are)\b/.test(s);
  return recency && isQuestion;
}

async function fetchChatWebContext(query, { force = false } = {}) {
  if (!query) return '';
  if (!force && !wantsWebSearch(query)) return '';

  // Prefer Tavily (free dev tier, always-on). Fall back to Exa only if the
  // admin toggle is on AND the user explicitly asked.
  const { searchTavily, searchExa } = require('./lib/web-search');
  const tryTavily = !!process.env.TAVILY_API_KEY;
  const tryExa    = !tryTavily && process.env.EXA_API_KEY && (await storage.isExaEnabled());

  let results = [];
  let provider = '';
  if (tryTavily) {
    try {
      results  = await searchTavily(query, { numResults: 4 });
      provider = 'Tavily';
    } catch (e) { console.warn('[chat/tavily]', e.message); }
  }
  if (!results.length && tryExa) {
    try {
      results  = await searchExa(query, { numResults: 4 });
      provider = 'Exa';
    } catch (e) { console.warn('[chat/exa]', e.message); }
  }
  if (!results.length) return '';

  const snippets = results
    .slice(0, 4)
    .map(r => `• [${r.title || r.url}](${r.url})${r.publishedDate ? ` — ${r.publishedDate}` : ''}\n  ${(r.snippet || r.text || '').slice(0, 600)}`)
    .join('\n\n');
  return `\n\nLIVE WEB CONTEXT (${provider} search for "${query.slice(0, 120)}"):\n${snippets}\n\nCite the URL inline when you use a fact from above.`;
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
    } else if (digestGen.ANTHROPIC_MODELS.includes(chatModel)) {
      // Anthropic SDK uses a different shape — collapse the multi-turn chat into
      // a single user turn that preserves conversational context.
      const convo = chatMessages
        .map(m => `${(m.role || 'user').toUpperCase()}: ${m.content}`)
        .join('\n\n');
      reply = await digestGen.callAnthropic(chatModel, CHAT_SYSTEM, convo);
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
    res.send('<h2>✅ Gmail connected!</h2><p>The daily digest will run automatically at 3pm ET. You can close this tab.</p>');
  } catch (err) {
    console.error('[auth/callback]', err.message);
    // If invalid_grant, the code may have already been exchanged (Vercel retry / double-invoke).
    // Check if tokens already exist in Supabase — if so, treat as success.
    if (err.message && err.message.includes('invalid_grant')) {
      try {
        const existing = await storage.getGmailTokens();
        if (existing && existing.access_token) {
          return res.send('<h2>✅ Gmail already connected!</h2><p>The daily digest will run automatically at 3pm ET. You can close this tab.</p>');
        }
      } catch (_) {}
    }
    res.status(500).send(`Auth failed: ${err.message}`);
  }
});

// ─── Shared digest runner (used by both cron and browser) ─────────────────────
async function runDigestSSE(req, res) {
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
  const _forceRefresh = req.query.force === 'true' || req.query.force === '1';
  if (_etHour >= 15 && !_forceRefresh) {
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
    const _dm = settings.digestModel  || DEFAULT_MODEL;
    const _cm = settings.clusterModel || DEFAULT_MODEL;
    const _em = settings.editorModel  || _dm;
    // claude-cli is not available on Vercel — fall back to Llama
    const digestModel  = _dm  === 'claude-cli' ? DEFAULT_MODEL : _dm;
    const clusterModel = _cm  === 'claude-cli' ? DEFAULT_MODEL : _cm;
    const editorModel  = _em  === 'claude-cli' ? DEFAULT_MODEL : _em;
    // Extract enabled custom sections from settings
    const customSections = (settings.sections || []).filter(s => s.custom && s.enabled !== false);
    console.log(`[cron/digest] cluster: ${clusterModel}, digest: ${digestModel}, editor: ${editorModel}, custom: ${customSections.map(s=>s.label).join(',') || 'none'}`);

    send('status', { message: 'Fetching emails…' });
    if (_forceRefresh) { await storage.setKey('emailCache', {}); console.log('[cron/digest] force refresh: email cache cleared'); }
    const { entries, cacheHits, cacheMisses } = await gmail.fetchNewsletterHeadlines();
    console.log(`[cron/digest] entries: ${entries.length}`);
    send('status', { message: `${entries.length} newsletters (${cacheHits} cached, ${cacheMisses} new). Clustering…` });

    console.log('[cron/digest] starting clustering…');
    const clusters = await clusterer.clusterHeadlines(entries, clusterModel);
    console.log(`[cron/digest] clustering done: ${clusters.length} clusters`);
    const _exaOn = settings.useExa === true || settings.showImages === true;
    send('status', { message: _exaOn ? `${clusters.length} unique stories. Fetching article images…` : `${clusters.length} unique stories.` });
    await exaImages.enrichClustersWithImages(clusters, { useExa: _exaOn });
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
    const _tz = settings?.timezone || 'America/New_York';
    const todayLabel = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: _tz });
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
        // Thought Leadership: separate Gmail fetch over the last 7 days,
        // restricted to sources tagged kind='thought_leadership'. Sort newest
        // first, drop anything already read, take up to 5.
        try {
          let tlCards = [];
          const tlEntries = await gmail.fetchThoughtLeadership({ days: 7 });
          if (tlEntries.length) {
            const alreadyRead = await thoughtLeadership.getReadTLIds();
            const fresh = tlEntries.filter(e => !alreadyRead.has(`tl:${e.id}`)).slice(0, 5);
            if (fresh.length) {
              tlCards = await thoughtLeadership.buildThoughtLeadershipDeck(
                fresh, digestModel, new Set()
              );
            }
          }
          // LLM fallback when no TL emails (or none summarised) — synthesise from top stories.
          if (!tlCards.length) {
            try {
              tlCards = await thoughtLeadership.buildLLMFallbackDeck(
                digest.top_today || [], digestModel
              );
              if (tlCards.length) console.log(`[cron/digest] thought leadership: ${tlCards.length} LLM-fallback cards`);
            } catch (e2) { console.warn('[cron/digest] TL LLM fallback error:', e2.message); }
          } else {
            console.log(`[cron/digest] thought leadership: ${tlCards.length} cards (from last 7d)`);
          }
          if (tlCards.length) digest.thought_leadership = tlCards;
        } catch (e) { console.warn('[cron/digest] thought-leadership error:', e.message); }

        // Earnings Watch (MarketBeat scrape) — 5 most recent earnings articles,
        // each with an LLM-generated 2-line insightful summary.
        try {
          let earnings = await earningsLib.fetchEarnings(5);
          if (earnings.length) {
            try { earnings = await earningsLib.summarizeEarnings(earnings, digestModel); }
            catch (e) { console.warn('[cron/digest] earnings summary error:', e.message); }
            digest.earnings = earnings;
            console.log(`[cron/digest] earnings: ${earnings.length} articles from MarketBeat`);
          }
        } catch (e) { console.warn('[cron/digest] earnings error:', e.message); }

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

        // Carousel "charts of the day" (Exa-sourced thumbnails in top_today) — skipped
        // entirely when the admin-only Show Images / Chart toggle is off, so we don't
        // burn web-search credits on assets the user has chosen to hide.
        if (settings.internetFallback && (settings.useExa === true || settings.showImages === true)) {
          const topHeadlines  = (digest.top_today || []).map(s => s.headline);
          const lastRun2      = await storage.getLastRun();
          const seenChartUrls = new Set((lastRun2?.charts || []).map(c => c.sourceUrl).filter(Boolean));
          digest.charts = await charts.fetchChartsOfDay(topHeadlines, seenChartUrls, digestModel)
            .catch(e => { console.error('[cron/digest] charts error:', e.message); return []; });
        } else {
          console.log('[cron/digest] useExa=false — skipping charts-of-day carousel');
        }

        // Pre-generate "Chart of the Day" (v2: scrapes user-configured predefined
        // sources — NBC economic indicators + Twitter/X accounts — and returns up
        // to 5 charts). No Exa, no LLM — this block is Exa-free by design and runs
        // regardless of the useExa toggle because it only scrapes predefined sources.
        if (true) {
          try {
            const payload = await chartOfDay.getCharts({ dateKey, force: true });
            try { payload.charts = await chartOfDay.summarizeCharts(payload.charts); } catch (e) { console.warn('[cron/digest] chart caption error:', e.message); }
            digest.chartOfDay = payload;
            console.log(`[cron/digest] chart-of-day v2 cached for ${dateKey} (${payload.charts.length} charts, captioned)`);
          } catch (e) { console.error('[cron/digest] chart-of-day v2 prefetch error:', e.message); }
        } else {
          console.log('[cron/digest] chart-of-day prefetch skipped');
        }

        // 30-day TTL sweep (digest cache, read history, temp KV rows). Feedback
        // and notebook are NEVER swept here — they are user data.
        try {
          const swept = await supa.purgeOldCache({ days: 30 });
          console.log('[cron/digest] 30d sweep:', JSON.stringify(swept));
        } catch (e) { console.warn('[cron/digest] sweep failed:', e.message); }

        // 365-day notebook idle purge (removes entries not touched in a year).
        try {
          const { purged } = await supa.purgeIdleNotebook({ days: 365 });
          if (purged) console.log(`[cron/digest] notebook purge: ${purged} entries`);
        } catch (e) { console.warn('[cron/digest] notebook purge failed:', e.message); }

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

    // IMPORTANT: on Vercel, async work after res.end() is killed when the serverless
    // function returns. Await enrichment inline so topic_clusters / chartOfDay /
    // thought_leadership actually persist. vercel.json has maxDuration=300s.
    // Note: the client may already have closed the EventSource after the first
    // 'done' event above — that's fine; the enriched digest is still saved to
    // Supabase digest_cache, and the UI will pick it up on the next load.
    await enrichAsync();
    // If the client is still listening, push the enriched payload as a distinct event.
    try { send('enriched', await storage.getLastRun()); } catch {}

    console.log(`[cron/digest] Core done — ${digest.date} | ${clusters.length} clusters → digest`);
  } catch (err) {
    console.error('[cron/digest] Error:', err.message);
    send('error', { error: err.message });
  } finally {
    digestRunning = false;
    res.end();
  }

}

// ─── Cron — auto digest (protected, called by Vercel scheduler) ───────────────
app.get('/api/cron/digest', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'];
  const querySecret = req.query.secret;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return runDigestSSE(req, res);
});

// ─── Admin migrate ─ creates issue_reports + indexes on demand ───────────
const ADMIN_MIGRATE_SQL = `
create table if not exists issue_reports (
  id          bigserial primary key,
  body        text not null,
  user_agent  text,
  url         text,
  created_at  timestamptz not null default now()
);
alter table issue_reports disable row level security;
create index if not exists read_stories_read_at_idx on read_stories (read_at);
create index if not exists digest_cache_ran_at_idx on digest_cache (ran_at);
`;
app.get('/api/admin/migrate', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.query.secret !== cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({ error: 'Supabase env missing' });

  // Supabase exposes the Postgres REST but not raw DDL. We use the optional
  // pg connection string if present (Vercel envs: DATABASE_URL / POSTGRES_URL /
  // SUPABASE_DB_URL). If none are set we print the SQL for manual copy.
  const pgUrl = process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!pgUrl) {
    return res.json({
      ok: false,
      note: 'No Postgres connection string env var (SUPABASE_DB_URL / POSTGRES_URL / DATABASE_URL). Paste the SQL below into Supabase SQL editor.',
      sql: ADMIN_MIGRATE_SQL,
    });
  }
  try {
    const { Client } = require('pg');
    const c = new Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
    await c.connect();
    await c.query(ADMIN_MIGRATE_SQL);
    await c.end();
    res.json({ ok: true, applied: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, sql: ADMIN_MIGRATE_SQL });
  }
});

// ─── Browser-initiated digest run (no auth required — Gmail tokens are the gate) ─
app.get('/api/run-digest', (req, res) => runDigestSSE(req, res));

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
