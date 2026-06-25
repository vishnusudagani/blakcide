// Fantasy-persona create/edit form. External module (underscore = not a route),
// imported from edit.astro. Drives a live preview, voice previews, "surprise me",
// and persists to fantasy_personas via supabase-js (owner RLS).
import { supabase } from '../../../lib/supabaseClient';

const $ = (id: string) => document.getElementById(id) as any;
const PURPOSES: [string, string][] = [['ai_friend', 'AI Friend'], ['study_buddy', 'Study Buddy'], ['hype', 'Hype-up'], ['coach', 'Coach'], ['roleplay', 'Roleplay'], ['custom', 'Custom']];
const PURPOSE_LABEL: Record<string, string> = Object.fromEntries(PURPOSES);
const VOICES: [string, string][] = [['Aoede', 'warm · breezy'], ['Kore', 'clear · firm'], ['Leda', 'soft · youthful'], ['Zephyr', 'bright · light'], ['Puck', 'playful · upbeat'], ['Charon', 'deep · calm'], ['Fenrir', 'bold · lively'], ['Orus', 'steady · grounded']];
const LANGS: [string, string][] = [['en', 'English'], ['hi', 'Hindi'], ['te', 'Telugu'], ['ta', 'Tamil'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['bn', 'Bengali'], ['mr', 'Marathi'], ['gu', 'Gujarati'], ['pa', 'Punjabi']];
const AV_STYLES = ['big-smile', 'fun-emoji', 'adventurer', 'open-peeps', 'micah', 'lorelei', 'notionists', 'thumbs', 'bottts', 'pixel-art'];
// Background swatches — on-brand pastels; '' = none (transparent). DiceBear takes hex w/o '#'.
const BG_COLORS: [string, string][] = [['', 'None'], ['ffd5dc', 'Blush'], ['ffe7b3', 'Gold'], ['e3d9ff', 'Lavender'], ['c7f0e0', 'Mint'], ['b6e3f4', 'Sky'], ['ffd9c2', 'Peach'], ['eceff3', 'Cloud']];
const PRESET_TAGS = ['Late-Night Friend', 'Safe Space', 'Best Friend Energy', 'Philosophical', 'Playful', 'Direct', 'Empathetic', 'Calm', 'Funny', 'Sarcastic', 'Hype', 'Motivating', 'Wise', 'Curious', 'Flirty', 'Chill', 'Deep Thinker', 'Good Listener', 'Honest', 'Gentle', 'Bold', 'Nerdy', 'Romantic', 'Mysterious', 'Optimistic', 'No-Nonsense', 'Creative', 'Supportive', 'Witty', 'Adventurous', 'Old Soul', 'Dramatic'];
const SURPRISE_NAMES = ['Aarav', 'Mira', 'Kai', 'Zara', 'Leo', 'Anya', 'Rumi', 'Nova', 'Dev', 'Sage', 'Ira', 'Remy', 'Tara', 'Juno', 'Esha'];
const SURPRISE_TAGS_POOL = ['Playful', 'Empathetic', 'Funny', 'Calm', 'Hype', 'Wise', 'Curious', 'Bold', 'Chill', 'Witty', 'Good Listener', 'Optimistic'];
const SURPRISE_TAGLINES = ['Always up for a late-night chat.', 'Here for the big questions and the small ones.', 'Your hype squad of one.', 'Calm in the chaos.', 'Curious about everything, especially you.'];

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  check: '<svg class="pf-voice-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
};
const esc = (s: any) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const rand = (a: any[]) => a[Math.floor(Math.random() * a.length)];

const editId = new URLSearchParams(location.search).get('id');
let avatar: any = { style: 'adventurer', seed: 'blak-' + Math.floor(Math.random() * 1e6) };
let cartoonStash: any = { style: avatar.style, seed: avatar.seed, options: {} }; // last cartoon look
let photoUrl: string | null = null;  // uploaded photo, if any
let avMode: 'cartoon' | 'photo' = 'cartoon';
let traits: string[] = [];
let selectedVoice = 'Aoede';
let selectedPurpose = 'ai_friend';
let ttsUrl: string | null = null;
const sampleCache: Record<string, string> = {};
let curAudio: HTMLAudioElement | null = null;

