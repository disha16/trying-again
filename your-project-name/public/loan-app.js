'use strict';

// ── Narrative factor definitions (matching guidelines) ──────────────────────
const NARRATIVE_DEFS = [
  {
    key: 'recent_job_gap',
    label: 'Recent job gap',
    desc: 'Gap in employment history in the past 12–24 months'
  },
  {
    key: 'late_payments',
    label: 'Multiple late payments',
    desc: 'More than one late payment in the past 12 months'
  },
  {
    key: 'income_volatility',
    label: 'Income volatility',
    desc: 'Irregular, seasonal, or significantly declining income'
  },
  {
    key: 'recent_bankruptcy',
    label: 'Recent bankruptcy',
    desc: 'Bankruptcy filed within the past 7 years'
  },
  {
    key: 'financial_distress',
    label: 'Financial distress purpose',
    desc: 'Loan for debt consolidation, medical bills, or avoiding foreclosure'
  }
];

// Map Claude's extracted factor strings to our keys
function matchFactor(factorStr) {
  const s = factorStr.toLowerCase();
  if (s.includes('job gap') || s.includes('employment gap') || s.includes('job gap')) return 'recent_job_gap';
  if (s.includes('late payment'))          return 'late_payments';
  if (s.includes('volatil') || s.includes('irregular income') || s.includes('declining income')) return 'income_volatility';
  if (s.includes('bankrupt'))              return 'recent_bankruptcy';
  if (s.includes('distress') || s.includes('consolidat') || s.includes('medical') || s.includes('foreclos')) return 'financial_distress';
  return null;
}

// ── DOM references ───────────────────────────────────────────────────────────
const uploadZone   = document.getElementById('uploadZone');
const fileInput    = document.getElementById('fileInput');
const statusBar    = document.getElementById('statusBar');
const fieldsCard   = document.getElementById('fieldsCard');
const resultsCard  = document.getElementById('resultsCard');
const scoreBtn     = document.getElementById('scoreBtn');

// ── Status helpers ───────────────────────────────────────────────────────────
function setStatus(msg, type = 'info', spinner = false) {
  statusBar.innerHTML = spinner
    ? `<span class="spinner-inline"></span>${msg}`
    : msg;
  statusBar.className = `status-bar ${type}`;
  statusBar.classList.remove('hidden');
}
function clearStatus() { statusBar.classList.add('hidden'); }

// ── Narrative factor renderer ────────────────────────────────────────────────
function renderNarrativeFactors(preChecked = {}) {
  const container = document.getElementById('narrativeFactors');
  container.innerHTML = '';

  NARRATIVE_DEFS.forEach(def => {
    const info = preChecked[def.key];
    const checked = !!info;
    const adj = info?.adjustment ?? 3;

    const row = document.createElement('div');
    row.className = 'narrative-row';
    row.innerHTML = `
      <label class="narrative-check">
        <input type="checkbox" data-key="${def.key}" ${checked ? 'checked' : ''} />
        <div class="narrative-text">
          <span class="narrative-label">${def.label}</span>
          <span class="narrative-desc">${def.desc}</span>
        </div>
      </label>
      <select class="narrative-adj" data-key="${def.key}" ${!checked ? 'disabled' : ''}>
        <option value="2" ${adj===2?'selected':''}>+2%</option>
        <option value="3" ${adj===3?'selected':''}>+3%</option>
        <option value="4" ${adj===4?'selected':''}>+4%</option>
        <option value="5" ${adj===5?'selected':''}>+5%</option>
        <option value="6" ${adj===6?'selected':''}>+6%</option>
      </select>`;

    row.querySelector('input[type=checkbox]').addEventListener('change', e => {
      row.querySelector('select').disabled = !e.target.checked;
    });
    container.appendChild(row);
  });
}

// ── Populate form from extracted data ────────────────────────────────────────
function populateForm(extracted) {
  if (extracted.credit_score)    document.getElementById('f-credit').value   = extracted.credit_score;
  if (extracted.dti_ratio)       document.getElementById('f-dti').value      = extracted.dti_ratio;
  if (extracted.employment_type) document.getElementById('f-emptype').value  = extracted.employment_type;
  if (extracted.employment_years)document.getElementById('f-empyears').value = extracted.employment_years;
  if (extracted.annual_income)   document.getElementById('f-income').value   = extracted.annual_income;
  if (extracted.loan_amount)     document.getElementById('f-loan').value     = extracted.loan_amount;
  if (extracted.applicant_name)  document.getElementById('applicantName').textContent = extracted.applicant_name;

  // Map narrative factors
  const preChecked = {};
  (extracted.narrative_factors || []).forEach(f => {
    const key = matchFactor(f.factor || '');
    if (key) preChecked[key] = { adjustment: Number(f.adjustment) || 3 };
  });
  renderNarrativeFactors(preChecked);
}

