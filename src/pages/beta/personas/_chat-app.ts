// Fantasy-persona chat — text + voice call, talking to ONE persona.
// External module (underscore = not a route), imported by chat.astro.
//
// Reuses the proven Blak chat backend: text streams from /api/blaksyd/symp/chat
// and calls from /api/gemini-live-session — both now take a persona_id so the
// reply IS the persona (its prompt + its voice). One ongoing conversation per
// persona (a single `chats` row with persona_id set); messages persist under RLS.
import { supabase } from '../../../lib/supabaseClient';

const $ = (id: string) => document.getElementById(id) as any;
const personaId = new URLSearchParams(location.search).get('id');
const shareCode = new URLSearchParams(location.search).get('s');  // present → guest, gated by this code
let isGuest = false;
const MAX_TURNS = 24;

let persona: any = null;
let userId: string | null = null;
let activeChatId: string | null = null;
let history: any[] = [];
let sending = false;
let controller: AbortController | null = null;
let atBottom = true;

const stream = $('pc-stream'), input = $('pc-input'), form = $('pc-form');
const sendBtn = $('pc-send'), stopBtn = $('pc-stop');

function avatarUrl(av: any) {
  av = av || {};
  if (av.type === 'image' && av.url) return av.url;
  const qs = new URLSearchParams(Object.assign({ seed: av.seed || 'blak' }, av.options || {})).toString();
  return 'https://api.dicebear.com/9.x/' + encodeURIComponent(av.style || 'adventurer') + '/svg?' + qs;
}
const esc = (s: any) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
const fmtTime = (ts: number) => { try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
async function getToken() { try { return (await supabase!.auth.getSession()).data?.session?.access_token || null; } catch { return null; } }

// ── Hear a reply in the persona's voice (reuses the /tts bridge: { voice, text } → WAV) ──
let ttsUrl: string | null = null;
let curAudio: HTMLAudioElement | null = null;
const SPK_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
async function deriveTtsUrl() {
  try {
    const jwt = await getToken();
    const r = await fetch('/api/gemini-live-session', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (jwt || '') }, body: '{}' });
    const j = await r.json().catch(() => null);
    if (j && j.wsUrl) ttsUrl = j.wsUrl.replace(/^wss:/, 'https:').replace(/\/live$/, '/tts');
  } catch (e) { /* voice unavailable — button is a silent no-op */ }
}
function stopReply() {
  if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; }
  document.querySelectorAll('.pc-speak').forEach((b: any) => { b.style.opacity = '.6'; b.style.color = ''; });
}
async function speakReply(text: string, btn: any) {
  text = (text || '').trim();
  if (!text) return;
  if (btn.dataset.on === '1') { stopReply(); return; }
  stopReply();
  if (!ttsUrl) { await deriveTtsUrl(); if (!ttsUrl) return; }
  btn.dataset.on = '1'; btn.style.opacity = '1'; btn.style.color = '#ff6b5e';
  const reset = () => { btn.dataset.on = ''; btn.style.opacity = '.6'; btn.style.color = ''; };
  try {
    const jwt = await getToken();
    const r = await fetch(ttsUrl!, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt }, body: JSON.stringify({ voice: persona?.voice || 'Aoede', text }) });
    const j = await r.json().catch(() => null);
    if (j && j.audio) {
      curAudio = new Audio('data:audio/wav;base64,' + j.audio);
      curAudio.onended = reset; curAudio.onerror = reset;
      curAudio.play().catch(reset);
    } else { reset(); }
  } catch (e) { reset(); }
}
// In-chat tuning: a quick note → appended to the persona's `corrections`, which the
// system prompt always honors. Persona is re-fetched server-side each turn, so the
// very next reply obeys it.
const TUNE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>';
async function tuneReply(btn: any) {
  const note = (window.prompt('Tune ' + (persona?.name || 'this persona') + ' — how should they be? A short note sticks for next time.\n(e.g. "shorter replies", "more sarcastic", "less formal", "use more Telugu")') || '').trim();
  if (!note || !personaId || !supabase) return;
  const prev = (persona && persona.corrections) ? String(persona.corrections) : '';
  const next = ((prev ? prev + '\n' : '') + '- ' + note).slice(0, 4000);
  btn.style.opacity = '1';
  try {
    const { error } = await supabase.from('fantasy_personas').update({ corrections: next }).eq('id', personaId);
    if (!error) { if (persona) persona.corrections = next; btn.innerHTML = '✓'; setTimeout(() => { btn.innerHTML = TUNE_ICON; btn.style.opacity = '.6'; }, 1600); }
    else btn.style.opacity = '.6';
  } catch (e) { btn.style.opacity = '.6'; }
}
function addSpeakBtn(h: any) {
  if (!h || !h.col || h.col.querySelector('.pc-speak')) return;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'pc-speak';
  b.setAttribute('aria-label', 'Hear it in ' + (persona?.name || 'their') + ' voice');
  b.style.cssText = 'display:inline-flex;align-items:center;margin-top:.25rem;margin-right:.15rem;padding:.1rem .3rem;border:none;background:transparent;color:inherit;opacity:.6;cursor:pointer;border-radius:6px;';
  b.innerHTML = SPK_ICON;
  b.onclick = () => speakReply(h.bub.textContent || '', b);
  h.col.appendChild(b);
  // Tuning edits the OWNER's persona — guests can't (and RLS would block it anyway).
  if (!isGuest) {
    const tb = document.createElement('button');
    tb.type = 'button'; tb.className = 'pc-tune';
    tb.setAttribute('aria-label', 'Tune ' + (persona?.name || 'this persona'));
    tb.style.cssText = b.style.cssText;
    tb.innerHTML = TUNE_ICON;
    tb.onclick = () => tuneReply(tb);
    h.col.appendChild(tb);
  }
}