function avatarUrl(av: any) {
  av = av || {};
  if (av.type === 'image' && av.url) return av.url;
  const qs = new URLSearchParams(Object.assign({ seed: av.seed || 'blak' }, av.options || {})).toString();
  return 'https://api.dicebear.com/9.x/' + encodeURIComponent(av.style || 'adventurer') + '/svg?' + qs;
}
async function getToken() { try { return (await supabase!.auth.getSession()).data?.session?.access_token || null; } catch (e) { return null; } }
async function userId() { try { return (await supabase!.auth.getSession()).data?.session?.user?.id || null; } catch (e) { return null; } }
function setMsg(t: string, err?: boolean) { const m = $('pf-msg'); m.hidden = !t; m.textContent = t || ''; m.classList.toggle('err', !!err); }

// ── Live preview ────────────────────────────────────────────────────────────
function renderPreview() {
  const name = $('pf-name').value.trim();
  $('pf-av').src = avatarUrl(avatar);
  $('pf-hero-av').src = avatarUrl(avatar);
  const hn = $('pf-hero-name');
  hn.textContent = name || 'Your persona';
  hn.classList.toggle('placeholder', !name);
  const tag = $('pf-tagline').value.trim();
  $('pf-hero-tag').textContent = tag || (traits.length ? traits.slice(0, 3).join(' · ') : 'A friend you design.');
  $('pf-hero-chips').innerHTML = traits.slice(0, 5).map((t) => '<span>' + esc(t) + '</span>').join('');
  const badge = $('pf-hero-badge');
  badge.textContent = PURPOSE_LABEL[selectedPurpose] || '';
  badge.hidden = !selectedPurpose;
}

// ── Build the option lists ───────────────────────────────────────────────────
function renderPurpose() {
  $('pf-purpose').innerHTML = PURPOSES.map(([v, l]) => '<button type="button" class="pf-chip' + (v === selectedPurpose ? ' sel' : '') + '" data-p="' + v + '">' + l + '</button>').join('');
}
$('pf-purpose').addEventListener('click', (e: any) => { const b = e.target.closest('.pf-chip'); if (!b) return; selectedPurpose = b.dataset.p; renderPurpose(); renderPreview(); });

$('pf-langs').innerHTML = LANGS.map(([v, l]) => '<button type="button" class="pf-chip" data-l="' + v + '">' + l + '</button>').join('');
$('pf-langs').addEventListener('click', (e: any) => { const b = e.target.closest('.pf-chip'); if (b) b.classList.toggle('sel'); });

function renderTags() {
  $('pf-tags').innerHTML = PRESET_TAGS.map((t) => '<button type="button" class="pf-tag' + (traits.includes(t) ? ' sel' : '') + '" data-t="' + esc(t) + '">' + t + '</button>').join('');
  $('pf-tags-hint').textContent = traits.length ? '— ' + traits.length + ' chosen' : '— tap a few';
}
$('pf-tags').addEventListener('click', (e: any) => {
  const b = e.target.closest('.pf-tag'); if (!b) return;
  const t = b.dataset.t;
  if (traits.includes(t)) traits = traits.filter((x) => x !== t); else if (traits.length < 16) traits.push(t);
  b.classList.toggle('sel', traits.includes(t));
  renderCustomChips(); renderTags(); renderPreview();
});
function renderCustomChips() {
  const input = $('pf-trait-input');
  $('pf-traits').querySelectorAll('.pf-trait').forEach((x: any) => x.remove());
  traits.filter((t) => !PRESET_TAGS.includes(t)).forEach((t) => {
    const el = document.createElement('span'); el.className = 'pf-trait';
    el.append(document.createTextNode(t));
    const x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', 'remove'); x.textContent = '×';
    x.onclick = () => { traits = traits.filter((v) => v !== t); renderCustomChips(); renderPreview(); };
    el.appendChild(x);
    $('pf-traits').insertBefore(el, input);
  });
}
$('pf-trait-input').addEventListener('keydown', (e: any) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const v = e.target.value.trim().replace(/,$/, '');
    if (v && !traits.includes(v) && traits.length < 16) { traits.push(v); renderCustomChips(); renderPreview(); }
    e.target.value = '';
  } else if (e.key === 'Backspace' && !e.target.value) {
    const custom = traits.filter((t) => !PRESET_TAGS.includes(t));
    if (custom.length) { traits = traits.filter((v) => v !== custom[custom.length - 1]); renderCustomChips(); renderPreview(); }
  }
});

