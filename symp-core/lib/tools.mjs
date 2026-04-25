// Symp.ai AI-Companion tool surface.
//
// Three tools exposed to the chat model in OpenAI function-calling format:
//
//   1. search_vault(query)        — semantic search over journals OLDER than the
//                                   3-day immediate-context window. Lets the
//                                   companion remember things the user told it
//                                   weeks ago without paying the prompt cost
//                                   of dumping every entry every turn.
//
//   2. get_live_context()         — current local time, day-of-week, and a
//                                   short Hyderabad weather snapshot. Powers
//                                   warm context-aware openings ("It's pretty
//                                   late on a Tuesday — long day?").
//
//   3. search_web(query)          — fallback for live data the model wouldn't
//                                   know (cricket scores, news, prices). Sub-
//                                   calls gpt-4o-search-preview internally so
//                                   answers stay grounded in real sources.
//
// Each tool ships its OpenAI JSONSchema definition + an async `execute(args)`
// that returns a STRING (since the chat model receives tool results as the
// `content` of a `role:'tool'` message — must be string-serialisable).
//
// All executors must NEVER throw — we catch internally and return an error
// string so the model can still produce a graceful answer.

import { fetchOlderJournals } from './supabase.mjs';

// ── 1. search_vault ────────────────────────────────────────────────────────

export const SEARCH_VAULT_DEF = {
    type: 'function',
    function: {
        name: 'search_vault',
        description:
            "Search the user's older journal entries (older than 3 days) for memories, " +
            'feelings, events, or topics they mentioned in the past. Use this when the user ' +
            'references something they told you before, or when older context would make ' +
            'your reply more grounded. Returns at most 5 matching entries with their dates.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Free-text search query. Use the topic or keyword the user mentioned ' +
                        '(e.g. "exam stress", "father", "promotion", "Goa trip").',
                },
            },
            required: ['query'],
        },
    },
};

async function execSearchVault({ userId, args }) {
    const query = String(args?.query || '').trim();
    if (!query) return 'No query provided.';
    if (!userId) return 'No user context — cannot search vault.';
    try {
        const rows = await fetchOlderJournals(userId, query, 5);
        if (!rows || rows.length === 0) {
            return `No older journal entries found matching "${query}".`;
        }
        return rows
            .map(r => `[${r.journal_date} · ${r.entry_type}] ${(r.summary_content || '').slice(0, 400)}`)
            .join('\n\n');
    } catch (e) {
        return `search_vault failed: ${e.message || e}`;
    }
}

// ── 2. get_live_context ────────────────────────────────────────────────────
// Open-Meteo is keyless and reliable for short weather snapshots. Default
// city: Hyderabad (most of our users). The model can pass `city` when the
// user has indicated they live elsewhere.

const CITY_COORDS = {
    hyderabad: { lat: 17.385,  lon: 78.4867, tz: 'Asia/Kolkata' },
    mumbai:    { lat: 19.076,  lon: 72.8777, tz: 'Asia/Kolkata' },
    delhi:     { lat: 28.6139, lon: 77.2090, tz: 'Asia/Kolkata' },
    bangalore: { lat: 12.9716, lon: 77.5946, tz: 'Asia/Kolkata' },
    chennai:   { lat: 13.0827, lon: 80.2707, tz: 'Asia/Kolkata' },
    kolkata:   { lat: 22.5726, lon: 88.3639, tz: 'Asia/Kolkata' },
};

export const GET_LIVE_CONTEXT_DEF = {
    type: 'function',
    function: {
        name: 'get_live_context',
        description:
            'Get the current local time, day of week, and a short weather snapshot for the ' +
            "user's city. Use this proactively at the start of a conversation to ground your " +
            "tone (e.g. acknowledge it's late, or that it's a Monday morning), or when the " +
            'user asks about time/weather. Defaults to Hyderabad.',
        parameters: {
            type: 'object',
            properties: {
                city: {
                    type: 'string',
                    description:
                        'Lower-cased city name. Supported: hyderabad, mumbai, delhi, bangalore, chennai, kolkata. ' +
                        'Defaults to hyderabad if omitted or unknown.',
                },
            },
        },
    },
};

