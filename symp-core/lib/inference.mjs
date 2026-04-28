// Unified Inference Router — SYMP Sovereign migration layer.
//
// Single chokepoint for all chat completions and embeddings. Call sites import
// `chatComplete` and `embed` from here instead of fetching OpenAI directly,
// which lets us swap providers via env without touching code.
//
// Default behaviour is identical to the old direct-OpenAI calls — same models,
// same key-fallback chain (BLAKCIDE_OPENAI_KEY → OPENAI_API_KEY) — so flipping
// every call site to the router is a no-op until env vars change.
//
// Provider switching:
//
//   SYMP_LLM_PROVIDER       openai | together | fireworks | openrouter | deepinfra | custom
//   SYMP_LLM_BASE_URL       https://your-endpoint/v1   (only when provider=custom)
//   SYMP_LLM_API_KEY        used as fallback for any non-openai provider
//   SYMP_LLM_MODEL_<TASK>   per-task model override (e.g. SYMP_LLM_MODEL_CLASSIFIER)
//
//   SYMP_EMBED_PROVIDER     openai | voyage | together | custom
//   SYMP_EMBED_BASE_URL     https://your-endpoint/v1   (only when provider=custom)
//   SYMP_EMBED_API_KEY      provider-specific
//   SYMP_EMBED_MODEL        explicit embedding model override
//
// Tasks (used to pick a sensible default model per provider):
//   chat | classifier | summary | vision | hint | proactive | ai_participant
//
// All providers must speak the OpenAI Chat Completions / Embeddings wire
// format. Self-hosted vLLM, SGLang, and Ollama all do; native Cohere /
// Anthropic / Gemini do not (would need a separate adapter).

const LLM_PROVIDERS = {
    openai: {
        baseUrl:   'https://api.openai.com/v1',
        apiKeyEnv: ['BLAKCIDE_OPENAI_KEY', 'OPENAI_API_KEY'],
    },
    together: {
        baseUrl:   'https://api.together.xyz/v1',
        apiKeyEnv: ['TOGETHER_API_KEY', 'SYMP_LLM_API_KEY'],
    },
    fireworks: {
        baseUrl:   'https://api.fireworks.ai/inference/v1',
        apiKeyEnv: ['FIREWORKS_API_KEY', 'SYMP_LLM_API_KEY'],
    },
    openrouter: {
        baseUrl:   'https://openrouter.ai/api/v1',
        apiKeyEnv: ['OPENROUTER_API_KEY', 'SYMP_LLM_API_KEY'],
    },
    deepinfra: {
        baseUrl:   'https://api.deepinfra.com/v1/openai',
        apiKeyEnv: ['DEEPINFRA_API_KEY', 'SYMP_LLM_API_KEY'],
    },
    custom: {
        baseUrl:   null,
        apiKeyEnv: ['SYMP_LLM_API_KEY'],
    },
};

const EMBED_PROVIDERS = {
    openai: {
        baseUrl:      'https://api.openai.com/v1',
        apiKeyEnv:    ['BLAKCIDE_OPENAI_KEY', 'OPENAI_API_KEY'],
        defaultModel: 'text-embedding-3-small',
        defaultDim:   1536,
    },
    voyage: {
        baseUrl:      'https://api.voyageai.com/v1',
        apiKeyEnv:    ['VOYAGE_API_KEY', 'SYMP_EMBED_API_KEY'],
        defaultModel: 'voyage-large-2',          // 1536 dims, multilingual, ~5x cheaper than OpenAI
        defaultDim:   1536,
    },
    together: {
        baseUrl:      'https://api.together.xyz/v1',
        apiKeyEnv:    ['TOGETHER_API_KEY', 'SYMP_EMBED_API_KEY'],
        defaultModel: 'BAAI/bge-large-en-v1.5',  // 1024 dims — requires schema migration before use
        defaultDim:   1024,
    },
    custom: {
        baseUrl:      null,
        apiKeyEnv:    ['SYMP_EMBED_API_KEY'],
        defaultModel: null,
        defaultDim:   null,
    },
};

