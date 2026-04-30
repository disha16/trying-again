/* ── Utility ── */
const $ = sel => document.querySelector(sel);

// ─── Source name prettifier ────────────────────────────────────────────────
// Turns "telegraphindia" into "Telegraph India", "newsvent" into "Newsvent",
// "wsj" stays "WSJ", known outlets get canonical names.
const SOURCE_OVERRIDES = {
  'wsj': 'WSJ', 'ft': 'FT', 'nyt': 'NYT', 'ap': 'AP', 'afp': 'AFP',
  'bbc': 'BBC', 'cnn': 'CNN', 'cnbc': 'CNBC', 'nbc': 'NBC', 'abc': 'ABC',
  'telegraphindia': 'Telegraph India',
  'moneycontrol': 'Moneycontrol',
  'livemint': 'Mint',
  'nikkei': 'Nikkei',
  'reuters': 'Reuters',
  'bloomberg': 'Bloomberg',
  'techcrunch': 'TechCrunch',
  'theverge': 'The Verge',
  'substack': 'Substack',
};
function prettifySource(s) {
  if (!s || typeof s !== 'string') return s || '';
  if (s.includes(',')) return s.split(',').map(prettifySource).join(', ');
  const raw = s.trim();
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (SOURCE_OVERRIDES[key]) return SOURCE_OVERRIDES[key];
  // If it's already Mixed Case (has a lowercase letter and uppercase letter), leave it alone
  if (/[a-z]/.test(raw) && /[A-Z]/.test(raw)) return raw;
  // Split ChamelCase or joinedlowercase: "telegraphindia" → "Telegraph India"
  return raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ─── Timezone + date/time formatting ────────────────────────────────────────
// Defaults to America/New_York (ET). Overridden by user Settings → Timezone.
let USER_TZ = localStorage.getItem('userTz') || 'America/New_York';
window.setUserTz = (tz) => { USER_TZ = tz || 'America/New_York'; try { localStorage.setItem('userTz', USER_TZ); } catch {} };
function fmtDT(dt, opts) {
  const d = dt instanceof Date ? dt : new Date(dt);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { timeZone: USER_TZ, ...(opts || {}) });
}
function tzAbbr() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: USER_TZ, timeZoneName: 'short' }).formatToParts(new Date());
    return (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
  } catch { return ''; }
}
function localDateKey(d) {
  const s = fmtDT(d, { year:'numeric', month:'2-digit', day:'2-digit' }); // "MM/DD/YYYY"
  const [mm, dd, yyyy] = s.split(/[/\-]/);
  return `${yyyy}-${mm}-${dd}`;
}
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
    // Refresh notebook data whenever the tab is opened
    if (btn.dataset.tab === 'notebook') loadNotebook();
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
  $('#digestTitle').innerHTML = `<em>today's digest</em> <span class="digest-date-label">— ${date}</span>`;
  const ran = data.ranAt ? fmtDT(data.ranAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  $('#digestMeta').textContent = ran ? `Last updated: ${ran} ${tzAbbr()}` : '';

  renderInnerTabs(data);
  renderCategory(currentCat);
}

// Build the section-tab strip dynamically so custom sections (e.g. Entertainment)
// show up alongside the defaults. Order: top_today → defaults present in data → custom sections.
const DEFAULT_TAB_ORDER = ['top_today', 'tech', 'us_business', 'india_business', 'global_economies', 'politics', 'everything_else'];
function renderInnerTabs(data) {
  const nav = document.querySelector('.inner-tabs');
  if (!nav) return;

  // Pull section metadata from settings (cached in app load):
  // - sectionLabels: id → label (for custom tab name display)
  // - disabledSections: set of ids that have been toggled off
  const settingsSections = window._settingsSections || [];
  const sectionLabels = settingsSections.reduce((m, s) => {
    if (s.id && s.label) m[s.id] = s.label;
    return m;
  }, {});
  const disabledSections = new Set(
    settingsSections.filter(s => s.enabled === false).map(s => s.id)
  );

  const presentDefaults = DEFAULT_TAB_ORDER.filter(k =>
    Array.isArray(data[k]) && data[k].length > 0 && !disabledSections.has(k)
  );
  // Always show top_today even if empty so it's a stable home tab
  if (!presentDefaults.includes('top_today')) presentDefaults.unshift('top_today');

  const customKeys = Object.keys(data)
    .filter(k => k.startsWith('custom_') && Array.isArray(data[k]) && data[k].length > 0 && !disabledSections.has(k));

  const allCats = [...presentDefaults, ...customKeys];
  // If currentCat no longer exists in this digest, fall back to top_today
  if (!allCats.includes(currentCat)) currentCat = 'top_today';

  nav.innerHTML = allCats.map(cat => {
    // For custom sections, prefer the saved label from settings over the raw key
    const label = CAT_LABELS[cat] || sectionLabels[cat] || cat.replace(/^custom_\d+$/, 'Custom').replace(/_/g, ' ');
    const active = cat === currentCat ? ' active' : '';
    return `<button class="inner-tab${active}" data-cat="${cat}">${label.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</button>`;
  }).join('');
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
  renderTopics(digestData?.[cat] || []);
  if (cat === 'top_today') {
    renderTopicClusters(digestData?.topic_clusters || []);
    loadChartsOfDay();
    renderThoughtLeadership(digestData?.thought_leadership || []);
  } else {
    $('#topicClusters').classList.add('hidden');
    $('#chartsOfDay').classList.add('hidden');
    $('#thoughtLeadership')?.classList.add('hidden');
  }
}

/* ── Thought Leadership deck (tinder-card TL;DRs from Substacks) ── */
function renderThoughtLeadership(cards) {
  const block = $('#thoughtLeadership');
  const deck  = $('#tlDeck');
  if (!block || !deck) return;
  if (!cards || !cards.length) { block.classList.add('hidden'); return; }
  block.classList.remove('hidden');
  deck.innerHTML = cards.map((c, i) => `
    <article class="tl-card" data-tl-id="${c.id}" data-idx="${i}">
      ${c.image ? `<div class="tl-img" style="background-image:url('${c.image}')"></div>` : ''}
      <div class="tl-body">
        <div class="tl-source">${c.source}</div>
        <h3 class="tl-headline">${c.title}</h3>
        <p class="tl-tldr">${c.tldr}</p>
        ${Array.isArray(c.keyPoints) && c.keyPoints.length ? `<ul class="tl-points">${c.keyPoints.map(p => `<li>${p}</li>`).join('')}</ul>` : ''}
        <div class="tl-actions">
          <button class="tl-done" data-id="${c.id}">Mark read</button>
          <span class="tl-meta">∼ ${c.readingMinutes || 1} min</span>
        </div>
      </div>
    </article>
  `).join('');
  deck.querySelectorAll('.tl-done').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      try {
        await fetch('/api/mark-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headline: id, category: 'thought_leadership', source: 'thought_leadership' }),
        });
      } catch {}
      const card = e.currentTarget.closest('.tl-card');
      card?.classList.add('tl-card-read');
      setTimeout(() => card?.remove(), 300);
    });
  });
}

/* ── Topics block ── */
let activeTopicFilter = null;

