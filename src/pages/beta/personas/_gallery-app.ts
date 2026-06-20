// Fantasy-personas gallery logic. External module (underscore = not a route),
// imported from index.astro — the proven interactive-page pattern in this codebase.
import { supabase } from '../../../lib/supabaseClient';

const grid = document.getElementById('pg-grid') as HTMLElement;
const createCard = document.getElementById('pg-create') as HTMLElement;
const emptyEl = document.getElementById('pg-empty') as HTMLElement;

const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';

function avatarUrl(av: any) {
  av = av || {};
  if (av.type === 'image' && av.url) return av.url;
  const style = av.style || 'adventurer';
  const seed = av.seed || 'blak';
  const qs = new URLSearchParams(Object.assign({ seed }, av.options || {})).toString();
  return 'https://api.dicebear.com/9.x/' + encodeURIComponent(style) + '/svg?' + qs;
}
const esc = (s: any) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const PURPOSE_LABEL: Record<string, string> = { ai_friend: 'AI Friend', study_buddy: 'Study Buddy', hype: 'Hype', coach: 'Coach', roleplay: 'Roleplay', custom: '' };

async function userId() { try { return (await supabase!.auth.getSession()).data?.session?.user?.id || null; } catch (e) { return null; } }

function cardEl(p: any) {
  const a = document.createElement('div');
  a.className = 'pg-card';
  a.innerHTML =
    '<button type="button" class="pg-del" aria-label="Delete persona">' + TRASH + '</button>' +
    '<img class="pg-av" alt="" loading="lazy" src="' + esc(avatarUrl(p.avatar)) + '" />' +
    '<div class="pg-name">' + esc(p.name || 'Untitled') + '</div>' +
    (p.purpose && PURPOSE_LABEL[p.purpose] ? '<div class="pg-purpose">' + esc(PURPOSE_LABEL[p.purpose]) + '</div>' : '') +
    (p.tagline ? '<div class="pg-tag">' + esc(p.tagline) + '</div>' : '');
  a.addEventListener('click', (e: any) => {
    if (e.target.closest('.pg-del')) return;
    window.location.href = '/beta/personas/edit/?id=' + encodeURIComponent(p.id);
  });
  a.querySelector('.pg-del')!.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete "' + (p.name || 'this persona') + '"? This removes its chats too.')) return;
    a.style.opacity = '.4';
    try { await supabase!.from('fantasy_personas').delete().eq('id', p.id); a.remove(); refreshEmpty(); }
    catch (err) { a.style.opacity = '1'; alert('Could not delete — try again.'); }
  });
  return a;
}

function refreshEmpty() {
  const has = grid.querySelectorAll('.pg-card').length > 0;
  if (emptyEl) emptyEl.hidden = has;
}

async function load() {
  const uid = await userId();
  if (!uid) return;
  let rows: any[] = [];
  try {
    const { data } = await supabase!.from('fantasy_personas')
      .select('id,name,tagline,purpose,avatar')
      .eq('user_id', uid).order('created_at', { ascending: false }).limit(100);
    rows = data || [];
  } catch (e) { rows = []; }
  for (const p of rows) grid.insertBefore(cardEl(p), createCard);
  refreshEmpty();
}

load();