// ── Voices (with audio preview) ──────────────────────────────────────────────
function renderVoices() {
  $('pf-voices').innerHTML = VOICES.map(([v, d]) =>
    '<div class="pf-voice' + (v === selectedVoice ? ' sel' : '') + '" data-v="' + v + '">' +
      '<button type="button" class="pf-voice-play" aria-label="Hear ' + v + '">' + ICON.play + '</button>' +
      '<div class="pf-voice-meta"><div class="pf-voice-name">' + v + '</div><div class="pf-voice-desc">' + d + '</div></div>' +
      ICON.check +
    '</div>').join('');
}
$('pf-voices').addEventListener('click', (e: any) => {
  const chip = e.target.closest('.pf-voice'); if (!chip) return;
  const v = chip.dataset.v;
  if (e.target.closest('.pf-voice-play')) { playVoice(v, chip.querySelector('.pf-voice-play')); return; }
  selectedVoice = v; renderVoices();
});
async function deriveTtsUrl() {
  try {
    // The session endpoint is JWT-gated (same as the call path). Without this
    // Authorization header it 401s, ttsUrl stays null, and every voice preview
    // silently falls back to "ready shortly" — that was the bug.
    const jwt = await getToken();
    const r = await fetch('/api/gemini-live-session', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (jwt || '') }, body: '{}' });
    const j = await r.json().catch(() => null);
    if (j && j.wsUrl) ttsUrl = j.wsUrl.replace(/^wss:/, 'https:').replace(/\/live$/, '/tts');
  } catch (e) { /* preview unavailable */ }
}
function stopAudio(btn?: any) {
  if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; }
  document.querySelectorAll('.pf-voice-play.playing').forEach((b: any) => { b.classList.remove('playing'); b.innerHTML = ICON.play; });
}
async function playVoice(voice: string, btn: any) {
  if (btn.classList.contains('playing')) { stopAudio(); return; }
  stopAudio();
  const start = (src: string) => {
    curAudio = new Audio(src); btn.classList.add('playing'); btn.innerHTML = ICON.pause;
    curAudio.onended = () => { btn.classList.remove('playing'); btn.innerHTML = ICON.play; curAudio = null; };
    curAudio.play().catch(() => { btn.classList.remove('playing'); btn.innerHTML = ICON.play; });
  };
  if (sampleCache[voice]) { start(sampleCache[voice]); return; }
  if (!ttsUrl) { await deriveTtsUrl(); if (!ttsUrl) { setMsg('Voice preview will be ready shortly.'); return; } }
  btn.innerHTML = ICON.pause; btn.classList.add('playing');
  try {
    const jwt = await getToken();
    const r = await fetch(ttsUrl!, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt }, body: JSON.stringify({ voice }) });
    const j = await r.json().catch(() => null);
    if (j && j.audio) { sampleCache[voice] = 'data:audio/wav;base64,' + j.audio; start(sampleCache[voice]); }
    else { btn.classList.remove('playing'); btn.innerHTML = ICON.play; setMsg('Could not load that voice.'); }
  } catch (e) { btn.classList.remove('playing'); btn.innerHTML = ICON.play; setMsg('Could not load that voice.'); }
}

