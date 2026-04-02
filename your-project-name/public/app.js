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

function renderCategory(cat) {
  currentCat = cat;
  $$('.inner-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === cat));

  const items = (digestData?.[cat]) || [];
  const panel = $('#newsPanel');

  if (!items.length) {
    panel.innerHTML = '<p style="color:var(--muted);font-size:.88rem;padding:8px 0">No items in this category.</p>';
    return;
  }

  panel.innerHTML = items.map((item, i) => {
    const url = sourceMap[item.source];
    const badge = url
      ? `<a class="badge badge-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(item.source)}</a>`
      : `<span class="badge">${esc(item.source)}</span>`;
    return `
    <div class="news-item">
      <span class="news-num">${String(i + 1).padStart(2, '0')}</span>
      <div class="news-body">
        <span class="news-headline">${esc(item.headline)}</span>
        ${item.description ? `<span class="news-desc">${esc(item.description)}</span>` : ''}
      </div>
      ${badge}
    </div>`;
  }).join('');
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ── Inner tab switching ── */
$$('.inner-tab').forEach(btn => {
  btn.addEventListener('click', () => renderCategory(btn.dataset.cat));
});

/* ── Refresh button (reload cache from server) ── */
$('#refreshBtn').addEventListener('click', async () => {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Loading…';
  try {
    const data = await fetch('/last-run').then(r => r.json());
    if (data) {
      renderDigest(data);
      showStatus('Digest loaded from cache.', 'success');
      setTimeout(hideStatus, 3000);
    } else {
      showStatus('No digest found — ask Claude to run it first.', 'info');
    }
  } catch (e) {
    showStatus(`Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
  }
});

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

/* ── Init ── */
(async () => {
  await loadSources();   // build sourceMap first
  await loadLastRun();   // then render digest (badges will have URLs)
  await loadInboxStatus(); // show inbox sync badge in chat tab
})();