// ── DB (owner RLS) ───────────────────────────────────────────────────────────
async function dbFindChat() {
  try {
    const { data } = await supabase!.from('chats').select('id')
      .eq('user_id', userId).eq('persona_id', personaId).order('created_at', { ascending: false }).limit(1);
    return data && data[0] ? data[0].id : null;
  } catch { return null; }
}
async function dbCreateChat(titleHint?: string) {
  const title = (titleHint && titleHint.trim()) ? titleHint.trim().slice(0, 42) : (persona?.name || 'Conversation');
  try {
    const { data } = await supabase!.from('chats')
      .insert({ user_id: userId, persona_id: personaId, title, channel: 'web' })
      .select('id').single();
    return data ? data.id : null;
  } catch { return null; }
}
async function dbLoadMessages(chatId: string) {
  try {
    const { data } = await supabase!.from('messages').select('id,role,content,created_at,media_url,media_type,media_description')
      .eq('chat_id', chatId).order('created_at', { ascending: true }).limit(500);
    return (data || []).map((m: any) => ({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.content || '', ts: m.created_at ? new Date(m.created_at).getTime() : Date.now(), media_url: m.media_url || null, vision: m.media_description || null }));
  } catch { return []; }
}
async function dbInsertMessage(role: string, content: string, media?: any) {
  if (!activeChatId) return null;
  const row: any = { chat_id: activeChatId, role, content: content || '' };
  if (role === 'user') row.sender_id = userId;
  if (media && media.url) { row.media_url = media.url; row.media_type = 'image'; if (media.vision) row.media_description = media.vision; }
  try { const { data } = await supabase!.from('messages').insert(row).select('id').single(); return data ? data.id : null; }
  catch { return null; }
}

// ── Render ───────────────────────────────────────────────────────────────────
function nearBottom() { return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80; }
function scrollBottom(force?: boolean) { if (force || atBottom) stream.scrollTop = stream.scrollHeight; }
stream.addEventListener('scroll', () => { atBottom = nearBottom(); });

function addRow(side: 'me' | 'them', text: string, opts: any = {}) {
  const ts = opts.ts || Date.now();
  const row = document.createElement('div'); row.className = 'pc-row ' + side + (opts.err ? ' err' : '');
  if (side === 'them') { const av = document.createElement('span'); av.className = 'pc-av-sm'; av.style.backgroundImage = 'url("' + avatarUrl(persona?.avatar) + '")'; row.appendChild(av); }
  const col = document.createElement('div'); col.className = 'pc-col';
  const bub = document.createElement('div'); bub.className = 'pc-bub'; col.appendChild(bub); row.appendChild(col);
  if (opts.typing) { bub.innerHTML = '<span class="pc-typing"><i></i><i></i><i></i></span>'; }
  else {
    if (opts.media_url) { const im = document.createElement('img'); im.className = 'pc-img'; im.src = opts.media_url; im.alt = 'shared image'; im.loading = 'lazy'; im.style.cssText = 'max-width:220px;max-height:240px;border-radius:12px;display:block;'; bub.appendChild(im); }
    if (text) { const tx = document.createElement('span'); tx.textContent = text; bub.appendChild(tx); }
    const tm = document.createElement('time'); tm.className = 'pc-time'; tm.textContent = fmtTime(ts); col.appendChild(tm);
  }
  const empty = $('pc-empty'); if (empty) empty.remove();
  stream.appendChild(row); scrollBottom(side === 'me');
  const h = { row, col, bub, ts };
  if (side === 'them' && !opts.typing) addSpeakBtn(h);
  return h;
}
function stamp(h: any) { if (h.col.querySelector('.pc-time')) return; const t = document.createElement('time'); t.className = 'pc-time'; t.textContent = fmtTime(h.ts); h.col.appendChild(t); }
function render() {
  stream.innerHTML = '';
  if (!history.length) { renderEmpty(); return; }
  for (const m of history) { if (!m.content && !m.media_url) continue; addRow(m.role === 'user' ? 'me' : 'them', m.content, { ts: m.ts, media_url: m.media_url }); }
  scrollBottom(true);
}
function renderEmpty() {
  stream.innerHTML = '<div class="pc-empty" id="pc-empty"><img alt="" src="' + esc(avatarUrl(persona?.avatar)) + '" /><div class="pc-empty-name">' + esc(persona?.name || 'Your persona') + '</div><div>' + esc(persona?.tagline || 'Say hi 👋') + '</div></div>';
}

