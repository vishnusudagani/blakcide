// Fantasy-personas gallery logic. External module (underscore = not a route),
// imported from index.astro — the proven interactive-page pattern in this codebase.
import { supabase } from '../../../lib/supabaseClient';

const grid = document.getElementById('pg-grid') as HTMLElement;
const createCard = document.getElementById('pg-create') as HTMLElement;
const emptyEl = document.getElementById('pg-empty') as HTMLElement;

const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
const PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const DUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

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
    '<button type="button" class="pg-edit" aria-label="Edit persona">' + PENCIL + '</button>' +
    '<button type="button" class="pg-dup" aria-label="Duplicate persona">' + DUP + '</button>' +
    '<button type="button" class="pg-del" aria-label="Delete persona">' + TRASH + '</button>' +
    '<img class="pg-av" alt="" loading="lazy" src="' + esc(avatarUrl(p.avatar)) + '" />' +
    '<div class="pg-name">' + esc(p.name || 'Untitled') + '</div>' +
    (p.purpose && PURPOSE_LABEL[p.purpose] ? '<div class="pg-purpose">' + esc(PURPOSE_LABEL[p.purpose]) + '</div>' : '') +
    (p.tagline ? '<div class="pg-tag">' + esc(p.tagline) + '</div>' : '');
  // Tap the card → talk to it. The pencil edits; the trash deletes.
  a.addEventListener('click', (e: any) => {
    if (e.target.closest('.pg-del') || e.target.closest('.pg-edit') || e.target.closest('.pg-dup')) return;
    window.location.href = '/beta/personas/chat/?id=' + encodeURIComponent(p.id);
  });
  a.querySelector('.pg-edit')!.addEventListener('click', (e) => {
    e.stopPropagation();
    window.location.href = '/beta/personas/edit/?id=' + encodeURIComponent(p.id);
  });
  a.querySelector('.pg-dup')!.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = a.querySelector('.pg-dup') as HTMLElement; btn.style.opacity = '.4';
    try {
      const uid = await userId();
      const { data: full } = await supabase!.from('fantasy_personas').select('*').eq('id', p.id).single();
      if (!full || !uid) throw new Error('no');
      const row: any = { ...full };
      delete row.id; delete row.created_at; delete row.updated_at;
      // A copy is a fresh character: don't inherit the original's accumulated
      // in-chat tuning or its proactive-greeting state (the user didn't author those for the copy).
      delete row.corrections; delete row.proactive_last_at; row.proactive = false;
      row.user_id = uid;
      row.name = ((full.name || 'Persona') + ' (copy)').slice(0, 40);
      const { data: created } = await supabase!.from('fantasy_personas').insert(row).select('id,name,tagline,purpose,avatar').single();
      if (created) { grid.insertBefore(cardEl(created), createCard); refreshEmpty(); }
      btn.style.opacity = '';
    } catch (err) { btn.style.opacity = ''; alert('Could not duplicate — try again.'); }
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
  try {
    const { data, error } = await supabase!.from('fantasy_personas')
      .select('id,name,tagline,purpose,avatar')
      .eq('user_id', uid).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;                                  // a failed fetch must NOT look like "you have none"
    for (const p of (data || [])) grid.insertBefore(cardEl(p), createCard);
    refreshEmpty();
  } catch (e) {
    if (emptyEl) emptyEl.hidden = true;                      // don't show the create-first empty state on an error
    const err = document.createElement('div');
    err.style.cssText = 'grid-column:1/-1;text-align:center;color:var(--ink-soft);padding:1.5rem;border:1px solid var(--line);border-radius:var(--r-lg)';
    err.innerHTML = '<p>Couldn’t load your personas.</p>';
    const btn = document.createElement('button');
    btn.textContent = 'Retry'; btn.style.cssText = 'margin-top:.6rem;padding:.4rem 1rem;border-radius:var(--r-pill);border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);cursor:pointer;font:inherit';
    btn.onclick = () => { err.remove(); load(); };
    err.appendChild(btn);
    grid.insertBefore(err, createCard);
  }
}

load();
