/* ── Utility ── */
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

/* ── State ── */
let digestData = null;
let currentCat = 'top_today';
let chatHistory = [];
let sourceMap = {}; // name → url

/* ── Top-level tab switching ── */
$$('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-content').forEach(s => { s.classList.add('hidden'); s.classList.remove('active'); });
    btn.classList.add('active');
    const section = $(`#tab-${btn.dataset.tab}`);
    section.classList.remove('hidden');
    section.classList.add('active');
  });
});

/* ── Status bar ── */
function showStatus(msg, type = 'info') {
  const bar = $('#runStatus');
  bar.textContent = msg;
  bar.className = `status-bar ${type}`;
}
function hideStatus() { $('#runStatus').className = 'status-bar hidden'; }

/* ── Digest rendering ── */
const CAT_LABELS = {
  top_today:        "Today's Top 10",
  tech:             'Tech',
  us_business:      'US Business',
  india_business:   'India Business',
  global_economies: 'Global Economies',
  politics:         'Politics',
  everything_else:  'Everything Else',
};

function renderDigest(data) {
  digestData = data;
  $('#howToRun').classList.add('hidden');
  $('#digestArea').classList.remove('hidden');

  const date = data.date || '—';
  $('#digestTitle').textContent = `Newsletter Digest — ${date}`;
  const ran = data.ranAt
    ? new Date(data.ranAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  $('#digestMeta').textContent = ran ? `Last updated: ${ran}` : '';

  renderCategory(currentCat);
}

/* ── Card Deck ── */
let deckItems   = [];
let deckIndex   = 0;
let readTimer   = null;
let readSeconds = 0;
const READ_THRESHOLD = 5;

function renderCategory(cat) {
  currentCat = cat;
  $$('.inner-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === cat));
  deckItems = (digestData?.[cat]) || [];
  deckIndex = 0;
  renderDeck();
}

function renderDeck() {
  clearReadTimer();
  const panel = $('#newsPanel');

  if (!deckItems.length) {
    panel.innerHTML = '<p style="color:var(--muted);font-size:.88rem;padding:8px 0">No items in this category.</p>';
    return;
  }

  if (deckIndex >= deckItems.length) {
    panel.innerHTML = `<div class="deck-done"><p>You've read all ${deckItems.length} stories in this section.</p></div>`;
    return;
  }

  // Build stack: show current + up to 2 behind
  const stackHtml = deckItems.slice(deckIndex, deckIndex + 3).map((item, offset) => {
    const isActive = offset === 0;
    const url      = sourceMap[item.source];
    const badge    = url
      ? `<a class="badge badge-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(item.source)}</a>`
      : `<span class="badge">${esc(item.source)}</span>`;
    return `
    <div class="deck-card ${isActive ? 'deck-active' : ''}" style="--offset:${offset}">
      <div class="deck-card-inner">
        <div class="deck-progress-bar"><div class="deck-progress-fill" id="deckProgress"></div></div>
        <span class="deck-counter">${deckIndex + 1} / ${deckItems.length}</span>
        ${item.image ? `<img class="deck-image" src="${esc(item.image)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}
        <div class="deck-headline">${esc(item.headline)}</div>
        ${item.description ? `<div class="deck-desc">${esc(item.description)}</div>` : ''}
        <div class="deck-footer">
          ${badge}
          <div class="deck-actions">
            <button class="deck-btn deck-skip" title="Skip">→</button>
          </div>
        </div>
      </div>
    </div>`;
  }).reverse().join('');

  panel.innerHTML = `<div class="deck-stack">${stackHtml}</div>`;

  // Swipe handling
  const card = panel.querySelector('.deck-active');
  if (card) {
    setupSwipe(card);
    startReadTimer();
  }

  panel.querySelector('.deck-skip')?.addEventListener('click', () => advanceDeck(false));
}

function startReadTimer() {
  readSeconds = 0;
  readTimer   = setInterval(() => {
    readSeconds++;
    if (readSeconds >= READ_THRESHOLD) {
      clearReadTimer();
      markCurrentRead(false);
    }
  }, 1000);
}

function clearReadTimer() {
  if (readTimer) { clearInterval(readTimer); readTimer = null; }
}

function markCurrentRead() {
  const item = deckItems[deckIndex];
  if (!item) return;
  // Fire-and-forget to Supabase, no UI change, no auto-advance
  fetch('/api/mark-read', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      headline:         item.headline,
      cluster_keywords: item.keywords || [],
      category:         currentCat,
      source:           item.source,
    }),
  }).catch(() => {});
}

function advanceDeck(wasRead) {
  clearReadTimer();
  const card = $('#newsPanel .deck-active');
  if (card) {
    card.classList.add(wasRead ? 'deck-exit-read' : 'deck-exit-skip');
    setTimeout(() => { deckIndex++; renderDeck(); }, 250);
  } else {
    deckIndex++;
    renderDeck();
  }
}

function setupSwipe(card) {
  let startX = 0;
  const onStart = e => { startX = (e.touches?.[0] || e).clientX; };
  const onEnd   = e => {
    const dx = (e.changedTouches?.[0] || e).clientX - startX;
    if (Math.abs(dx) > 60) advanceDeck(dx > 0);
  };
  card.addEventListener('touchstart', onStart, { passive: true });
  card.addEventListener('touchend',   onEnd,   { passive: true });
  card.addEventListener('mousedown',  onStart);
  card.addEventListener('mouseup',    onEnd);
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ── Inner tab switching ── */
$$('.inner-tab').forEach(btn => {
  btn.addEventListener('click', () => renderCategory(btn.dataset.cat));
});

/* ── Refresh button (reload cache from server) ── */
$('#refreshBtn').addEventListener('click', () => {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating…';
  showStatus('Connecting…', 'info');

  const es = new EventSource('/api/cron/digest');

  es.addEventListener('status', e => {
    const { message } = JSON.parse(e.data);
    showStatus(message, 'info');
  });

  es.addEventListener('done', e => {
    const digest = JSON.parse(e.data);
    renderDigest(digest);
    showStatus('Digest updated!', 'success');
    setTimeout(hideStatus, 3000);
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
    es.close();
  });

  es.addEventListener('error', e => {
    try {
      const { error } = JSON.parse(e.data);
      showStatus(`Error: ${error}`, 'error');
    } catch {
      showStatus('Something went wrong', 'error');
    }
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
    es.close();
  });

  es.onerror = () => {
    es.close();
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
  };
});

/* ── Model picker (Settings tab) ── */
async function loadModel() {
  const s = await fetch('/api/settings').then(r => r.json()).catch(() => ({ model: 'qwen-turbo' }));
  const picker = $('#modelPicker');
  if (picker) picker.value = s.model;
}

const modelPicker = $('#modelPicker');
if (modelPicker) {
  modelPicker.addEventListener('change', async () => {
    const model = modelPicker.value;
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    const status = $('#modelSaveStatus');
    if (status) { status.textContent = `Saved — next digest will use ${modelPicker.options[modelPicker.selectedIndex].text}`; setTimeout(() => { status.textContent = ''; }, 3000); }
  });
}

/* ── Load last run on startup ── */
async function loadLastRun() {
  const data = await fetch('/last-run').then(r => r.json()).catch(() => null);
  if (data) {
    renderDigest(data);
  } else {
    $('#howToRun').classList.remove('hidden');
  }
}

/* ── Sources ── */
async function loadSources() {
  const sources = await fetch('/sources').then(r => r.json());
  renderSources(sources);
}

function renderSources(sources) {
  // rebuild sourceMap whenever sources are rendered
  // badge links → Gmail search for that sender; fallback to website
  sourceMap = {};
  sources.forEach(s => {
    if (s.name) {
      // search by FW: + source name to handle forwarded newsletters
      sourceMap[s.name] = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent('subject:FW ' + s.name)}`;
    } else if (s.url) {
      sourceMap[s.name] = s.url;
    }
  });

  $('#sourceList').innerHTML = sources.map(s => `
    <li class="source-item" data-id="${s.id}">
      <div class="source-info">
        <span class="source-name ${s.enabled ? '' : 'disabled'}">${esc(s.name)}</span>
        <span class="source-email">${s.email ? esc(s.email) : '<span style="color:#f59e0b">⚠ No sender email</span>'}</span>
        ${s.url ? `<a class="source-url" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : ''}
      </div>
      <div class="toggle-wrap">
        <span class="toggle-label">${s.enabled ? 'On' : 'Off'}</span>
        <label class="toggle">
          <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="toggleSource(${s.id}, this.checked)" />
          <span class="slider"></span>
        </label>
      </div>
      <button class="btn-danger" onclick="deleteSource(${s.id})">Remove</button>
    </li>
  `).join('');
}

window.toggleSource = async (id, enabled) => {
  await fetch(`/sources/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  loadSources();
};

window.deleteSource = async (id) => {
  if (!confirm('Remove this source?')) return;
  await fetch(`/sources/${id}`, { method: 'DELETE' });
  loadSources();
};

$('#addSourceBtn').addEventListener('click', async () => {
  const nameInput = $('#newSourceInput');
  const emailInput = $('#newSourceEmail');
  const urlInput = $('#newSourceUrl');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  await fetch('/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email: emailInput.value.trim(), url: urlInput.value.trim() }),
  });
  nameInput.value = '';
  emailInput.value = '';
  urlInput.value = '';
  loadSources();
});

