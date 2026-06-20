// POST /api/symp/v1/group-mediate — Blak as the ACTIVE MEDIATOR of a group room.
//
// Called by a member's client after they post a message. Blak reads the recent
// room transcript and decides whether to chime in (addressed, a hanging question,
// tension to soften, someone left out) — otherwise it stays silent. When it does
// speak, the reply is inserted server-side (service role) into blak_group_messages
// and reaches everyone via Supabase Realtime.
//
// Security: the proxy injects the authenticated user_id; we verify they're a
// member of the room before doing anything. Rate-limited per-room (cooldown) so
// Blak never spams a fast-moving chat.

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import { chatCompleteFailover } from '../../symp-core/lib/llm-providers.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BLAK_COOLDOWN_MS = 8000;   // at most one Blak line per room per ~8s

async function sbGet(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!r.ok) return [];
    return r.json().catch(() => []);
}
async function sbPost(table, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(body),
    });
    return r.ok ? r.json().catch(() => null) : null;
}

const SYS = [
    'You are Blak — a warm, real presence in a small private group chat (friends in a room together). You are the group\'s quiet host and mediator, NOT an assistant and NOT a therapist.',
    'Reply ONLY when you would genuinely add something: someone addresses you ("blak"), a real question is hanging unanswered, things get tense and need softening, or someone is being left out and you can bring them in. If none of that applies, output EXACTLY the token <silent> and nothing else.',
    'When you DO speak: ONE short, natural line — lowercase, casual, like a friend in the group. Use people\'s names when it helps. Never lecture, never moderate heavy-handedly, never reveal you are an AI, never claim to be human. Keep the room warm and inclusive.',
].join('\n');

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 });

    const requestId = getRequestId(req);
    const auth = validateApiKey(req, requestId);
    if (!auth.ok) return auth.response;

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);
    const { user_id, room_id } = parsed.data || {};

    const ok = (data) => new Response(
        JSON.stringify({ ok: true, data, request_id: requestId }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
    );

    if (!user_id || !room_id || !SUPABASE_URL || !SERVICE_KEY) return ok({ said: null });

    try {
        // 1. Membership guard — only members can trigger the room's mediator.
        const mem = await sbGet(`blak_group_members?room_id=eq.${room_id}&user_id=eq.${user_id}&select=user_id&limit=1`);
        if (!Array.isArray(mem) || !mem.length) return jsonError(ERROR_CODES.FORBIDDEN || 'FORBIDDEN', 'Not a member of this room', 403, requestId);

        // 2. Room must be active.
        const room = await sbGet(`blak_group_rooms?id=eq.${room_id}&select=status&limit=1`);
        if (!room[0] || room[0].status !== 'active') return ok({ said: null });

        // 3. Cooldown — don't let Blak pile on a fast chat.
        const lastBlak = await sbGet(`blak_group_messages?room_id=eq.${room_id}&sender_role=eq.blak&select=created_at&order=created_at.desc&limit=1`);
        if (lastBlak[0] && (Date.now() - new Date(lastBlak[0].created_at).getTime()) < BLAK_COOLDOWN_MS) return ok({ said: null, skipped: 'cooldown' });

        // 4. Recent transcript for context (oldest→newest).
        const recent = (await sbGet(`blak_group_messages?room_id=eq.${room_id}&select=sender_role,display_name,content&order=created_at.desc&limit=10`)).reverse();
        if (!recent.length) return ok({ said: null });
        const transcript = recent.map((m) => `${m.sender_role === 'blak' ? 'Blak' : (m.display_name || 'Someone')}: ${m.content}`).join('\n');

        // 5. Ask Blak whether/how to chime in.
        const out = await chatCompleteFailover([
            { role: 'system', content: SYS },
            { role: 'user',   content: `Group chat so far:\n${transcript}\n\nReply as Blak with ONE short line, or output <silent> if you should stay quiet right now.` },
        ], { temperature: 0.8, maxTokens: 70, timeoutMs: 12000, tier: 'cheap' });

        let text = (out.text || '').trim();
        if (!text || /<silent>/i.test(text) || text.length < 2) return ok({ said: null });
        text = text.replace(/^["'`]+|["'`]+$/g, '').slice(0, 400);

        // 6. Post as Blak (service role bypasses RLS). Realtime fans it out.
        await sbPost('blak_group_messages', { room_id, user_id: null, sender_role: 'blak', display_name: 'Blak', content: text });
        return ok({ said: text });
    } catch (e) {
        return ok({ said: null });   // mediator is best-effort — never break the chat
    }
};

export const config = { path: '/api/symp/v1/group-mediate' };