function renderTopics(items) {
  const block = $('#topicsBlock');
  const chipsEl = $('#topicChips');
  const storiesEl = $('#topicStories');
  if (!items.length) { block.classList.add('hidden'); return; }

  // Collect unique keywords across all items in category
  const freq = {};
  for (const item of items) {
    for (const kw of (item.keywords || [])) {
      freq[kw] = (freq[kw] || 0) + 1;
    }
  }
  const topics = Object.entries(freq).sort((a,b) => b[1]-a[1]).map(([kw]) => kw);
  if (!topics.length) { block.classList.add('hidden'); return; }

  activeTopicFilter = null;
  block.classList.remove('hidden');
  storiesEl.classList.add('hidden');

  chipsEl.innerHTML = topics.map(t =>
    `<button class="topic-chip" data-topic="${esc(t)}">${esc(t)}</button>`
  ).join('');

  chipsEl.querySelectorAll('.topic-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const topic = btn.dataset.topic;
      if (activeTopicFilter === topic) {
        activeTopicFilter = null;
        chipsEl.querySelectorAll('.topic-chip').forEach(b => b.classList.remove('active'));
        storiesEl.classList.add('hidden');
        return;
      }
      activeTopicFilter = topic;
      chipsEl.querySelectorAll('.topic-chip').forEach(b => b.classList.toggle('active', b.dataset.topic === topic));
      const filtered = items.filter(i => (i.keywords || []).includes(topic));
      storiesEl.innerHTML = filtered.map(item => `
        <div class="topic-story-item">
          ${item.image ? `<img class="topic-story-img" src="${esc(item.image)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
          <div class="topic-story-text">
            <div class="topic-story-headline">${esc(item.headline)}</div>
            <div class="topic-story-source">${item.internetSource ? '🌐 ' : ''}${esc(item.source)}</div>
          </div>
        </div>`).join('');
      storiesEl.classList.remove('hidden');
    });
  });

  $('#topicsViewAll').onclick = () => {
    activeTopicFilter = null;
    chipsEl.querySelectorAll('.topic-chip').forEach(b => b.classList.remove('active'));
    storiesEl.classList.add('hidden');
  };
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
    const url      = item.internetSource ? item.sourceUrl : sourceMap[item.source];
    const srcName  = prettifySource(item.source);
    const badge    = url
      ? `<a class="badge badge-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(srcName)}</a>`
      : `<span class="badge">${esc(srcName)}</span>`;
    return `
    <div class="deck-card ${isActive ? 'deck-active' : ''}" style="--offset:${offset}">
      <div class="deck-card-inner">
        <div class="deck-feedback-top">
          <button class="deck-feedback-mini deck-up"   aria-label="Good story" title="Good story" data-vote="up">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.63-10.1-9.25C.17 8.82 1.9 5.5 5.1 5.5c1.94 0 3.48 1.04 4.4 2.55h1c.92-1.51 2.46-2.55 4.4-2.55 3.2 0 4.93 3.32 3.2 6.25C19.5 16.37 12 21 12 21z"/></svg>
          </button>
          <button class="deck-feedback-mini deck-down" aria-label="Not for me"  title="Not for me"  data-vote="down">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 21.35 10.2 19.72C5.1 15.14 1.5 11.94 1.5 8.05 1.5 5.11 3.82 3 6.7 3c1.67 0 3.28.78 4.3 2.02L12 6l1-.98C14.02 3.78 15.63 3 17.3 3c2.88 0 5.2 2.11 5.2 5.05 0 .57-.08 1.11-.22 1.63l-3.05-1.52-1.23 2.46 3.01 1.5c-.55.71-1.22 1.45-2 2.23-.35-.13-.72-.22-1.11-.22a3 3 0 0 0-2.9 2.27l-2.32-1.16 1.23-2.46-4.9-2.44-1.23 2.45 2.44 1.22-2.45 1.22 1.24 2.46 2.73-1.37a3 3 0 0 0 3.07 2.28c.25 0 .49-.03.72-.09L12 21.35z"/></svg>
          </button>
        </div>
        ${item.image ? `<img class="deck-image" src="${esc(item.image)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}
        <div class="deck-body">
          <span class="deck-counter">${deckIndex + 1} / ${deckItems.length}</span>
          <div class="deck-headline">${esc(item.headline)}</div>
          ${item.description ? `<div class="deck-desc">${esc(item.description)}</div>` : ''}
          ${item.context ? `<div class="deck-context">${esc(item.context)}</div>` : ''}
          <div class="deck-footer">
            ${badge}
            <div class="deck-actions">
              <button class="deck-btn deck-chat"     title="Ask about this story">💬</button>
              <button class="deck-btn deck-notebook" title="Add to notebook">📓</button>
              <button class="deck-btn deck-skip"     title="Skip">→</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }).reverse().join('');

  panel.innerHTML = `<div class="deck-stack">${stackHtml}</div>`;

  // Size the stack to fit the active card's content (no fixed height, no whitespace)
  const stack = panel.querySelector('.deck-stack');
  const activeCard = panel.querySelector('.deck-active');
  if (stack && activeCard) {
    const setHeight = () => { stack.style.height = activeCard.offsetHeight + 'px'; };
    requestAnimationFrame(setHeight);
    // Re-measure after the image (and any other deferred content) loads
    activeCard.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', setHeight, { once: true });
      img.addEventListener('error', setHeight, { once: true });
    });
    // And track any later layout changes (font load, lazy content, etc.)
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(setHeight);
      ro.observe(activeCard);
      // Disconnect when the panel changes so we don't leak
      stack._cleanup?.();
      stack._cleanup = () => ro.disconnect();
    }
  }

  // Swipe handling
  const card = panel.querySelector('.deck-active');
  if (card) {
    setupSwipe(card);
    startReadTimer();
  }

  panel.querySelector('.deck-active .deck-skip')?.addEventListener('click', () => advanceDeck(false));
  panel.querySelector('.deck-active .deck-chat')?.addEventListener('click', () => openChatFromCard(deckItems[deckIndex]));
  panel.querySelector('.deck-active .deck-notebook')?.addEventListener('click', () => openNotebookModal(deckItems[deckIndex]));
  panel.querySelectorAll('.deck-active .deck-feedback-mini').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = deckItems[deckIndex];
      if (!item) return;
      const vote = btn.dataset.vote;
      // Visual feedback — highlight the voted button
      panel.querySelectorAll('.deck-active .deck-feedback-mini').forEach(b => b.classList.remove('voted'));
      btn.classList.add('voted');
      const now = new Date();
      const dk = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headline: item.headline, category: currentCat, source: item.source, vote, dateKey: dk }),
      }).catch(() => {});
    });
  });
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

/* ── Topic deep-dive clusters ── */
const clusterState = new Map(); // clusterId -> { items, index }
let openClusterId  = null;

