// Open-source LLM provider router for the Netlify (Node) chat path.
//
// This is the Node/streaming sibling of the Deno router in
// supabase/functions/_shared/llm.ts. Same idea: every provider here is
// OpenAI-Chat-Completions-compatible and serves an OPEN-SOURCE model
// (Qwen 2.5 72B, with Llama 3.3 70B as the always-free floor). Because the
// wire format is identical to OpenAI's — including streaming SSE and
// function/tool-calling deltas — the existing chat-runner can talk to any of
// them by only swapping {baseUrl, model, apiKey}. No OpenAI anywhere.
//
// Priority order: quality-first (Qwen 72B hosts), with Groq's Llama kept LAST
// as a zero-cost downtime floor. A provider with no key in the environment is
// silently skipped, so the same router serves "only GROQ+OPENROUTER set today"
// and "all five set later" with no code change.
//
// Env vars (set whichever you have; the rest are skipped):
//   OPENROUTER_API_KEY   — OpenRouter (serves Qwen 2.5 72B + many others)
//   TOGETHER_API_KEY     — Together.ai
//   FIREWORKS_API_KEY    — Fireworks.ai
//   DEEPINFRA_API_KEY    — DeepInfra
//   GROQ_API_KEY         — Groq (Llama 3.3 70B, free tier, downtime floor)

const env = (k) => process.env[k] || undefined;

/**
 * Ordered, env-filtered list of OpenAI-compatible providers serving an
 * open-source model. First entry with a key wins; the runner falls through
 * to the next on connection error / 5xx / 429 / empty completion.
 *
 * `supportsTools` flags whether we trust the host's streaming tool-call
 * deltas. All current entries do; kept explicit so a future tool-less host
 * can be added for plain chat without breaking the tool loop.
 *
 * @returns {Array<{id,baseUrl,model,apiKey,supportsTools,headers?}>}
 */
export function chatProviders() {
    const all = [
        {
            id: 'together',
            baseUrl: 'https://api.together.xyz/v1/chat/completions',
            model: 'Qwen/Qwen2.5-72B-Instruct-Turbo',
            apiKey: env('TOGETHER_API_KEY'),
            supportsTools: true,
        },
        {
            id: 'fireworks',
            baseUrl: 'https://api.fireworks.ai/inference/v1/chat/completions',
            model: 'accounts/fireworks/models/qwen2p5-72b-instruct',
            apiKey: env('FIREWORKS_API_KEY'),
            supportsTools: true,
        },
        {
            id: 'deepinfra',
            baseUrl: 'https://api.deepinfra.com/v1/openai/chat/completions',
            model: 'Qwen/Qwen2.5-72B-Instruct',
            apiKey: env('DEEPINFRA_API_KEY'),
            supportsTools: true,
        },
        {
            id: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
            model: 'qwen/qwen-2.5-72b-instruct',
            apiKey: env('OPENROUTER_API_KEY'),
            supportsTools: true,
            // OpenRouter likes (optional) attribution headers.
            headers: {
                'HTTP-Referer': 'https://blaksyd.com',
                'X-Title': 'Blaksyd Blak',
            },
        },
        {
            // Free tier, no card. Strong Hindi/Telugu. Kept LAST as the floor.
            id: 'groq',
            baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
            model: 'llama-3.3-70b-versatile',
            apiKey: env('GROQ_API_KEY'),
            supportsTools: true,
        },
    ];
    return all.filter((p) => !!p.apiKey);
}

/** Append OpenRouter's `:online` web-search plugin suffix to a model id. */
export function onlineModel(model) {
    return model.endsWith(':online') ? model : `${model}:online`;
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Non-streaming completion with provider failover. Used by tools that need a
 * quick grounded answer (e.g. the open-source search_web). Mirrors llm.ts.
 *
 * @param {Array<{role,content}>} messages
 * @param {Object} [opts]
 * @param {number} [opts.temperature=0.6]
 * @param {number} [opts.maxTokens=400]
 * @param {boolean} [opts.online=false]   route through OpenRouter :online if available
 * @param {number} [opts.timeoutMs=20000]
 * @returns {Promise<{text,provider,model}>}
 */
export async function chatCompleteFailover(messages, opts = {}) {
    const { temperature = 0.6, maxTokens = 400, online = false, timeoutMs = 20_000 } = opts;

    let providers = chatProviders();
    // For online/web-grounded calls, prefer OpenRouter (it has the web plugin).
    if (online) {
        const or = providers.find((p) => p.id === 'openrouter');
        providers = or ? [or, ...providers.filter((p) => p.id !== 'openrouter')] : providers;
    }
    if (providers.length === 0) throw new Error('No open-source LLM provider keys configured.');

    const errors = [];
    for (const p of providers) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const model = online && p.id === 'openrouter' ? onlineModel(p.model) : p.model;
            const res = await fetch(p.baseUrl, {
                method: 'POST',
                signal: ctrl.signal,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${p.apiKey}`,
                    ...(p.headers || {}),
                },
                body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
            });
            if (!res.ok) {
                errors.push(`${p.id}:${res.status}`);
                if (RETRYABLE.has(res.status) || res.status >= 400) continue;
            }
            const data = await res.json();
            const text = data?.choices?.[0]?.message?.content?.trim() || '';
            if (!text) { errors.push(`${p.id}:empty`); continue; }
            return { text, provider: p.id, model };
        } catch (e) {
            errors.push(`${p.id}:${(e?.message || e).toString().slice(0, 60)}`);
            continue;
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`All LLM providers failed → ${errors.join(', ')}`);
}
