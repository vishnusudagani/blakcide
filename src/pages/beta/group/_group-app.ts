// Blak group mediator room — lobby (create / join by code) + the live room
// (Supabase Realtime text, real account names, Blak as active mediator, host
// controls, ephemeral). External module imported by group/index.astro.
import { supabase } from '../../../lib/supabaseClient';

const $ = (id: string) => document.getElementById(id) as any;
const roomId = new URLSearchParams(location.search).get('id');

let userId: string | null = null;
let myName = 'You';
let isHost = false;
let roomCode = '';
let ended = false;
let channel: any = null;
let members: any[] = [];
const seen = new Set<string>();   // dedup realtime echo vs optimistic/initial

const stream = () => $('gr-stream');
function toast(t: string) { const el = $('gr-toast'); if (!el) return; el.textContent = t; el.hidden = false; setTimeout(() => { el.hidden = true; }, 2200); }
// Robust copy: the async Clipboard API only works in a secure context and can be
// blocked; fall back to a hidden-textarea execCommand so the invite code is always copyable.
async function copyText(t: string): Promise<boolean> {
  try { if (navigator.clipboard && (window as any).isSecureContext) { await navigator.clipboard.writeText(t); return true; } } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, t.length);
    const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
  } catch (e) { return false; }
}
function setLobbyMsg(t: string, err?: boolean) { const m = $('gr-lobby-msg'); if (!m) return; m.hidden = !t; m.textContent = t || ''; m.classList.toggle('err', !!err); }
function nameFrom(s: any) { const u = s && s.user, m = (u && u.user_metadata) || {}; return String(m.full_name || m.name || (u && u.email ? u.email.split('@')[0] : '') || 'Guest').trim(); }
function initials(n: string) { return (n || '?').trim().slice(0, 1).toUpperCase(); }
function scrollBottom(force?: boolean) { const s = stream(); if (!s) return; const near = s.scrollHeight - s.scrollTop - s.clientHeight < 100; if (force || near) s.scrollTop = s.scrollHeight; }

