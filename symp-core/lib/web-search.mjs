// Live web search via Tavily — LLM-optimized search with a generous free tier.
// Powers Blak's search_web tool (current events, prices, where-to-watch a movie,
// opening hours, place reviews, etc.). Dep-free (fetch only). Degrades to null
// when TAVILY_API_KEY is unset, so the tool falls back to a hedged model answer
// instead of fabricating.

const TAVILY_KEY = process.env.TAVILY_API_KEY || '';

export function webSearchConfigured() { return !!TAVILY_KEY; }

// Returns { answer, results: [{ title, url, content }] } or null if unconfigured.
// Throws on a transport/API error (the caller falls back gracefully).
export async function tavilySearch(query, { maxResults = 5, timeoutMs = 9000 } = {}) {
    if (!TAVILY_KEY) return null;
    const q = String(query || '').trim().slice(0, 400);
    if (!q) return null;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: TAVILY_KEY,
                query: q,
                search_depth: 'basic',
                include_answer: true,
                max_results: Math.min(Math.max(1, maxResults), 8),
            }),
            signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`tavily ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
        const d = await r.json();
        return { answer: d.answer || '', results: Array.isArray(d.results) ? d.results : [] };
    } finally {
        clearTimeout(to);
    }
}
