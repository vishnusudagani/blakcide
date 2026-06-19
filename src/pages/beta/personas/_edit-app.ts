// Fantasy-persona create/edit form logic. Kept as an external module (underscore
// prefix = not a route) and imported from edit.astro — the proven pattern in this
// codebase for interactive beta pages (big inline page scripts misbehave).
import { supabase } from '../../../lib/supabaseClient';

const $ = (id: string) => document.getElementById(id) as any;
const PURPOSES = [['ai_friend','AI Friend'],['study_buddy','Study Buddy'],['hype','Hype-up'],['coach','Coach / Critic'],['roleplay','Roleplay / Story'],['custom','Custom']];
const VOICES = [['Aoede','Aoede'],['Kore','Kore'],['Leda','Leda'],['Zephyr','Zephyr'],['Puck','Puck'],['Charon','Charon'],['Fenrir','Fenrir'],['Orus','Orus']];
const LANGS = [['en','English'],['hi','Hindi'],['te','Telugu'],['ta','Tamil'],['kn','Kannada'],['ml','Malayalam'],['bn','Bengali'],['mr','Marathi'],['gu','Gujarati'],['pa','Punjabi']];
// Friendly avatar styles (avataaars looked sad/odd — dropped as default).
const AV_STYLES = ['adventurer','fun-emoji','big-smile','open-peeps','notionists','lorelei','micah','thumbs','bottts','pixel-art'];
const PRESET_TAGS = ['Late-Night Friend','Safe Space','Best Friend Energy','Philosophical','Playful','Direct','Empathetic','Calm','Funny','Sarcastic','Hype','Motivating','Wise','Curious','Flirty','Chill','Deep Thinker','Good Listener','Honest','Gentle','Bold','Nerdy','Romantic','Mysterious','Optimistic','No-Nonsense','Creative','Supportive','Witty','Adventurous','Old Soul','Dramatic'];

const editId = new URLSearchParams(location.search).get('id');
let avatar: any = { style: 'adventurer', seed: 'blak-' + Math.floor(Math.random() * 1e6) };
let traits: string[] = [];
let selectedVoice = 'Aoede';
let ttsUrl: string | null = null;
const sampleCache: Record<string, string> = {};

function avatarUrl(av: any) {
  const qs = new URLSearchParams(Object.assign({ seed: av.seed || 'blak' }, av.options || {})).toString();
  return 'https://api.dicebear.com/9.x/' + encodeURIComponent(av.style || 'adventurer') + '/svg?' + qs;
}
function paintAvatar() { $('pf-av').src = avatarUrl(avatar); }
async function getToken() { try { return (await supabase!.auth.getSession()).data?.session?.access_token || null; } catch (e) { return null; } }
async function userId() { try { return (await supabase!.auth.getSession()).data?.session?.user?.id || null; } catch (e) { return null; } }
function setMsg(t: string, err?: boolean) { const m = $('pf-msg'); m.hidden = !t; m.textContent = t || ''; m.classList.toggle('err', !!err); }

$('pf-purpose').innerHTML = PURPOSES.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
$('pf-langs').innerHTML = LANGS.map(([v, l]) => '<button type="button" class="pf-lang" data-l="' + v + '">' + l + '</button>').join('');
$('pf-langs').addEventListener('click', (e: any) => { const b = e.target.closest('.pf-lang'); if (b) b.classList.toggle('sel'); });
$('pf-av-styles').innerHTML = AV_STYLES.map((s) => '<button type="button" class="pf-av-style" data-s="' + s + '"><img alt="' + s + '" src="https://api.dicebear.com/9.x/' + s + '/svg?seed=Sunny" /></button>').join('');

function renderTags() {
  $('pf-tags').innerHTML = PRESET_TAGS.map((t) => '<button type="button" class="pf-tag' + (traits.includes(t) ? ' sel' : '') + '" data-t="' + t.replace(/"/g, '&quot;') + '">' + t + '</button>').join('');
}
$('pf-tags').addEventListener('click', (e: any) => {
  const b = e.target.closest('.pf-tag'); if (!b) return;
  const t = b.dataset.t;
  if (traits.includes(t)) traits = traits.filter((x) => x !== t); else if (traits.length < 16) traits.push(t);
  b.classList.toggle('sel', traits.includes(t));
  renderCustomChips();
});
function renderCustomChips() {
  const input = $('pf-trait-input');
  $('pf-traits').querySelectorAll('.pf-trait').forEach((x: any) => x.remove());
  traits.filter((t) => !PRESET_TAGS.includes(t)).forEach((t) => {
    const el = document.createElement('span'); el.className = 'pf-trait';
    el.append(document.createTextNode(t));
    const x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', 'remove'); x.textContent = '×';
    x.onclick = () => { traits = traits.filter((v) => v !== t); renderCustomChips(); };
    el.appendChild(x);
    $('pf-traits').insertBefore(el, input);
  });
}
$('pf-trait-input').addEventListener('keydown', (e: any) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const v = e.target.value.trim().replace(/,$/, '');
    if (v && !traits.includes(v) && traits.length < 16) { traits.push(v); renderCustomChips(); }
    e.target.value = '';
  } else if (e.key === 'Backspace' && !e.target.value) {
    const custom = traits.filter((t) => !PRESET_TAGS.includes(t));
    if (custom.length) { traits = traits.filter((v) => v !== custom[custom.length - 1]); renderCustomChips(); }
  }
});