// ── Render one message ────────────────────────────────────────────────────────
function renderMsg(m: any) {
  if (!m || seen.has(m.id)) return; seen.add(m.id);
  const s = stream(); if (!s) return;
  if (m.sender_role === 'system') { const d = document.createElement('div'); d.className = 'gr-sys'; d.textContent = m.content; s.appendChild(d); scrollBottom(); return; }
  const mine = m.user_id === userId && m.sender_role === 'user';
  const blak = m.sender_role === 'blak';
  const row = document.createElement('div'); row.className = 'gr-row ' + (mine ? 'me' : (blak ? 'them blak' : 'them'));
  if (!mine) { const nm = document.createElement('div'); nm.className = 'gr-name' + (blak ? ' blak' : ''); nm.textContent = blak ? 'Blak' : (m.display_name || 'Someone'); row.appendChild(nm); }
  const bub = document.createElement('div'); bub.className = 'gr-bub'; bub.textContent = m.content; row.appendChild(bub);
  s.appendChild(row); scrollBottom(mine);
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function showLobby() {
  $('gr-lobby').hidden = false;
  $('gr-create').addEventListener('click', async () => {
    const title = $('gr-new-name').value.trim();
    $('gr-create').disabled = true; setLobbyMsg('Creating…');
    try {
      const { data, error } = await supabase!.rpc('bg_create_room', { p_title: title || null, p_display_name: myName });
      if (error || !data) throw error || new Error('failed');
      const room = Array.isArray(data) ? data[0] : data;
      location.href = '/beta/group/?id=' + encodeURIComponent(room.id);
    } catch (e) { $('gr-create').disabled = false; setLobbyMsg('Could not create — try again.', true); }
  });
  const join = async () => {
    const code = $('gr-join-code').value.trim().toUpperCase();
    if (code.length < 4) { setLobbyMsg('Enter the 6-letter code.', true); return; }
    $('gr-join').disabled = true; setLobbyMsg('Joining…');
    try {
      const { data, error } = await supabase!.rpc('bg_join', { p_code: code, p_display_name: myName });
      if (error) throw error;
      if (!data) { $('gr-join').disabled = false; setLobbyMsg('No active group with that code.', true); return; }
      location.href = '/beta/group/?id=' + encodeURIComponent(data);
    } catch (e) { $('gr-join').disabled = false; setLobbyMsg('Could not join — try again.', true); }
  };
  $('gr-join').addEventListener('click', join);
  $('gr-join-code').addEventListener('keydown', (e: any) => { if (e.key === 'Enter') join(); });
}

// ── Room ──────────────────────────────────────────────────────────────────────
function markEnded() {
  ended = true;
  $('gr-ended').hidden = false;
  $('gr-input').disabled = true; $('gr-send').disabled = true;
  $('gr-end').hidden = true;
  if (inVoice) leaveVoice();
}
async function loadMembers() {
  try { const { data } = await supabase!.from('blak_group_members').select('user_id,display_name,role').eq('room_id', roomId); members = data || []; } catch { members = []; }
  $('gr-sub').textContent = members.length + (members.length === 1 ? ' person' : ' people') + ' · ' + roomCode;
  renderMembers();
}
function renderMembers() {
  const box = $('gr-members'); if (!box) return;
  box.innerHTML = '';
  for (const m of members) {
    const row = document.createElement('div'); row.className = 'gr-member';
    const av = document.createElement('div'); av.className = 'gr-member-av'; av.textContent = initials(m.display_name || '?'); row.appendChild(av);
    const nm = document.createElement('div'); nm.className = 'gr-member-name'; nm.textContent = (m.display_name || 'Someone') + (m.user_id === userId ? ' (you)' : ''); row.appendChild(nm);
    if (m.role === 'host') { const t = document.createElement('span'); t.className = 'gr-member-tag'; t.textContent = 'host'; row.appendChild(t); }
    else if (isHost && m.user_id !== userId) { const x = document.createElement('button'); x.className = 'gr-member-x'; x.textContent = 'remove'; x.onclick = async () => { try { await supabase!.rpc('bg_remove_member', { p_room: roomId, p_user: m.user_id }); loadMembers(); } catch (e) {} }; row.appendChild(x); }
    box.appendChild(row);
  }
}
async function loadMessages() {
  let rows: any[] = [];
  try { const { data } = await supabase!.from('blak_group_messages').select('*').eq('room_id', roomId).order('created_at', { ascending: true }).limit(500); rows = data || []; } catch {}
  stream().innerHTML = ''; seen.clear();
  for (const m of rows) renderMsg(m);
  scrollBottom(true);
}
function subscribe() {
  channel = supabase!.channel('bg:' + roomId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'blak_group_messages', filter: 'room_id=eq.' + roomId }, (p: any) => renderMsg(p.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'blak_group_members', filter: 'room_id=eq.' + roomId }, () => loadMembers())
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'blak_group_rooms', filter: 'id=eq.' + roomId }, (p: any) => { if (p.new && p.new.status === 'ended') markEnded(); })
    .subscribe();
  setInterval(loadMembers, 15000);   // roster backstop (DELETE events aren't filterable)
}
async function mediate() {
  try {
    const jwt = (await supabase!.auth.getSession()).data?.session?.access_token; if (!jwt) return;
    fetch('/api/blaksyd/symp/group-mediate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt }, body: JSON.stringify({ room_id: roomId }) }).catch(() => {});
  } catch (e) {}
}
async function send(text: string) {
  text = (text || '').trim(); if (!text || ended) return;
  $('gr-input').value = ''; autogrow();
  try {
    const { data, error } = await supabase!.from('blak_group_messages').insert({ room_id: roomId, user_id: userId, sender_role: 'user', display_name: myName, content: text }).select().single();
    if (error) throw error;
    if (data) renderMsg(data);   // instant; the realtime echo is deduped by `seen`
    mediate();                   // Blak may chime in (inserted server-side → realtime)
  } catch (e) { toast('Could not send'); }
}
function autogrow() { const t = $('gr-input'); if (!t) return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px'; }

function wireRoomUI() {
  $('gr-input').addEventListener('input', autogrow);
  $('gr-input').addEventListener('keydown', (e: any) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('gr-form').requestSubmit(); } });
  $('gr-form').addEventListener('submit', (e: any) => { e.preventDefault(); send($('gr-input').value); });
  const openSheet = () => { $('gr-sheet').hidden = false; };
  const closeSheet = () => { $('gr-sheet').hidden = true; };
  $('gr-sub').addEventListener('click', openSheet);
  $('gr-menu-btn').addEventListener('click', openSheet);
  $('gr-sheet-scrim').addEventListener('click', closeSheet);
  $('gr-voice-btn').addEventListener('click', startVoice);
  $('gr-call-mute').addEventListener('click', toggleMute);
  $('gr-call-leave').addEventListener('click', leaveVoice);
  $('gr-share').addEventListener('click', async () => {
    const txt = 'Join my Blak group — code: ' + roomCode;
    try { if (navigator.share) { await navigator.share({ text: txt }); return; } } catch (e) { /* share cancelled/unsupported → copy instead */ }
    const ok = await copyText(roomCode); toast(ok ? 'Invite code copied ✓' : roomCode);
  });
  // Tapping the code chip in the sheet copies it (the obvious gesture users expect).
  const codeBtn = $('gr-sheet-code');
  if (codeBtn) codeBtn.addEventListener('click', async () => { const ok = await copyText(roomCode); toast(ok ? 'Invite code copied ✓' : roomCode); });
  $('gr-leave').addEventListener('click', async () => {
    try { await supabase!.from('blak_group_members').delete().eq('room_id', roomId).eq('user_id', userId); } catch (e) {}
    location.href = '/beta/blak/';
  });
  $('gr-end').addEventListener('click', async () => {
    if (!confirm('End this group for everyone?')) return;
    try { await supabase!.rpc('bg_end_room', { p_room: roomId }); markEnded(); $('gr-sheet').hidden = true; } catch (e) {}
  });
}