async function execGetLiveContext({ args }) {
    const cityKey = String(args?.city || 'hyderabad').toLowerCase().trim();
    const coords  = CITY_COORDS[cityKey] || CITY_COORDS.hyderabad;
    const cityLabel = cityKey in CITY_COORDS
        ? cityKey.charAt(0).toUpperCase() + cityKey.slice(1)
        : 'Hyderabad';

    // Local time via Intl — no network required.
    let timeStr = '';
    let dayStr  = '';
    try {
        const now = new Date();
        timeStr = now.toLocaleTimeString('en-IN', { timeZone: coords.tz, hour: '2-digit', minute: '2-digit', hour12: true });
        dayStr  = now.toLocaleDateString('en-IN', { timeZone: coords.tz, weekday: 'long', day: 'numeric', month: 'short' });
    } catch (_) {
        timeStr = new Date().toISOString();
    }

    // Weather via Open-Meteo (keyless, fast). Soft-fail — time alone is still useful.
    let weatherStr = 'weather unavailable';
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,weather_code,relative_humidity_2m&timezone=${encodeURIComponent(coords.tz)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
        if (res.ok) {
            const data = await res.json();
            const c = data?.current || {};
            if (typeof c.temperature_2m === 'number') {
                weatherStr = `${Math.round(c.temperature_2m)}°C, ${weatherCodeLabel(c.weather_code)}, humidity ${c.relative_humidity_2m ?? '?'}%`;
            }
        }
    } catch (_) { /* ignore — weather is best-effort */ }

    return `City: ${cityLabel}\nLocal time: ${timeStr} (${dayStr})\nWeather: ${weatherStr}`;
}

// Subset of WMO weather codes — short human-readable labels.
function weatherCodeLabel(code) {
    if (code == null) return 'clear';
    if (code === 0) return 'clear';
    if (code <= 3)  return 'partly cloudy';
    if (code <= 48) return 'foggy';
    if (code <= 67) return 'rainy';
    if (code <= 77) return 'snowy';
    if (code <= 82) return 'showers';
    if (code <= 99) return 'thunderstorms';
    return 'mixed';
}

// ── 3. search_web ──────────────────────────────────────────────────────────
// Sub-calls gpt-4o-search-preview to ground the answer. We keep the call
// non-streaming and short; the parent chat model paraphrases the result.

export const SEARCH_WEB_DEF = {
    type: 'function',
    function: {
        name: 'search_web',
        description:
            'Search the live web for real-time information the model would not otherwise know: ' +
            'cricket / sports scores, breaking news, weather forecasts beyond today, prices, ' +
            'schedules, or any factual query about current events. Returns a short grounded summary.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The web-search query — phrase as a clear question.',
                },
            },
            required: ['query'],
        },
    },
};

async function execSearchWeb({ args }) {
    const query = String(args?.query || '').trim();
    if (!query) return 'No query provided.';

    const key = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!key) return 'search_web unavailable: no OpenAI key configured.';

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body:    JSON.stringify({
                model:    'gpt-4o-search-preview',
                messages: [
                    { role: 'system', content: 'Answer concisely (≤120 words) and ground the answer in live search results. Cite sources inline.' },
                    { role: 'user',   content: query },
                ],
                max_tokens: 350,
                web_search_options: { search_context_size: 'low' },
            }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            return `search_web failed (${res.status}): ${txt.slice(0, 200)}`;
        }
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content || '';
        return content || 'No result.';
    } catch (e) {
        return `search_web error: ${e.message || e}`;
    }
}

// ── Registry ───────────────────────────────────────────────────────────────

export const TOOL_DEFS = [SEARCH_VAULT_DEF, GET_LIVE_CONTEXT_DEF, SEARCH_WEB_DEF];

const EXECUTORS = {
    search_vault:     execSearchVault,
    get_live_context: execGetLiveContext,
    search_web:       execSearchWeb,
};

/**
 * Execute a tool call by name. ALWAYS returns a string (never throws).
 *
 * @param {string} name           — the function name from the model's tool_call
 * @param {Object} args           — parsed JSON args from the model
 * @param {Object} ctx            — { userId } injected by the chat handler
 * @returns {Promise<string>}     — content for the role:'tool' message
 */
export async function executeTool(name, args, ctx = {}) {
    const fn = EXECUTORS[name];
    if (!fn) return `Unknown tool: ${name}`;
    try {
        return await fn({ ...ctx, args });
    } catch (e) {
        return `Tool ${name} threw: ${e.message || e}`;
    }
}
