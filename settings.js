/* ============================================================
   PROMPT STUDIO — per-device settings

   Three kinds of state, and the split matters:

     · CREDENTIALS (model API keys) stay in this browser's
       localStorage and are NEVER written to Supabase. On a new
       device you enter them once more.

     · PREFERENCES (theme, view, sort) are also local, because they
       are per-device by nature — a phone wants a different list
       view than a desktop.

     · Everything shared across devices — retention windows, the
       default model, the prompts themselves — lives in Supabase.
       See cloud.js.

   WHY PLAINTEXT localStorage IS THE CHOSEN TRADE
     There is no server. Putting the key in localStorage means it is
     readable by anything that can run JavaScript on this origin. Two
     things make that acceptable here, and neither of them is the
     login screen — that is a DOM visibility toggle, not a lock, and
     the console can read localStorage without signing in:

       1. The Supabase session token already lives in this same
          localStorage and is strictly more privileged — it grants
          the whole workspace. Anyone who can read one can read the
          other, so the API key adds no new class of exposure.
       2. The CSP admits no third-party script origins and every
          innerHTML boundary is escaped, so there is no untrusted JS
          on the page to read it in the first place.

     If that trade ever stops being right, the answer is a Worker
     proxy holding the key as a server secret — the shape sc/worker
     already has — not encrypting it in the browser, which just moves
     the problem to where the decryption key is kept.
   ============================================================ */