// ── Avatar: cartoon (style + background + shuffle) or a real photo ────────────
function initAvatarState() {
  if (avatar && avatar.type === 'image' && avatar.url) {
    photoUrl = avatar.url;
    if (!cartoonStash || !cartoonStash.style) cartoonStash = { style: 'adventurer', seed: 'blak-' + Math.floor(Math.random() * 1e6), options: {} };
  } else {
    cartoonStash = { style: (avatar && avatar.style) || 'adventurer', seed: (avatar && avatar.seed) || ('blak-' + Math.floor(Math.random() * 1e6)), options: (avatar && avatar.options) ? { ...avatar.options } : {} };
  }
}
function applyCartoon() {
  avatar = { style: cartoonStash.style, seed: cartoonStash.seed, options: { ...(cartoonStash.options || {}) } };
  renderPreview();
}
function markStyle() { $('pf-av-styles').querySelectorAll('.pf-av-style').forEach((b: any) => b.classList.toggle('sel', b.dataset.s === cartoonStash.style)); }
function renderStyles() {
  $('pf-av-styles').innerHTML = AV_STYLES.map((s) =>
    '<button type="button" class="pf-av-style" data-s="' + s + '"><img alt="' + s + '" loading="lazy" src="' +
    esc(avatarUrl({ style: s, seed: cartoonStash.seed, options: cartoonStash.options })) + '" /></button>').join('');
  markStyle();
}
function renderBgs() {
  const cur = (cartoonStash.options && cartoonStash.options.backgroundColor) || '';
  $('pf-av-bgs').innerHTML = BG_COLORS.map(([hex, name]) =>
    '<button type="button" class="pf-av-bg' + (hex === cur ? ' sel' : '') + (hex ? '' : ' none') + '" data-bg="' + hex + '" title="' + esc(name) + '"' +
    (hex ? ' style="background:#' + hex + '"' : '') + '></button>').join('');
}
function renderPhoto() {
  const has = !!photoUrl;
  $('pf-av-upload-txt').textContent = has ? 'Change photo' : 'Upload a photo';
  $('pf-av-photo-clear').hidden = !has;
  const up = $('pf-av-upload'); up.classList.toggle('has', has);
  up.style.backgroundImage = has ? 'url("' + photoUrl + '")' : '';
}
function setAvMode(m: 'cartoon' | 'photo') {
  avMode = m;
  $('pf-av-cartoon').hidden = m !== 'cartoon';
  $('pf-av-photo').hidden = m !== 'photo';
  $('pf-av-modes').querySelectorAll('.pf-av-mode').forEach((b: any) => b.classList.toggle('sel', b.dataset.m === m));
  if (m === 'cartoon') { applyCartoon(); renderStyles(); renderBgs(); }
  else { if (photoUrl) { avatar = { type: 'image', url: photoUrl }; renderPreview(); } renderPhoto(); }
}
// After surprise / AI set a cartoon avatar, resync the stash (and the open editor).
function adoptCartoon() {
  if (!avatar || avatar.type === 'image') return;
  cartoonStash = { style: avatar.style, seed: avatar.seed, options: avatar.options ? { ...avatar.options } : {} };
  if (!$('pf-av-editor').hidden) setAvMode('cartoon');
}

$('pf-av-btn').addEventListener('click', () => {
  const ed = $('pf-av-editor'); const show = ed.hidden; ed.hidden = !show;
  if (show) setAvMode(avatar && avatar.type === 'image' ? 'photo' : 'cartoon');
});
$('pf-av-modes').addEventListener('click', (e: any) => { const b = e.target.closest('.pf-av-mode'); if (b) setAvMode(b.dataset.m); });
$('pf-av-styles').addEventListener('click', (e: any) => { const b = e.target.closest('.pf-av-style'); if (!b) return; cartoonStash.style = b.dataset.s; applyCartoon(); markStyle(); });
$('pf-av-bgs').addEventListener('click', (e: any) => {
  const b = e.target.closest('.pf-av-bg'); if (!b) return;
  const hex = b.dataset.bg; cartoonStash.options = cartoonStash.options || {};
  if (hex) { cartoonStash.options.backgroundColor = hex; cartoonStash.options.backgroundType = 'solid'; }
  else { delete cartoonStash.options.backgroundColor; delete cartoonStash.options.backgroundType; }
  applyCartoon(); renderStyles(); renderBgs();
});
$('pf-av-shuffle').addEventListener('click', () => { cartoonStash.seed = 'blak-' + Math.floor(Math.random() * 1e9); applyCartoon(); renderStyles(); });

// Photo upload — center-crop to a square + re-encode (strips EXIF), no size cap; reuses the chat_images bucket.
async function processAvatar(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const size = Math.min(bmp.width, bmp.height);
    const sx = (bmp.width - size) / 2, sy = (bmp.height - size) / 2;
    const out = 512; const c = document.createElement('canvas'); c.width = out; c.height = out;
    c.getContext('2d')!.drawImage(bmp, sx, sy, size, size, 0, 0, out, out);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.88));
    return blob || file;
  } catch (e) { return file; }
}
async function uploadAvatar(file: File): Promise<string | null> {
  const uid = await userId(); if (!uid || !file || !supabase) return null;
  const blob = await processAvatar(file);
  const path = uid + '/persona-av/' + ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.round(Math.random() * 1e9))) + '.jpg';
  const { error } = await supabase.storage.from('chat_images').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) { setMsg('Photo upload failed — try again.', true); return null; }
  return supabase.storage.from('chat_images').getPublicUrl(path).data.publicUrl;
}
$('pf-av-file').addEventListener('change', async (e: any) => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  $('pf-av-upload-txt').textContent = 'Uploading…'; setMsg('');
  const url = await uploadAvatar(file); e.target.value = '';
  if (!url) { renderPhoto(); return; }
  photoUrl = url; avatar = { type: 'image', url }; renderPhoto(); renderPreview();
});
$('pf-av-photo-clear').addEventListener('click', () => setAvMode('cartoon'));

