'use strict';

/**
 * Manus API v2 wrapper — exposes a simple callManus(system, prompt, opts) that
 * creates an agent task, polls task.listMessages until status=stopped, and returns
 * the final assistant message text.
 *
 * Note: Manus is an autonomous-agent platform, not a chat-completion API. A round
 * trip is typically minutes (agent reasoning + tool use). Use this only when latency
 * is acceptable; for tight digest paths, prefer Claude/Groq.
 *
 * Env: MANUS_API_KEY — get from Manus webapp → Integrations → API.
 */

const BASE_URL  = process.env.MANUS_BASE_URL || 'https://api.manus.ai';
const POLL_MS   = 5_000;        // 5s between polls
const MAX_WAIT  = 5 * 60_000;   // 5 minutes hard cap before giving up

function _key() {
  return process.env.MANUS_API_KEY || process.env.manus_api_key || '';
}

function hasManusKey() {
  return Boolean(_key());
}

async function _fetch(path, init = {}) {
  const key = _key();
  if (!key) {
    const err = new Error('MANUS_API_KEY not set');
    err.status = 401;
    throw err;
  }
  const headers = { 'x-manus-api-key': key, 'Content-Type': 'application/json', ...(init.headers || {}) };
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave json null */ }
  if (!res.ok || (json && json.ok === false)) {
    const msg = (json && json.error && json.error.message) || text || `HTTP ${res.status}`;
    const err = new Error(`Manus API error: ${msg}`);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }
  return json;
}

async function _createTask(prompt) {
  // task.create — single-message task that runs the agent on `prompt`.
  // Manus v2 accepts a `messages` array similar to chat APIs.
  const body = { messages: [{ role: 'user', content: prompt }] };
  const out = await _fetch('/v2/task.create', { method: 'POST', body: JSON.stringify(body) });
  if (!out || !out.task_id) {
    throw new Error(`Manus task.create returned no task_id: ${JSON.stringify(out).slice(0, 200)}`);
  }
  return out.task_id;
}

async function _pollOnce(taskId) {
  // task.listMessages?task_id=...&order=desc&limit=20
  const qs  = new URLSearchParams({ task_id: taskId, order: 'desc', limit: '20' }).toString();
  return _fetch(`/v2/task.listMessages?${qs}`, { method: 'GET' });
}

function _extractFinalText(events) {
  if (!events || !Array.isArray(events.messages || events.data)) return null;
  const list = events.messages || events.data;
  // Walk in reverse-chronological order (already desc) for the latest assistant_message
  for (const ev of list) {
    if (ev.type === 'assistant_message' && ev.assistant_message) {
      const am = ev.assistant_message;
      if (typeof am.content === 'string') return am.content;
      if (Array.isArray(am.content)) {
        const textParts = am.content.filter(p => p && (p.type === 'text' || typeof p.text === 'string')).map(p => p.text || '');
        if (textParts.length) return textParts.join('\n').trim();
      }
    }
  }
  return null;
}

function _agentStatus(events) {
  if (!events || !Array.isArray(events.messages || events.data)) return null;
  const list = events.messages || events.data;
  for (const ev of list) {
    if (ev.type === 'status_update' && ev.status_update) {
      return ev.status_update.agent_status || null;
    }
  }
  return null;
}

/**
 * callManus(system, prompt, opts) — runs an agent task and returns the final text.
 * Falls through with a clear error if the task takes longer than MAX_WAIT or errors.
 */
async function callManus(system, prompt, opts = {}) {
  const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  const taskId = await _createTask(fullPrompt);
  console.log(`[manus] task created: ${taskId}`);

  const startedAt = Date.now();
  while (true) {
    if (Date.now() - startedAt > MAX_WAIT) {
      throw new Error(`Manus task ${taskId} exceeded ${MAX_WAIT/1000}s cap (still ${_agentStatus({})}=${(await _pollOnce(taskId)) && 'unknown'})`);
    }
    const events = await _pollOnce(taskId);
    const status = _agentStatus(events);
    if (status === 'stopped') {
      const text = _extractFinalText(events);
      if (text) return text;
      // No assistant message yet — keep polling briefly in case events are still propagating
      console.warn(`[manus] task ${taskId} stopped but no assistant_message found yet`);
    }
    if (status === 'error') {
      throw new Error(`Manus task ${taskId} ended with status=error`);
    }
    if (status === 'waiting') {
      // We do NOT auto-confirm tool/connector requests — that's a security choice.
      // For pure-LLM use cases the agent shouldn't enter waiting; if it does, fail loudly.
      throw new Error(`Manus task ${taskId} is waiting for user input — not supported in headless mode`);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

module.exports = { callManus, hasManusKey };