(function () {
  'use strict';

  const CRED_KEY = 'ps.credentials.v1';
  const PREF_KEY = 'ps.prefs.v1';
  const MODELS_KEY = 'ps.models.v1';

  /* Provider metadata. `defaultModel` is what an empty model box
     resolves to; the picker is populated from the live list the
     provider returns for the entered key, so it reflects what the
     key can actually reach rather than what this file was written
     believing. */
  const PROVIDERS = Object.freeze({
    anthropic: {
      label: 'Anthropic Claude',
      defaultModel: 'claude-opus-5',
      placeholder: 'sk-ant-…',
      keysUrl: 'https://platform.claude.com/settings/keys',
      /* Anthropic exposes a reasoning-effort control; the others
         ignore it. */
      supportsEffort: true
    },
    openai: {
      label: 'OpenAI',
      defaultModel: 'gpt-5.6',
      placeholder: 'sk-…',
      keysUrl: 'https://platform.openai.com/api-keys',
      supportsEffort: false
    },
    gemini: {
      label: 'Google Gemini',
      defaultModel: 'gemini-3-pro',
      placeholder: 'AIza…',
      keysUrl: 'https://aistudio.google.com/apikey',
      supportsEffort: false
    }
  });

  const PROVIDER_IDS = Object.keys(PROVIDERS);
  const DEFAULT_PROVIDER = 'anthropic';
  const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

  const DEFAULT_PREFS = Object.freeze({
    theme: 'dark',          // v2 is dark by default
    view: 'large',
    sort: 'date-desc',
    section: 'library'
  });

  // ─────────────────────────────────────────────
  // RAW localStorage HELPERS
  // ─────────────────────────────────────────────

  // Every accessor is wrapped: private mode and "block site data"
  // both throw on access rather than returning null, and a settings
  // read must never be able to take the app down.
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return structuredCloneSafe(fallback);
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : structuredCloneSafe(fallback);
    } catch (e) {
      return structuredCloneSafe(fallback);
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // Private mode; settings just won't persist for this session.
      return false;
    }
  }

  function drop(key) {
    try { localStorage.removeItem(key); } catch (e) { /* nothing to do */ }
  }

  function structuredCloneSafe(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // ─────────────────────────────────────────────
  // CREDENTIALS
  // ─────────────────────────────────────────────

  function readCredentials() {
    const saved = read(CRED_KEY, {});

    // The pre-Supabase version of this app stored a GitHub token to
    // sync through a Gist. That sync is long gone, but a browser that
    // used it may still carry the credentials — drop them rather than
    // leaving a stale token sitting in storage forever.
    if (Object.prototype.hasOwnProperty.call(saved, 'githubToken') ||
        Object.prototype.hasOwnProperty.call(saved, 'gistId')) {
      delete saved.githubToken;
      delete saved.gistId;
      write(CRED_KEY, saved);
    }

    const provider = PROVIDERS[saved.provider] ? saved.provider : DEFAULT_PROVIDER;
    const keys = {};
    const models = {};
    PROVIDER_IDS.forEach(id => {
      keys[id] = String((saved.keys && saved.keys[id]) || '').trim();
      // "" is Auto: resolved against defaultModel at request time.
      models[id] = String((saved.models && saved.models[id]) || '').trim();
    });

    return {
      provider,
      effort: EFFORTS.includes(saved.effort) ? saved.effort : '',
      keys,
      models
    };
  }

  function writeCredentials(next) {
    const current = readCredentials();
    const merged = {
      provider: PROVIDERS[next.provider] ? next.provider : current.provider,
      effort: EFFORTS.includes(next.effort) ? next.effort : current.effort,
      keys: { ...current.keys },
      models: { ...current.models }
    };
    PROVIDER_IDS.forEach(id => {
      if (next.keys && typeof next.keys[id] === 'string') {
        merged.keys[id] = next.keys[id].trim();
      }
      if (next.models && typeof next.models[id] === 'string') {
        merged.models[id] = next.models[id].trim();
      }
    });
    write(CRED_KEY, merged);
    return merged;
  }

  function clearCredentials() {
    drop(CRED_KEY);
    drop(MODELS_KEY);
  }

  // Masked display. Never render a raw key into the DOM — this is
  // what Settings shows next to each provider.
  function fingerprint(token) {
    const value = String(token || '').trim();
    if (!value) return '—';
    return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : 'set';
  }

  function hasKey(providerId) {
    const creds = readCredentials();
    return Boolean(creds.keys[providerId]);
  }

  // The model actually used for a request: explicit pin, else the
  // provider's default.
  function resolveModel(providerId, creds) {
    const c = creds || readCredentials();
    const meta = PROVIDERS[providerId];
    if (!meta) return '';
    return (c.models[providerId] || '').trim() || meta.defaultModel;
  }

  // ─────────────────────────────────────────────
  // MODEL CATALOG CACHE
  // ─────────────────────────────────────────────

  /* Cached per provider and keyed by a FINGERPRINT of the API key,
     not the key itself — localStorage still has a small per-origin
     budget and a model list should not be a second place the secret
     is written. Changing the key invalidates the cache because the
     fingerprint no longer matches. */
  function readModelCatalog(providerId, apiKey) {
    const all = read(MODELS_KEY, {});
    const entry = all[providerId];
    if (!entry || !Array.isArray(entry.models)) return null;
    if (entry.keyPrint !== fingerprint(apiKey)) return null;
    return entry;
  }

  function writeModelCatalog(providerId, { models = [], apiKey = '', fetchedAt = '' } = {}) {
    const all = read(MODELS_KEY, {});
    all[providerId] = {
      models: models.slice(0, 400),
      keyPrint: fingerprint(apiKey),
      fetchedAt: fetchedAt || new Date().toISOString()
    };
    write(MODELS_KEY, all);
    return all[providerId];
  }

  function clearModelCatalog() {
    drop(MODELS_KEY);
  }

  // ─────────────────────────────────────────────
  // PREFERENCES
  // ─────────────────────────────────────────────

  function readPrefs() {
    const saved = read(PREF_KEY, DEFAULT_PREFS);
    return {
      theme: saved.theme === 'light' ? 'light' : 'dark',
      view: ['large', 'list', 'compact'].includes(saved.view) ? saved.view : DEFAULT_PREFS.view,
      sort: ['date-desc', 'date-asc', 'name-asc', 'name-desc', 'custom'].includes(saved.sort)
        ? saved.sort : DEFAULT_PREFS.sort,
      section: ['library', 'workshop', 'scratch', 'history'].includes(saved.section)
        ? saved.section : DEFAULT_PREFS.section
    };
  }

  function writePrefs(patch) {
    const merged = { ...readPrefs(), ...(patch || {}) };
    write(PREF_KEY, merged);
    return readPrefs();
  }

  window.PromptSettings = {
    PROVIDERS,
    PROVIDER_IDS,
    DEFAULT_PROVIDER,
    EFFORTS,
    readCredentials,
    writeCredentials,
    clearCredentials,
    fingerprint,
    hasKey,
    resolveModel,
    readModelCatalog,
    writeModelCatalog,
    clearModelCatalog,
    readPrefs,
    writePrefs
  };
})();