// Default model per (provider, task). Each provider exposes its best
// drop-in for the task. Override per-task with SYMP_LLM_MODEL_<TASK>.
const DEFAULT_MODELS = {
    openai: {
        chat:           'gpt-4o',
        classifier:     'gpt-4o-mini',
        summary:        'gpt-4o-mini',
        vision:         'gpt-4o-mini',
        hint:           'gpt-4o-mini',
        proactive:      'gpt-4o',
        ai_participant: 'gpt-4o-mini',
    },
    together: {
        chat:           'Qwen/Qwen2.5-72B-Instruct-Turbo',
        classifier:     'Qwen/Qwen2.5-7B-Instruct-Turbo',
        summary:        'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        vision:         'meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo',
        hint:           'Qwen/Qwen2.5-7B-Instruct-Turbo',
        proactive:      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        ai_participant: 'Qwen/Qwen2.5-7B-Instruct-Turbo',
    },
    fireworks: {
        chat:           'accounts/fireworks/models/qwen2p5-72b-instruct',
        classifier:     'accounts/fireworks/models/qwen2p5-7b-instruct',
        summary:        'accounts/fireworks/models/llama-v3p3-70b-instruct',
        vision:         'accounts/fireworks/models/llama-v3p2-11b-vision-instruct',
        hint:           'accounts/fireworks/models/qwen2p5-7b-instruct',
        proactive:      'accounts/fireworks/models/llama-v3p3-70b-instruct',
        ai_participant: 'accounts/fireworks/models/qwen2p5-7b-instruct',
    },
    openrouter: {
        chat:           'qwen/qwen-2.5-72b-instruct',
        classifier:     'qwen/qwen-2.5-7b-instruct',
        summary:        'meta-llama/llama-3.3-70b-instruct',
        vision:         'meta-llama/llama-3.2-11b-vision-instruct',
        hint:           'qwen/qwen-2.5-7b-instruct',
        proactive:      'meta-llama/llama-3.3-70b-instruct',
        ai_participant: 'qwen/qwen-2.5-7b-instruct',
    },
    deepinfra: {
        chat:           'Qwen/Qwen2.5-72B-Instruct',
        classifier:     'Qwen/Qwen2.5-7B-Instruct',
        summary:        'meta-llama/Llama-3.3-70B-Instruct',
        vision:         'meta-llama/Llama-3.2-11B-Vision-Instruct',
        hint:           'Qwen/Qwen2.5-7B-Instruct',
        proactive:      'meta-llama/Llama-3.3-70B-Instruct',
        ai_participant: 'Qwen/Qwen2.5-7B-Instruct',
    },
};

function pickEnv(keys) {
    for (const k of keys) {
        const v = process.env[k];
        if (v) return v;
    }
    return null;
}

function resolveLlmConfig() {
    const provider = (process.env.SYMP_LLM_PROVIDER || 'openai').toLowerCase();
    const cfg = LLM_PROVIDERS[provider];
    if (!cfg) {
        throw new InferenceError(`Unknown SYMP_LLM_PROVIDER: ${provider}`, { provider });
    }
    const baseUrl = process.env.SYMP_LLM_BASE_URL || cfg.baseUrl;
    if (!baseUrl) {
        throw new InferenceError(`SYMP_LLM_BASE_URL required when provider=${provider}`, { provider });
    }
    const apiKey = pickEnv(cfg.apiKeyEnv);
    if (!apiKey) {
        throw new InferenceError(
            `No API key for LLM provider=${provider} (tried env: ${cfg.apiKeyEnv.join(', ')})`,
            { provider },
        );
    }
    return { provider, baseUrl, apiKey };
}

function resolveEmbedConfig() {
    const provider = (process.env.SYMP_EMBED_PROVIDER || 'openai').toLowerCase();
    const cfg = EMBED_PROVIDERS[provider];
    if (!cfg) {
        throw new InferenceError(`Unknown SYMP_EMBED_PROVIDER: ${provider}`, { provider });
    }
    const baseUrl = process.env.SYMP_EMBED_BASE_URL || cfg.baseUrl;
    if (!baseUrl) {
        throw new InferenceError(`SYMP_EMBED_BASE_URL required when provider=${provider}`, { provider });
    }
    const apiKey = pickEnv(cfg.apiKeyEnv);
    if (!apiKey) {
        throw new InferenceError(
            `No API key for embed provider=${provider} (tried env: ${cfg.apiKeyEnv.join(', ')})`,
            { provider },
        );
    }
    return {
        provider,
        baseUrl,
        apiKey,
        defaultModel: cfg.defaultModel,
        defaultDim:   cfg.defaultDim,
    };
}

function resolveModel(task, provider) {
    const taskKey = `SYMP_LLM_MODEL_${String(task || 'chat').toUpperCase()}`;
    if (process.env[taskKey]) return process.env[taskKey];
    const map = DEFAULT_MODELS[provider] || DEFAULT_MODELS.openai;
    return map[task] || map.chat || DEFAULT_MODELS.openai.chat;
}

/**
 * OpenAI-compatible chat completion. Returns a normalised envelope:
 *   { content, usage, model_used, provider, latency_ms, raw }
 *
 * Throws InferenceError on HTTP failure. Caller decides whether to fall back
 * to a default response or surface the error.
 *
 * @param {Object}   opts
 * @param {string}   [opts.task='chat']
 * @param {Array}    opts.messages          OpenAI-style { role, content }[]
 * @param {number}   [opts.temperature=0.7]
 * @param {number}   [opts.max_tokens=800]
 * @param {Object}   [opts.response_format] e.g. { type: 'json_object' }
 * @param {AbortSignal} [opts.signal]       caller-provided abort
 * @param {string}   [opts.model_override]  explicit model id (skips resolver)
 * @param {number}   [opts.timeoutMs=30000] hard timeout for this call
 */
