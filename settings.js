/* ============================================================
   PROMPT STUDIO — credentials and per-device settings

   Three kinds of state, and the split matters:

     · CREDENTIALS (model API keys, the active provider, the pinned
       model per provider) are written to this browser's
       localStorage AND — unless you turn "Remember keys in my
       account" off — mirrored into your own row of
       prompts.user_settings. localStorage is the working copy the
       runner reads on every request; the Supabase row is what a new
       device restores from.

     · PREFERENCES (theme, view, sort, split width) are local only,
       because they are per-device by nature — a phone wants a
       different list view than a desktop.

     · Everything else shared across devices — retention windows, max
       tokens, the prompts themselves — lives in Supabase. See
       cloud.js.

   ────────────────────────────────────────────────────────────
   WHERE THE KEYS LIVE, AND WHY THAT IS THE TRADE

   1. localStorage, under `ps.credentials.v1`, in plaintext.

      Unchanged, and still the copy every request reads. It is
      readable by anything that can run JavaScript on this origin,
      and the login screen is not a lock — it is a DOM visibility
      toggle, and the console can read localStorage without signing
      in. Two things make that acceptable:

        a. The Supabase session token already lives in this same
           localStorage and is strictly more privileged — it grants
           the whole workspace, including this row. Anyone who can
           read one can read the other, so the API key adds no new
           class of exposure.
        b. The CSP admits no third-party script origins and every
           innerHTML boundary is escaped, so there is no untrusted JS
           on the page to read it in the first place.

   2. prompts.user_settings.settings->'credentials', in plaintext
      jsonb, one row per user.

      What protects it is row-level security, not secrecy. The table
      has RLS enabled with a single policy — `for all to
      authenticated using (user_id = auth.uid())` — and the `anon`
      role is revoked from the `prompts` schema itself, not merely
      from the tables. So the publishable key committed in
      supabase-config.js cannot read this row, and neither can any
      other signed-in user: Postgres filters it before PostgREST ever
      sees it.

      THE RESIDUAL RISK, STATED PLAINLY. Three parties can read the
      stored key, and none of them is an attacker on the internet:

        · anyone holding this account's Supabase session (the same
          people who could already read localStorage);
        · anyone with the project's service_role key or SQL editor
          access — that is the project owner, i.e. you;
        · the database's own backups.

      A provider API key is a bearer token for spend, so the honest
      mitigation is not encryption, it is rotation: a key you can
      revoke at the provider in ten seconds is the control that
      actually works here.

   WHY NOT ENCRYPT IT IN THE BROWSER
      Because there is nowhere to put the decryption key that is not
      also in the browser. Supabase does not hand the password back
      after sign-in, so a passphrase-derived key would mean asking
      for a second password on every device — and one stored
      alongside the ciphertext is decoration, not protection. Fake
      encryption reads as a stronger promise than RLS while being a
      weaker one.

   WHY NOT A WORKER PROXY
      That remains the only shape that keeps the key out of the
      browser entirely, and it is what to build if this ever holds a
      key that cannot be cheaply rotated. It needs a deployed server,
      which this project deliberately does not have.

   OFFLINE AND OPT-OUT
      localStorage is always written, so the app works with no
      network and an unreachable Supabase never blocks a run. Turning
      the toggle off stops the mirror AND deletes what is already in
      the row on the next save — see normalizeSettings in cloud.js,
      which drops `credentials` whenever `rememberKeys` is false.
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
  /* The nine providers that are reachable straight from a browser.
     Defaults and key URLs match the ones already in use in sc, so a
     key that works there works here without being re-chosen.

     Two vendors are deliberately absent, for reasons sc records after
     hitting both: Cloudflare Workers AI and NVIDIA NIM answer no CORS
     headers, so no browser can reach them without a proxy this app
     does not have; and GitHub Models was retired 2026-07-30 and now
     answers 410 permanently. */
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
      defaultModel: 'gpt-5.6-luna',
      placeholder: 'sk-…',
      keysUrl: 'https://platform.openai.com/api-keys',
      supportsEffort: false
    },
    gemini: {
      label: 'Google Gemini',
      defaultModel: 'gemini-3.6-flash',
      placeholder: 'AIza…',
      keysUrl: 'https://aistudio.google.com/apikey',
      supportsEffort: false
    },
    groq: {
      label: 'Groq',
      defaultModel: 'llama-3.3-70b-versatile',
      placeholder: 'gsk_…',
      keysUrl: 'https://console.groq.com/keys',
      supportsEffort: false
    },
    cerebras: {
      label: 'Cerebras',
      defaultModel: 'llama-3.3-70b',
      placeholder: 'csk-…',
      keysUrl: 'https://cloud.cerebras.ai/platform/apikeys',
      supportsEffort: false
    },
    openrouter: {
      label: 'OpenRouter',
      defaultModel: 'openai/gpt-4.1-mini',
      placeholder: 'sk-or-…',
      keysUrl: 'https://openrouter.ai/keys',
      supportsEffort: false
    },
    mistral: {
      label: 'Mistral AI',
      defaultModel: 'mistral-large-latest',
      placeholder: 'API key',
      keysUrl: 'https://console.mistral.ai/api-keys',
      supportsEffort: false
    },
    cohere: {
      label: 'Cohere',
      defaultModel: 'command-a-03-2025',
      placeholder: 'API key',
      keysUrl: 'https://dashboard.cohere.com/api-keys',
      supportsEffort: false
    },
    huggingface: {
      label: 'Hugging Face',
      defaultModel: 'openai/gpt-oss-120b',
      placeholder: 'hf_…',
      keysUrl: 'https://huggingface.co/settings/tokens',
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
    section: 'library',
    // Model output is Markdown far more often than not.
    outputMode: 'markdown'
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

  // ─────────────────────────────────────────────
  // CREDENTIALS ACROSS DEVICES
  // ─────────────────────────────────────────────

  /* What gets mirrored into prompts.user_settings. Empty values are
     omitted rather than sent as "", so a provider you have never
     configured takes no room in the row and — more importantly —
     cannot come back down and blank out a key another device has. */
  function credentialsPayload() {
    const creds = readCredentials();
    const keys = {};
    const models = {};
    PROVIDER_IDS.forEach(id => {
      if (creds.keys[id]) keys[id] = creds.keys[id];
      if (creds.models[id]) models[id] = creds.models[id];
    });
    return { provider: creds.provider, effort: creds.effort, keys, models };
  }

  function countKeys(creds) {
    const c = creds || readCredentials();
    return PROVIDER_IDS.filter(id => c.keys[id]).length;
  }

  /**
   * Merge the copy held in Supabase into this browser.
   *
   * WHICH SIDE WINS, AND WHY IT IS NOT SYMMETRICAL
   *   A key is adopted only where this device has none. The stored
   *   row is refreshed on every local edit, so it is never older
   *   than the last thing anybody typed — but a device that has a
   *   key already is a device somebody set up on purpose, and
   *   silently swapping it for another one mid-session would change
   *   which account gets billed without saying so.
   *
   *   The ACTIVE provider and the reasoning effort are adopted only
   *   when this device has nothing configured at all. That is the
   *   new-device case, where following the row is the whole point;
   *   on a device already in use, moving the provider under the
   *   composer is the same surprise in a different place.
   *
   *   Nothing is ever deleted from here. A key removed elsewhere
   *   stays on this device until "Forget keys" removes it, because
   *   the local copy is also the offline cache and an empty pull
   *   must never be able to wipe it.
   */
  function adoptCredentials(remote) {
    const current = readCredentials();
    if (!remote || typeof remote !== 'object') {
      return { adopted: 0, changed: false, credentials: current };
    }

    const keys = {};
    const models = {};
    let adopted = 0;
    let changed = false;

    PROVIDER_IDS.forEach(id => {
      const key = String((remote.keys && remote.keys[id]) || '').trim();
      if (key && !current.keys[id]) { keys[id] = key; adopted += 1; changed = true; }
      const model = String((remote.models && remote.models[id]) || '').trim();
      if (model && !current.models[id]) { models[id] = model; changed = true; }
    });

    const patch = { keys, models };
    const blank = countKeys(current) === 0;
    if (blank && PROVIDERS[remote.provider]) { patch.provider = remote.provider; changed = true; }
    // "" is already the default, so adopting it is a no-op that would
    // still report a change and trigger a pointless re-render.
    if (blank && remote.effort && EFFORTS.includes(remote.effort)) {
      patch.effort = remote.effort;
      changed = true;
    }

    if (!changed) return { adopted: 0, changed: false, credentials: current };
    return { adopted, changed: true, credentials: writeCredentials(patch) };
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
        ? saved.section : DEFAULT_PREFS.section,
      outputMode: saved.outputMode === 'raw' ? 'raw' : DEFAULT_PREFS.outputMode,

      /* Width of the reading pane, in px, when the user has dragged
         the splitter. `null` means "unset", which is not the same as
         a width that happens to equal the default: unset follows the
         responsive defaults as the window changes, and a set width
         does not. The stylesheet clamps whatever comes back, so a
         width saved on a 3440 monitor cannot strand the pane
         off-screen on a laptop. */
      detailWidth: Number.isFinite(saved.detailWidth) && saved.detailWidth > 0
        ? Math.round(saved.detailWidth)
        : null
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
    credentialsPayload,
    adoptCredentials,
    countKeys,
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