function renderTopicClusters(clusters) {
  const el = $('#topicClusters');
  if (!clusters?.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  clusterState.clear();
  openClusterId = null;

  el.innerHTML = `<div class="tc-title">Deep Dives</div>` +
    clusters.map((c, i) => {
      clusterState.set(i, { items: c.stories || [], index: 0, summary: c.summary || '' });
      const count = c.stories?.length ? `<span class="tc-count">${c.stories.length} angles</span>` : '';
      return `
        <div class="tc-row" id="tc-row-${i}">
          <button class="tc-header" data-ci="${i}">
            <span class="tc-name">${esc(c.topic)}</span>
            ${count}
            <span class="tc-chevron">›</span>
          </button>
          <div class="tc-deck-wrap" id="tc-wrap-${i}"></div>
        </div>`;
    }).join('');

  el.querySelectorAll('.tc-header').forEach(btn => {
    btn.addEventListener('click', () => toggleCluster(+btn.dataset.ci));
  });
}

function toggleCluster(i) {
  if (openClusterId === i) {
    // Close
    $(`#tc-wrap-${i}`).innerHTML = '';
    $(`#tc-row-${i} .tc-header`).classList.remove('tc-open');
    openClusterId = null;
    return;
  }
  // Close previously open
  if (openClusterId !== null) {
    $(`#tc-wrap-${openClusterId}`).innerHTML = '';
    $(`#tc-row-${openClusterId} .tc-header`)?.classList.remove('tc-open');
  }
  openClusterId = i;
  $(`#tc-row-${i} .tc-header`).classList.add('tc-open');
  renderMiniDeck(i);
}

function renderMiniDeck(clusterId) {
  const state = clusterState.get(clusterId);
  const wrap  = $(`#tc-wrap-${clusterId}`);
  if (!state || !wrap) return;
  const { items, index } = state;

  if (!items.length) {
    const st = clusterState.get(clusterId);
    const summary = st?.summary || '';
    wrap.innerHTML = summary
      ? `<div class="tc-summary-fallback">${esc(summary)}</div>`
      : '<p class="tc-empty">Angle search returned no results — try refreshing the digest.</p>';
    return;
  }
  if (index >= items.length) {
    wrap.innerHTML = '<p class="tc-empty">All caught up on this topic.</p>';
    return;
  }

  const stack = items.slice(index, index + 3).map((item, offset) => {
    const isActive = offset === 0;
    const srcName = prettifySource(item.source);
    const badge = item.sourceUrl
      ? `<a class="badge badge-link" href="${esc(item.sourceUrl)}" target="_blank" rel="noopener">${esc(srcName)}</a>`
      : `<span class="badge">${esc(srcName)}</span>`;
    return `
      <div class="mini-card ${isActive ? 'mini-active' : ''}" style="--offset:${offset}">
        <div class="mini-inner">
          ${item.image ? `<img class="mini-img" src="${esc(item.image)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}
          <div class="mini-body">
            <div class="mini-headline">${esc(item.headline)}</div>
            ${item.description ? `<div class="mini-desc">${esc(item.description)}</div>` : ''}
            <div class="mini-footer">
              <div class="mini-badges">${badge}</div>
              <button class="deck-btn mini-skip" title="Next">→</button>
            </div>
          </div>
        </div>
      </div>`;
  }).reverse().join('');

  wrap.innerHTML = `<div class="mini-stack" id="ms-${clusterId}">${stack}</div>`;

  // Auto-size stack height to active card (re-measure after image loads)
  const stackEl  = wrap.querySelector('.mini-stack');
  const activeEl = wrap.querySelector('.mini-active');
  if (stackEl && activeEl) {
    const setH = () => { stackEl.style.height = activeEl.offsetHeight + 'px'; };
    requestAnimationFrame(setH);
    activeEl.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', setH, { once: true });
      img.addEventListener('error', setH, { once: true });
    });
  }

  // Swipe + skip
  const card = wrap.querySelector('.mini-active');
  if (card) {
    let startX = 0;
    card.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
    card.addEventListener('touchend',   e => { if (Math.abs(e.changedTouches[0].clientX - startX) > 60) advanceMiniDeck(clusterId, true); }, { passive: true });
    card.addEventListener('mousedown',  e => { startX = e.clientX; });
    card.addEventListener('mouseup',    e => { if (Math.abs(e.clientX - startX) > 60) advanceMiniDeck(clusterId, true); });
  }
  wrap.querySelector('.mini-active .mini-skip')?.addEventListener('click', () => advanceMiniDeck(clusterId, false));
}

function advanceMiniDeck(clusterId, markRead) {
  const state = clusterState.get(clusterId);
  if (!state) return;
  const item = state.items[state.index];

  if (markRead && item) {
    fetch('/api/mark-read', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ headline: item.headline, cluster_keywords: item.keywords || [], category: 'topic_cluster', source: item.source }),
    }).catch(() => {});
  }

  const card = $(`#tc-wrap-${clusterId} .mini-active`);
  if (card) {
    card.classList.add(markRead ? 'deck-exit-read' : 'deck-exit-skip');
    setTimeout(() => { state.index++; renderMiniDeck(clusterId); }, 220);
  } else {
    state.index++;
    renderMiniDeck(clusterId);
  }
}

/* ── Inner tab switching — use event delegation so listener survives DOM swaps ── */
$('#tab-digest').addEventListener('click', e => {
  const btn = e.target.closest('.inner-tab');
  if (btn) renderCategory(btn.dataset.cat);
});

/* ── Refresh button (reload cache from server) ── */
$('#refreshBtn').addEventListener('click', () => {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating…';

  // Overlay breathing animation over digest area without destroying inner DOM
  const digestArea = $('#digestArea');
  digestArea.classList.add('hidden'); // hide content but keep DOM intact
  const breathOverlay = document.createElement('div');
  breathOverlay.id = 'breathStatus';
  breathOverlay.className = 'breath-status-wrap';
  digestArea.parentNode.insertBefore(breathOverlay, digestArea);
  showBreathing(breathOverlay);

  function restoreDigest() {
    stopBreathing();
    breathOverlay.remove();
    digestArea.classList.remove('hidden');
  }

  // EventSource can't send headers; pass secret as query param
  const _cronSecret = 'newsletter-digest-cron-2026';
  const es = new EventSource('/api/run-digest?force=true');

  es.addEventListener('status', e => {
    const { message } = JSON.parse(e.data);
    setBreathLabel(message);
  });

  es.addEventListener('done', e => {
    restoreDigest();
    const digest = JSON.parse(e.data);
    enrichDigestWithClusters(digest);
    renderDigest(digest);
    loadChartsOfDay();
    loadDateRolodex();
    showStatus('Digest updated!', 'success');
    setTimeout(hideStatus, 3000);
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
    es.close();
  });

  let gotServerError = false;
  es.addEventListener('error', e => {
    gotServerError = true;
    restoreDigest();
    try {
      const { error } = JSON.parse(e.data);
      showStatus(error || 'Something went wrong', 'error');
    } catch {
      showStatus('Something went wrong', 'error');
    }
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
    es.close();
  });

  es.onerror = () => {
    if (gotServerError) return;
    restoreDigest();
    es.close();
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
  };
});

/* ── Model pickers (Settings tab) ── */
const MODEL_PICKERS = [
  'clusterModelPicker',
  'digestModelPicker',
  'editorModelPicker',
  'chatModelPicker',
];

async function loadModel() {
  const s = await fetch('/api/settings').then(r => r.json()).catch(() => ({}));
  window._settingsSections = s.sections || []; // expose for renderInnerTabs labels
  for (const id of MODEL_PICKERS) {
    const picker = $(`#${id}`);
    if (!picker) continue;
    const key = picker.dataset.key;
    if (s[key]) picker.value = s[key];
  }
  const toggle = $('#internetFallbackToggle');
  if (toggle) toggle.checked = s.internetFallback !== false;
  const imgToggle = $('#showImagesToggle');
  if (imgToggle) imgToggle.checked = s.showImages !== false;
  applyImagesPreference(s.showImages !== false);
  const tzSel = $('#tzSelect');
  if (tzSel) {
    const serverTz = s.timezone || USER_TZ;
    tzSel.value = [...tzSel.options].some(o => o.value === serverTz) ? serverTz : 'America/New_York';
    window.setUserTz(tzSel.value);
  }
}

function showSaveStatus(text) {
  const el = $('#modelSaveStatus');
  if (!el) return;
  el.textContent = text;
  setTimeout(() => { el.textContent = ''; }, 2500);
}

for (const id of MODEL_PICKERS) {
  const picker = $(`#${id}`);
  if (!picker) continue;
  picker.addEventListener('change', async () => {
    const key   = picker.dataset.key;
    const label = picker.options[picker.selectedIndex].text.split(' —')[0];
    await fetch('/api/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ [key]: picker.value }),
    });
    showSaveStatus(`Saved — ${label}`);
  });
}

function applyImagesPreference(show) {
  document.documentElement.classList.toggle('hide-images', !show);
}
$('#showImagesToggle')?.addEventListener('change', async e => {
  const show = e.target.checked;
  applyImagesPreference(show);
  await fetch('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ showImages: show }),
  });
  showSaveStatus(show ? 'Images on' : 'Images & chart off');
});
$('#tzSelect')?.addEventListener('change', async e => {
  window.setUserTz(e.target.value);
  await fetch('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ timezone: e.target.value }),
  });
  if (digestData) renderDigest(digestData); // refresh timestamps in the UI
});
$('#internetFallbackToggle')?.addEventListener('change', async e => {
  await fetch('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ internetFallback: e.target.checked }),
  });
  showSaveStatus(e.target.checked ? 'Internet fallback on' : 'Internet fallback off');
});

/* ── Last run cache panel (Settings) ─────────────────────────────── */
async function loadCacheIndex() {
  const el = document.getElementById('cacheIndex');
  if (!el) return;
  try {
    const list = await fetch('/api/cache-index').then(r => r.json());
    if (!Array.isArray(list) || !list.length) { el.innerHTML = '<p class="meta">No cached digests yet.</p>'; return; }
    const rows = list.map(r => {
      const when = fmtDT(r.ranAt, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
      const badge = r.enriched
        ? '<span class="cache-badge cache-enriched">enriched</span>'
        : '<span class="cache-badge cache-core">core only</span>';
      return `<div class="cache-row"><div class="cache-date">${r.dateKey}</div><div class="cache-meta">cached ${when} ${badge}</div></div>`;
    }).join('');
    el.innerHTML = rows;
  } catch (e) {
    el.innerHTML = `<p class="meta" style="color:#b4635a">Could not load cache index: ${e.message}</p>`;
  }
}
// Refresh whenever the settings view is shown
document.addEventListener('click', e => {
  const tab = e.target.closest('[data-view="settings"]');
  if (tab) setTimeout(loadCacheIndex, 150);
});
// Also load once on boot so the data is fresh when the user opens settings
setTimeout(loadCacheIndex, 800);



/* ── Load last run on startup ── */
async function loadLastRun() {
  const data = await fetch('/last-run').then(r => r.json()).catch(() => null);
  if (data) {
    enrichDigestWithClusters(data);
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
        <span class="source-name ${s.enabled ? '' : 'disabled'}">${esc(s.name)}${s.kind === 'thought_leadership' ? ' <span class="src-kind-badge">TL</span>' : ''}</span>
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
  const kindInput = $('#newSourceKind');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  await fetch('/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      email: emailInput.value.trim(),
      url: urlInput.value.trim(),
      kind: kindInput?.value || 'newsletter',
    }),
  });
  nameInput.value = '';
  emailInput.value = '';
  urlInput.value = '';
  if (kindInput) kindInput.value = 'newsletter';
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

// Card context injected silently into chat history — not shown in the input box
let pendingCardContext = null;

function openChatFromCard(item) {
  // Switch to chat tab
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.tab-content').forEach(s => { s.classList.add('hidden'); s.classList.remove('active'); });
  const chatTab = document.querySelector('.tab[data-tab="chat"]');
  if (chatTab) chatTab.classList.add('active');
  const chatSection = $('#tab-chat');
  if (chatSection) { chatSection.classList.remove('hidden'); chatSection.classList.add('active'); }

  // Store story context to inject silently when user sends their message
  const parts = [`Context: I'm reading about "${item.headline}"`];
  if (item.source)      parts.push(`(${item.source})`);
  if (item.description) parts.push(`— ${item.description}`);
  if (item.context)     parts.push(`Background: ${item.context}`);
  pendingCardContext = parts.join(' ');

  const input = $('#chatInput');
  input.value = '';
  input.focus();
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

  // Prepend card context silently (not shown in UI) if coming from a card
  const content = pendingCardContext ? `${pendingCardContext}\n\nUser question: ${text}` : text;
  pendingCardContext = null;
  chatHistory.push({ role: 'user', content });

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
    const ago = fmtDT(info.fetchedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
            <span class="news-desc">${fmtDT(row.read_at, { hour: 'numeric', minute: '2-digit' })}</span>
          </div>
        </div>`).join('')}
    </div>`).join('');
}

$('[data-tab="settings"]').addEventListener('click', loadReadMap);

/* ── Clusters — used to enrich digest items with keywords + images ── */
let clusterData  = [];
let cachedImages = [];

async function loadClusters() {
  const [clusterRes, imageRes] = await Promise.all([
    fetch('/api/clusters').then(r => r.json()).catch(() => null),
    fetch('/api/images').then(r => r.json()).catch(() => null),
  ]);
  clusterData  = clusterRes?.clusters || [];
  cachedImages = imageRes?.urls || [];
}