// ── Send / stream one turn ───────────────────────────────────────────────────
function setBusy(b: boolean) { sending = b; sendBtn.hidden = b; stopBtn.hidden = !b; }
function payload() {
  return history.filter(m => m.role === 'user' || m.role === 'assistant').slice(-MAX_TURNS).map(m => {
    let c = m.content || '';
    if (m.vision) c = (c ? c + '\n\n' : '') + '[I shared a photo with you. It shows: ' + m.vision + ']';
    return { role: m.role, content: c };
  });
}

// ── Image: upload → /vision describe → react (the persona "sees" the photo) ───
const addBtn = $('pc-add'), fileInput = $('pc-file');
async function uploadChatImage(file: File): Promise<string | null> {
  if (!userId || !file || !supabase) return null;
  const ext = (file.type && file.type.indexOf('png') >= 0) ? 'png' : 'jpg';
  const rid = (window.crypto && (crypto as any).randomUUID) ? (crypto as any).randomUUID() : (Date.now() + '-' + Math.round(Math.random() * 1e9));
  const path = userId + '/persona-chat/' + rid + '.' + ext;
  const { error } = await supabase.storage.from('chat_images').upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
  if (error) return null;
  return supabase.storage.from('chat_images').getPublicUrl(path).data.publicUrl;
}
async function sendImage(file: File) {
  if (sending) return;
  setBusy(true);
  try {
    if (!activeChatId) activeChatId = await dbCreateChat();
    const url = await uploadChatImage(file);
    if (!url) { setBusy(false); return; }
    const um: any = { role: 'user', content: '', media_url: url, ts: Date.now() };
    history.push(um); addRow('me', '', { media_url: url });
    let vision = '';
    try {
      const jwt = await getToken();
      const r = await fetch('/api/blaksyd/symp/vision', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (jwt || '') }, body: JSON.stringify({ imageUrl: url }) });
      const j = await r.json().catch(() => null);
      vision = String((j && (j.data ? j.data.description : j.description)) || '').trim();
    } catch (e) { /* vision soft-fails → persona still reacts to the photo */ }
    um.vision = vision;
    dbInsertMessage('user', '', { url, vision }).then((id: any) => { if (id) um.id = id; });
    await runTurn('');
  } catch { setBusy(false); }
}
if (addBtn && fileInput) {
  addBtn.onclick = () => fileInput.click();
  fileInput.addEventListener('change', (e: any) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) sendImage(f); });
}

async function attempt(typing: any) {
  controller = new AbortController();
  const jwt = await getToken();
  if (!jwt) { const e: any = new Error('no_auth'); e.code = 'no_auth'; throw e; }
  const res = await fetch('/api/blaksyd/symp/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
    body: JSON.stringify({ messages: payload(), persona_id: personaId, stream: true, ...(isGuest && shareCode ? { share_code: shareCode } : {}) }), signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error('http_' + res.status);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let acc = '', buf = ''; typing.bub.textContent = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim(); if (!t.startsWith('data:')) continue;
      const p = t.slice(5).trim(); if (!p || p === '[DONE]') continue;
      let o: any; try { o = JSON.parse(p); } catch { continue; }
      if (o.delta) { acc += o.delta; typing.bub.textContent = acc; scrollBottom(); }
      if (o.error) throw new Error(String(o.error));
    }
  }
  return acc.trim();
}
function showError(typing: any, srcText: string) {
  typing.row.classList.add('err');
  typing.bub.textContent = 'I lost my train of thought for a second — your message is safe.';
  const retry = document.createElement('button'); retry.className = 'pc-retry'; retry.textContent = 'Try again';
  retry.onclick = () => { typing.row.remove(); runTurn(srcText); };
  typing.col.appendChild(retry); setBusy(false);
}
async function runTurn(srcText: string) {
  setBusy(true);
  const typing = addRow('them', '', { typing: true });
  try {
    let acc = '';
    try { acc = await attempt(typing); }
    catch (e: any) {
      if (e.name === 'AbortError') throw e;
      if (e.code === 'no_auth') { typing.bub.textContent = 'Sign in again to chat.'; setBusy(false); return; }
      acc = '';
    }
    if (!acc) { await new Promise(r => setTimeout(r, 700)); acc = await attempt(typing); }
    acc = acc.trim();
    const shown = acc || 'Mmm — say that again?';
    typing.bub.textContent = shown; stamp(typing); addSpeakBtn(typing);
    const am: any = { role: 'assistant', content: shown, ts: typing.ts };
    history.push(am); dbInsertMessage('assistant', shown).then(id => { if (id) am.id = id; });
    setBusy(false);
  } catch (e: any) {
    if (e.name === 'AbortError') {
      const partial = (typing.bub.textContent || '').trim();
      if (partial) { stamp(typing); addSpeakBtn(typing); const am: any = { role: 'assistant', content: partial, ts: typing.ts }; history.push(am); dbInsertMessage('assistant', partial); }
      else typing.row.remove();
      setBusy(false);
    } else { showError(typing, srcText); }
  } finally { controller = null; }
}
async function send(text: string) {
  text = (text || '').trim();
  if (!text || sending) return;
  setBusy(true);
  try {
    if (!activeChatId) activeChatId = await dbCreateChat(text);
    const um: any = { role: 'user', content: text, ts: Date.now() };
    history.push(um); addRow('me', text);
    dbInsertMessage('user', text).then(id => { if (id) um.id = id; });
    await runTurn(text);
  } catch { setBusy(false); }
}

