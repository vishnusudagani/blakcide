// POST /api/symp/v1/persona-generate — draft a fantasy persona from a short
// description, or improve a single field. Returns { ok, data }.
//
//   { mode:"generate", description:"a calm philosophy-loving friend named Aarav" }
//     → { name, tagline, purpose, traits[], backstory, voice_tone, voice, languages[], avatar_style }
//   { mode:"improve", field:"backstory"|"voice_tone"|"tagline", value, name } → { text }

import {
    corsPreflight, getRequestId, validateApiKey, jsonError, readJson,
    logAccess, CORS_HEADERS,
} from '../../symp-core/lib/middleware.mjs';
import { chatCompleteFailover } from '../../symp-core/lib/llm-providers.mjs';
import SympContract from '../../symp-core/contract/endpoints.js';

const { ERROR_CODES, SYMP_REQUEST_ID_HEADER } = SympContract;

const PURPOSES = ['ai_friend', 'study_buddy', 'hype', 'coach', 'roleplay', 'custom'];
const VOICES   = ['Aoede', 'Kore', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus'];
const STYLES   = ['adventurer', 'fun-emoji', 'big-smile', 'open-peeps', 'notionists', 'lorelei', 'micah', 'thumbs', 'bottts', 'pixel-art'];
const LANGS    = ['en', 'hi', 'te', 'ta', 'kn', 'ml', 'bn', 'mr', 'gu', 'pa'];

const GEN_SYS = [
    'You design a fantasy AI-companion persona from a short description, for an app where people create characters to talk to.',
    'Return STRICT JSON only — no prose, no markdown fences:',
    '{"name":"","tagline":"","purpose":"","traits":[],"backstory":"","voice_tone":"","voice":"","languages":[],"avatar_style":""}',
    'Rules:',
    '- name: a fitting first name or short handle.',
    '- tagline: <= 70 characters, warm and specific.',
    '- purpose: EXACTLY ONE of ' + PURPOSES.join(', ') + '.',
    '- traits: 3-6 short personality words/phrases (e.g. "Empathetic", "Dry humour", "Night owl").',
    '- backstory: 2-3 warm sentences about who they are and what they love.',
    '- voice_tone: ONE sentence on how they talk.',
    '- voice: EXACTLY ONE of ' + VOICES.join(', ') + ' — pick what fits (Charon = deep/calm, Aoede/Leda = warm female, Zephyr = bright, Puck = playful, Fenrir = lively, Orus = steady).',
    '- languages: array from ' + LANGS.join(', ') + '; default ["en"] unless the description implies others.',
    '- avatar_style: EXACTLY ONE of ' + STYLES.join(', ') + '.',
    '- Keep it friendly and non-explicit. Match the requested vibe closely.',
].join('\n');

function parseJson(raw) {
    let s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j < 0 || j < i) return null;
    try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
}
const pick = (v, allow, def) => (typeof v === 'string' && allow.includes(v)) ? v : def;

export default async (req) => {
    if (req.method === 'OPTIONS') return corsPreflight();
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405 });

    const t0 = Date.now();
    const requestId = getRequestId(req);
    const auth = validateApiKey(req, requestId);
    if (!auth.ok) return auth.response;

    const parsed = await readJson(req);
    if (!parsed.ok) return jsonError(ERROR_CODES.BAD_REQUEST, 'Invalid JSON body', 400, requestId);
    const { user_id, mode, description, field, value, name } = parsed.data || {};

    const ok = (data) => new Response(
        JSON.stringify({ ok: true, data, request_id: requestId }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', [SYMP_REQUEST_ID_HEADER]: requestId } }
    );

    try {
        if (mode === 'improve') {
            const f = String(field || '').trim();
            const labels = { backstory: 'backstory & bio', voice_tone: 'voice & tone instructions', tagline: 'one-line tagline' };
            const lbl = labels[f] || 'text';
            const out = await chatCompleteFailover([
                { role: 'system', content: 'You polish one field of an AI-persona profile. Rewrite the provided ' + lbl + ' to be vivid, warm and concise' + (f === 'tagline' ? ' (<= 70 characters)' : '') + '. Output ONLY the rewritten text — no quotes, no preamble, no explanation.' },
                { role: 'user',   content: 'Persona: ' + (name || '(unnamed)') + '\nCurrent ' + lbl + ': ' + String(value || '').slice(0, 600) },
            ], { temperature: 0.7, maxTokens: f === 'tagline' ? 40 : 220, timeoutMs: 15000 });
            const text = (out.text || '').trim().replace(/^["'`\s]+|["'`\s]+$/g, '');
            logAccess({ requestId, endpoint: 'persona-generate', statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
            return ok({ text });
        }

        const desc = String(description || '').trim().slice(0, 500);
        if (!desc) return jsonError(ERROR_CODES.BAD_REQUEST, 'description is required', 400, requestId);
        const out = await chatCompleteFailover([
            { role: 'system', content: GEN_SYS },
            { role: 'user',   content: 'Describe-to-persona: ' + desc },
        ], { temperature: 0.85, maxTokens: 500, timeoutMs: 18000 });
        const j = parseJson(out.text) || {};
        const data = {
            name:        String(j.name || '').trim().slice(0, 40),
            tagline:     String(j.tagline || '').trim().slice(0, 70),
            purpose:     pick(j.purpose, PURPOSES, 'ai_friend'),
            traits:      Array.isArray(j.traits) ? j.traits.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : [],
            backstory:   String(j.backstory || '').trim().slice(0, 600),
            voice_tone:  String(j.voice_tone || '').trim().slice(0, 300),
            voice:       pick(j.voice, VOICES, 'Aoede'),
            languages:   Array.isArray(j.languages) ? j.languages.map((l) => String(l).toLowerCase().slice(0, 2)).filter((l) => LANGS.includes(l)) : [],
            avatar_style: pick(j.avatar_style, STYLES, 'adventurer'),
        };
        if (!data.languages.length) data.languages = ['en'];
        logAccess({ requestId, endpoint: 'persona-generate', statusCode: 200, latencyMs: Date.now() - t0, userId: user_id });
        return ok(data);
    } catch (e) {
        logAccess({ requestId, endpoint: 'persona-generate', statusCode: 502, latencyMs: Date.now() - t0, userId: user_id, errorCode: 'UPSTREAM_FAILED' });
        return jsonError(ERROR_CODES.UPSTREAM_FAILED, 'Generation failed: ' + (e.message || e), 502, requestId);
    }
};

export const config = { path: '/api/symp/v1/persona-generate' };