$('#newSourceInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#newSourceEmail').focus();
});
$('#newSourceEmail').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#newSourceUrl').focus();
});
$('#newSourceUrl').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#addSourceBtn').click();
});

/* ── Chat ── */
function appendMsg(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'assistant' && typeof marked !== 'undefined') {
    div.innerHTML = marked.parse(text);
  } else {
    div.textContent = text;
  }
  $('#chatMessages').appendChild(div);
  $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
}

$('#chatSend').addEventListener('click', sendChat);
$('#chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

async function sendChat() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendMsg('user', text);
  chatHistory.push({ role: 'user', content: text });

  const btn = $('#chatSend');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    appendMsg('assistant', data.reply);
    chatHistory.push({ role: 'assistant', content: data.reply });
  } catch (e) {
    appendMsg('assistant', `⚠️ ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

/* ── Inbox sync status ── */
async function loadInboxStatus() {
  const info = await fetch('/last-inbox').then(r => r.json()).catch(() => null);
  if (info?.fetchedAt) {
    const ago = new Date(info.fetchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    $('#inboxSyncLabel').textContent = `${info.count} emails synced · ${ago}`;
    $('#inboxSyncBadge').classList.remove('hidden');
  }
}

/* ── Read Map tab ── */
async function loadReadMap() {
  const el   = $('#readMapList');
  el.innerHTML = '<p style="color:var(--muted);font-size:.88rem">Loading…</p>';
  const data = await fetch('/api/read-history').then(r => r.json()).catch(() => null);
  if (!data?.length) {
    el.innerHTML = '<p style="color:var(--muted);font-size:.88rem">Nothing read yet today — swipe through stories to build your map.</p>';
    return;
  }

  const catLabel = {
    top_today: 'Top Stories', tech: 'Tech', us_business: 'US Business',
    india_business: 'India Business', global_economies: 'Global Economies',
    politics: 'Politics', everything_else: 'Everything Else',
  };

  // Group by category
  const groups = {};
  for (const row of data) {
    const key = row.category || 'everything_else';
    if (!groups[key]) groups[key] = { label: catLabel[key] || key, items: [] };
    groups[key].items.push(row);
  }

  el.innerHTML = Object.values(groups).map(g => `
    <div class="readmap-group">
      <div class="readmap-topic">${esc(g.label)}</div>
      ${g.items.map(row => `
        <div class="cluster-item">
          <div class="news-body">
            <span class="news-headline">${esc(row.headline)}</span>
            <span class="news-desc">${new Date(row.read_at).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
          </div>
        </div>`).join('')}
    </div>`).join('');
}

$('[data-tab="readmap"]').addEventListener('click', loadReadMap);

/* ── Init ── */
(async () => {
  await loadSources();
  await loadLastRun();
  await loadInboxStatus();
  await loadModel();
})();
