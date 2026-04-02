'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');
const isVercel  = !!process.env.KV_REST_API_URL;

// ── Local JSON helpers ────────────────────────────────────────────────────────

function fileLoad() {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  return { sources: [], lastRun: null };
}

function fileSave(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── KV helpers (lazy-required so local dev never needs @vercel/kv) ────────────

async function kvGet(key) {
  const { kv } = require('@vercel/kv');
  return kv.get(key);
}

async function kvSet(key, value) {
  const { kv } = require('@vercel/kv');
  return kv.set(key, value);
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getKey(key) {
  if (isVercel) return kvGet(key);
  return fileLoad()[key] ?? null;
}

async function setKey(key, value) {
  if (isVercel) return kvSet(key, value);
  const data = fileLoad();
  data[key] = value;
  fileSave(data);
}

const getSources       = ()  => getKey('sources').then(v => v ?? []);
const setSources       = arr => setKey('sources', arr);
const getLastRun       = ()  => getKey('lastRun');
const setLastRun       = d   => setKey('lastRun', d);
const getInboxSnapshot = ()  => getKey('inboxSnapshot');
const setInboxSnapshot = s   => setKey('inboxSnapshot', s);
const getGmailTokens   = ()  => getKey('gmail_tokens');
const setGmailTokens   = t   => setKey('gmail_tokens', t);

module.exports = {
  isVercel,
  getKey, setKey,
  getSources, setSources,
  getLastRun, setLastRun,
  getInboxSnapshot, setInboxSnapshot,
  getGmailTokens, setGmailTokens,
};