// ── Voice call (LiveKit) ──────────────────────────────────────────────────────
let lkRoom: any = null, inVoice = false, lkMuted = false, lkWake: any = null;
async function acquireWake() { try { if ('wakeLock' in navigator && !lkWake) { lkWake = await (navigator as any).wakeLock.request('screen'); lkWake.addEventListener('release', () => { lkWake = null; }); } } catch (e) {} }
function releaseWake() { try { if (lkWake) { lkWake.release(); lkWake = null; } } catch (e) {} }
function renderVoicePeople() {
  if (!lkRoom) return;
  const remotes = lkRoom.remoteParticipants ? [...lkRoom.remoteParticipants.values()] : [];
  const names = [myName + ' (you)', ...remotes.map((p: any) => p.name || 'Someone')];
  $('gr-callbar-label').textContent = 'In voice · ' + names.length;
  $('gr-callbar-people').textContent = names.join(', ');
}
function endVoiceUI() {
  inVoice = false; lkMuted = false;
  $('gr-callbar').hidden = true; $('gr-voice-btn').classList.remove('live'); $('gr-call-mute').textContent = 'Mute';
  document.querySelectorAll('audio[data-lk]').forEach((e) => e.remove());
  releaseWake();
}
async function startVoice() {
  if (inVoice || ended) return;
  $('gr-voice-btn').classList.add('live'); toast('Connecting voice…');
  let cfg: any = null;
  try {
    const jwt = (await supabase!.auth.getSession()).data?.session?.access_token;
    const r = await fetch('/api/blaksyd/symp/livekit-token', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt }, body: JSON.stringify({ room_id: roomId, display_name: myName }) });
    if (r.status === 503) { $('gr-voice-btn').classList.remove('live'); toast('Voice isn’t switched on yet'); return; }
    cfg = await r.json();
  } catch (e) { $('gr-voice-btn').classList.remove('live'); toast('Could not start voice'); return; }
  if (!cfg || !cfg.ok || !cfg.data || !cfg.data.token) { $('gr-voice-btn').classList.remove('live'); toast('Voice unavailable'); return; }
  try {
    const lk: any = await import('livekit-client');
    lkRoom = new lk.Room({ adaptiveStream: true, dynacast: true });
    lkRoom.on(lk.RoomEvent.TrackSubscribed, (track: any) => { if (track.kind === 'audio') { const el = track.attach(); el.setAttribute('data-lk', '1'); el.style.display = 'none'; document.body.appendChild(el); } renderVoicePeople(); });
    lkRoom.on(lk.RoomEvent.TrackUnsubscribed, (track: any) => { try { track.detach().forEach((e: any) => e.remove()); } catch (e) {} renderVoicePeople(); });
    lkRoom.on(lk.RoomEvent.ParticipantConnected, renderVoicePeople);
    lkRoom.on(lk.RoomEvent.ParticipantDisconnected, renderVoicePeople);
    lkRoom.on(lk.RoomEvent.Disconnected, () => endVoiceUI());
    await lkRoom.connect(cfg.data.url, cfg.data.token);
    await lkRoom.localParticipant.setMicrophoneEnabled(true);
    inVoice = true; $('gr-callbar').hidden = false; $('gr-voice-btn').classList.add('live');
    acquireWake(); renderVoicePeople();
  } catch (e) { $('gr-voice-btn').classList.remove('live'); toast('Could not join voice'); try { if (lkRoom) await lkRoom.disconnect(); } catch (e2) {} lkRoom = null; }
}
async function leaveVoice() { try { if (lkRoom) await lkRoom.disconnect(); } catch (e) {} lkRoom = null; endVoiceUI(); }
async function toggleMute() { if (!lkRoom) return; lkMuted = !lkMuted; try { await lkRoom.localParticipant.setMicrophoneEnabled(!lkMuted); } catch (e) {} $('gr-call-mute').textContent = lkMuted ? 'Unmute' : 'Mute'; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && inVoice) acquireWake(); });

async function openRoom() {
  $('gr-room').hidden = false;
  let room: any = null;
  try { const { data } = await supabase!.from('blak_group_rooms').select('*').eq('id', roomId).single(); room = data; } catch {}
  if (!room) { toast('Group not found or you’re not in it'); setTimeout(() => { location.href = '/beta/group/'; }, 1400); return; }
  roomCode = room.code; isHost = room.creator_id === userId;
  $('gr-title').textContent = room.title || 'Group';
  $('gr-sheet-code').innerHTML = '<span>Invite code</span><span class="gr-code-val">' + room.code + '</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  if (isHost) $('gr-end').hidden = false;
  wireRoomUI();
  await loadMembers();
  await loadMessages();
  if (room.status === 'ended') markEnded();
  subscribe();
  $('gr-input').focus();
}

async function boot() {
  let s: any = null;
  try { s = (await supabase!.auth.getSession()).data?.session; } catch {}
  if (!s) { location.href = '/beta/blak/'; return; }
  userId = s.user.id; myName = nameFrom(s);
  if (!roomId) showLobby(); else await openRoom();
}
boot();