// ── Composer ─────────────────────────────────────────────────────────────────
function autogrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }
input.addEventListener('input', autogrow);
input.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
form.addEventListener('submit', (e: any) => { e.preventDefault(); const v = input.value; input.value = ''; autogrow(); send(v); });
stopBtn.addEventListener('click', () => { if (controller) controller.abort(); });

// ── Voice note: record → /transcribe → send as a normal message ──────────────
// (uses its own vn* recorder so it never collides with the voice-CALL micStream below)
const voiceBtn = $('pc-voice');
let vnRec: MediaRecorder | null = null, vnChunks: Blob[] = [], vnStream: MediaStream | null = null, vnRecording = false;
function vnBlobB64(blob: Blob): Promise<string> { return new Promise(r => { const fr = new FileReader(); fr.onloadend = () => r(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(blob); }); }
async function vnStart() {
  if (vnRecording || sending) return;
  try { vnStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { return; }
  vnChunks = [];
  const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm')) ? 'audio/webm' : '';
  vnRec = new MediaRecorder(vnStream, mime ? { mimeType: mime } : undefined);
  vnRec.ondataavailable = (e: any) => { if (e.data && e.data.size) vnChunks.push(e.data); };
  vnRec.onstop = vnFinish;
  vnRec.start(); vnRecording = true; if (voiceBtn) voiceBtn.classList.add('rec');
}
function vnStop() {
  if (!vnRecording) return;
  vnRecording = false; if (voiceBtn) voiceBtn.classList.remove('rec');
  try { if (vnRec && vnRec.state !== 'inactive') vnRec.stop(); } catch (e) { vnFinish(); }
}
async function vnFinish() {
  try { if (vnStream) vnStream.getTracks().forEach((t: any) => t.stop()); } catch (e) {}
  const mime = vnRec ? (vnRec.mimeType || 'audio/webm') : 'audio/webm';
  vnStream = null; vnRec = null;
  if (!vnChunks.length) return;
  const blob = new Blob(vnChunks, { type: mime }); vnChunks = [];
  if (blob.size < 1200) return;  // too short to transcribe
  if (voiceBtn) voiceBtn.classList.add('busy');
  try {
    const audio = await vnBlobB64(blob);
    const jwt = await getToken();
    const r = await fetch('/api/blaksyd/symp/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (jwt || '') }, body: JSON.stringify({ audioBase64: audio, mimeType: mime }) });
    const j = await r.json().catch(() => null);
    const text = String((j && (j.data ? j.data.text : j.text)) || '').trim();
    if (text) send(text);
  } catch (e) { /* transcription failed — silent no-op */ }
  finally { if (voiceBtn) voiceBtn.classList.remove('busy'); }
}
if (voiceBtn) voiceBtn.onclick = () => { if (vnRecording) vnStop(); else vnStart(); };

// ── Voice call (realtime Gemini Live with the persona's voice) ───────────────
const callOv = $('pc-call-overlay'), callStatus = $('pc-call-status'), callCap = $('pc-call-caption'), callMic = $('pc-call-mic');
let gws: WebSocket | null = null, gproc: any = null, actx: any = null, micStream: MediaStream | null = null;
let gNextPlay = 0, gAiSpeaking = false, liveMode = false, gCap = '', gYou = '', gDuckTimer: any = null, muted = false, callOpen = false;
let callTurns: { you: string; them: string }[] = [], callStartedAt = '';  // transcript of the live call
const setStatus = (s: string) => { if (callStatus) callStatus.textContent = s; };
const mayLearn = () => !persona || persona.build_profile_from !== false;
// Keep the screen awake during a call so the device doesn't auto-lock (and drop it).
let wakeLock: any = null;
async function acquireWakeLock() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await (navigator as any).wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) {} }
function releaseWakeLock() { try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {} }

function gPlay(b64: string) {
  if (!actx || !callOpen) return;
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer), f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const b = actx.createBuffer(1, f32.length, 24000); b.copyToChannel(f32, 0);
  const s = actx.createBufferSource(); s.buffer = b;
  const now = actx.currentTime, fresh = gNextPlay <= now + 0.02, t = fresh ? now + 0.1 : gNextPlay;
  if (fresh) { const g = actx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.03); s.connect(g); g.connect(actx.destination); }
  else s.connect(actx.destination);
  s.start(t); gNextPlay = t + b.duration;
  if (!gAiSpeaking) { gAiSpeaking = true; setStatus('speaking…'); }
  if (gDuckTimer) clearTimeout(gDuckTimer);
  gDuckTimer = setTimeout(() => { gAiSpeaking = false; if (callOpen && !muted) setStatus('listening…'); }, Math.max(0, (gNextPlay - now) * 1000) + 300);
}
function flushCallLearn(u: string, a: string) {
  u = (u || '').trim(); a = (a || '').trim();
  if (!u || !mayLearn()) return;   // respect the persona's "get to know me" toggle
  getToken().then(jwt => { if (!jwt) return; fetch('/api/blaksyd/symp/call-learn', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt }, body: JSON.stringify({ userText: u, assistantText: a }) }).catch(() => {}); });
}
// Accumulate each finished turn so we can save the whole transcript on hang-up.
// Separate from flushCallLearn (which is gated by the learn toggle) — the owner
// always gets their own transcript regardless of whether the persona learns.
function recordTurn(u: string, a: string) {
  u = (u || '').trim(); a = (a || '').trim();
  if (u || a) callTurns.push({ you: u, them: a });
}
function gHandle(o: any) {
  if (!o) return; const sc = o.serverContent; if (!sc) return;
  if (sc.interrupted) { gNextPlay = actx ? actx.currentTime : 0; if (gDuckTimer) { clearTimeout(gDuckTimer); gDuckTimer = null; } recordTurn(gYou, gCap); flushCallLearn(gYou, gCap); gYou = ''; gCap = ''; gAiSpeaking = false; setStatus('listening…'); return; }
  if (sc.modelTurn && sc.modelTurn.parts) sc.modelTurn.parts.forEach((p: any) => { if (p.inlineData && p.inlineData.data && String(p.inlineData.mimeType || '').indexOf('audio') === 0) gPlay(p.inlineData.data); });
  if (sc.outputTranscription && sc.outputTranscription.text) gCap += sc.outputTranscription.text;
  if (sc.inputTranscription && sc.inputTranscription.text) { gYou += sc.inputTranscription.text; if (callCap) callCap.innerHTML = '<p class="cc-you">' + esc(gYou) + '</p>' + (gCap ? '<p class="cc-them">' + esc(gCap) + '</p>' : ''); }
  if (sc.turnComplete) { if (callCap && gCap.trim()) { const you = callCap.querySelector('.cc-you'); callCap.innerHTML = (you ? you.outerHTML : '') + '<p class="cc-them">' + esc(gCap.trim()) + '</p>'; } recordTurn(gYou, gCap); flushCallLearn(gYou, gCap); gYou = ''; gCap = ''; }
}
function gStartMic() {
  const sr = actx.sampleRate, srcN = actx.createMediaStreamSource(micStream);
  gproc = actx.createScriptProcessor(2048, 1, 1);
  gproc.onaudioprocess = (e: any) => {
    if (!liveMode || muted || !gws || gws.readyState !== 1 || gAiSpeaking) return;
    const inp = e.inputBuffer.getChannelData(0), ratio = sr / 16000, n = Math.floor(inp.length / ratio);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) { const v = inp[Math.round(i * ratio)] || 0; pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767))); }
    const u8 = new Uint8Array(pcm.buffer); let str = '';
    for (let i = 0; i < u8.length; i += 8192) str += String.fromCharCode.apply(null, u8.subarray(i, i + 8192) as any);
    gws.send(JSON.stringify({ realtimeInput: { audio: { data: btoa(str), mimeType: 'audio/pcm;rate=16000' } } }));
  };
  srcN.connect(gproc); gproc.connect(actx.destination);
}
async function openCall() {
  if (callOpen) return;
  callOv.hidden = false; callOpen = true; muted = false; callMic.classList.remove('muted'); liveMode = false; gCap = ''; gYou = '';
  callTurns = []; callStartedAt = new Date().toISOString();
  if (callCap) callCap.innerHTML = '';
  setStatus('connecting…');
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { setStatus('mic blocked — allow microphone access'); return; }
  try { actx = actx || new (window.AudioContext || (window as any).webkitAudioContext)(); if (actx.state === 'suspended') await actx.resume(); } catch {}
  acquireWakeLock();
  let cfg: any;
  try {
    const jwt = await getToken();
    const r = await fetch('/api/gemini-live-session', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (jwt || '') }, body: JSON.stringify({ persona_id: personaId }) });
    if (!r.ok) { setStatus('calls aren’t available right now'); return; }
    cfg = await r.json();
  } catch { setStatus('couldn’t connect — try again'); return; }
  if (!cfg || !cfg.wsUrl) { setStatus('calls aren’t available right now'); return; }
  const jwt = await getToken(); if (!jwt) { setStatus('sign in again to call'); return; }
  let ws: WebSocket; try { ws = new WebSocket(cfg.wsUrl, ['blak.v1', 'blak.jwt.' + jwt]); } catch { setStatus('couldn’t connect — try again'); return; }
  gws = ws; gNextPlay = 0; gAiSpeaking = false;
  const to = setTimeout(() => { if (!liveMode) { try { ws.close(); } catch {} setStatus('couldn’t connect — try again'); } }, 9000);
  ws.onopen = () => { setStatus('connecting…'); ws.send(JSON.stringify({ setup: {
    model: cfg.model,
    generationConfig: { responseModalities: ['AUDIO'], temperature: 0.9, speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice || 'Aoede' } } } },
    systemInstruction: { parts: [{ text: cfg.instructions || '' }] },
    realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', silenceDurationMs: 350, prefixPaddingMs: 60 } },
    inputAudioTranscription: {}, outputAudioTranscription: {},
  } })); };
  const onObj = (o: any) => { if (o && o.setupComplete && !liveMode) { clearTimeout(to); liveMode = true; gStartMic(); setStatus('listening…'); } gHandle(o); };
  ws.onmessage = (ev: any) => { if (typeof ev.data === 'string') { try { onObj(JSON.parse(ev.data)); } catch {} } else if (ev.data && ev.data.text) { ev.data.text().then((t: string) => { try { onObj(JSON.parse(t)); } catch {} }); } };
  ws.onerror = () => { clearTimeout(to); if (!liveMode) setStatus('couldn’t connect — try again'); };
  ws.onclose = (e: any) => { clearTimeout(to); if (liveMode && callOpen) setStatus(e.reason ? 'call ended — ' + e.reason : 'call ended'); };
}
function endCall() {
  callOpen = false; liveMode = false;
  if (gws) { try { gws.close(); } catch {} gws = null; }
  if (gproc) { try { gproc.disconnect(); } catch {} gproc = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (gDuckTimer) { clearTimeout(gDuckTimer); gDuckTimer = null; }
  releaseWakeLock();
  callOv.hidden = true;
  // Persist the transcript (owner only — guests can't call; RLS would block anyway).
  if (!isGuest && callTurns.length && userId && personaId && supabase) {
    const turns = callTurns.slice(); const startedAt = callStartedAt || new Date().toISOString();
    callTurns = [];
    supabase.from('persona_call_logs').insert({ user_id: userId, persona_id: personaId, transcript: turns, turn_count: turns.length, started_at: startedAt, ended_at: new Date().toISOString() }).then(() => {}, () => {});
  }
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !callOpen) return;
  acquireWakeLock();
  try { if (actx && actx.state === 'suspended') await actx.resume(); } catch (e) {}
});
$('pc-call').addEventListener('click', openCall);
$('pc-call-end').addEventListener('click', endCall);
callMic.addEventListener('click', () => { muted = !muted; callMic.classList.toggle('muted', muted); setStatus(muted ? 'muted — tap to resume' : 'listening…'); });