// ── Inputs, counters, toggles ────────────────────────────────────────────────
function counters() {
  $('pf-name-count').textContent = $('pf-name').value.length ? $('pf-name').value.length + '/40' : '';
  $('pf-tag-count').textContent = $('pf-tagline').value.length ? $('pf-tagline').value.length + '/70' : '';
}
$('pf-name').addEventListener('input', () => { counters(); renderPreview(); });
$('pf-tagline').addEventListener('input', () => { counters(); renderPreview(); });

function wireToggle(id: string) { const b = $(id); b.addEventListener('click', () => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }); }
wireToggle('pf-build'); wireToggle('pf-use'); wireToggle('pf-proactive');
$('pf-build').classList.add('on'); $('pf-build').setAttribute('aria-checked', 'true');

// ── Surprise me ──────────────────────────────────────────────────────────────
$('pf-surprise').addEventListener('click', () => {
  $('pf-name').value = rand(SURPRISE_NAMES);
  $('pf-tagline').value = rand(SURPRISE_TAGLINES);
  const sbg = rand(BG_COLORS);
  avatar = { style: rand(AV_STYLES), seed: 'blak-' + Math.floor(Math.random() * 1e9), options: sbg[0] ? { backgroundColor: sbg[0], backgroundType: 'solid' } : {} };
  adoptCartoon();
  selectedPurpose = rand(PURPOSES)[0];
  const pool = SURPRISE_TAGS_POOL.slice().sort(() => Math.random() - 0.5);
  traits = pool.slice(0, 3 + Math.floor(Math.random() * 2));
  selectedVoice = rand(VOICES)[0];
  renderPurpose(); renderTags(); renderCustomChips(); renderVoices(); counters(); renderPreview();
});

