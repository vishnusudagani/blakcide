// Background worker for the WhatsApp (Blak) channel.
//
// Invoked (POST) by whatsapp-webhook.mjs with the raw Meta payload + an internal
// auth header. Netlify treats *-background functions as async (returns 202 to the
// caller, runs up to 15 min) — so slow LLM / learning steps never trip a
// sync-function timeout.
//
// Pipeline: dedup(wamid) → auto-create phone identity → voice/image → text
// (in-process, no HTTP self-call) → load thread history → run Blak IN-PROCESS
// (buildChatSystemStack + chatCompleteFailover — the SAME brain the web chat uses)
// → persist → send via Cloud API → THEN fire knowledge-extraction + rolling-memory
// (reply goes out before learning, so the user always gets the reply).

import {
    getOrCreateIdentity, persistMessage, loadThreadHistory,
    touchInbound, touchOutbound, isNewEvent, markConsentNoted,
    sendText, downloadMedia,
} from '../../symp-core/lib/whatsapp.mjs';
import { buildChatSystemStack } from '../../symp-core/lib/system-prompt.mjs';
import { chatCompleteFailover }  from '../../symp-core/lib/llm-providers.mjs';
import { extractKnowledge }      from '../../symp-core/lib/knowledge-extractor.mjs';
import { updateRollingMemory }   from '../../symp-core/lib/memory-updater.mjs';

// Subtle, on-brand first-contact note (+ privacy link). Sent once per identity.
const FIRST_TOUCH_NOTE =
    "hey — you're talking to Blak from Blaksyd 🖤 quick note on how I look after your stuff: https://blaksyd.com/privacy";

export default async (req) => {
    if ((req.headers.get('x-wa-internal') || '') !== (process.env.SYMP_API_KEY || '')) {
        return new Response('forbidden', { status: 403 });
    }
    let payload;
    try { payload = await req.json(); } catch (_) { return new Response('bad json', { status: 400 }); }
    try { await handleEvent(payload); }
    catch (e) { console.error('[wa-bg] handler error:', e?.message || e); }
    return new Response('ok', { status: 200 });
};

async function handleEvent(payload) {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const msg   = value?.messages?.[0];
    if (!msg) return;                                   // delivery/read status events → ignore

    const phone  = msg.from;
    const wamid  = msg.id;
    const kind   = msg.type;
    const waName = value?.contacts?.[0]?.profile?.name || null;

    if (!(await isNewEvent(wamid, phone, kind))) return; // idempotency

    const id = await getOrCreateIdentity(phone, waName);
    await touchInbound(phone);

    const userText = await extractText(msg, kind);
    if (!userText) {
        await sendText(phone, "i can do text, voice notes and pics for now — send me one of those 🙂");
        await touchOutbound(phone);
        return;
    }

    await persistMessage({ chatId: id.chatId, role: 'user', content: userText, mediaType: kind !== 'text' ? kind : null });

    const history  = await loadThreadHistory(id.chatId, 16);
    const messages = history.length ? history : [{ role: 'user', content: userText }];

    let reply = '';
    try { reply = await runBlak(id.userId, messages, userText); }
    catch (e) { console.error('[wa-bg] brain failed:', e?.message || e); }
    if (!reply) reply = "mm my head went quiet for a sec — say that again? 🙂";

    const consentNoted = !!id.identity?.consent_noted_at;
    const outbound = !consentNoted ? `${FIRST_TOUCH_NOTE}\n\n${reply}` : reply;
    if (!consentNoted) await markConsentNoted(phone);

    await persistMessage({ chatId: id.chatId, role: 'ai', content: reply });
    await sendText(phone, outbound);                    // ← reply is delivered HERE
    await touchOutbound(phone);

    // Learn from the turn — same as the web chat endpoint. Runs AFTER the reply is
    // sent; bounded, and the 15-min background budget means it never races the reply.
    await Promise.race([
        Promise.allSettled([
            extractKnowledge(id.userId, { userText, assistantText: reply }),
            updateRollingMemory(id.userId, { userText, assistantText: reply }),
        ]),
        new Promise((r) => setTimeout(r, 12000)),
    ]);
}