export async function chatComplete({
    task = 'chat',
    messages,
    temperature = 0.7,
    max_tokens = 800,
    response_format = null,
    signal = null,
    model_override = null,
    timeoutMs = 30000,
} = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new InferenceError('chatComplete: messages[] is required', { task });
    }

    const t0 = Date.now();
    const { provider, baseUrl, apiKey } = resolveLlmConfig();
    const model = model_override || resolveModel(task, provider);

    const body = { model, messages, temperature, max_tokens };
    if (response_format) body.response_format = response_format;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('inference timeout')), timeoutMs);
    const composed = signal ? anySignal([signal, ctrl.signal]) : ctrl.signal;

    let res;
    try {
        res = await fetch(`${baseUrl}/chat/completions`, {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type':  'application/json',
            },
            body:    JSON.stringify(body),
            signal:  composed,
        });
    } catch (e) {
        clearTimeout(timer);
        throw new InferenceError(`${provider} fetch failed: ${e.message}`, {
            provider, model, task, cause: e,
        });
    }
    clearTimeout(timer);

    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new InferenceError(`${provider} ${res.status}: ${errBody.slice(0, 240)}`, {
            provider, model, status: res.status, task,
        });
    }

    const data    = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    return {
        content,
        usage:      data?.usage || null,
        model_used: model,
        provider,
        latency_ms: Date.now() - t0,
        raw:        data,
    };
}

/**
 * OpenAI-compatible embeddings. Accepts a string or an array of strings.
 * Returns:
 *   { embedding, usage, model_used, provider, dim, expected_dim, latency_ms }
 *
 * For a single string input, `embedding` is a Float[]. For an array input,
 * `embedding` is a Float[][] in the same order.
 */
export async function embed({
    input,
    model_override = null,
    dimensions = null,
    timeoutMs = 30000,
} = {}) {
    if (input == null || input === '') {
        throw new InferenceError('embed: input is required', { task: 'embed' });
    }

    const t0 = Date.now();
    const { provider, baseUrl, apiKey, defaultModel, defaultDim } = resolveEmbedConfig();
    const model = model_override || process.env.SYMP_EMBED_MODEL || defaultModel;
    if (!model) {
        throw new InferenceError(
            `No embedding model resolved for provider=${provider}. Set SYMP_EMBED_MODEL.`,
            { provider, task: 'embed' },
        );
    }

    const body = { model, input };
    // OpenAI's text-embedding-3-* supports `dimensions` to truncate. Other
    // providers ignore it gracefully (or 400 if unsupported — we surface that).
    if (dimensions) body.dimensions = dimensions;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('inference timeout')), timeoutMs);

    let res;
    try {
        res = await fetch(`${baseUrl}/embeddings`, {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type':  'application/json',
            },
            body:    JSON.stringify(body),
            signal:  ctrl.signal,
        });
    } catch (e) {
        clearTimeout(timer);
        throw new InferenceError(`${provider} embed fetch failed: ${e.message}`, {
            provider, model, task: 'embed', cause: e,
        });
    }
    clearTimeout(timer);

    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new InferenceError(`${provider} embed ${res.status}: ${errBody.slice(0, 240)}`, {
            provider, model, status: res.status, task: 'embed',
        });
    }

    const data    = await res.json();
    const single  = !Array.isArray(input);
    const vectors = (data?.data || []).map(d => d.embedding).filter(Array.isArray);
    if (!vectors.length) {
        throw new InferenceError(`${provider} embed returned no vectors`, {
            provider, model, task: 'embed',
        });
    }
    return {
        embedding:    single ? vectors[0] : vectors,
        usage:        data?.usage || null,
        model_used:   model,
        provider,
        dim:          vectors[0].length,
        expected_dim: dimensions || defaultDim || null,
        latency_ms:   Date.now() - t0,
    };
}

/**
 * Cheap probe — surfaces the resolved provider config without leaking keys.
 * Useful for /health endpoints + debug pages.
 */
export function inferenceDiagnostics() {
    const out = { llm: null, embed: null };
    try {
        const c = resolveLlmConfig();
        out.llm = { provider: c.provider, base_url: c.baseUrl, has_key: !!c.apiKey };
    } catch (e) {
        out.llm = { error: e.message };
    }
    try {
        const c = resolveEmbedConfig();
        out.embed = {
            provider:      c.provider,
            base_url:      c.baseUrl,
            has_key:       !!c.apiKey,
            default_model: c.defaultModel,
            default_dim:   c.defaultDim,
        };
    } catch (e) {
        out.embed = { error: e.message };
    }
    return out;
}

export class InferenceError extends Error {
    constructor(message, meta = {}) {
        super(message);
        this.name = 'InferenceError';
        Object.assign(this, meta);
    }
}

// AbortSignal.any is Node 20+. Polyfill for Node 18 (Netlify default runtime).
function anySignal(signals) {
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
    const ctrl = new AbortController();
    for (const s of signals) {
        if (!s) continue;
        if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
        s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
    }
    return ctrl.signal;
}