function renderVoices() {
  $('pf-voices').innerHTML = VOICES.map(([v, l]) =>
    '<span class="pf-voice' + (v === selectedVoice ? ' sel' : '') + '" data-v="' + v + '"><button type="button" class="pf-voice-play" aria-label="Hear ' + l + '">▶</button><span class="pf-voice-name">' + l + '</span></span>').join('');
}
$('pf-voices').addEventListener('click', async (e: any) => {
  const chip = e.target.closest('.pf-voice'); if (!chip) return;
  const v = chip.dataset.v;
  if (e.target.closest('.pf-voice-play')) { await playVoice(v, e.target.closest('.pf-voice-play')); return; }
  selectedVoice = v; renderVoices();
});
async function deriveTtsUrl() {
  try {
    const r = await fetch('/api/gemini-live-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json().catch(() => null);
    if (j && j.wsUrl) ttsUrl = j.wsUrl.replace(/^wss:/, 'https:').replace(/\/live$/, '/tts');
  } catch (e) { /* preview unavailable */ }
}
async function playVoice(voice: string, btn: any) {
  if (sampleCache[voice]) { new Audio(sampleCache[voice]).play().catch(() => {}); return; }
  if (!ttsUrl) { await deriveTtsUrl(); if (!ttsUrl) { setMsg('Voice preview will be ready shortly.'); return; } }
  btn.classList.add('loading');
  try {
    const jwt = await getToken();
    const r = await fetch(ttsUrl!, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt }, body: JSON.stringify({ voice }) });
    const j = await r.json().catch(() => null);
    if (j && j.audio) { const src = 'data:audio/wav;base64,' + j.audio; sampleCache[voice] = src; new Audio(src).play().catch(() => {}); }
    else setMsg('Could not load that voice preview.');
  } catch (e) { setMsg('Could not load that voice preview.'); }
  finally { btn.classList.remove('loading'); }
}

$('pf-av-change').addEventListener('click', () => { const ed = $('pf-av-editor'); ed.hidden = !ed.hidden; markStyle(); });
function markStyle() { $('pf-av-styles').querySelectorAll('.pf-av-style').forEach((b: any) => b.classList.toggle('sel', b.dataset.s === avatar.style)); }
$('pf-av-styles').addEventListener('click', (e: any) => { const b = e.target.closest('.pf-av-style'); if (!b) return; avatar.style = b.dataset.s; markStyle(); paintAvatar(); });
$('pf-av-shuffle').addEventListener('click', () => { avatar.seed = 'blak-' + Math.floor(Math.random() * 1e9); paintAvatar(); });

function wireToggle(id: string) { const b = $(id); b.addEventListener('click', () => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }); }
wireToggle('pf-build'); wireToggle('pf-use');
$('pf-build').classList.add('on'); $('pf-build').setAttribute('aria-checked', 'true');

async function loadExisting() {
  renderTags(); renderVoices();
  if (!editId) { paintAvatar(); deriveTtsUrl(); return; }
  try {
    const { data } = await supabase!.from('fantasy_personas').select('*').eq('id', editId).single();
    if (data) {
      $('pf-title').textContent = 'Editing ' + (data.name || 'persona');
      $('pf-name').value = data.name || '';
      $('pf-tagline').value = data.tagline || '';
      $('pf-purpose').value = data.purpose || 'ai_friend';
      $('pf-backstory').value = data.backstory || '';
      $('pf-tone').value = data.voice_tone || '';
      selectedVoice = data.voice || 'Aoede';
      avatar = data.avatar && data.avatar.style ? data.avatar : avatar;
      traits = Array.isArray(data.traits) ? data.traits.slice() : [];
      renderTags(); renderVoices(); renderCustomChips();
      (data.languages || []).forEach((l: string) => { const b = $('pf-langs').querySelector('.pf-lang[data-l="' + l + '"]'); if (b) b.classList.add('sel'); });
      $('pf-build').classList.toggle('on', data.build_profile_from !== false); $('pf-build').setAttribute('aria-checked', String(data.build_profile_from !== false));
      $('pf-use').classList.toggle('on', !!data.can_use_profile); $('pf-use').setAttribute('aria-checked', String(!!data.can_use_profile));
    }
  } catch (e) { /* blank */ }
  paintAvatar(); deriveTtsUrl();
}

$('pf-cancel').addEventListener('click', () => { window.location.href = '/beta/personas/'; });
$('pf-save').addEventListener('click', async () => {
  const name = $('pf-name').value.trim();
  if (!name) { setMsg('Give your persona a name first.', true); $('pf-name').focus(); return; }
  const uid = await userId();
  if (!uid) { setMsg('Sign in again and retry.', true); return; }
  $('pf-save').disabled = true; setMsg('Saving…');
  const row: any = {
    user_id: uid, name,
    tagline: $('pf-tagline').value.trim() || null,
    purpose: $('pf-purpose').value,
    avatar,
    backstory: $('pf-backstory').value.trim() || null,
    traits,
    voice_tone: $('pf-tone').value.trim() || null,
    voice: selectedVoice,
    languages: [...$('pf-langs').querySelectorAll('.pf-lang.sel')].map((b: any) => b.dataset.l),
    build_profile_from: $('pf-build').classList.contains('on'),
    can_use_profile: $('pf-use').classList.contains('on'),
  };
  try {
    if (editId) { row.updated_at = new Date().toISOString(); await supabase!.from('fantasy_personas').update(row).eq('id', editId); }
    else { await supabase!.from('fantasy_personas').insert(row); }
    window.location.href = '/beta/personas/';
  } catch (e) { $('pf-save').disabled = false; setMsg('Could not save — try again.', true); }
});

loadExisting();