// ── Boot ─────────────────────────────────────────────────────────────────────
// ── Conversations: multiple threads per persona ──────────────────────────────
const threadPanel = $('pc-thread-panel'), threadList = $('pc-thread-list'), threadsBtn = $('pc-threads'), threadNewBtn = $('pc-thread-new');
async function dbListChats() {
  try {
    const { data } = await supabase!.from('chats').select('id,title,created_at')
      .eq('user_id', userId).eq('persona_id', personaId).order('created_at', { ascending: false }).limit(50);
    return data || [];
  } catch { return []; }
}
function relTime(iso: string) {
  try { const ms = Date.now() - new Date(iso).getTime(); const m = Math.floor(ms / 60000); if (m < 1) return 'just now'; if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); if (h < 24) return h + 'h ago'; const d = Math.floor(h / 24); return d + 'd ago'; } catch { return ''; }
}
function closeThreads() { if (threadPanel) threadPanel.hidden = true; }
async function renderThreads() {
  if (!threadList) return;
  threadList.innerHTML = '<div style="padding:.6rem .7rem;color:var(--ink-faint,#999);font-size:var(--fs-sm);">Loading…</div>';
  const rows = await dbListChats();
  let calls: any[] = [];
  try { const { data } = await supabase!.from('persona_call_logs').select('id,transcript,turn_count,started_at,ended_at,created_at').eq('user_id', userId).eq('persona_id', personaId).order('created_at', { ascending: false }).limit(20); calls = data || []; } catch (e) {}
  threadList.innerHTML = '';
  if (!rows.length && !calls.length) { threadList.innerHTML = '<div style="padding:.6rem .7rem;color:var(--ink-faint,#999);font-size:var(--fs-sm);">No conversations yet.</div>'; return; }
  for (const c of rows) {
    const active = c.id === activeChatId;
    const it = document.createElement('button');
    it.type = 'button';
    it.style.cssText = 'width:100%;text-align:left;padding:.55rem .7rem;border:none;background:' + (active ? 'rgba(255,255,255,.06)' : 'transparent') + ';color:var(--ink);font:inherit;cursor:pointer;border-radius:10px;display:block;';
    const title = (c.title && c.title !== (persona && persona.name)) ? c.title : 'Conversation';
    it.innerHTML = '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:var(--fs-sm);">' + esc(title) + (active ? ' · now open' : '') + '</div><div style="font-size:.72rem;color:var(--ink-faint,#999);">' + esc(relTime(c.created_at)) + '</div>';
    it.onclick = () => switchThread(c.id);
    threadList.appendChild(it);
  }
  if (calls.length) {
    const hdr = document.createElement('div');
    hdr.textContent = 'Past calls';
    hdr.style.cssText = 'padding:.7rem .7rem .25rem;font-size:.7rem;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-faint,#999);';
    threadList.appendChild(hdr);
    for (const cl of calls) {
      const it = document.createElement('button');
      it.type = 'button';
      it.style.cssText = 'width:100%;text-align:left;padding:.55rem .7rem;border:none;background:transparent;color:var(--ink);font:inherit;cursor:pointer;border-radius:10px;display:block;';
      const t0 = Array.isArray(cl.transcript) && cl.transcript[0] ? (cl.transcript[0].you || cl.transcript[0].them || '') : '';
      const label = t0 ? t0.slice(0, 42) : ((cl.turn_count || 0) + ' turns');
      it.innerHTML = '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:var(--fs-sm);">📞 ' + esc(label) + '</div><div style="font-size:.72rem;color:var(--ink-faint,#999);">' + esc(relTime(cl.created_at)) + ' · ' + esc(callDuration(cl)) + '</div>';
      it.onclick = () => openTranscript(cl);
      threadList.appendChild(it);
    }
  }
}
function callDuration(cl: any) {
  try { const ms = new Date(cl.ended_at).getTime() - new Date(cl.started_at).getTime(); if (!(ms > 0)) return (cl.turn_count || 0) + ' turns'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; return Math.floor(s / 60) + 'm ' + (s % 60) + 's'; } catch (e) { return (cl.turn_count || 0) + ' turns'; }
}
let tsSheet: HTMLElement | null = null;
function closeTranscript() { if (tsSheet) tsSheet.remove(); tsSheet = null; }
function openTranscript(cl: any) {
  closeThreads();
  const turns = Array.isArray(cl.transcript) ? cl.transcript : [];
  const body = turns.map((t: any) => {
    const you = (t.you || '').trim(), them = (t.them || '').trim();
    return (you ? '<p style="margin:.3rem 0;"><b style="opacity:.55;">You:</b> ' + esc(you) + '</p>' : '') + (them ? '<p style="margin:.3rem 0;"><b style="opacity:.55;">' + esc(persona?.name || 'Them') + ':</b> ' + esc(them) + '</p>' : '');
  }).join('') || '<p style="opacity:.6;">No words were captured on this call.</p>';
  tsSheet = document.createElement('div');
  tsSheet.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(10,4,24,.55);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);padding:18px;';
  tsSheet.innerHTML = '<div style="width:min(440px,100%);max-height:80vh;overflow:auto;box-sizing:border-box;background:var(--surface,#1a1130);border:1px solid var(--line,rgba(255,255,255,.12));border-radius:18px;padding:1.1rem;box-shadow:0 24px 70px rgba(0,0,0,.5);color:var(--ink,#fff);">' +
    '<div style="font-weight:700;margin-bottom:.1rem;">📞 Call with ' + esc(persona?.name || 'persona') + '</div>' +
    '<div style="font-size:.78rem;opacity:.6;margin-bottom:.7rem;">' + esc(relTime(cl.created_at)) + ' · ' + esc(callDuration(cl)) + '</div>' +
    '<div style="font-size:.9rem;line-height:1.5;">' + body + '</div>' +
    '<button type="button" id="ts-done" style="width:100%;margin-top:.8rem;padding:.55rem;border-radius:11px;border:none;background:linear-gradient(135deg,#c9a24b,#e0746a);color:#1a1020;font-weight:600;cursor:pointer;">Close</button>' +
  '</div>';
  document.body.appendChild(tsSheet);
  tsSheet.onclick = (e: any) => { if (e.target === tsSheet) closeTranscript(); };
  const d = document.getElementById('ts-done'); if (d) d.onclick = closeTranscript;
}
async function switchThread(id: string) {
  if (sending || id === activeChatId) { closeThreads(); return; }
  closeThreads();
  activeChatId = id;
  history = await dbLoadMessages(id);
  render();
}
function newThread() {
  if (sending) return;
  closeThreads();
  activeChatId = null; history = []; render();
  try { input.focus(); } catch (e) {}
}
if (threadsBtn) threadsBtn.onclick = async () => { if (!threadPanel) return; const willOpen = threadPanel.hidden; threadPanel.hidden = !willOpen; if (willOpen) await renderThreads(); };
if (threadNewBtn) threadNewBtn.onclick = newThread;
document.addEventListener('click', (e: any) => { if (threadPanel && !threadPanel.hidden && !threadPanel.contains(e.target) && !(threadsBtn && threadsBtn.contains(e.target))) closeThreads(); });

