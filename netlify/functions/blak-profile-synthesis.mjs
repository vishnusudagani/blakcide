// POST /.netlify/functions/blak-profile-synthesis — (re)generate the user's
// "About you" narrative: the identity mirror at the top of /beta/profile (#36).
//
// Browser-called with the user's Supabase JWT. We resolve the user from the
// token (never trust a body user_id), read their knowledge via the service role,
// and write a short, warm, second-person reflection — NOT a list, NOT clinical.
// Only 'shared'/'blak_only' non-archived, non-never-raise facts feed it, so the
// mirror never surfaces something the user has walled off.
//
// The page reads the cached row (symp_profile_synthesis) directly via RLS; this
// function only generates + caches, then echoes the fresh narrative back.

import { corsPreflight, CORS_HEADERS } from '../../symp-core/lib/middleware.mjs';
import { verifySupabaseJwt, extractBearer } from '../../symp-core/lib/auth.mjs';
import { fetchKnowledgeFacts, fetchEntities, saveSynthesis } from '../../symp-core/lib/supabase.mjs';
import { chatCompleteFailover } from '../../symp-core/lib/llm-providers.mjs';

const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

const SYS = [
    'You write a short, warm "here\'s how I see you" reflection FOR the user, in SECOND PERSON ("You\'re someone who…"),',
    'drawn from what their AI friend "Blak" has come to know about them.',
    '',
    'STYLE:',
    '- 3–5 sentences. Affirming, specific, genuinely human. Flowing prose, NOT a list.',
    '- Mirror who they are AND who they\'re becoming (their goals, their growth).',
    '- Use their real specifics (names, places, interests) so it feels like them, not a horoscope.',
    '- NO therapy-speak, NO clinical or mental-health framing, no labels.',
    '- NEVER mention "facts", "data", "profile", "Blak", or that this text was generated.',
    '- If little is known, keep it short, kind, and open-ended.',
].join('\n');

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

    const token = extractBearer(req.headers.get('authorization') || req.headers.get('Authorization'));
    const auth = await verifySupabaseJwt(token);
    if (!auth.ok) return json({ ok: false, error: 'unauthorized', reason: auth.reason }, 401);
    const userId = auth.user_id;

    try {
        const [facts, entities] = await Promise.all([
            fetchKnowledgeFacts(userId).catch(() => []),
            fetchEntities(userId).catch(() => []),
        ]);

        // Only what the user hasn't walled off feeds the mirror.
        const usable = (facts || []).filter(f =>
            f && f.value && f.visibility !== 'private' && !f.archived && !f.never_raise);

        if (usable.length < 2 && (!entities || !entities.length)) {
            return json({ ok: true, narrative: null, fact_count: usable.length, reason: 'not_enough_yet' });
        }

        const lines = usable.map(f => `- ${f.label || f.key}: ${String(f.value).slice(0, 200)}`);
        const people = (entities || [])
            .filter(e => e.visibility !== 'private' && !e.never_raise)
            .slice(0, 10)
            .map(e => `- ${e.name}${e.role ? ` (${e.role})` : ''}${e.notes ? ` — ${e.notes}` : ''}`);

        const userMsg =
            `WHAT BLAK KNOWS:\n${lines.join('\n').slice(0, 3000)}` +
            (people.length ? `\n\nPEOPLE WHO MATTER:\n${people.join('\n').slice(0, 800)}` : '') +
            `\n\nWrite the reflection now.`;

        const out = await chatCompleteFailover(
            [{ role: 'system', content: SYS }, { role: 'user', content: userMsg }],
            { temperature: 0.6, maxTokens: 260, timeoutMs: 20000, tier: 'cheap' }
        );

        const narrative = (out.text || '').trim().slice(0, 1200);
        if (!narrative) return json({ ok: false, error: 'empty_generation' }, 502);

        await saveSynthesis({ userId, narrative, factCount: usable.length, model: out.model || null });
        return json({ ok: true, narrative, fact_count: usable.length, generated_at: new Date().toISOString() });
    } catch (e) {
        return json({ ok: false, error: 'failed', detail: e && e.message }, 500);
    }
};