function enrichDigestWithClusters(data) {
  if (!clusterData.length || !data) return;
  // Build maps keyed by headline for precise matching
  const headlineMap = {};
  for (const c of clusterData) {
    const key = (c.headline || '').toLowerCase().trim();
    if (key) headlineMap[key] = { image: c.image, keywords: c.keywords };
  }

  const CATS = ['top_today','tech','us_business','india_business','global_economies','politics','everything_else'];
  for (const cat of CATS) {
    for (const item of (data[cat] || [])) {
      const key = (item.headline || '').toLowerCase().trim();
      const match = headlineMap[key];
      if (match) {
        if (!item.image    && match.image)    item.image    = match.image;
        if (!item.keywords && match.keywords) item.keywords = match.keywords;
      }
    }
  }
}

/* ── Date rolodex ── */
async function loadDateRolodex() {
  const el = $('#dateRolodex');
  if (!el) return;
  const history = await fetch(`/api/digest-history?today=${localDateKey(new Date())}`).then(r => r.json()).catch(() => ({}));

  const todayKey = localDateKey(new Date());

  // Build last 14 days
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key       = localDateKey(d);
    const label     = i === 0 ? 'Today' : fmtDT(d, { month: 'short', day: 'numeric' });
    const hasDigest = !!history[key];
    const isToday   = i === 0;
    days.push({ key, label, hasDigest, isToday });
  }

  el.innerHTML = days.map(d => `
    <button class="dr-pill ${d.isToday ? 'dr-today dr-active' : ''} ${d.hasDigest ? 'dr-has' : 'dr-empty'}"
      data-date="${d.key}">
      ${d.label}
    </button>`).join('');

  // Scroll today into view
  requestAnimationFrame(() => {
    el.querySelector('.dr-today')?.scrollIntoView({ inline: 'end', block: 'nearest' });
  });

  el.querySelectorAll('.dr-pill').forEach(btn => {
    btn.addEventListener('click', async () => {
      el.querySelectorAll('.dr-pill').forEach(b => b.classList.remove('dr-active'));
      btn.classList.add('dr-active');
      const date = btn.dataset.date;
      if (date === todayKey) {
        await loadLastRun();
      } else {
        const data = await fetch(`/api/digest/${date}`).then(r => r.json()).catch(() => null);
        if (data && (data.top_today?.length || data.tech?.length)) {
          enrichDigestWithClusters(data);
          renderDigest(data);
        } else {
          // No digest for this date — show empty state in digest area
          digestData = null;
          const digestArea = $('#digestArea');
          if (digestArea) {
            digestArea.querySelector('#deckWrap').innerHTML = '';
            digestArea.querySelector('#topicsBlock')?.classList.add('hidden');
            digestArea.querySelector('#topicClusters')?.classList.add('hidden');
            digestArea.querySelector('#chartsOfDay')?.classList.add('hidden');
            const empty = digestArea.querySelector('#emptyState') || (() => {
              const d = document.createElement('div');
              d.id = 'emptyState';
              digestArea.appendChild(d);
              return d;
            })();
            empty.innerHTML = `<div class="dr-no-digest">No digest stored for ${btn.textContent.trim()}.<br><span>Hit Refresh to generate one.</span></div>`;
            empty.classList.remove('hidden');
          }
        }
      }
    });
  });
}

/* ── Breathing load animation ── */
const BREATH_MESSAGES = [
  'Sit back, this takes a minute ☕',
  'Good things take time…',
  'Scanning the world for you 🌍',
  'Relax — your digest is brewing',
  'Clustering the noise into signal…',
  'Almost there, hang tight ✨',
  'Reading so you don\'t have to 📰',
  'Finding what actually matters…',
];
let _breathMsgTimer = null;

function showBreathing(statusEl) {
  statusEl.innerHTML = `
    <div class="breath-wrap">
      <div class="breath-anim">
        <div class="breath-blob"></div>
        <div class="breath-blob b2"></div>
        <div class="breath-blob b3"></div>
      </div>
      <div class="breath-step" id="breathLabel">Starting…</div>
      <div class="breath-msg" id="breathMsg">${BREATH_MESSAGES[0]}</div>
    </div>`;

  // Rotate flavour messages every 8s (one full breath cycle)
  let mi = 0;
  _breathMsgTimer = setInterval(() => {
    mi = (mi + 1) % BREATH_MESSAGES.length;
    const el = $('#breathMsg');
    if (el) { el.style.opacity = 0; setTimeout(() => { el.textContent = BREATH_MESSAGES[mi]; el.style.opacity = 1; }, 300); }
  }, 8000);
}

function setBreathLabel(text) {
  const el = $('#breathLabel');
  if (el) el.textContent = text;
}

function stopBreathing() {
  if (_breathMsgTimer) { clearInterval(_breathMsgTimer); _breathMsgTimer = null; }
}

/* ── Notebook ── */
let notebookNotes    = [];
let nbPendingItem    = null;

async function loadNotebook() {
  notebookNotes = await fetch('/api/notes').then(r => r.json()).catch(() => []);
  renderNoteList();
}

function renderNoteList() {
  const el = $('#noteList');
  if (!el) return;
  if (!notebookNotes.length) {
    el.innerHTML = '<p class="meta" style="padding:24px 0">No notes yet. Add stories from the digest using the 📓 button on any card.</p>';
    return;
  }
  el.innerHTML = notebookNotes.map(note => `
    <div class="note-card" id="note-${note.id}">
      <div class="note-card-header">
        <span class="note-title" id="ntitle-${note.id}" contenteditable="true" data-id="${note.id}" spellcheck="false">${esc(note.title)}</span>
        <div class="note-header-actions">
          <button class="note-summarise-btn" data-id="${note.id}" title="Regenerate summary">✨ Summary</button>
          <button class="note-delete-btn" data-id="${note.id}" title="Delete note">✕</button>
        </div>
      </div>
      ${note.summary ? `<div class="note-summary">${esc(note.summary)}</div>` : ''}
      <div class="note-entries">
        ${note.entries.length ? note.entries.map(e => `
          <div class="note-entry" id="nentry-${e.id}">
            <div class="note-entry-headline">${esc(e.headline)}</div>
            <div class="note-entry-desc" contenteditable="true" data-nid="${note.id}" data-eid="${e.id}" spellcheck="false">${esc(e.description || '')}</div>
            <div class="note-entry-meta">${esc(e.source || '')} · ${new Date(e.addedAt).toLocaleDateString('en-US', {month:'short', day:'numeric'})}</div>
            <button class="note-entry-del" data-nid="${note.id}" data-eid="${e.id}" title="Remove">✕</button>
          </div>`).join('') : '<p class="note-empty">No entries yet.</p>'}
      </div>
      <div class="note-similar" data-note-id="${note.id}"></div>
    </div>`).join('');

  el.querySelectorAll('.note-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this note?')) return;
      await fetch(`/api/notes/${btn.dataset.id}`, { method: 'DELETE' });
      notebookNotes = notebookNotes.filter(n => n.id != btn.dataset.id);
      renderNoteList();
    });
  });

  el.querySelectorAll('.note-entry-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/notes/${btn.dataset.nid}/entries/${btn.dataset.eid}`, { method: 'DELETE' });
      const note = notebookNotes.find(n => n.id == btn.dataset.nid);
      if (note) note.entries = note.entries.filter(e => e.id != btn.dataset.eid);
      renderNoteList();
    });
  });

  // Editable note titles — save on blur
  el.querySelectorAll('.note-title[contenteditable]').forEach(span => {
    span.addEventListener('blur', async () => {
      const newTitle = span.textContent.trim();
      if (!newTitle) return;
      const note = notebookNotes.find(n => n.id == span.dataset.id);
      if (note && note.title !== newTitle) {
        note.title = newTitle;
        await fetch(`/api/notes/${span.dataset.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
      }
    });
    span.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); span.blur(); } });
  });

  // Editable entry descriptions — save on blur
  el.querySelectorAll('.note-entry-desc[contenteditable]').forEach(div => {
    div.addEventListener('blur', async () => {
      const text = div.textContent.trim();
      await fetch(`/api/notes/${div.dataset.nid}/entries/${div.dataset.eid}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: text }),
      });
      const note = notebookNotes.find(n => n.id == div.dataset.nid);
      if (note) { const e = note.entries.find(e => e.id == div.dataset.eid); if (e) e.description = text; }
    });
  });

  // Load similar stories for each note
  el.querySelectorAll('.note-card').forEach(card => {
    const noteId = +card.id.replace('note-', '');
    const note   = notebookNotes.find(n => n.id === noteId);
    if (note) loadNoteSimilar(note, card.querySelector('.note-similar'));
  });

  el.querySelectorAll('.note-summarise-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '…';
      btn.disabled = true;
      try {
        const r = await fetch(`/api/notes/${btn.dataset.id}/summary`, { method: 'POST' });
        const d = await r.json();
        if (d.summary) {
          const note = notebookNotes.find(n => n.id == btn.dataset.id);
          if (note) note.summary = d.summary;
          renderNoteList();
        }
      } finally { btn.textContent = '✨ Summary'; btn.disabled = false; }
    });
  });
}