// ── Share (owner): mint/reuse an invite link a friend can open to chat as a guest ──
function toast(msg: string) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);background:#1b1030;color:#fff;padding:.6rem 1rem;border-radius:10px;font-size:14px;z-index:9999;box-shadow:0 8px 30px rgba(0,0,0,.4);max-width:90%;text-align:center;';
  document.body.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2800);
}
// Reuse an active share code for this persona, or mint one. '' on failure.
async function ensureShareCode(): Promise<string> {
  let code = '';
  try {
    const { data } = await supabase!.from('persona_shares').select('code')
      .eq('persona_id', personaId).eq('owner_id', userId).eq('revoked', false)
      .order('created_at', { ascending: false }).limit(1);
    if (data && data[0]) code = data[0].code;
  } catch (e) {}
  if (!code) {
    code = (window.crypto && (crypto as any).randomUUID) ? (crypto as any).randomUUID().replace(/-/g, '').slice(0, 18) : (Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
    const { error } = await supabase!.from('persona_shares').insert({ persona_id: personaId, owner_id: userId, code });
    if (error) return '';
  }
  return code;
}
async function stopSharing() {
  try { await supabase!.from('persona_shares').update({ revoked: true }).eq('persona_id', personaId).eq('owner_id', userId).eq('revoked', false); } catch (e) {}
}
let shareSheet: HTMLElement | null = null;
function closeShareSheet() { if (shareSheet) shareSheet.remove(); shareSheet = null; }
async function openShareSheet() {
  if (!userId || !personaId || !supabase) return;
  const code = await ensureShareCode();
  if (!code) { toast('Could not create a share link.'); return; }
  const link = location.origin + '/beta/personas/chat/?id=' + encodeURIComponent(personaId) + '&s=' + encodeURIComponent(code);
  const nm = esc(persona?.name || 'this persona');
  shareSheet = document.createElement('div');
  shareSheet.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(10,4,24,.55);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);padding:18px;';
  shareSheet.innerHTML =
    '<div style="width:min(420px,100%);box-sizing:border-box;background:var(--surface,#1a1130);border:1px solid var(--line,rgba(255,255,255,.12));border-radius:18px;padding:1.1rem 1.1rem 1rem;box-shadow:0 24px 70px rgba(0,0,0,.5);color:var(--ink,#fff);">' +
      '<div style="font-weight:700;font-size:1.05rem;margin-bottom:.25rem;">Share ' + nm + '</div>' +
      '<div style="font-size:.86rem;opacity:.72;line-height:1.45;margin-bottom:.85rem;">Anyone with this link can chat with ' + nm + '. They won\'t see your profile or your private history with ' + nm + ', and they can\'t edit it. Stop sharing any time — the link stops working instantly.</div>' +
      '<input id="ss-link" readonly value="' + esc(link) + '" style="width:100%;box-sizing:border-box;font-size:13px;padding:.6rem .7rem;border-radius:10px;border:1px solid var(--line,rgba(255,255,255,.14));background:rgba(255,255,255,.06);color:inherit;margin-bottom:.7rem;" />' +
      '<div style="display:flex;gap:.5rem;flex-wrap:wrap;">' +
        '<button type="button" id="ss-copy" style="flex:1;min-width:120px;padding:.62rem;border-radius:11px;border:none;font-weight:600;font-size:14px;cursor:pointer;background:linear-gradient(135deg,#c9a24b,#e0746a);color:#1a1020;">Copy link</button>' +
        '<button type="button" id="ss-stop" style="flex:1;min-width:120px;padding:.62rem;border-radius:11px;border:1px solid rgba(224,116,106,.6);background:transparent;color:#e0746a;font-weight:600;font-size:14px;cursor:pointer;">Stop sharing</button>' +
      '</div>' +
      '<button type="button" id="ss-done" style="width:100%;margin-top:.55rem;padding:.5rem;border-radius:11px;border:none;background:transparent;color:inherit;opacity:.6;font-size:14px;cursor:pointer;">Done</button>' +
    '</div>';
  document.body.appendChild(shareSheet);
  shareSheet.onclick = (e: any) => { if (e.target === shareSheet) closeShareSheet(); };
  const linkEl = document.getElementById('ss-link') as HTMLInputElement | null;
  if (linkEl) linkEl.onclick = () => linkEl.select();
  const copyBtn = document.getElementById('ss-copy');
  if (copyBtn) copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(link); copyBtn.textContent = 'Copied ✓'; setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1600); } catch (e) { if (linkEl) linkEl.select(); } };
  const stopBtn = document.getElementById('ss-stop') as HTMLButtonElement | null;
  if (stopBtn) stopBtn.onclick = async () => { stopBtn.disabled = true; stopBtn.textContent = 'Stopping…'; await stopSharing(); closeShareSheet(); toast('Sharing stopped — that link no longer works.'); };
  const doneBtn = document.getElementById('ss-done');
  if (doneBtn) doneBtn.onclick = closeShareSheet;
}