// ── Read current form values ─────────────────────────────────────────────────
function readFields() {
  const narrativeFactors = [];
  document.querySelectorAll('#narrativeFactors input[type=checkbox]:checked').forEach(cb => {
    const key = cb.dataset.key;
    const sel = document.querySelector(`#narrativeFactors select[data-key="${key}"]`);
    const def = NARRATIVE_DEFS.find(d => d.key === key);
    narrativeFactors.push({
      factor: def ? def.label : key,
      adjustment: sel ? Number(sel.value) : 3
    });
  });
  return {
    credit_score:     parseFloat(document.getElementById('f-credit').value)   || null,
    dti_ratio:        parseFloat(document.getElementById('f-dti').value)       || null,
    employment_type:  document.getElementById('f-emptype').value               || null,
    employment_years: parseFloat(document.getElementById('f-empyears').value)  || null,
    annual_income:    parseFloat(document.getElementById('f-income').value)    || null,
    loan_amount:      parseFloat(document.getElementById('f-loan').value)      || null,
    narrative_factors: narrativeFactors
  };
}

// ── Display results ──────────────────────────────────────────────────────────
function showResults(data) {
  const { pd, breakdown, primary_risk_drivers } = data;

  // PD value
  document.getElementById('pdValue').textContent = `${pd}%`;

  // Color class
  const gauge = document.getElementById('pdGauge');
  gauge.className = 'pd-gauge ' + (
    pd < 8  ? 'pd-low'      :
    pd < 15 ? 'pd-moderate' :
    pd < 25 ? 'pd-elevated' :
    pd < 40 ? 'pd-high'     : 'pd-critical'
  );

  // Risk badge
  const badge = document.getElementById('riskBadge');
  const levels = [
    { max:  8, label: 'LOW RISK',  cls: 'badge-low' },
    { max: 15, label: 'MODERATE',  cls: 'badge-moderate' },
    { max: 25, label: 'ELEVATED',  cls: 'badge-elevated' },
    { max: 40, label: 'HIGH RISK', cls: 'badge-high' },
    { max: 61, label: 'VERY HIGH', cls: 'badge-critical' }
  ];
  const level = levels.find(l => pd <= l.max) || levels[levels.length - 1];
  badge.textContent = level.label;
  badge.className = `risk-badge ${level.cls}`;

  // Risk drivers
  const driversEl = document.getElementById('riskDrivers');
  if (primary_risk_drivers.length) {
    document.getElementById('driversList').innerHTML =
      primary_risk_drivers.map(d => `<li>${d}</li>`).join('');
    driversEl.classList.remove('hidden');
  } else {
    driversEl.classList.add('hidden');
  }

  // Breakdown table
  const tbody = document.getElementById('breakdownBody');
  tbody.innerHTML = breakdown.map(row => {
    const sign = row.adjustment > 0 ? '+' : '';
    const cls  = row.adjustment > 0 ? 'adj-pos' : row.adjustment < 0 ? 'adj-neg' : 'adj-zero';
    return `<tr>
      <td>${row.label}</td>
      <td class="${cls}">${sign}${row.adjustment}%</td>
      <td>${row.running}%</td>
    </tr>`;
  }).join('') + `<tr class="final-row">
    <td colspan="2"><strong>Final PD (bounded 1–60%)</strong></td>
    <td><strong>${pd}%</strong></td>
  </tr>`;

  resultsCard.classList.remove('hidden');
  resultsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── File helpers ─────────────────────────────────────────────────────────────
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result.split(',')[1]);
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

// ── Batch queue UI ────────────────────────────────────────────────────────────
let _batchFiles = [];

function showBatchQueue(files) {
  _batchFiles = files;
  const queueEl = document.getElementById('batchQueue');
  const filesEl = document.getElementById('batchFiles');
  const btn     = document.getElementById('batchProcessBtn');
  filesEl.innerHTML = files.map((f, i) =>
    `<span class="batch-file-chip" id="bchip-${i}" title="${f.name}">${f.name.replace(/\.pdf$/i,'')}</span>`
  ).join('');
  btn.textContent = `Process ${files.length} PDF${files.length > 1 ? 's' : ''}`;
  queueEl.classList.remove('hidden');
}

function hideBatchQueue() {
  document.getElementById('batchQueue').classList.add('hidden');
  _batchFiles = [];
}