// ── AI helper: describe → draft the whole persona, and per-field improve ──────
async function aiCall(body: any) {
  const jwt = await getToken();
  const r = await fetch('/api/blaksyd/symp/persona-generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok || !j.data) throw new Error((j && j.error && j.error.message) || 'failed');
  return j.data;
}
$('pf-ai-go').addEventListener('click', async () => {
  const desc = $('pf-ai-input').value.trim();
  if (!desc) { $('pf-ai-input').focus(); return; }
  const btn = $('pf-ai-go'); btn.disabled = true; const label = btn.textContent; btn.textContent = '✨ Thinking…'; setMsg('');
  try {
    const d = await aiCall({ mode: 'generate', description: desc });
    if (d.name) $('pf-name').value = d.name;
    if (d.tagline) $('pf-tagline').value = d.tagline;
    if (d.purpose) selectedPurpose = d.purpose;
    if (d.voice) selectedVoice = d.voice;
    if (d.avatar_style) { avatar = { style: d.avatar_style, seed: 'blak-' + Math.floor(Math.random() * 1e9) }; adoptCartoon(); }
    if (Array.isArray(d.traits) && d.traits.length) traits = d.traits.slice(0, 16);
    if (d.backstory) $('pf-backstory').value = d.backstory;
    if (d.voice_tone) $('pf-tone').value = d.voice_tone;
    if (Array.isArray(d.languages)) $('pf-langs').querySelectorAll('.pf-chip').forEach((b: any) => b.classList.toggle('sel', d.languages.includes(b.dataset.l)));
    if (d.backstory || d.voice_tone) { const det: any = document.querySelector('.pf-more'); if (det) det.open = true; }
    renderPurpose(); renderTags(); renderCustomChips(); renderVoices(); counters(); renderPreview();
  } catch (e) { setMsg("Couldn't generate — try again, or fill it in yourself.", true); }
  finally { btn.disabled = false; btn.textContent = label; }
});
$('pf-ai-input').addEventListener('keydown', (e: any) => { if (e.key === 'Enter') { e.preventDefault(); $('pf-ai-go').click(); } });

document.querySelectorAll('.pf-improve').forEach((btn: any) => {
  btn.addEventListener('click', async () => {
    const f = btn.dataset.f;
    const ta = f === 'backstory' ? $('pf-backstory') : $('pf-tone');
    const val = ta.value.trim();
    if (!val) { ta.focus(); setMsg("Jot a little down first and I'll polish it."); return; }
    btn.disabled = true; const o = btn.textContent; btn.textContent = '…';
    try { const d = await aiCall({ mode: 'improve', field: f, value: val, name: $('pf-name').value.trim() }); if (d.text) ta.value = d.text; }
    catch (e) { setMsg("Couldn't improve that — try again.", true); }
    finally { btn.disabled = false; btn.textContent = o; }
  });
});

// ── Load (edit) / boot ───────────────────────────────────────────────────────
// Starter templates — one tap prefills the whole form (kills the blank page).
const TEMPLATES: any[] = [
  { label: '📚 Study buddy', name: 'Nova', tagline: 'Makes hard things click.', purpose: 'study_buddy', traits: ['Patient', 'Encouraging', 'Clear'], voice: 'Kore', voice_tone: 'Warm and clear; explains step by step, never condescending. Short and focused.', backstory: 'A tireless study partner who loves a good "aha" moment and quizzes you just enough.' },
  { label: '🔥 Hype coach', name: 'Blaze', tagline: 'Your hype squad of one.', purpose: 'hype', traits: ['Bold', 'Energetic', 'Loyal'], voice: 'Puck', voice_tone: 'High energy, short punchy lines, huge belief in you. Celebrates every win.', backstory: 'Believes in you harder than you believe in yourself — and says so, loudly.' },
  { label: '🧘 Calm guide', name: 'Sage', tagline: 'Calm in the chaos.', purpose: 'ai_friend', traits: ['Calm', 'Wise', 'Grounding'], voice: 'Charon', voice_tone: 'Slow, soft, grounding. Few words, lots of space. Never preachy.', backstory: 'A steady presence who helps you breathe and see things clearly.' },
  { label: '🎭 Roleplay hero', name: 'Kael', tagline: 'An adventure waiting to begin.', purpose: 'roleplay', traits: ['Dramatic', 'Brave', 'Mysterious'], voice: 'Fenrir', voice_tone: 'Vivid, fully in character, paints the scene. Never breaks the story.', backstory: 'A wandering hero from a half-remembered realm, always mid-quest.', example_dialogues: 'You: where are we?\nKael: The mist hasn\'t lifted since dawn — keep your blade close. Something watches from the treeline.' },
  { label: '💪 Tough-love coach', name: 'Rhea', tagline: 'Honest. Demanding. On your side.', purpose: 'coach', traits: ['Direct', 'Disciplined', 'Caring'], voice: 'Leda', voice_tone: 'Direct, no fluff, a little demanding — but always in your corner.', backstory: "Won't let you off the hook, because she knows what you're capable of." },
  { label: '😄 Witty friend', name: 'Remy', tagline: 'Here for the chaos and the chats.', purpose: 'ai_friend', traits: ['Funny', 'Witty', 'Warm'], voice: 'Aoede', voice_tone: 'Quick, playful, a bit cheeky. Lowercase, casual, the odd emoji.', backstory: 'The friend who replies with a joke first and a hug right after.' },
  { label: '🔭 Curious nerd', name: 'Iris', tagline: 'Obsessed with how things work.', purpose: 'ai_friend', traits: ['Curious', 'Smart', 'Excitable'], voice: 'Zephyr', voice_tone: "Excited, full of tangents and 'ok but here's the cool part'. Geeks out warmly.", backstory: 'Will happily fall down a rabbit hole with you about literally anything.' },
];
function applyTemplate(t: any) {
  $('pf-name').value = t.name || '';
  $('pf-tagline').value = t.tagline || '';
  selectedPurpose = t.purpose || 'ai_friend';
  traits = Array.isArray(t.traits) ? t.traits.slice(0, 16) : [];
  selectedVoice = t.voice || 'Aoede';
  $('pf-backstory').value = t.backstory || '';
  $('pf-tone').value = t.voice_tone || '';
  if ($('pf-knowledge')) $('pf-knowledge').value = t.knowledge_note || '';
  if ($('pf-examples')) $('pf-examples').value = t.example_dialogues || '';
  const det: any = document.querySelector('.pf-more'); if (det && (t.backstory || t.voice_tone)) det.open = true;
  renderPurpose(); renderTags(); renderCustomChips(); renderVoices(); counters(); renderPreview();
}
function renderTemplates() {
  const row = $('pf-tpl-row'); if (!row) return;
  if (editId) { const c = $('pf-templates'); if (c) c.style.display = 'none'; return; }
  row.innerHTML = '';
  TEMPLATES.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pf-chip'; b.style.whiteSpace = 'nowrap';
    b.textContent = t.label;
    b.onclick = () => applyTemplate(t);
    row.appendChild(b);
  });
}

