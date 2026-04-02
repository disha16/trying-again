require('dotenv').config({ override: true });
const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const storage   = require('./lib/storage');
const gmail     = require('./lib/gmail');
const digestGen = require('./lib/digest-generator');

const app  = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

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

// ─── Digest cache ──────────────────────────────────────────────────────────────

app.get('/last-run', async (req, res) => res.json(await storage.getLastRun()));

app.post('/api/push-digest', async (req, res) => {
  const { digest } = req.body;
  if (!digest) return res.status(400).json({ error: 'digest required' });
  await storage.setLastRun({ ...digest, ranAt: new Date().toISOString() });
  console.log(`[push-digest] Stored digest for ${digest.date}`);
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

app.post('/chat', async (req, res) => {
  const { messages: chatMessages } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Add ANTHROPIC_API_KEY to .env to enable chat.' });

  const lastRun       = await storage.getLastRun();
  const inboxSnapshot = await storage.getInboxSnapshot();

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

  const anthropic = new Anthropic({ apiKey });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: `You are a sharp, well-informed personal assistant with full access to the user's email inbox and newsletter digest. Answer questions about news, emails, and anything in the inbox with precision.

FORMAT RULES (always follow):
- Use **bold** for key names, figures, and terms
- Use bullet points for lists of 3+ items
- Use ### headings when covering multiple topics in one answer
- Keep answers tight — no filler phrases, no "certainly!", no lengthy preambles
- Lead with the most important point; add context only if it adds value
- Max 3-4 sentences per topic unless asked for more detail
- If asked about a specific email or sender, search the inbox snapshot data
- If data is missing from the inbox snapshot, say so clearly

${digestContext}${inboxContext}`,
      messages: chatMessages,
    });
    res.json({ reply: response.content[0].text });
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
  try {
    console.log('[cron/digest] Starting');
    const emails = await gmail.fetchNewsletterEmails();
    console.log(`[cron/digest] Fetched ${emails.length} emails`);
    const digest = await digestGen.generateDigest(emails);
    await storage.setLastRun({ ...digest, ranAt: new Date().toISOString() });
    console.log(`[cron/digest] Done — ${digest.date}`);
    res.json({ success: true, date: digest.date, emailCount: emails.length });
  } catch (err) {
    console.error('[cron/digest] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Loan Risk Scoring ─────────────────────────────────────────────────────────

const LOAN_EXTRACTION_PROMPT = `Extract loan application data from this document. Return ONLY a JSON object with these exact fields (null for any field you cannot determine):

{
  "applicant_name": null,
  "credit_score": null,
  "dti_ratio": null,
  "employment_type": null,
  "employment_years": null,
  "annual_income": null,
  "loan_amount": null,
  "loan_purpose": null,
  "narrative_factors": []
}

Field rules:
- credit_score: integer (e.g. 720)
- dti_ratio: percentage as a number (e.g. 35 means 35%). If you see monthly debt and monthly income, compute (debt/income)*100.
- employment_type: one of "full-time" | "self-employed" | "part-time" | "unstable" | "unemployed"
- employment_years: decimal years in current role (e.g. 2.5)
- annual_income: gross annual income in USD (integer)
- loan_amount: requested loan in USD (integer)
- narrative_factors: ONLY include factors actually present in the document. Each item: { "factor": "recent job gap" | "multiple late payments" | "income volatility" | "recent bankruptcy" | "financial distress purpose", "adjustment": 2-6 }
  Use adjustment 2=minor, 4=moderate, 6=severe. Financial distress purpose includes debt consolidation, medical bills, avoiding foreclosure.

Return ONLY the JSON object, no other text.`;

function computeLoanPD(fields) {
  const {
    credit_score, dti_ratio, employment_type, employment_years,
    annual_income, loan_amount, narrative_factors = []
  } = fields;

  let pd = 8;
  let pdLti = 8;
  const breakdown = [{ label: 'Base Rate', adjustment: 8, running: 8 }];

  if (credit_score != null) {
    const adj = credit_score >= 760 ? -4 : credit_score >= 720 ? -2 :
                credit_score >= 680 ? 0  : credit_score >= 640 ? 4 : 8;
    pd += adj; pdLti += adj;
    breakdown.push({ label: `Credit Score (${credit_score})`, adjustment: adj, running: pd });
  }

  if (dti_ratio != null) {
    const adj = dti_ratio <= 30 ? -3 : dti_ratio <= 40 ? 0 : dti_ratio <= 50 ? 4 : 8;
    pd += adj; pdLti += adj;
    breakdown.push({ label: `DTI Ratio (${dti_ratio}%)`, adjustment: adj, running: pd });
  }

  {
    const type = (employment_type || '').toLowerCase();
    const yrs  = Number(employment_years) || 0;
    let adj;
    if (type.includes('full') && yrs >= 3)      adj = -2;
    else if (type.includes('full') && yrs >= 1)  adj =  0;
    else if (type.includes('self') && yrs >= 2)  adj =  2;
    else                                          adj =  5;
    pd += adj; pdLti += adj;
    breakdown.push({ label: `Employment (${employment_type || 'unknown'}, ${yrs}yr)`, adjustment: adj, running: pd });
  }

  let ltiPct = null;
  if (loan_amount != null && annual_income > 0) {
    ltiPct = (loan_amount / annual_income) * 100;
    const adj = ltiPct <= 30 ? -2 : ltiPct <= 50 ? 0 : ltiPct <= 70 ? 3 : 6;
    pd    += adj;
    pdLti += adj * 2;
    breakdown.push({ label: `Loan-to-Income (${ltiPct.toFixed(0)}%)`, adjustment: adj, running: pd });
  }

  const narrativeTotal = narrative_factors.reduce((s, f) => s + (Number(f.adjustment) || 3), 0);
  if (narrativeTotal > 0) {
    pd += narrativeTotal; pdLti += narrativeTotal;
    breakdown.push({
      label: `Narrative Risk (${narrative_factors.length} factor${narrative_factors.length !== 1 ? 's' : ''})`,
      adjustment: narrativeTotal, running: pd
    });
  }

  pd    = Math.max(1, Math.min(60, Math.round(pd)));
  pdLti = Math.max(1, Math.min(60, Math.round(pdLti)));

  const primary_risk_drivers = breakdown
    .filter(b => b.adjustment > 0 && b.label !== 'Base Rate')
    .sort((a, b) => b.adjustment - a.adjustment)
    .slice(0, 3)
    .map(b => b.label);

  return { pd, pd_lti_weighted: pdLti, breakdown, lti: ltiPct ? Math.round(ltiPct) : null, primary_risk_drivers };
}

app.post('/api/loan-extract', async (req, res) => {
  const { pdf_base64 } = req.body;
  if (!pdf_base64) return res.status(400).json({ error: 'pdf_base64 required' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const anthropic = new Anthropic({ apiKey });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
          { type: 'text', text: LOAN_EXTRACTION_PROMPT }
        ]
      }]
    });
    const text = response.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Model did not return valid JSON');
    res.json({ extracted: JSON.parse(match[0]) });
  } catch (err) {
    console.error('loan-extract error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/loan-score', (req, res) => {
  const { fields } = req.body;
  if (!fields) return res.status(400).json({ error: 'fields required' });
  try { res.json(computeLoanPD(fields)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/loan-analyze', async (req, res) => {
  const { fields, pd_result } = req.body;
  if (!fields) return res.status(400).json({ error: 'fields required' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { pd, breakdown, primary_risk_drivers, lti } = pd_result || {};
  const profile = [
    `Credit Score: ${fields.credit_score ?? 'Unknown'}`,
    `DTI Ratio: ${fields.dti_ratio != null ? fields.dti_ratio + '%' : 'Unknown'}`,
    `Employment: ${fields.employment_type ?? 'Unknown'}, ${fields.employment_years ?? '?'} years`,
    `Annual Income: ${fields.annual_income ? '$' + Number(fields.annual_income).toLocaleString() : 'Unknown'}`,
    `Loan Amount: ${fields.loan_amount ? '$' + Number(fields.loan_amount).toLocaleString() : 'Unknown'}`,
    `Loan-to-Income: ${lti != null ? lti + '%' : 'Unknown'}`,
    `Loan Purpose: ${fields.loan_purpose || 'Not specified'}`,
    `Narrative Risks Present: ${(fields.narrative_factors || []).map(f => f.factor).join(', ') || 'None identified'}`,
  ].join('\n');

  const scoring = [
    `Rule-Based PD: ${pd ?? '?'}%`,
    `Breakdown: ${(breakdown || []).map(b => `${b.label} ${b.adjustment > 0 ? '+' : ''}${b.adjustment}%`).join(' | ')}`,
    `Flagged Drivers: ${(primary_risk_drivers || []).join(', ') || 'None'}`,
  ].join('\n');

  const prompt = `You are an expert loan underwriter with 20 years of experience at a major bank. A rule-based model has already scored this applicant — your job is to provide the qualitative layer a rules engine cannot.

APPLICANT PROFILE:
${profile}

RULE-BASED SCORING:
${scoring}

Analyze holistically. Surface risks and insights NOT already reflected in the five scoring factors (credit score, DTI, employment stability, LTI, identified narrative factors). Consider:
- Compounding effects where multiple weaknesses amplify each other beyond their individual scores
- Income sustainability and sector/employment-type risk
- Loan purpose risk and whether the requested amount makes sense for the stated purpose
- Inconsistencies or unusual patterns in the profile
- Positive compensating factors the rules may have discounted
- Payment capacity: approximate monthly payment burden relative to likely take-home pay
- Whether the PD seems appropriate, too lenient, or too conservative given the full picture

Return ONLY this JSON (max 4 items per array, each item under 130 characters):
{
  "headline_assessment": "2 sentences: overall risk read on this specific applicant, not generic",
  "hidden_risks": ["specific risk not already penalised by the scoring model"],
  "compounding_factors": ["where two or more factors interact to make the risk worse than the sum of parts"],
  "mitigating_factors": ["genuine positive signals that offset risk — omit if none"],
  "recommendation": "APPROVE" | "APPROVE WITH CONDITIONS" | "REFER FOR REVIEW" | "DECLINE",
  "recommendation_note": "one sentence rationale under 120 chars",
  "claude_pd": <integer 1-60, your independent holistic PD estimate>,
  "claude_pd_reasoning": "1-2 sentences explaining specifically why you landed on this number"
}`;

  const anthropic = new Anthropic({ apiKey });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    const text  = response.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Model did not return valid JSON');
    const result = JSON.parse(match[0]);
    result._usage = response.usage;
    res.json(result);
  } catch (err) {
    console.error('loan-analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Newsletter Digest running at http://localhost:${PORT}`);
  });
}

module.exports = app;
