/* ============================================================
   PROMPT STUDIO — model gateway

   Nine provider adapters behind one call, and a RECEIPT.

   A run takes a system prompt and a list of turns, so the same entry
   point serves a first attempt and every refinement after it. The
   caller owns the thread; this file only sends what it is handed and
   normalises it into each vendor's wire format.

   The receipt is the point. "Which model wrote this" should be a
   recorded fact, not a label typed into a settings box — a provider
   can resolve a family alias to a dated snapshot, or serve a
   different model than the one requested, and the History row has to
   show what actually answered rather than repeat what was asked for.
   Every run returns { text, provider, requestedModel, servedModel,
   responseId, usage, costUsd, durationMs }.

   Calls go straight from the browser. That is a deliberate trade:
   this project has no server, so the keys live in your browser
   instead of in a backend you would have to run. See the doctrine
   note at the top of settings.js.

   STREAMING
     Anthropic streams (SSE). The other eight are single-shot and
     deliver their text in one onDelta call at the end. The caller
     sees one interface either way; `streams` on the provider meta
     says which it is, so the UI can promise token-by-token only
     where it is real.
   ============================================================ */

(function () {
  'use strict';

  const S = window.PromptSettings;

  /* Bump when the run contract changes, so an old run's receipt
     still says which prompt shape produced it. */
  const PROMPT_VERSION = 'ps-run-1';

  const ANTHROPIC_VERSION = '2023-06-01';
  const DEFAULT_MAX_TOKENS = 16000;

  /* USD per 1M tokens, input/output. Used to price a run at the
     moment it happens, so History keeps the cost that was true then
     even if this table is updated later. A model missing from here
     prices at 0 and the row records `priced: false` rather than
     guessing. */
  const PRICING = Object.freeze({
    'claude-fable-5-1':  { in: 10, out: 50 },
    'claude-fable-5':    { in: 10, out: 50 },
    'claude-opus-5':     { in: 5,  out: 25 },
    'claude-opus-4-8':   { in: 5,  out: 25 },
    'claude-opus-4-7':   { in: 5,  out: 25 },
    'claude-opus-4-6':   { in: 5,  out: 25 },
    'claude-sonnet-5':   { in: 2,  out: 10 },
    'claude-sonnet-4-6': { in: 3,  out: 15 },
    'claude-haiku-4-5':  { in: 1,  out: 5  }
  });

  // Anthropic streams token by token; the rest are single-shot and
  // deliver their text in one onDelta at the end. The caller sees one
  // interface either way, and this says where streaming is real so the
  // UI never promises it falsely.
  const PROVIDER_META = Object.freeze({
    anthropic:   { streams: true },
    openai:      { streams: false },
    gemini:      { streams: false },
    groq:        { streams: false },
    cerebras:    { streams: false },
    openrouter:  { streams: false },
    mistral:     { streams: false },
    cohere:      { streams: false },
    huggingface: { streams: false }
  });

  /* Models that rejected `thinking` or `output_config` are recorded
     here for the rest of the session, so the retry happens once per
     model rather than once per run. Memory only — a page reload
     re-probes, which is correct if the account gains access to a
     newer model. */
  const unsupported = new Map();

  function flags(model) {
    if (!unsupported.has(model)) unsupported.set(model, { thinking: false, effort: false });
    return unsupported.get(model);
  }

  // ─────────────────────────────────────────────
  // ERRORS
  // ─────────────────────────────────────────────

  class ProviderError extends Error {
    constructor(message, { status = 0, hint = '', code = '' } = {}) {
      super(message);
      this.name = 'ProviderError';
      this.status = status;
      this.hint = hint;
      this.code = code;
    }
  }

  // Turns an HTTP status into something a person can act on. The raw
  // provider message is kept as the hint, never as the headline —
  // vendor error prose is inconsistent and often mentions parameters
  // this app never sent.
  function classify(label, status, detail) {
    const code = detail && detail.error && (detail.error.type || detail.error.code) || '';
    const raw = detail && detail.error && detail.error.message || '';
    if (status === 401 || status === 403) {
      return new ProviderError(`${label} rejected the API key.`, {
        status, code, hint: 'Check the key in Settings, then run the test again.'
      });
    }
    if (status === 404) {
      return new ProviderError(`${label} does not have that model.`, {
        status, code, hint: 'Pick a different model in Settings.'
      });
    }
    if (status === 429) {
      return new ProviderError(`${label} is rate-limiting this key.`, {
        status, code, hint: 'Wait a moment and run it again.'
      });
    }
    if (status >= 500) {
      return new ProviderError(`${label} had a server error.`, {
        status, code, hint: 'This is on their side. Try again shortly.'
      });
    }
    return new ProviderError(raw || `${label} refused the request.`, { status, code, hint: raw });
  }

  async function readError(response) {
    try { return await response.json(); } catch (e) { return {}; }
  }

  // ─────────────────────────────────────────────
  // PROMPT ASSEMBLY
  // ─────────────────────────────────────────────

  /* A meta-prompt is a SYSTEM prompt and the pasted idea is the USER
     message. If the meta-prompt contains {{input}}, the idea is
     interpolated there instead and the user message carries a short
     stand-in — some meta-prompts only make sense with the material
     inline.

     That one rule covers "polish this prompt", "summarise this
     excerpt" and everything else, which is why summarising is a
     meta-prompt in this app rather than a feature. */
  const INPUT_TOKEN = /\{\{\s*input\s*\}\}/g;

  function assemble(metaPromptText, input) {
    const meta = String(metaPromptText || '').trim();
    const idea = String(input || '').trim();
    if (INPUT_TOKEN.test(meta)) {
      INPUT_TOKEN.lastIndex = 0;
      return {
        system: meta.replace(INPUT_TOKEN, idea),
        user: 'Follow the instructions above and return only the result.',
        interpolated: true
      };
    }
    return { system: meta, user: idea, interpolated: false };
  }

  // ─────────────────────────────────────────────
  // COST
  // ─────────────────────────────────────────────

  function priceOf(model) {
    const id = String(model || '').trim();
    if (PRICING[id]) return PRICING[id];
    // A dated snapshot (claude-opus-5-20260401) prices as its family.
    const family = Object.keys(PRICING).find(key => id.startsWith(key));
    return family ? PRICING[family] : null;
  }

  function costFor(model, inputTokens, outputTokens) {
    const price = priceOf(model);
    if (!price) return { costUsd: 0, priced: false };
    const cost = (Number(inputTokens || 0) / 1e6) * price.in +
                 (Number(outputTokens || 0) / 1e6) * price.out;
    // 6dp matches numeric(12,6) in the runs table.
    return { costUsd: Math.round(cost * 1e6) / 1e6, priced: true };
  }

  // ─────────────────────────────────────────────
  // ANTHROPIC
  // ─────────────────────────────────────────────

  function anthropicHeaders(apiKey) {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      // Required for calls originating in a browser.
      'anthropic-dangerous-direct-browser-access': 'true'
    };
  }

  function anthropicBody({ model, system, messages, maxTokens, effort, stream }) {
    const f = flags(model);
    const body = {
      model,
      max_tokens: maxTokens,
      messages: toChatMessages(messages)
    };
    if (system) body.system = system;
    if (stream) body.stream = true;

    /* Adaptive thinking is the current shape; budget_tokens is gone
       on the 5-series and errors there. Older models reject
       `thinking` entirely, so a 400 naming it disables the parameter
       for that model and the request is retried once. */
    if (!f.thinking) body.thinking = { type: 'adaptive' };
    if (effort && !f.effort) body.output_config = { effort };
    return body;
  }

  // Detects the two parameter rejections worth retrying without,
  // rather than surfacing a 400 the user cannot act on.
  function degrade(model, detail) {
    const message = String(
      (detail && detail.error && detail.error.message) || ''
    ).toLowerCase();
    const f = flags(model);
    let changed = false;
    if (!f.thinking && message.includes('thinking')) { f.thinking = true; changed = true; }
    if (!f.effort && (message.includes('effort') || message.includes('output_config'))) {
      f.effort = true; changed = true;
    }
    return changed;
  }

  async function callAnthropic(options) {
    const { apiKey, model, system, messages, maxTokens, effort, signal, onDelta } = options;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: anthropicHeaders(apiKey),
        body: JSON.stringify(anthropicBody({
          model, system, messages, maxTokens, effort, stream: true
        })),
        signal
      });

      if (!response.ok) {
        const detail = await readError(response);
        if (response.status === 400 && attempt === 0 && degrade(model, detail)) continue;
        throw classify('Anthropic', response.status, detail);
      }
      return await consumeAnthropicStream(response, model, onDelta);
    }
    throw new ProviderError('Anthropic refused the request twice.', { status: 400 });
  }

  /* SSE frames are separated by a blank line. The buffer is carried
     across reads because a frame can be split across chunks — a
     naive per-chunk parse loses text at the seam under exactly the
     conditions that make streaming worth having. */
  async function consumeAnthropicStream(response, requestedModel, onDelta) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let servedModel = '';
    let responseId = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = '';
    let refusal = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf('\n\n');

        const line = frame.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let event;
        try { event = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }

        if (event.type === 'message_start' && event.message) {
          servedModel = event.message.model || '';
          responseId = event.message.id || '';
          inputTokens = Number(event.message.usage && event.message.usage.input_tokens) || 0;
        } else if (event.type === 'content_block_delta' &&
                   event.delta && event.delta.type === 'text_delta') {
          text += event.delta.text;
          if (onDelta) onDelta(event.delta.text);
        } else if (event.type === 'message_delta') {
          if (event.delta && event.delta.stop_reason) stopReason = event.delta.stop_reason;
          if (event.delta && event.delta.stop_details) refusal = event.delta.stop_details;
          if (event.usage) outputTokens = Number(event.usage.output_tokens) || outputTokens;
        } else if (event.type === 'error') {
          throw new ProviderError(
            (event.error && event.error.message) || 'The stream failed.',
            { code: (event.error && event.error.type) || '' }
          );
        }
      }
    }

    // stop_reason is only meaningful after the stream closes, so
    // these two checks cannot move earlier.
    if (stopReason === 'refusal') {
      throw new ProviderError('The model declined this request.', {
        hint: (refusal && refusal.explanation) || 'Rephrase the input and try again.'
      });
    }
    if (stopReason === 'max_tokens') {
      throw new ProviderError('The reply was cut off before it finished.', {
        hint: 'Raise Max tokens in Settings, or shorten the input.'
      });
    }

    return {
      text,
      servedModel: servedModel || requestedModel,
      responseId,
      inputTokens,
      outputTokens
    };
  }

  async function anthropicModels(apiKey, signal) {
    const out = [];
    let cursor = '';
    // Pages, not models — each request already asks for the maximum.
    for (let page = 0; page < 5; page += 1) {
      const url = new URL('https://api.anthropic.com/v1/models');
      url.searchParams.set('limit', '100');
      if (cursor) url.searchParams.set('after_id', cursor);
      const response = await fetch(url, { headers: anthropicHeaders(apiKey), signal });
      if (!response.ok) throw classify('Anthropic', response.status, await readError(response));
      const payload = await response.json();
      (payload.data || []).forEach(entry => { if (entry.id) out.push(entry.id); });
      if (!payload.has_more || !payload.last_id) break;
      cursor = payload.last_id;
    }
    return out;
  }

  // ─────────────────────────────────────────────
  // OPENAI  (single-shot)
  // ─────────────────────────────────────────────

  async function callOpenAI({ apiKey, model, system, messages, maxTokens, signal, onDelta }) {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        instructions: system || undefined,
        input: toChatMessages(messages),
        max_output_tokens: maxTokens,
        store: false
      }),
      signal
    });
    if (!response.ok) throw classify('OpenAI', response.status, await readError(response));
    const payload = await response.json();

    const text = payload.output_text || (payload.output || [])
      .flatMap(item => item.content || [])
      .filter(part => part.type === 'output_text')
      .map(part => part.text)
      .join('');

    if (onDelta && text) onDelta(text);
    return {
      text,
      servedModel: payload.model || model,
      responseId: payload.id || '',
      inputTokens: Number(payload.usage && payload.usage.input_tokens) || 0,
      outputTokens: Number(payload.usage && payload.usage.output_tokens) || 0
    };
  }

  async function openaiModels(apiKey, signal) {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }, signal
    });
    if (!response.ok) throw classify('OpenAI', response.status, await readError(response));
    const payload = await response.json();
    return (payload.data || []).map(entry => entry.id).filter(Boolean);
  }

  // ─────────────────────────────────────────────
  // GEMINI  (single-shot)
  // ─────────────────────────────────────────────

  async function callGemini({ apiKey, model, system, messages, maxTokens, signal, onDelta }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      contents: toChatMessages(messages).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: { maxOutputTokens: maxTokens }
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal
    });
    if (!response.ok) throw classify('Gemini', response.status, await readError(response));
    const payload = await response.json();

    const candidate = (payload.candidates || [])[0] || {};
    const text = ((candidate.content && candidate.content.parts) || [])
      .map(part => part.text || '').join('');
    const usage = payload.usageMetadata || {};

    if (onDelta && text) onDelta(text);
    return {
      text,
      servedModel: payload.modelVersion || model,
      responseId: payload.responseId || '',
      inputTokens: Number(usage.promptTokenCount) || 0,
      outputTokens: Number(usage.candidatesTokenCount) || 0
    };
  }

  async function geminiModels(apiKey, signal) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '200');
    const response = await fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal });
    if (!response.ok) throw classify('Gemini', response.status, await readError(response));
    const payload = await response.json();
    return (payload.models || [])
      // Embedding and token-counting models arrive in the same list.
      .filter(entry => (entry.supportedGenerationMethods || []).includes('generateContent'))
      // callGemini builds `models/${id}:generateContent`, so strip the prefix.
      .map(entry => String(entry.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  }

  // ─────────────────────────────────────────────
  // OPENAI-COMPATIBLE GATEWAYS  (single-shot)
  // ─────────────────────────────────────────────

  /* Five providers speak OpenAI's /chat/completions verbatim, so one
     adapter serves them all and each entry is only what differs: the
     base URL and how that vendor lists its models. Kept apart from
     the `openai` adapter above on purpose — that one talks to
     /v1/responses, which none of these do. */
  const GATEWAYS = {
    groq:        { base: 'https://api.groq.com/openai/v1' },
    cerebras:    { base: 'https://api.cerebras.ai/v1' },
    openrouter:  { base: 'https://openrouter.ai/api/v1' },
    mistral:     { base: 'https://api.mistral.ai/v1', listUsesCapabilities: true },
    huggingface: { base: 'https://router.huggingface.co/v1' }
  };

  // Non-chat endpoints, keyed on the job rather than the family name,
  // so an "-instruct" chat model is kept.
  const NOT_TEXT = /embed|whisper|tts|audio|image|vision-encoder|rerank|moderation|ocr/i;

  function gatewayCall(providerId) {
    const gateway = GATEWAYS[providerId];
    return async function call({ apiKey, model, system, messages, maxTokens, signal, onDelta }) {
      const turns = [];
      if (system) turns.push({ role: 'system', content: system });
      toChatMessages(messages).forEach(m => turns.push(m));

      const response = await fetch(`${gateway.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: turns, max_tokens: maxTokens }),
        signal
      });
      if (!response.ok) {
        throw classify(S.PROVIDERS[providerId].label, response.status, await readError(response));
      }
      const payload = await response.json();

      const choice = (payload.choices || [])[0] || {};
      const text = (choice.message && choice.message.content) || '';
      const usage = payload.usage || {};

      if (onDelta && text) onDelta(text);
      return {
        text,
        servedModel: payload.model || model,
        responseId: payload.id || '',
        inputTokens: Number(usage.prompt_tokens) || 0,
        outputTokens: Number(usage.completion_tokens) || 0
      };
    };
  }

  function gatewayModels(providerId) {
    const gateway = GATEWAYS[providerId];
    return async function models(apiKey, signal) {
      const response = await fetch(`${gateway.base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }, signal
      });
      if (!response.ok) {
        throw classify(S.PROVIDERS[providerId].label, response.status, await readError(response));
      }
      const payload = await response.json();
      let rows = (payload.data || []).filter(entry => entry && entry.id);

      // Mistral publishes per-model capability flags, so its embedding,
      // OCR and moderation models are dropped on the vendor's own say-so.
      if (gateway.listUsesCapabilities) {
        rows = rows.filter(entry => !entry.capabilities || entry.capabilities.completion_chat !== false);
      }
      const usable = rows.filter(entry => !NOT_TEXT.test(entry.id));
      return (usable.length ? usable : rows).map(entry => String(entry.id));
    };
  }

  // ─────────────────────────────────────────────
  // COHERE  (single-shot)
  // ─────────────────────────────────────────────

  /* Cohere borrows OpenAI's request shape but not its reply: /v2/chat
     returns a single `message` whose text arrives as content blocks,
     and its token counts sit one level deeper under usage.tokens. */
  async function callCohere({ apiKey, model, system, messages, maxTokens, signal, onDelta }) {
    const turns = [];
    if (system) turns.push({ role: 'system', content: system });
    toChatMessages(messages).forEach(m => turns.push(m));

    const response = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: turns, max_tokens: maxTokens }),
      signal
    });
    if (!response.ok) throw classify('Cohere', response.status, await readError(response));
    const payload = await response.json();

    const content = payload.message && payload.message.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter(b => b && b.type === 'text').map(b => b.text || '').join('')
        : '';
    const tokens = (payload.usage && payload.usage.tokens) || {};

    if (onDelta && text) onDelta(text);
    return {
      text,
      // Cohere does not echo the served model, so this falls back to
      // what was asked for rather than inventing a match.
      servedModel: payload.model || model,
      responseId: payload.id || '',
      inputTokens: Number(tokens.input_tokens) || 0,
      outputTokens: Number(tokens.output_tokens) || 0
    };
  }

  // endpoint=chat is Cohere's own filter, so embedding and rerank
  // models never reach the picker.
  async function cohereModels(apiKey, signal) {
    const url = new URL('https://api.cohere.com/v1/models');
    url.searchParams.set('page_size', '1000');
    url.searchParams.set('endpoint', 'chat');
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal
    });
    if (!response.ok) throw classify('Cohere', response.status, await readError(response));
    const payload = await response.json();
    return (payload.models || []).map(entry => entry && entry.name).filter(Boolean);
  }

  // ─────────────────────────────────────────────
  // PUBLIC
  // ─────────────────────────────────────────────

  const ADAPTERS = {
    anthropic: { call: callAnthropic, models: anthropicModels },
    openai:    { call: callOpenAI,    models: openaiModels },
    gemini:    { call: callGemini,    models: geminiModels },
    cohere:    { call: callCohere,    models: cohereModels }
  };

  Object.keys(GATEWAYS).forEach(id => {
    ADAPTERS[id] = { call: gatewayCall(id), models: gatewayModels(id) };
  });

  /**
   * Run one meta-prompt against one input. One request, one response,
   * no conversation state.
   *
   * @returns {Promise<object>} the receipt described at the top.
   */
  async function run({ system, messages, maxTokens, signal, onDelta } = {}) {
    const creds = S.readCredentials();
    const provider = creds.provider;
    const adapter = ADAPTERS[provider];
    if (!adapter) throw new ProviderError(`Unknown provider "${provider}".`);

    const apiKey = creds.keys[provider];
    if (!apiKey) {
      throw new ProviderError(`No API key for ${S.PROVIDERS[provider].label}.`, {
        hint: 'Add one in Settings.'
      });
    }

    const requestedModel = S.resolveModel(provider, creds);
    const started = Date.now();

    const result = await adapter.call({
      apiKey,
      model: requestedModel,
      system,
      messages,
      maxTokens: Number(maxTokens) > 0 ? Number(maxTokens) : DEFAULT_MAX_TOKENS,
      effort: creds.effort,
      signal,
      onDelta
    });

    const { costUsd, priced } = costFor(
      result.servedModel || requestedModel, result.inputTokens, result.outputTokens
    );

    return {
      text: result.text,
      provider,
      requestedModel,
      servedModel: result.servedModel || requestedModel,
      responseId: result.responseId || '',
      promptVersion: PROMPT_VERSION,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd,
      priced,
      durationMs: Date.now() - started
    };
  }

  /**
   * Ask a provider which models the entered key can actually use, so
   * the picker is a list the provider gave us rather than a list this
   * file was written believing. Doubles as the Settings test call:
   * a key that can list models is a key that works.
   */
  async function listModels(providerId, apiKey, { force = false, signal } = {}) {
    const adapter = ADAPTERS[providerId];
    if (!adapter) throw new ProviderError(`Unknown provider "${providerId}".`);
    const key = String(apiKey || '').trim();
    if (!key) throw new ProviderError('Enter an API key first.');

    if (!force) {
      const cached = S.readModelCatalog(providerId, key);
      if (cached) return { models: cached.models, fetchedAt: cached.fetchedAt, cached: true };
    }

    const models = dedupe(await adapter.models(key, signal));
    if (!models.length) {
      throw new ProviderError(
        `${S.PROVIDERS[providerId].label} accepted the key but listed no usable models.`
      );
    }
    const entry = S.writeModelCatalog(providerId, { models, apiKey: key });
    return { models: entry.models, fetchedAt: entry.fetchedAt, cached: false };
  }

  function dedupe(list) {
    return [...new Set((list || []).map(String).filter(Boolean))].sort();
  }

  window.PromptRunner = {
    run,
    listModels,
    assemble,
    costFor,
    priceOf,
    ProviderError,
    PROMPT_VERSION,
    PROVIDER_META,
    PRICING,
    DEFAULT_MAX_TOKENS
  };
})();