async function boot() {
  if (!personaId) { location.href = '/beta/personas/'; return; }
  try { userId = (await supabase!.auth.getSession()).data?.session?.user?.id || null; } catch {}
  if (!userId) { location.href = '/beta/personas/'; return; }
  try { const { data } = await supabase!.from('fantasy_personas').select('*').eq('id', personaId).single(); persona = data; } catch {}
  // Not the owner but arrived with a share code → load just the public meta via the share-gated endpoint.
  if (!persona && shareCode) {
    try {
      const jwt = (await supabase!.auth.getSession()).data?.session?.access_token || '';
      const r = await fetch('/api/blaksyd/symp/persona-share-meta', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt }, body: JSON.stringify({ persona_id: personaId, share_code: shareCode }) });
      const m = ((await r.json().catch(() => null)) || {}).data;
      if (m && m.id) { persona = { id: m.id, name: m.name, avatar: m.avatar, tagline: m.tagline }; isGuest = true; }
    } catch {}
  }
  if (!persona) { location.href = '/beta/personas/'; return; }
  $('pc-name').textContent = persona.name || 'Persona';
  $('pc-sub').textContent = persona.tagline || (isGuest ? 'shared with you' : (Array.isArray(persona.traits) ? persona.traits.slice(0, 3).join(' · ') : '')) || '';
  const url = avatarUrl(persona.avatar);
  $('pc-av').src = url; $('pc-call-av').src = url; $('pc-call-name').textContent = persona.name || '';
  document.title = (persona.name || 'Persona') + ' · chat';
  // Owner-only controls: share, conversation history, and calls (not share-aware) are hidden for guests.
  if (isGuest) {
    ['pc-share', 'pc-threads', 'pc-call'].forEach((id) => { const el = $(id); if (el) el.style.display = 'none'; });
  } else {
    const sb = $('pc-share'); if (sb) sb.onclick = openShareSheet;
  }
  activeChatId = await dbFindChat();
  if (activeChatId) history = await dbLoadMessages(activeChatId);
  render();
  input.focus();
}
boot();