// Run the SAME brain the web chat uses, in-process (no HTTP self-call).
async function runBlak(userId, messages, latestUserText) {
    let systemStack = [];
    try { systemStack = await buildChatSystemStack(userId, { latestUserText }); }
    catch (e) { console.warn('[wa-bg] system-stack build failed:', e?.message || e); }
    const finalMessages = [...systemStack, ...messages];
    const { text } = await chatCompleteFailover(finalMessages, {
        tier: 'quality', maxTokens: 600, temperature: 0.9, timeoutMs: 25000,
    });
    return (text || '').trim();
}

// text | audio (voice note) | image → plain text Blak can read. All in-process.
async function extractText(msg, kind) {
    if (kind === 'text') return msg.text?.body?.trim() || '';

    if (kind === 'audio' || kind === 'voice') {
        const mediaId = msg.audio?.id || msg.voice?.id;
        if (!mediaId) return '';
        try {
            const { buffer, mimeType } = await downloadMedia(mediaId);
            return await transcribeAudio(buffer, mimeType);
        } catch (e) { console.error('[wa-bg] transcribe failed:', e?.message || e); return ''; }
    }

    if (kind === 'image') {
        const mediaId = msg.image?.id;
        const caption = msg.image?.caption?.trim() || '';
        if (!mediaId) return caption;
        try {
            const { buffer, mimeType } = await downloadMedia(mediaId);
            const desc = await describeImage(`data:${mimeType};base64,${buffer.toString('base64')}`);
            return caption ? `${caption}\n\n[shared a photo: ${desc}]` : `[shared a photo: ${desc}]`;
        } catch (e) { console.error('[wa-bg] vision failed:', e?.message || e); return caption || ''; }
    }

    return '';                                          // sticker / location / contact / etc.
}

// Whisper transcription (OpenAI), mirroring netlify/functions/symp-v1-transcribe.mjs.
async function transcribeAudio(buffer, mimeType) {
    const key = process.env.BLAKCIDE_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!key) return '';
    const ext = !mimeType                 ? 'ogg'
              : mimeType.includes('ogg')  ? 'ogg'
              : mimeType.includes('m4a')  ? 'm4a'
              : mimeType.includes('mp4')  ? 'm4a'
              : mimeType.includes('mpeg') ? 'mp3'
              : mimeType.includes('wav')  ? 'wav'
              :                             'ogg';
    const form = new FormData();
    form.append('file',  new Blob([buffer], { type: mimeType || 'audio/ogg' }), `audio.${ext}`);
    form.append('model', 'whisper-1');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
    });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.text || '').trim();
}

// Multimodal image description via Azure gpt-4.1-mini, mirroring symp-v1-vision.mjs.
async function describeImage(imageUrl) {
    const ep = process.env.AZURE_OPENAI_ENDPOINT, dep = process.env.AZURE_OPENAI_DEPLOYMENT, key = process.env.AZURE_OPENAI_API_KEY;
    if (!ep || !dep || !key) return 'an image';
    const ver = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
    const url = ep.replace(/\/+$/, '') + '/openai/deployments/' + dep + '/chat/completions?api-version=' + ver;
    const PROMPT = 'Describe this image in 1–3 natural sentences, casual, like a friend describing a photo. No "I see".';
    try {
        const r = await fetch(url, {
            method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'user', content: [
                    { type: 'text', text: PROMPT },
                    { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
                ] }],
                max_tokens: 200, temperature: 0.7,
            }),
        });
        if (!r.ok) return 'an image';
        const d = await r.json();
        return d?.choices?.[0]?.message?.content?.trim() || 'an image';
    } catch (_) { return 'an image'; }
}

// Background functions are invoked at /.netlify/functions/whatsapp-webhook-background
// (the sync dispatcher calls that path). No config.path needed.