function setChipState(idx, state) {
  const chip = document.getElementById(`bchip-${idx}`);
  if (chip) chip.className = `batch-file-chip ${state}`;
}

// ── Dispatch uploads ──────────────────────────────────────────────────────────
function dispatchFiles(files) {
  const pdfs = Array.from(files).filter(f => f.type === 'application/pdf').slice(0, 6);
  if (!pdfs.length) { setStatus('Please upload PDF files only.', 'error'); return; }
  if (pdfs.length === 1) {
    hideBatchQueue();
    handleSingleFile(pdfs[0]);
  } else {
    showBatchQueue(pdfs);
  }
}

// ── Single-file upload → show editable form ───────────────────────────────────
async function handleSingleFile(file) {
  setStatus('Extracting data from PDF…', 'info', true);
  resultsCard.classList.add('hidden');
  try {
    const base64 = await readFileAsBase64(file);
    const res = await fetch('/api/loan-extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_base64: base64 })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || `HTTP ${res.status}`); }
    const { extracted } = await res.json();
    clearStatus();
    populateForm(extracted);
    fieldsCard.classList.remove('hidden');
    fieldsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus(`Extraction failed: ${err.message}`, 'error');
  }
}

// ── Batch processing → auto extract + score + analyze all ────────────────────
async function processBatch(files) {
  resultsCard.classList.add('hidden');
  document.getElementById('aiInsights').classList.add('hidden');
  let done = 0;
  setStatus(`Processing ${files.length} PDFs…`, 'info', true);

  await Promise.allSettled(files.map(async (file, idx) => {
    setChipState(idx, 'processing');
    try {
      const base64 = await readFileAsBase64(file);

      const extractRes = await fetch('/api/loan-extract', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf_base64: base64 })
      });
      if (!extractRes.ok) { const e = await extractRes.json(); throw new Error(e.error); }
      const { extracted } = await extractRes.json();

      const scoreRes = await fetch('/api/loan-score', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: extracted })
      });
      if (!scoreRes.ok) { const e = await scoreRes.json(); throw new Error(e.error); }
      const scoreData = await scoreRes.json();

      const name = extracted.applicant_name || file.name.replace(/\.pdf$/i, '');
      const histIdx = addHistoryRow(extracted, scoreData, name);
      runAIAnalysis(extracted, scoreData, histIdx);

      done++;
      setStatus(`Scored ${done}/${files.length}…`, 'info', true);
      setChipState(idx, 'done');
    } catch (err) {
      setChipState(idx, 'error');
      console.error(`[${file.name}]`, err.message);
    }
  }));

  clearStatus();
  setStatus(`✓ ${done}/${files.length} PDFs scored — AI analysis running below`, 'success');
  document.getElementById('historySection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Legacy alias used by single-file path before refactor
async function handleFile(file) { await handleSingleFile(file); }

// ── AI analysis ──────────────────────────────────────────────────────────────
function renderAISection(title, items, cls) {
  if (!items?.length) return '';
  return `<div class="ai-section ${cls}">
    <h5>${title}</h5>
    <ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>
  </div>`;
}

async function runAIAnalysis(fields, pdResult, histIdx) {
  const aiInsights = document.getElementById('aiInsights');
  const aiLoading  = document.getElementById('aiLoading');
  const aiContent  = document.getElementById('aiContent');
  const aiError    = document.getElementById('aiError');

  aiInsights.classList.remove('hidden');
  aiLoading.classList.remove('hidden');
  aiContent.classList.add('hidden');
  aiError.classList.add('hidden');

  const t0 = Date.now();
  try {
    const res = await fetch('/api/loan-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields, pd_result: pdResult })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const analysis = await res.json();
    const elapsed = Date.now() - t0;
    const tokens = analysis._usage
      ? (analysis._usage.input_tokens + analysis._usage.output_tokens)
      : null;

    // Headline
    document.getElementById('aiHeadline').textContent = analysis.headline_assessment || '';

    // Recommendation badge
    const badge = document.getElementById('aiBadge');
    const recMap = {
      'APPROVE':                 ['rec-approve',   'Approve'],
      'APPROVE WITH CONDITIONS': ['rec-approve-c', 'Approve w/ Conditions'],
      'REFER FOR REVIEW':        ['rec-refer',     'Refer for Review'],
      'DECLINE':                 ['rec-decline',   'Decline'],
    };
    const [cls, label] = recMap[analysis.recommendation] || ['rec-refer', analysis.recommendation || '?'];
    badge.className = `rec-badge ${cls}`;
    badge.textContent = label;
    badge.classList.remove('hidden');

    // Sections
    document.getElementById('aiSections').innerHTML =
      renderAISection('Additional Risks',      analysis.hidden_risks,        'risks')    +
      renderAISection('Compounding Effects',   analysis.compounding_factors, 'compounds') +
      renderAISection('Mitigating Factors',    analysis.mitigating_factors,  'positive');

    // Rec note
    const recNote = document.getElementById('aiRecNote');
    if (analysis.recommendation_note) {
      recNote.textContent = analysis.recommendation_note;
      recNote.classList.remove('hidden');
    } else {
      recNote.classList.add('hidden');
    }

    // Claude PD strip
    if (analysis.claude_pd != null) {
      const numEl = document.getElementById('claudePdNum');
      numEl.textContent = `${analysis.claude_pd}%`;
      numEl.className   = `claude-pd-num ${pdClass(analysis.claude_pd)}`;
      document.getElementById('claudePdReason').textContent = analysis.claude_pd_reasoning || '';
      document.getElementById('claudePdStrip').classList.remove('hidden');
    } else {
      document.getElementById('claudePdStrip').classList.add('hidden');
    }

    aiLoading.classList.add('hidden');
    aiContent.classList.remove('hidden');
    if (histIdx !== undefined) updateHistoryRowAI(histIdx, analysis, tokens, elapsed);
  } catch (err) {
    aiLoading.classList.add('hidden');
    aiError.textContent = `AI analysis unavailable: ${err.message}`;
    aiError.classList.remove('hidden');
    if (histIdx !== undefined) updateHistoryRowAI(histIdx, null, null, null);
  }
}

// ── Score button ─────────────────────────────────────────────────────────────
scoreBtn.addEventListener('click', async () => {
  const fields = readFields();
  scoreBtn.disabled = true;
  scoreBtn.innerHTML = '<span class="spinner-inline"></span>Calculating…';

  // Reset AI panel
  document.getElementById('aiInsights').classList.add('hidden');
  document.getElementById('aiBadge').classList.add('hidden');

  try {
    const res = await fetch('/api/loan-score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    showResults(data);
    const histIdx = addHistoryRow(fields, data);
    // Fire AI analysis without blocking — results populate when ready
    runAIAnalysis(fields, data, histIdx);
  } catch (err) {
    setStatus(`Scoring failed: ${err.message}`, 'error');
  } finally {
    scoreBtn.disabled = false;
    scoreBtn.textContent = 'Calculate PD →';
  }
});

// ── Recalculate button ───────────────────────────────────────────────────────
document.getElementById('recalcBtn').addEventListener('click', () => {
  resultsCard.classList.add('hidden');
  fieldsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ── File input & drag-drop ───────────────────────────────────────────────────
document.getElementById('browseBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => { if (e.target.files.length) dispatchFiles(e.target.files); fileInput.value = ''; });

uploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) dispatchFiles(e.dataTransfer.files);
});

document.getElementById('batchProcessBtn').addEventListener('click', () => {
  hideBatchQueue();
  processBatch(_batchFiles);
});

// ── Manual entry ─────────────────────────────────────────────────────────────
document.getElementById('manualBtn').addEventListener('click', () => {
  renderNarrativeFactors({});
  fieldsCard.classList.remove('hidden');
  resultsCard.classList.add('hidden');
  fieldsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ── History ──────────────────────────────────────────────────────────────────
const HISTORY_KEY = 'loan_scorer_history';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}
function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function pdClass(pd) {
  return pd < 8 ? 'pd-low' : pd < 15 ? 'pd-moderate' : pd < 25 ? 'pd-elevated' : pd < 40 ? 'pd-high' : 'pd-critical';
}
function pdLabel(pd) {
  return pd < 8 ? 'Low' : pd < 15 ? 'Moderate' : pd < 25 ? 'Elevated' : pd < 40 ? 'High Risk' : 'Very High';
}

const REC_MAP = {
  'APPROVE':                 ['rec-approve',   'Approve'],
  'APPROVE WITH CONDITIONS': ['rec-approve-c', 'Approve w/ Cond.'],
  'REFER FOR REVIEW':        ['rec-refer',     'Refer'],
  'DECLINE':                 ['rec-decline',   'Decline'],
};

function renderHistoryTable() {
  const history = loadHistory();
  const section = document.getElementById('historySection');
  const tbody   = document.getElementById('historyBody');

  if (!history.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  tbody.innerHTML = history.map((row, i) => {
    const cls = pdClass(row.pd);
    const narrativeStr = (row.narrative_factors || []).map(f => f.factor).join(', ') || '—';
    const ltiStr = row.lti != null ? row.lti + '%' : '—';
    const incStr = row.annual_income ? '$' + Number(row.annual_income).toLocaleString() : '—';
    const loanStr = row.loan_amount  ? '$' + Number(row.loan_amount).toLocaleString()  : '—';

    let claudePdCell = '<span class="hist-pending">…</span>';
    let recCell = '<span class="hist-pending">…</span>';
    let summaryCell = '<span class="hist-pending">Analyzing…</span>';
    if (row.ai) {
      const [recCls, recLabel] = REC_MAP[row.ai.recommendation] || ['rec-refer', row.ai.recommendation || '?'];
      recCell = `<span class="hist-rec ${recCls}">${recLabel}</span>`;
      summaryCell = `<span class="hist-summary">${row.ai.headline_assessment || '—'}</span>`;
      if (row.ai.claude_pd != null) {
        const cpc = pdClass(row.ai.claude_pd);
        claudePdCell = `<span class="hist-pd ${cpc}">${row.ai.claude_pd}%</span>`;
      } else {
        claudePdCell = '<span class="hist-pending">—</span>';
      }
    } else if (row.ai === null) {
      claudePdCell = '<span class="hist-pending">—</span>';
      recCell = '<span class="hist-pending">—</span>';
      summaryCell = '<span class="hist-pending">Unavailable</span>';
    }

    return `<tr data-idx="${i}">
      <td>${history.length - i}</td>
      <td>${row.name || '—'}</td>
      <td>${row.credit_score ?? '—'}</td>
      <td>${row.dti_ratio != null ? row.dti_ratio + '%' : '—'}</td>
      <td>${row.employment_type ? row.employment_type + (row.employment_years ? ', ' + row.employment_years + 'yr' : '') : '—'}</td>
      <td>${incStr}</td>
      <td>${loanStr}</td>
      <td>${ltiStr}</td>
      <td style="white-space:normal;max-width:150px">${narrativeStr}</td>
      <td><span class="hist-pd ${cls}">${row.pd}%</span></td>
      <td>${row.pd_lti_weighted != null ? `<span class="hist-pd ${pdClass(row.pd_lti_weighted)}">${row.pd_lti_weighted}%</span>` : '—'}</td>
      <td>${claudePdCell}</td>
      <td><span class="hist-risk ${cls}">${pdLabel(row.pd)}</span></td>
      <td>${recCell}</td>
      <td>${summaryCell}</td>
      <td style="color:var(--muted);font-size:.75rem;text-align:right">${
        row.tokens != null ? Number(row.tokens).toLocaleString()
        : row.ai === undefined ? '<span class="hist-pending">…</span>' : '—'
      }</td>
      <td style="color:var(--muted);font-size:.75rem;text-align:right">${
        row.elapsed_ms != null ? (row.elapsed_ms / 1000).toFixed(1) + 's'
        : row.ai === undefined ? '<span class="hist-pending">…</span>' : '—'
      }</td>
      <td style="color:var(--muted);font-size:.68rem">${row.time || ''}</td>
    </tr>`;
  }).join('');
}

function addHistoryRow(fields, pdResult, nameOverride) {
  const history = loadHistory();
  const entry = {
    name:             nameOverride || document.getElementById('applicantName').textContent.trim() || 'Manual entry',
    credit_score:     fields.credit_score,
    dti_ratio:        fields.dti_ratio,
    employment_type:  fields.employment_type,
    employment_years: fields.employment_years,
    annual_income:    fields.annual_income,
    loan_amount:      fields.loan_amount,
    lti:              pdResult.lti,
    narrative_factors: fields.narrative_factors,
    pd:               pdResult.pd,
    pd_lti_weighted:  pdResult.pd_lti_weighted,
    ai:               undefined,   // pending
    time:             new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
  history.unshift(entry);
  saveHistory(history);
  renderHistoryTable();
  return 0; // index into history array (newest is always 0)
}

function updateHistoryRowAI(idx, analysis, tokens, elapsed_ms) {
  const history = loadHistory();
  if (history[idx] !== undefined) {
    history[idx].ai = analysis;   // null means failed
    history[idx].tokens = tokens;
    history[idx].elapsed_ms = elapsed_ms;
    saveHistory(history);
    renderHistoryTable();
  }
}

// Patch score button to also record history
const _origScoreClick = scoreBtn.onclick;
scoreBtn.addEventListener('click', () => {}, false); // history is wired inside the existing handler below

// ── Clear history ─────────────────────────────────────────────────────────────
document.getElementById('clearHistoryBtn').addEventListener('click', () => {
  if (confirm('Clear all run history?')) {
    localStorage.removeItem(HISTORY_KEY);
    renderHistoryTable();
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────
renderNarrativeFactors({});
renderHistoryTable();