// Per-note similar story state (survives re-renders via sessionStorage key)
const noteSeenHeadlines = {};

async function loadNoteSimilar(note, containerEl) {
  if (!containerEl) return;
  const key   = `nseen_${note.id}`;
  const seen  = JSON.parse(sessionStorage.getItem(key) || '[]');
  noteSeenHeadlines[note.id] = new Set(seen);

  const res = await fetch(`/api/notes/${note.id}/similar`).catch(() => null);
  if (!res?.ok) { containerEl.innerHTML = ''; return; }
  const { stories } = await res.json();
  if (!stories?.length) { containerEl.innerHTML = ''; return; }

  // Filter already-seen
  const fresh = stories.filter(s => !noteSeenHeadlines[note.id].has(s.headline?.toLowerCase()));
  if (!fresh.length) { containerEl.innerHTML = ''; return; }

  // Mini-deck state keyed by note id
  const stateKey = `ns_${note.id}`;
  if (!clusterState.has(stateKey)) clusterState.set(stateKey, { items: fresh, index: 0 });

  containerEl.innerHTML = `<div class="note-similar-title">Related Reading</div><div class="note-sim-deck" id="nsd-${note.id}"></div>`;
  renderNoteSimilarDeck(note.id);
}

function renderNoteSimilarDeck(noteId) {
  const state = clusterState.get(`ns_${noteId}`);
  const el    = $(`#nsd-${noteId}`);
  if (!state || !el) return;
  const { items, index } = state;
  if (index >= items.length) { el.innerHTML = '<p class="note-empty">All caught up.</p>'; return; }

  const stack = items.slice(index, index + 3).map((item, offset) => {
    const isActive = offset === 0;
    const badge = item.sourceUrl
      ? `<a class="badge badge-link" href="${esc(item.sourceUrl)}" target="_blank" rel="noopener">${esc(item.source)}</a>`
      : `<span class="badge">${esc(item.source)}</span>`;
    return `
      <div class="mini-card ${isActive ? 'mini-active' : ''}" style="--offset:${offset}">
        <div class="mini-inner">
          ${item.image ? `<img class="mini-img" src="${esc(item.image)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}
          <div class="mini-body">
            <div class="mini-headline">${esc(item.headline)}</div>
            ${item.description ? `<div class="mini-desc">${esc(item.description)}</div>` : ''}
            <div class="mini-footer">
              <div class="mini-badges">${badge}</div>
              <button class="deck-btn ns-skip" title="Next">→</button>
            </div>
          </div>
        </div>
      </div>`;
  }).reverse().join('');

  el.innerHTML = `<div class="mini-stack" style="margin-top:8px">${stack}</div>`;

  const stackEl  = el.querySelector('.mini-stack');
  const activeEl = el.querySelector('.mini-active');
  if (stackEl && activeEl) {
    const setH = () => { stackEl.style.height = activeEl.offsetHeight + 'px'; };
    requestAnimationFrame(setH);
    activeEl.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', setH, { once: true });
      img.addEventListener('error', setH, { once: true });
    });
  }

  const card = el.querySelector('.mini-active');
  if (card) {
    let sx = 0;
    card.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    card.addEventListener('touchend',   e => { if (Math.abs(e.changedTouches[0].clientX - sx) > 60) advanceNoteSimilar(noteId); }, { passive: true });
    card.addEventListener('mousedown',  e => { sx = e.clientX; });
    card.addEventListener('mouseup',    e => { if (Math.abs(e.clientX - sx) > 60) advanceNoteSimilar(noteId); });
  }
  el.querySelector('.mini-active .ns-skip')?.addEventListener('click', () => advanceNoteSimilar(noteId));
}

function advanceNoteSimilar(noteId) {
  const state = clusterState.get(`ns_${noteId}`);
  if (!state) return;
  const item = state.items[state.index];
  if (item) {
    // Track as seen in sessionStorage
    const key  = `nseen_${noteId}`;
    const seen = JSON.parse(sessionStorage.getItem(key) || '[]');
    seen.push(item.headline?.toLowerCase());
    sessionStorage.setItem(key, JSON.stringify(seen));
  }
  const card = $(`#nsd-${noteId} .mini-active`);
  if (card) {
    card.classList.add('deck-exit-skip');
    setTimeout(() => { state.index++; renderNoteSimilarDeck(noteId); }, 220);
  } else {
    state.index++;
    renderNoteSimilarDeck(noteId);
  }
}

$('#newNoteBtn')?.addEventListener('click', async () => {
  const title = prompt('Note name:');
  if (!title?.trim()) return;
  const note = await fetch('/api/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim() }),
  }).then(r => r.json());
  notebookNotes.push(note);
  renderNoteList();
  // Switch to notebook tab
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.tab-content').forEach(s => { s.classList.add('hidden'); s.classList.remove('active'); });
  document.querySelector('.tab[data-tab="notebook"]').classList.add('active');
  $('#tab-notebook').classList.remove('hidden'); $('#tab-notebook').classList.add('active');
});

function openNotebookModal(item) {
  nbPendingItem = item;
  const modal = $('#notebookModal');
  $('#nbModalStory').textContent = item.headline.slice(0, 100);
  const sel = $('#nbNoteSelect');
  sel.innerHTML = notebookNotes.length
    ? notebookNotes.map(n => `<option value="${n.id}">${esc(n.title)}</option>`).join('')
    : '<option value="">— no notes yet —</option>';
  $('#nbNewNoteInput').value = '';
  modal.classList.remove('hidden');
}

$('#nbCancelBtn')?.addEventListener('click', () => { $('#notebookModal').classList.add('hidden'); nbPendingItem = null; });
$('#notebookModal')?.addEventListener('click', e => { if (e.target === $('#notebookModal')) { $('#notebookModal').classList.add('hidden'); nbPendingItem = null; } });

$('#nbSaveBtn')?.addEventListener('click', async () => {
  if (!nbPendingItem) return;
  const newTitle = $('#nbNewNoteInput').value.trim();
  let noteId;

  if (newTitle) {
    const note = await fetch('/api/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle }),
    }).then(r => r.json());
    notebookNotes.push(note);
    noteId = note.id;
  } else {
    noteId = $('#nbNoteSelect').value;
    if (!noteId) return;
  }

  const entry = await fetch(`/api/notes/${noteId}/entries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      headline:    nbPendingItem.headline,
      description: nbPendingItem.description || '',
      source:      nbPendingItem.source || '',
      context:     nbPendingItem.context || '',
    }),
  }).then(r => r.json());

  const note = notebookNotes.find(n => n.id == noteId);
  if (note) { note.entries.push(entry); renderNoteList(); }

  $('#notebookModal').classList.add('hidden');
  nbPendingItem = null;

  // Flash feedback
  showSaveStatus('Added to notebook 📓');
});

/* ── Persona tab ── */
const DEFAULT_SECTIONS = [
  { id: 'tech',             label: 'Tech',             custom: false },
  { id: 'us_business',      label: 'US Business',      custom: false },
  { id: 'india_business',   label: 'India Business',   custom: false },
  { id: 'global_economies', label: 'Global Economies', custom: false },
  { id: 'politics',         label: 'Politics',         custom: false },
  { id: 'everything_else',  label: 'Everything Else',  custom: false },
];

let personaAnswers  = {};
let personaSections = [];

async function loadPersona() {
  const s = await fetch('/api/settings').then(r => r.json()).catch(() => ({}));
  personaAnswers  = s.persona  || {};
  personaSections = s.sections || DEFAULT_SECTIONS.map(s => ({ ...s }));
  renderPersonaQuestions();
  renderPersonaSections();
}

function renderPersonaQuestions() {
  $$('#personaQuestions .pq-item').forEach(item => {
    const key = item.dataset.key;
    const val = personaAnswers[key];
    item.querySelectorAll('.pq-btn').forEach(btn => {
      btn.classList.toggle('pq-selected', btn.dataset.val === val);
    });
  });
}

function showPersonaSaved() {
  const el = $('#personaSaveStatus');
  if (!el) return;
  el.textContent = '✓ Saved';
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

$('#personaSaveBtn')?.addEventListener('click', async () => {
  await savePersona();
  showPersonaSaved();
});

$$('#personaQuestions .pq-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const key = btn.closest('.pq-item').dataset.key;
    personaAnswers[key] = btn.dataset.val;
    renderPersonaQuestions();
    await savePersona();
    showPersonaSaved();
  });
});

function renderPersonaSections() {
  const list = $('#personaSectionList');
  if (!list) return;
  list.innerHTML = personaSections.map((s, i) => `
    <li class="persona-section-item ${s.enabled === false ? 'ps-disabled' : ''}">
      <span class="persona-section-name">${esc(s.label)}${!s.custom ? ' <span class="ps-default-tag">default</span>' : ''}</span>
      <div class="persona-section-actions">
        ${s.custom ? `<button class="ps-btn ps-edit" data-i="${i}" title="Rename">✏️</button>` : ''}
        ${s.custom
          ? `<button class="ps-btn ps-del" data-i="${i}" title="Remove">✕</button>`
          : `<label class="toggle" title="${s.enabled === false ? 'Enable' : 'Disable'} section">
               <input type="checkbox" class="ps-toggle" data-i="${i}" ${s.enabled !== false ? 'checked' : ''} />
               <span class="slider"></span>
             </label>`
        }
      </div>
    </li>`).join('');

  list.querySelectorAll('.ps-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      personaSections.splice(+btn.dataset.i, 1);
      renderPersonaSections();
      await savePersona();
    });
  });

  list.querySelectorAll('.ps-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const i    = +btn.dataset.i;
      const name = prompt('Rename section:', personaSections[i].label);
      if (name?.trim()) {
        personaSections[i].label = name.trim();
        renderPersonaSections();
        savePersona();
      }
    });
  });

  list.querySelectorAll('.ps-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
      personaSections[+cb.dataset.i].enabled = cb.checked;
      renderPersonaSections();
      await savePersona();
      showPersonaSaved();
    });
  });
}

$('#addSectionBtn')?.addEventListener('click', async () => {
  const input = $('#newSectionInput');
  const label = input?.value.trim();
  if (!label) return;
  const id = 'custom_' + Date.now();
  personaSections.push({ id, label, custom: true });
  input.value = '';
  renderPersonaSections();
  await savePersona();
});

async function savePersona() {
  await fetch('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ persona: personaAnswers, sections: personaSections }),
  });
}

/* ── Chart of the Day v2 (predefined sources: up to 5 image cards) ── */
async function loadChartsOfDay() {
  const el = $('#chartsOfDay');
  if (!el) return;

  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="charts-title">Chart of the Day</div>
    <div class="cotd-card">
      <div class="cotd-loading">
        <div class="cotd-spinner"></div>
        <span>Loading charts…</span>
      </div>
    </div>`;

  try {
    const resp = await fetch('/api/chart-of-day');
    // 204 → showImages is off; quietly hide the section.
    if (resp.status === 204) { el.classList.add('hidden'); return; }
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    renderChartOfDayV2(el, data);
  } catch (e) {
    el.innerHTML = `<div class="charts-title">Chart of the Day</div><p class="cotd-error">Could not load charts: ${esc(e.message)}</p>`;
  }
}

function renderChartOfDayV2(el, payload) {
  const charts = Array.isArray(payload?.charts) ? payload.charts : [];
  if (!charts.length) {
    el.innerHTML = `<div class="charts-title">Chart of the Day</div><p class="cotd-error">No charts available right now. Check your chart sources in Settings.</p>`;
    return;
  }
  el.innerHTML = `
    <div class="charts-title">Chart of the Day</div>
    <div class="cod-grid">
      ${charts.map(c => `
        <a href="${esc(c.sourceUrl || '#')}" target="_blank" rel="noopener" class="cod-card">
          <img class="cod-card-img" src="${esc(c.image)}" alt="${esc(c.title || '')}" loading="lazy" onerror="this.style.display='none'" />
          <div class="cod-card-body">
            <h4 class="cod-card-title">${esc(c.title || 'Chart')}</h4>
            <span class="cod-card-src">${esc(c.source || '')}</span>
          </div>
        </a>
      `).join('')}
    </div>`;
}

// Retained for backwards compatibility but no longer invoked by v2.
let _chartInstance = null;

function renderChartOfDay(el, data) {
  if (_chartInstance) { _chartInstance.destroy(); _chartInstance = null; }

  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#D4745A';
  const accentSoft  = getComputedStyle(document.documentElement).getPropertyValue('--peach-light').trim() || '#F5C5A3';

  // Big-number callout: most recent value + delta vs. first point
  const isBar    = data.chartType === 'bar';
  const last     = data.data[data.data.length - 1];
  const first    = data.data[0];
  const delta    = (last - first);
  const deltaPct = first ? (delta / Math.abs(first)) * 100 : 0;
  const deltaSign = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
  const deltaClass = delta > 0 ? 'cotd-delta-up' : delta < 0 ? 'cotd-delta-down' : 'cotd-delta-flat';
  const unitStr  = data.unit ? (data.unit.length <= 3 ? data.unit : ' ' + data.unit) : '';
  const formatVal = v => {
    if (typeof v !== 'number') return v;
    if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };
  const lastLabel = data.labels[data.labels.length - 1];
  const firstLabel = data.labels[0];

  el.innerHTML = `
    <div class="charts-title">Chart of the Day</div>
    <div class="cotd-card">
      <div class="cotd-topic-badge">${esc(data.topic)}</div>
      <div class="cotd-headline">${esc(data.headline)}</div>
      <div class="cotd-stat-row">
        <div class="cotd-bignum">
          <span class="cotd-bignum-value">${formatVal(last)}${unitStr.length <= 3 ? unitStr : ''}</span>
          <span class="cotd-bignum-label">as of ${esc(lastLabel)}</span>
        </div>
        <div class="cotd-delta ${deltaClass}">
          <span class="cotd-delta-arrow">${deltaSign}</span>
          <span class="cotd-delta-value">${formatVal(Math.abs(delta))}${unitStr.length <= 3 ? unitStr : ''}</span>
          <span class="cotd-delta-pct">${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%</span>
          <span class="cotd-delta-since">since ${esc(firstLabel)}</span>
        </div>
      </div>
      <div class="cotd-canvas-wrap">
        <canvas id="cotdCanvas"></canvas>
      </div>
      <div class="cotd-axis-note">${esc(data.chartTitle || data.unit || '')}</div>
      <div class="cotd-insight">${esc(data.insight)}</div>
      <div class="cotd-explanation">${esc(data.explanation)}</div>
    </div>`;

  const ctx = document.getElementById('cotdCanvas')?.getContext('2d');
  if (!ctx) return;

  // Build a vertical gradient for the area fill
  const canvas = ctx.canvas;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height || 220);
  gradient.addColorStop(0, accentColor + '55');
  gradient.addColorStop(1, accentColor + '08');

  // Highlight the last point: bigger filled circle in accent color, all others smaller and softer
  const lastIdx = data.data.length - 1;
  const pointRadius = data.data.map((_, i) => i === lastIdx ? 6 : (i === 0 ? 4 : 3));
  const pointBg     = data.data.map((_, i) => i === lastIdx ? accentColor : '#fff');
  const pointBorder = data.data.map(() => accentColor);

  _chartInstance = new Chart(ctx, {
    type: isBar ? 'bar' : 'line',
    data: {
      labels:   data.labels,
      datasets: [{
        label:           data.chartTitle || data.topic,
        data:            data.data,
        borderColor:     accentColor,
        backgroundColor: isBar ? data.data.map(() => accentSoft + 'cc') : gradient,
        borderWidth:     2.5,
        pointRadius:     isBar ? 0 : pointRadius,
        pointBackgroundColor: pointBg,
        pointBorderColor:     pointBorder,
        pointBorderWidth:     2,
        pointHoverRadius:     7,
        tension:              0.35,
        fill:                 !isBar,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      layout: { padding: { top: 12, right: 12, bottom: 4, left: 4 } },
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#2a1a14',
          titleFont:   { size: 11, weight: '600' },
          bodyFont:    { size: 12, weight: '700' },
          padding:     10,
          cornerRadius: 6,
          displayColors: false,
          callbacks: {
            label: ctx => `${formatVal(ctx.parsed.y)}${unitStr}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            font: { size: 11, weight: '500' },
            color: '#8a6f60',
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 18,
          },
          grid:   { display: false },
          border: { color: '#E5D2C2' },
        },
        y: {
          position: 'right',
          ticks: {
            font: { size: 10 },
            color: '#a89483',
            padding: 6,
            maxTicksLimit: 5,
            callback: v => `${formatVal(v)}${unitStr.length <= 3 ? unitStr : ''}`,
          },
          grid:   { color: '#EDD8C850', drawTicks: false },
          border: { display: false },
        },
      },
    },
  });
}

/* ── Init ── */
(async () => {
  // loadModel must run before loadLastRun so that window._settingsSections
  // (disabled tabs + custom labels) is ready before renderInnerTabs is called.
  await loadModel();
  await loadSources();
  await loadClusters();
  await loadLastRun();
  await loadInboxStatus();
  await loadPersona();
  await loadNotebook();
  await loadDateRolodex();
  // loadChartsOfDay is called lazily by renderCategory when top_today is active
})();

/* ── Persona Trainer ── */

const SECTION_LABELS = { top_today:'Top Today', tech:'Tech', us_business:'US Business', india_business:'India Business', global_economies:'Global Economies', politics:'Politics', everything_else:'Everything Else' };

function renderTrainerInput(persona, data) {
  if (persona === 'editor') {
    // Show digest sections as readable headline lists
    const sections = ['top_today','tech','us_business','india_business','global_economies','politics','everything_else'];
    return sections.map(s => {
      const items = data[s];
      if (!items?.length) return '';
      return `<div class="tr-section"><div class="tr-section-label">${SECTION_LABELS[s] || s}</div>${items.map(i => `<div class="tr-item">• ${esc(i.headline)}</div>`).join('')}</div>`;
    }).filter(Boolean).join('');
  }
  if (persona === 'reporter') {
    const clusters = data.clusters || [];
    return clusters.map(c => `
      <div class="tr-section">
        <div class="tr-section-label">Cluster ${c.id} — ${esc(c.category || '')}</div>
        <div class="tr-item"><strong>${esc(c.headline)}</strong></div>
        ${(c.articles || []).map(a => `<div class="tr-item tr-dim">— ${esc(String(a).slice(0,120))}</div>`).join('')}
      </div>`).join('');
  }
  if (persona === 'researcher') {
    const articles = data.articles || [];
    return articles.map(a => `<div class="tr-section"><div class="tr-section-label">${esc(a.source)}</div><div class="tr-item"><strong>${esc(a.title)}</strong></div><div class="tr-item tr-dim">${esc((a.snippet||'').slice(0,140))}</div></div>`).join('');
  }
  return esc(JSON.stringify(data, null, 2));
}

function renderTrainerOutput(persona, data) {
  if (persona === 'editor') {
    // Show what the editor removed/moved/reordered
    if (!data) return '<div class="tr-dim">No changes suggested.</div>';
    const removes = data.remove || {};
    const moves   = data.move   || [];
    const reorder = data.reorder || {};
    let html = '';
    for (const [sec, headlines] of Object.entries(removes)) {
      if (!headlines?.length) continue;
      html += `<div class="tr-section"><div class="tr-section-label tr-remove-label">Remove from ${SECTION_LABELS[sec] || sec}</div>${headlines.map(h => `<div class="tr-item tr-remove">✕ ${esc(h)}</div>`).join('')}</div>`;
    }
    for (const m of moves) {
      html += `<div class="tr-section"><div class="tr-section-label tr-move-label">Move story</div><div class="tr-item">→ "${esc(m.headline)}" from <strong>${SECTION_LABELS[m.from]||m.from}</strong> to <strong>${SECTION_LABELS[m.to]||m.to}</strong></div></div>`;
    }
    for (const [sec, order] of Object.entries(reorder)) {
      if (!order?.length) continue;
      html += `<div class="tr-section"><div class="tr-section-label">Re-ranked: ${SECTION_LABELS[sec]||sec}</div>${order.slice(0,5).map((h,i) => `<div class="tr-item">${i+1}. ${esc(h)}</div>`).join('')}</div>`;
    }
    return html || '<div class="tr-dim">Editor found no issues.</div>';
  }
  if (persona === 'reporter') {
    const entries = Array.isArray(data) ? data : [];
    return entries.map(e => `<div class="tr-section"><div class="tr-item"><strong>${esc(e.headline||'')}</strong></div><div class="tr-item tr-dim">${esc(e.description||'')}</div><div class="tr-item tr-dim" style="font-size:.7rem;margin-top:4px">${esc(e.source||'')}</div></div>`).join('');
  }
  if (persona === 'researcher') {
    const clusters = (data?.clusters || (Array.isArray(data) ? data : []));
    return clusters.map(c => `<div class="tr-section"><div class="tr-section-label">${esc(c.category||'')} — ${esc(c.headline||'')}</div>${(c.articleIds||[]).map(id => `<div class="tr-item tr-dim">Article #${id}</div>`).join('')}<div class="tr-item" style="font-size:.7rem">${(c.keywords||[]).join(', ')}</div></div>`).join('');
  }
  return esc(JSON.stringify(data, null, 2));
}

const PERSONA_DESCS = {
  editor:     'The Editor reviews the full digest after it\'s written. It removes cross-section duplicates, fixes misplaced stories, and re-ranks each section by importance. Think of it as your senior editor — coach it on what "important" means to you.',
  reporter:   'The Reporter turns raw story clusters into polished headlines and descriptions. Train it on your preferred style: lead with numbers, be specific, avoid hype, prefer active voice.',
  researcher: 'The Junior Editor scans headlines from Reuters, FT, WSJ, Guardian, and Bloomberg, then selects and groups the stories that matter. This is the first filter — coach it on which stories you want surfaced and which to skip.',
};

let trainerPersona      = 'editor';
let trainerSyntheticIn  = null;
let trainerPersonaOut   = null;

function openTrainer() {
  $('#trainerModal').classList.remove('hidden');
  loadTrainerState();
}
function closeTrainer() { $('#trainerModal').classList.add('hidden'); }

$('#openTrainerBtn')?.addEventListener('click', openTrainer);
$('#trainerClose')?.addEventListener('click', closeTrainer);
$('#trainerModal')?.addEventListener('click', e => { if (e.target === $('#trainerModal')) closeTrainer(); });

$$('.trainer-persona-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.trainer-persona-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    trainerPersona = btn.dataset.persona;
    trainerSyntheticIn = null;
    trainerPersonaOut  = null;
    $('#trainerScenario').classList.add('hidden');
    $('#trainerStatus').classList.add('hidden');
    loadTrainerState();
  });
});

async function loadTrainerState() {
  $('#trainerPersonaDesc').textContent = PERSONA_DESCS[trainerPersona] || '';
  try {
    const data = await fetch(`/api/train/${trainerPersona}`).then(r => r.json());
    const rulesWrap = $('#trainerRulesWrap');
    const rulesList = $('#trainerRulesList');
    if (data.rules && data.rules.length) {
      rulesList.innerHTML = data.rules.map(r => `<li>${esc(r)}</li>`).join('');
      rulesWrap.classList.remove('hidden');
    } else {
      rulesWrap.classList.add('hidden');
    }
    const genBtn = $('#trainerGenBtn');
    if (genBtn) genBtn.textContent = data.examples > 0
      ? `Generate Scenario (${data.examples} saved so far)`
      : 'Generate Scenario';
  } catch {}
}

$('#trainerGenBtn')?.addEventListener('click', async () => {
  const btn = $('#trainerGenBtn');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  $('#trainerStatus').classList.add('hidden');
  $('#trainerScenario').classList.add('hidden');

  try {
    const res = await fetch(`/api/train/${trainerPersona}/generate`, { method: 'POST' }).then(r => r.json());
    if (res.error) throw new Error(res.error);

    trainerSyntheticIn = res.syntheticInput;
    trainerPersonaOut  = res.personaOutput;

    $('#trainerInput').innerHTML  = renderTrainerInput(trainerPersona, res.syntheticInput);
    $('#trainerOutput').innerHTML = renderTrainerOutput(trainerPersona, res.personaOutput);
    $('#trainerFeedback').value   = '';
    $('#trainerScenario').classList.remove('hidden');
  } catch (e) {
    showTrainerStatus(`Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Regenerate Scenario';
  }
});

$('#trainerApproveBtn')?.addEventListener('click', async () => {
  if (!trainerSyntheticIn || !trainerPersonaOut) return;
  const feedback = $('#trainerFeedback').value.trim();

  const btn = $('#trainerApproveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const res = await fetch(`/api/train/${trainerPersona}/feedback`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        syntheticInput:  trainerSyntheticIn,
        personaOutput:   trainerPersonaOut,
        userFeedback:    feedback,
        approvedOutput:  trainerPersonaOut,
      }),
    }).then(r => r.json());

    const msg = res.rules?.length
      ? `Saved! ${res.totalExamples} examples total. ${res.rules.length} rules distilled.`
      : `Saved! ${res.totalExamples} examples total.`;
    showTrainerStatus(msg, 'success');
    trainerSyntheticIn = null;
    trainerPersonaOut  = null;
    $('#trainerScenario').classList.add('hidden');
    loadTrainerState();
  } catch (e) {
    showTrainerStatus(`Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ Approve & Save';
  }
});

$('#trainerRejectBtn')?.addEventListener('click', () => {
  trainerSyntheticIn = null;
  trainerPersonaOut  = null;
  $('#trainerScenario').classList.add('hidden');
  showTrainerStatus('Rejected. Generate a new scenario to try again.', 'error');
});

function showTrainerStatus(msg, type = 'success') {
  const el = $('#trainerStatus');
  el.textContent = msg;
  el.className = `trainer-status ${type}`;
  el.classList.remove('hidden');
}/* ── Thought Leadership sources (Settings panel) ────────────────── */
async function loadTlSources() {
  const list = document.getElementById('tlSourceList');
  if (!list) return;
  try {
    const all = await fetch('/sources').then(r => r.json());
    const tl  = (Array.isArray(all) ? all : []).filter(s => s.kind === 'thought_leadership');
    if (!tl.length) {
      list.innerHTML = '<li class="meta" style="padding:10px 4px;color:var(--muted)">No Thought Leadership sources yet. Add one below.</li>';
      return;
    }
    list.innerHTML = tl.map(s => `
      <li class="source-item" data-id="${s.id}">
        <div class="source-info">
          <span class="source-name ${s.enabled ? '' : 'disabled'}">${esc(s.name)}</span>
          <span class="source-email">${s.email ? esc(s.email) : '<span style="color:#f59e0b">⚠ No sender email</span>'}</span>
          ${s.url ? `<a class="source-url" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : ''}
        </div>
        <div class="toggle-wrap">
          <span class="toggle-label">${s.enabled ? 'On' : 'Off'}</span>
          <label class="toggle">
            <input type="checkbox" ${s.enabled ? 'checked' : ''} data-tl-toggle="${s.id}" />
            <span class="slider"></span>
          </label>
        </div>
        <button class="btn-danger" data-tl-delete="${s.id}">Remove</button>
      </li>
    `).join('');
    list.querySelectorAll('[data-tl-toggle]').forEach(el => {
      el.addEventListener('change', async (e) => {
        const id = el.getAttribute('data-tl-toggle');
        await fetch(`/sources/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: e.target.checked }),
        });
        loadTlSources(); loadSources();
      });
    });
    list.querySelectorAll('[data-tl-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this Thought Leadership source?')) return;
        const id = btn.getAttribute('data-tl-delete');
        await fetch(`/sources/${id}`, { method: 'DELETE' });
        loadTlSources(); loadSources();
      });
    });
  } catch (e) {
    list.innerHTML = `<li class="meta">Could not load TL sources: ${esc(e.message)}</li>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('addTlSrcBtn')?.addEventListener('click', async () => {
    const name  = document.getElementById('newTlSrcName')?.value.trim();
    const email = document.getElementById('newTlSrcEmail')?.value.trim();
    const url   = document.getElementById('newTlSrcUrl')?.value.trim();
    if (!name) { document.getElementById('newTlSrcName')?.focus(); return; }
    await fetch('/sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, url, kind: 'thought_leadership' }),
    });
    document.getElementById('newTlSrcName').value  = '';
    document.getElementById('newTlSrcEmail').value = '';
    document.getElementById('newTlSrcUrl').value   = '';
    loadTlSources();
    loadSources();
  });
  document.querySelectorAll('.tab[data-tab="settings"]').forEach(t => {
    t.addEventListener('click', () => { setTimeout(loadTlSources, 50); });
  });
  // Also load on first paint if Settings is the initial tab
  setTimeout(loadTlSources, 150);
});


/* ── Chart-of-day sources (Settings panel) ────────────────────── */
async function loadChartSources() {
  const list = $('#chartSourceList');
  if (!list) return;
  try {
    const sources = await fetch('/api/chart-sources').then(r => r.json());
    _chartSourcesCache = Array.isArray(sources) ? sources : [];
    list.innerHTML = _chartSourcesCache.map((s, i) => `
      <li class="source-item">
        <div class="source-info">
          <span class="source-name">${esc(s.name)} <span class="src-kind-badge">${s.kind === 'twitter' ? 'X' : 'WEB'}</span></span>
          <a class="source-url" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>
        </div>
        <button class="btn-danger" data-idx="${i}">Remove</button>
      </li>
    `).join('');
    list.querySelectorAll('button.btn-danger').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = +btn.dataset.idx;
        _chartSourcesCache.splice(idx, 1);
        await saveChartSources();
        loadChartSources();
      });
    });
  } catch (e) { list.innerHTML = `<li class="meta">Could not load chart sources: ${esc(e.message)}</li>`; }
}

let _chartSourcesCache = [];

async function saveChartSources() {
  await fetch('/api/chart-sources', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ sources: _chartSourcesCache }),
  });
}

