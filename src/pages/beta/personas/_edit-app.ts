// Fantasy-persona create/edit form. External module (underscore = not a route),
// imported from edit.astro. Drives a live preview, voice previews, "surprise me",
// and persists to fantasy_personas via supabase-js (owner RLS).
import { supabase } from '../../../lib/supabaseClient';

const $ = (id: string) => document.getElementById(id) as any;
const PURPOSES: [string, string][] = [['ai_friend', 'AI Friend'], ['study_buddy', 'Study Buddy'], ['hype', 'Hype-up'], ['coach', 'Coach'], ['roleplay', 'Roleplay'], ['custom', 'Custom']];
const PURPOSE_LABEL: Record<string, string> = Object.fromEntries(PURPOSES);
const VOICES: [string, string][] = [['Aoede', 'warm · breezy'], ['Kore', 'clear · firm'], ['Leda', 'soft · youthful'], ['Zephyr', 'bright · light'], ['Puck', 'playful · upbeat'], ['Charon', 'deep · calm'], ['Fenrir', 'bold · lively'], ['Orus', 'steady · grounded']];
const LANGS: [string, string][] = [['en', 'English'], ['hi', 'Hindi'], ['te', 'Telugu'], ['ta', 'Tamil'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['bn', 'Bengali'], ['mr', 'Marathi'], ['gu', 'Gujarati'], ['pa', 'Punjabi']];
const AV_STYLES = ['adventurer', 'fun-emoji', 'big-smile', 'open-peeps', 'notionists', 'lorelei', 'micah', 'thumbs', 'bottts', 'pixel-art'];
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
let traits: string[] = [];
let selectedVoice = 'Aoede';
let selectedPurpose = 'ai_friend';
let ttsUrl: string | null = null;
const sampleCache: Record<string, string> = {};
let curAudio: HTMLAudioElement | null = null;

function avatarUrl(av: any) {
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

$('pf-av-styles').innerHTML = AV_STYLES.map((s) => '<button type="button" class="pf-av-style" data-s="' + s + '"><img alt="' + s + '" src="https://api.dicebear.com/9.x/' + s + '/svg?seed=Sunny" /></button>').join('');

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
    const r = await fetch('/api/gemini-live-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
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

// ── Avatar ───────────────────────────────────────────────────────────────────
$('pf-av-btn').addEventListener('click', () => { const ed = $('pf-av-editor'); ed.hidden = !ed.hidden; markStyle(); });
function markStyle() { $('pf-av-styles').querySelectorAll('.pf-av-style').forEach((b: any) => b.classList.toggle('sel', b.dataset.s === avatar.style)); }
$('pf-av-styles').addEventListener('click', (e: any) => { const b = e.target.closest('.pf-av-style'); if (!b) return; avatar.style = b.dataset.s; markStyle(); renderPreview(); });
$('pf-av-shuffle').addEventListener('click', () => { avatar.seed = 'blak-' + Math.floor(Math.random() * 1e9); renderPreview(); });

// ── Inputs, counters, toggles ────────────────────────────────────────────────
function counters() {
  $('pf-name-count').textContent = $('pf-name').value.length ? $('pf-name').value.length + '/40' : '';
  $('pf-tag-count').textContent = $('pf-tagline').value.length ? $('pf-tagline').value.length + '/70' : '';
}
$('pf-name').addEventListener('input', () => { counters(); renderPreview(); });
$('pf-tagline').addEventListener('input', () => { counters(); renderPreview(); });

function wireToggle(id: string) { const b = $(id); b.addEventListener('click', () => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }); }
wireToggle('pf-build'); wireToggle('pf-use');
$('pf-build').classList.add('on'); $('pf-build').setAttribute('aria-checked', 'true');

// ── Surprise me ──────────────────────────────────────────────────────────────
$('pf-surprise').addEventListener('click', () => {
  $('pf-name').value = rand(SURPRISE_NAMES);
  $('pf-tagline').value = rand(SURPRISE_TAGLINES);
  avatar = { style: rand(AV_STYLES), seed: 'blak-' + Math.floor(Math.random() * 1e9) };
  selectedPurpose = rand(PURPOSES)[0];
  const pool = SURPRISE_TAGS_POOL.slice().sort(() => Math.random() - 0.5);
  traits = pool.slice(0, 3 + Math.floor(Math.random() * 2));
  selectedVoice = rand(VOICES)[0];
  renderPurpose(); renderTags(); renderCustomChips(); renderVoices(); counters(); renderPreview();
});

// ── Load (edit) / boot ───────────────────────────────────────────────────────
async function loadExisting() {
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
      selectedVoice = data.voice || 'Aoede';
      avatar = data.avatar && data.avatar.style ? data.avatar : avatar;
      traits = Array.isArray(data.traits) ? data.traits.slice() : [];
      renderPurpose(); renderTags(); renderVoices(); renderCustomChips();
      (data.languages || []).forEach((l: string) => { const b = $('pf-langs').querySelector('.pf-chip[data-l="' + l + '"]'); if (b) b.classList.add('sel'); });
      $('pf-build').classList.toggle('on', data.build_profile_from !== false); $('pf-build').setAttribute('aria-checked', String(data.build_profile_from !== false));
      $('pf-use').classList.toggle('on', !!data.can_use_profile); $('pf-use').setAttribute('aria-checked', String(!!data.can_use_profile));
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
    voice: selectedVoice,
    languages: [...$('pf-langs').querySelectorAll('.pf-chip.sel')].map((b: any) => b.dataset.l),
    build_profile_from: $('pf-build').classList.contains('on'),
    can_use_profile: $('pf-use').classList.contains('on'),
  };
  try {
    if (editId) { row.updated_at = new Date().toISOString(); await supabase!.from('fantasy_personas').update(row).eq('id', editId); }
    else { await supabase!.from('fantasy_personas').insert(row); }
    // success moment, then back to the gallery
    $('pf-done-av').src = avatarUrl(avatar);
    $('pf-done-name').textContent = name;
    $('pf-done').hidden = false;
    setTimeout(() => { window.location.href = '/beta/personas/'; }, 1100);
  } catch (e) { $('pf-save').disabled = false; setMsg('Could not save — try again.', true); }
});

loadExisting();