async function loadExisting() {
  renderTemplates();
  renderPurpose(); renderTags(); renderVoices();
  if (!editId) { counters(); renderPreview(); deriveTtsUrl(); $('pf-name').focus(); return; }
  $('pf-save').textContent = 'Save changes';
  try {
    const { data } = await supabase!.from('fantasy_personas').select('*').eq('id', editId).single();
    if (data) {
      $('pf-title').textContent = 'Editing ' + (data.name || 'persona');
      $('pf-name').value = data.name || '';
      $('pf-tagline').value = data.tagline || '';
      selectedPurpose = data.purpose || 'ai_friend';
      $('pf-backstory').value = data.backstory || '';
      $('pf-tone').value = data.voice_tone || '';
      $('pf-knowledge').value = data.knowledge_note || '';
      $('pf-examples').value = data.example_dialogues || '';
      selectedVoice = data.voice || 'Aoede';
      avatar = data.avatar && (data.avatar.style || data.avatar.type === 'image') ? data.avatar : avatar;
      initAvatarState();
      traits = Array.isArray(data.traits) ? data.traits.slice() : [];
      renderPurpose(); renderTags(); renderVoices(); renderCustomChips();
      (data.languages || []).forEach((l: string) => { const b = $('pf-langs').querySelector('.pf-chip[data-l="' + l + '"]'); if (b) b.classList.add('sel'); });
      $('pf-build').classList.toggle('on', data.build_profile_from !== false); $('pf-build').setAttribute('aria-checked', String(data.build_profile_from !== false));
      $('pf-use').classList.toggle('on', !!data.can_use_profile); $('pf-use').setAttribute('aria-checked', String(!!data.can_use_profile));
      $('pf-proactive').classList.toggle('on', !!data.proactive); $('pf-proactive').setAttribute('aria-checked', String(!!data.proactive));
    }
  } catch (e) { /* blank */ }
  counters(); renderPreview(); deriveTtsUrl();
}

$('pf-cancel').addEventListener('click', () => {
  const dirty = $('pf-name').value.trim() || traits.length;
  if (dirty && !confirm('Discard this persona?')) return;
  window.location.href = '/beta/personas/';
});

$('pf-save').addEventListener('click', async () => {
  const name = $('pf-name').value.trim();
  if (!name) { setMsg('Give your persona a name first.', true); $('pf-name').focus(); return; }
  const uid = await userId();
  if (!uid) { setMsg('Sign in again and retry.', true); return; }
  $('pf-save').disabled = true; setMsg('');
  const row: any = {
    user_id: uid, name,
    tagline: $('pf-tagline').value.trim() || null,
    purpose: selectedPurpose,
    avatar,
    backstory: $('pf-backstory').value.trim() || null,
    traits,
    voice_tone: $('pf-tone').value.trim() || null,
    knowledge_note: $('pf-knowledge').value.trim() || null,
    example_dialogues: $('pf-examples').value.trim() || null,
    voice: selectedVoice,
    languages: [...$('pf-langs').querySelectorAll('.pf-chip.sel')].map((b: any) => b.dataset.l),
    build_profile_from: $('pf-build').classList.contains('on'),
    can_use_profile: $('pf-use').classList.contains('on'),
    proactive: $('pf-proactive').classList.contains('on'),
  };
  try {
    // supabase-js does NOT throw on RLS/constraint failures — it returns { error }.
    // Check it, or a failed save shows the success modal while the persona never exists.
    const { error } = editId
      ? await supabase!.from('fantasy_personas').update({ ...row, updated_at: new Date().toISOString() }).eq('id', editId)
      : await supabase!.from('fantasy_personas').insert(row);
    if (error) throw error;
    // success moment, then back to the gallery
    $('pf-done-av').src = avatarUrl(avatar);
    $('pf-done-name').textContent = name;
    $('pf-done').hidden = false;
    setTimeout(() => { window.location.href = '/beta/personas/'; }, 1100);
  } catch (e) { $('pf-save').disabled = false; setMsg('Could not save — try again.', true); }
});

loadExisting();