document.addEventListener('DOMContentLoaded', () => {
  $('#addChartSrcBtn')?.addEventListener('click', async () => {
    const name = $('#newChartSrcName')?.value.trim();
    const url  = $('#newChartSrcUrl')?.value.trim();
    const kind = $('#newChartSrcKind')?.value || 'html';
    if (!name || !/^https?:\/\//.test(url || '')) return;
    _chartSourcesCache.push({ name, url, kind, limit: 2 });
    await saveChartSources();
    $('#newChartSrcName').value = '';
    $('#newChartSrcUrl').value  = '';
    loadChartSources();
  });
  // Load when Settings tab is shown. Easiest: hook into existing tab-click.
  document.querySelectorAll('.tab[data-tab="settings"]').forEach(t => {
    t.addEventListener('click', () => { setTimeout(loadChartSources, 50); });
  });
});


/* ── First-run walkthrough + Report-an-issue ───────────────────────── */
(() => {
  const STORAGE_KEY = 'wkSeenAt';
  const SLIDES = [
    {
      emoji: '👋',
      title: 'Welcome, <em>Prof Gupta</em>',
      body: 'A 30-second tour of your inbox-powered digest. You can skip at any time.',
    },
    {
      emoji: '📰',
      title: 'The <em>Digest</em>',
      body: `Your homepage. A fresh run lands every afternoon at 3pm ET — you don't need to hit Refresh unless you think the news is stale.`,
    },
    {
      emoji: '💬',
      title: '<em>Chat</em> with your inbox',
      body: 'Open any card and tap the chat bubble, or go to the Chat tab. Ask anything — I can read the full text of every newsletter you\'ve forwarded.',
    },
    {
      emoji: '📓',
      title: 'The <em>Notebook</em>',
      body: 'Save observations, recurring themes, or questions. I surface related notes when a similar story shows up later.',
    },
    {
      emoji: '📬',
      title: '<em>Sources</em> — managed by forwarding',
      body: `Add sources here. You can't import them automatically — forward newsletters to Gmail first, then register the sender address here. <em>(Oops — no magic add button.)</em>`,
    },
    {
      emoji: '🎭',
      title: '<em>Persona</em>',
      body: `Tune voice, length, and section priorities. I'll re-read your preferences before every run.`,
    },
    {
      emoji: '🛟',
      title: 'A few last notes',
      body: `If the digest looks sparse, it might be a slow news day — try again in a few hours.<br><br>This website is <b>optimized for web</b>.`,
    },
    {
      emoji: '🚀',
      title: 'You\'re all set',
      body: `<p style="margin:0">Enjoy your daily briefing, Prof Gupta.</p>`,
      extra: ``,
      isLast: true,
    },
  ];

  let idx = 0;
  const overlay = document.getElementById('walkthroughOverlay');
  if (!overlay) return;
  const slidesEl = document.getElementById('wkSlides');
  const dotsEl = document.getElementById('wkDots');
  const nextBtn = document.getElementById('wkNext');
  const skipBtn = document.getElementById('wkSkip');

  function render() {
    const s = SLIDES[idx];
    slidesEl.innerHTML = `
      <div class="wk-slide">
        <div class="wk-graphic">${s.emoji}</div>
        <div class="wk-title">${s.title}</div>
        <div class="wk-body">${s.body}${s.extra || ''}</div>
      </div>
    `;
    dotsEl.innerHTML = SLIDES.map((_, i) => `<span class="wk-dot ${i === idx ? 'active' : ''}"></span>`).join('');
    nextBtn.textContent = s.isLast ? 'Finish' : 'Next';
  }

  function open() { overlay.classList.remove('hidden'); idx = 0; render(); }
  function close() {
    overlay.classList.add('hidden');
    try { localStorage.setItem(STORAGE_KEY, new Date().toISOString()); } catch {}
    // If user typed a message on the final slide, submit it as an issue.
    const txt = document.getElementById('wkIssueText')?.value?.trim();
    if (txt) submitIssue(txt, { source: 'walkthrough' }).catch(() => {});
  }

  nextBtn?.addEventListener('click', () => {
    if (idx >= SLIDES.length - 1) { close(); return; }
    idx++; render();
  });
  skipBtn?.addEventListener('click', close);

  // Show on first visit.
  try {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setTimeout(open, 400);
    }
  } catch {}

  // Expose for manual replay (e.g. from future Help link)
  window._openWalkthrough = open;
  document.getElementById('replayTutorialBtn')?.addEventListener('click', open);

  // Dark-mode toggle wiring
  (function initDarkMode() {
    const stored = localStorage.getItem('theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initial = stored || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', initial);
    const moon = document.getElementById('darkIconMoon');
    const sun  = document.getElementById('darkIconSun');
    const setIcons = (t) => {
      if (!moon || !sun) return;
      if (t === 'dark') { moon.classList.add('hidden'); sun.classList.remove('hidden'); }
      else              { sun.classList.add('hidden'); moon.classList.remove('hidden'); }
    };
    setIcons(initial);
    document.getElementById('darkModeBtn')?.addEventListener('click', () => {
      const cur  = document.documentElement.getAttribute('data-theme') || 'light';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch {}
      setIcons(next);
    });
  })();

  // Report-an-issue wiring
  const issueModal = document.getElementById('issueModal');
  const issueText  = document.getElementById('issueText');
  const issueStat  = document.getElementById('issueStatus');
  document.getElementById('reportIssueBtn')?.addEventListener('click', () => {
    issueModal.classList.remove('hidden');
    setTimeout(() => issueText?.focus(), 50);
  });
  document.getElementById('issueCancel')?.addEventListener('click', () => {
    issueModal.classList.add('hidden');
    issueText.value = ''; issueStat.textContent = '';
  });
  document.getElementById('issueSubmit')?.addEventListener('click', async () => {
    const txt = issueText?.value.trim();
    if (!txt) { issueText?.focus(); return; }
    issueStat.textContent = 'Sending…';
    try {
      await submitIssue(txt, { source: 'nav' });
      issueStat.textContent = 'Thanks — sent. You can close this.';
      issueText.value = '';
      setTimeout(() => { issueModal.classList.add('hidden'); issueStat.textContent = ''; }, 1200);
    } catch (e) {
      issueStat.textContent = 'Could not send. Please try again.';
    }
  });

  async function submitIssue(body, meta = {}) {
    const r = await fetch('/api/report-issue', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ body, meta, url: location.href }),
    });
    if (!r.ok) throw new Error('submit failed');
  }
})();
