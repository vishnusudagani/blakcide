// Post-session summariser. Takes a completed transcript and produces a
// 2–4 paragraph first-person journal entry plus a best-effort extraction of
// names / emotions / times / specifics.
//
// Routed through the inference router. Default task=summary → gpt-4o-mini.
// Switch with SYMP_LLM_PROVIDER or SYMP_LLM_MODEL_SUMMARY.
//
// Output contract:
//   { summary: string, extracted: { names, emotions, times, specifics } }

import { chatComplete } from './inference.mjs';

const SYSTEM_PROMPT = `You are Symp.ai's post-session journaler.
Read the transcript of a completed session between a user and either the Blaksyd AI companion or a human listener, and produce a concise first-person journal entry from the USER's perspective (2–4 short paragraphs). Capture emotional arc, what they opened up about, and anything they committed to or resolved.

Also extract structured signals — do your best and leave arrays empty if nothing is clearly present. Do NOT invent details.

Return STRICT JSON matching this shape (no prose, no markdown fence):
{
  "summary": "first-person journal text",
  "extracted": {
    "names":     ["..."],
    "emotions":  ["..."],
    "times":     ["..."],
    "specifics": ["..."]
  }
}`;

function flattenTranscript(transcript) {
    if (!Array.isArray(transcript)) return '';
    return transcript
        .filter(m => m && m.content)
        .map(m => {
            const role = m.role || 'user';
            const ts   = m.ts ? ` [${m.ts}]` : '';
            return `${role}${ts}: ${m.content}`;
        })
        .join('\n');
}

function safeParseJson(text) {
    if (!text) return null;
    // Model sometimes wraps in ```json fences despite instructions
    const stripped = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(stripped); } catch { return null; }
}

export async function summariseSession({ sessionType, transcript, startedAt, endedAt }) {
    const flat = flattenTranscript(transcript);
    if (!flat) {
        return { summary: '', extracted: { names: [], emotions: [], times: [], specifics: [] } };
    }

    const userPrompt = [
        `Session type: ${sessionType}`,
        startedAt ? `Started: ${startedAt}` : null,
        endedAt   ? `Ended: ${endedAt}`     : null,
        '',
        '--- TRANSCRIPT ---',
        flat,
        '--- END TRANSCRIPT ---',
    ].filter(Boolean).join('\n');

    const out = await chatComplete({
        task:            'summary',
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens:  800,
    });

    const content = out.content;
    const parsed  = safeParseJson(content);

    if (!parsed || typeof parsed.summary !== 'string') {
        // Fall back to raw content as the summary so ingest isn't blocked.
        return {
            summary:   typeof content === 'string' ? content : '',
            extracted: { names: [], emotions: [], times: [], specifics: [] },
        };
    }

    return {
        summary: parsed.summary,
        extracted: {
            names:     Array.isArray(parsed.extracted?.names)     ? parsed.extracted.names     : [],
            emotions:  Array.isArray(parsed.extracted?.emotions)  ? parsed.extracted.emotions  : [],
            times:     Array.isArray(parsed.extracted?.times)     ? parsed.extracted.times     : [],
            specifics: Array.isArray(parsed.extracted?.specifics) ? parsed.extracted.specifics : [],
        },
    };
}
