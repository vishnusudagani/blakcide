// Profile app — all browser logic for /beta/profile ("What Blak knows about you").
//
// Extracted to an external module on purpose: a large inline Astro <script> can
// be bundled-but-not-injected (page renders blank). One-line import in the
// .astro keeps it reliable.
//
// Everything reads/writes the user's OWN rows directly through the Supabase anon
// client (owner-only RLS), so no server round-trips for facts/entities/events/
// settings. The single exception is the "About you" synthesis, which needs an
// LLM (POST /.netlify/functions/blak-profile-synthesis with the user's JWT).
//
// Covers, from the 50: people/pets entities (#1), events timeline + countdowns
// (#2/#8), fact history (#7), evidence "why" (#11), freshness + re-confirm (#6),
// per-fact visibility (#16), never-raise vault (#17), off-the-record (#18),
// export (#19), forget-and-don't-relearn (#20), energy map (#22), About-you
// synthesis (#36), search (#38), recently-learned feed (#13/#39).

import { supabase } from '../supabaseClient';
import {
    KNOWLEDGE_AREAS, OPEN_AREA, OPEN_AREA_ID,
    VISIBILITY_IDS, VISIBILITY_META,
    ENTITY_KINDS, ENTITY_KIND_META, EVENT_KINDS,
    isFresh, normalizeValue,
} from '../../../symp-core/lib/knowledge-schema.mjs';

const root = document.getElementById('pf-root');
const pctEl = document.getElementById('pf-pct');

let user = null;
let facts = [];
let entities = [];
let events = [];
let goals = [];
let settings = null;
let synthesis = null;
let editing = null;       // "area:key" | "ent:<id|new>" | "ev:<id|new>" | "open:__new__"
let whyOpen = {};         // factId -> bool
let histOpen = {};        // factId -> rows|null|'loading'
let query = '';           // search text
let curiosityDismissed = false;
let pendingAvatar = null;  // staged entity photo url during an edit (#37)

// ── helpers ───────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const byId = (id) => document.getElementById(id);

const relTime = (iso) => {
    try {
        const diff = Date.now() - new Date(iso).getTime();
        const m = Math.floor(diff / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
        if (d > 30) return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
        if (d >= 1) return d === 1 ? 'yesterday' : d + ' days ago';
        if (h >= 1) return h + (h === 1 ? ' hr ago' : ' hrs ago');
        if (m >= 1) return m + ' min ago';
        return 'just now';
    } catch (e) { return ''; }
};

const fmtDate = (iso) => { try { return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return iso; } };
const daysUntil = (iso) => { const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? null : Math.round((d.getTime() - Date.now()) / 86400000); };
const nextYearly = (iso) => { if (!iso || iso.length < 10) return iso; const md = iso.slice(5); const y = new Date().getFullYear(); let c = `${y}-${md}`; if ((daysUntil(c) ?? 0) < 0) c = `${y + 1}-${md}`; return c; };
const countdown = (dd) => dd === 0 ? 'today' : dd === 1 ? 'tomorrow' : dd > 0 ? `in ${dd} days` : `${Math.abs(dd)} days ago`;

const factFor = (area, key) => facts.find((f) => f.area === area && f.key === key) || null;
const factStale = (f) => f && f.status !== 'user_edited' && !f.last_confirmed_at && !isFresh(f);

function provChip(f) {
    if (f.source === 'user') return '<span class="pf-chip you">you said</span>';
    if ((f.confidence ?? 1) < 0.6) return "<span class=\"pf-chip hunch\">Blak's hunch</span>";
    return '<span class="pf-chip">Blak noticed</span>';
}

function visBadge(f) {
    if (f.visibility === 'private') return '<span class="pf-chip lock">🔒 private</span>';
    if (f.visibility === 'blak_only') return '<span class="pf-chip">Blak only</span>';
    return '';
}

// ── data ────────────────────────────────────────────────────────────────────
async function loadAll() {
    const uid = user.id;
    const [f, e, ev, st, sy, g] = await Promise.all([
        supabase.from('symp_knowledge_facts').select('id,area,key,label,value,source,confidence,status,evidence,evidence_at,source_kind,source_ref,visibility,never_raise,pinned,archived,last_confirmed_at,updated_at,last_seen_at').eq('user_id', uid).eq('archived', false).order('updated_at', { ascending: false }),
        supabase.from('symp_knowledge_entities').select('*').eq('user_id', uid).order('importance', { ascending: false }),
        supabase.from('symp_knowledge_events').select('*').eq('user_id', uid).order('occurred_on', { ascending: false, nullsFirst: false }),
        supabase.from('symp_profile_settings').select('*').eq('user_id', uid).maybeSingle(),
        supabase.from('symp_profile_synthesis').select('*').eq('user_id', uid).maybeSingle(),
        supabase.from('symp_goals').select('*').eq('user_id', uid).order('created_at', { ascending: false }),
    ]);
    facts = f.error ? [] : (f.data || []);
    entities = e.error ? [] : (e.data || []);
    events = ev.error ? [] : (ev.data || []);
    settings = st.error ? null : st.data;
    synthesis = sy.error ? null : sy.data;
    goals = g.error ? [] : (g.data || []);
}

async function reload() { await loadAll(); render(); }

// ── render: mirror (#36) ─────────────────────────────────────────────────────
function renderMirror() {
    const has = synthesis && synthesis.narrative;
    const body = has
        ? `<p class="pf-mirror-text">${esc(synthesis.narrative)}</p>
           <div class="pf-mirror-foot"><span>Reflected ${esc(relTime(synthesis.generated_at))}</span>
           <button class="pf-btn" data-act="synth-refresh">↻ Refresh</button></div>`
        : `<p class="pf-mirror-empty">As Blak gets to know you, it'll reflect back here how it sees you — in your own shape.</p>
           <button class="pf-btn add" data-act="synth-refresh">✨ Generate my reflection</button>`;
    return `<section class="ap-card pf-mirror"><div class="pf-mirror-head">How Blak sees you</div>${body}</section>`;
}

// ── render: gentle curiosity / guided basics (#26, #27) ──────────────────────
function missingCore(limit) {
    const out = [];
    for (const area of KNOWLEDGE_AREAS) for (const fl of area.fields) {
        if (fl.core && !factFor(area.id, fl.key)) out.push({ area: area.id, key: fl.key, label: fl.label });
    }
    return limit ? out.slice(0, limit) : out;
}
function renderCuriosity() {
    if (curiosityDismissed) return '';
    const miss = missingCore(3);
    if (!miss.length) return '';
    return `<section class="ap-card pf-curio"><div class="pf-curio-head"><span>Blak’s a little curious</span><button class="pf-link" data-act="curio-dismiss">dismiss</button></div>
      <p class="pf-area-blurb">No pressure — these would just help Blak know you a bit better.</p>
      <div class="pf-curio-chips">${miss.map(m => `<button class="pf-btn add" data-act="curio-add" data-area="${esc(m.area)}" data-key="${esc(m.key)}">+ ${esc(m.label)}</button>`).join('')}</div></section>`;
}

// ── render: energy map (#22) ─────────────────────────────────────────────────
function renderEnergy() {
    const lifts = factFor('inner', 'lifts_them');
    const drains = factFor('inner', 'drains_them');
    if (!lifts && !drains) return '';
    const col = (f, label, cls) => `<div class="pf-energy-col ${cls}"><p class="pf-energy-label">${label}</p><p class="pf-energy-val">${f ? esc(f.value) : '<span class="pf-faint">Blak hasn’t spotted this yet</span>'}</p></div>`;
    return `<section class="ap-card pf-energy"><div class="pf-area-head"><h2 class="pf-area-title">Your energy</h2></div>
        <div class="pf-energy-grid">${col(lifts, '↑ Lifts you', 'up')}${col(drains, '↓ Drains you', 'down')}</div></section>`;
}

// ── render: people & pets (#1, #37) ──────────────────────────────────────────
function entityCard(e) {
    if (editing === 'ent:' + e.id) return entityEditor(e);
    const meta = ENTITY_KIND_META[e.kind] || {};
    const sub = [e.role || e.relation, e.notes].filter(Boolean).join(' · ');
    const feel = e.sentiment == null ? '' : (e.sentiment >= 0.3 ? ' 💛' : e.sentiment <= -0.3 ? ' 🌧️' : '');
    const ava = e.avatar_url ? `<img class="pf-ent-ava" src="${esc(e.avatar_url)}" alt="" />` : `<span class="pf-ent-ava">${meta.emoji || '•'}</span>`;
    return `<div class="pf-ent" data-id="${esc(e.id)}">
        ${ava}
        <div class="pf-ent-main"><b>${esc(e.name)}${feel}</b>${sub ? `<span class="pf-ent-sub">${esc(sub)}</span>` : ''}</div>
        <div class="pf-actions">
          <button class="pf-btn" data-act="ent-edit" data-id="${esc(e.id)}">Edit</button>
          <button class="pf-btn danger" data-act="ent-del" data-id="${esc(e.id)}">Delete</button>
        </div></div>`;
}
function entityEditor(e) {
    return `<div class="pf-ent editing">
      <div class="pf-form col">
        <div class="pf-ent-photo-row">
          <img id="pf-ent-photo-prev" class="pf-ent-ava" src="${esc(e.avatar_url || '')}" alt="" ${e.avatar_url ? '' : 'style="display:none"'} />
          <label class="pf-btn">📷 Photo<input id="pf-ent-photo" type="file" accept="image/*" hidden /></label>
        </div>
        <div class="pf-form">
          <select class="pf-input key" id="pf-ent-kind">${ENTITY_KINDS.map(k => `<option value="${k}" ${e.kind === k ? 'selected' : ''}>${(ENTITY_KIND_META[k] || {}).label || k}</option>`).join('')}</select>
          <input class="pf-input" id="pf-ent-name" value="${esc(e.name || '')}" placeholder="Name (e.g. Ananya)" />
        </div>
        <input class="pf-input" id="pf-ent-role" value="${esc(e.role || '')}" placeholder="Who they are (e.g. sister, manager, my dog)" />
        <input class="pf-input" id="pf-ent-notes" value="${esc(e.notes || '')}" placeholder="What matters about them" />
        <div class="pf-actions">
          <button class="pf-btn add" data-act="ent-save" data-id="${esc(e.id || '')}">Save</button>
          <button class="pf-btn" data-act="cancel">Cancel</button>
        </div>
      </div></div>`;
}
function renderPeople() {
    const rows = entities.map(entityCard).join('');
    const adder = editing === 'ent:new' ? entityEditor({}) : '<button class="pf-btn add" data-act="ent-add">+ Add someone who matters</button>';
    return `<section class="ap-card pf-area"><div class="pf-area-head"><h2 class="pf-area-title">Their people & pets</h2><span class="pf-area-count">${entities.length}</span></div>
      <p class="pf-area-blurb">The people, pets and places in your world.</p>${rows}<div class="pf-ent-add">${adder}</div></section>`;
}

// ── render: timeline / coming up (#2, #8) ────────────────────────────────────
function eventRow(ev) {
    if (editing === 'ev:' + ev.id) return eventEditor(ev);
    let dd = null;
    if (ev.recurrence === 'yearly' && ev.occurred_on) dd = daysUntil(nextYearly(ev.occurred_on));
    else if (ev.occurred_on) dd = daysUntil(ev.occurred_on);
    const when = ev.occurred_on ? `${fmtDate(ev.occurred_on)}${dd != null ? ` · ${countdown(dd)}` : ''}${ev.recurrence === 'yearly' ? ' · yearly' : ''}` : 'no date';
    const soon = dd != null && dd >= 0 && dd <= 14;
    return `<div class="pf-row ev ${soon ? 'soon' : ''}"><div class="pf-row-main"><p class="pf-row-val">${esc(ev.title)}</p><p class="pf-row-label">${esc(when)}</p></div>
      <div class="pf-actions"><button class="pf-btn" data-act="ev-edit" data-id="${esc(ev.id)}">Edit</button><button class="pf-btn danger" data-act="ev-del" data-id="${esc(ev.id)}">Delete</button></div></div>`;
}
function eventEditor(ev) {
    return `<div class="pf-row"><div class="pf-form col">
      <input class="pf-input" id="pf-ev-title" value="${esc(ev.title || '')}" placeholder="What's happening? (e.g. Company launch)" />
      <div class="pf-form">
        <input class="pf-input key" id="pf-ev-date" type="date" value="${esc(ev.occurred_on || '')}" />
        <select class="pf-input key" id="pf-ev-kind">${EVENT_KINDS.map(k => `<option value="${k}" ${ev.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
        <label class="pf-mini"><input type="checkbox" id="pf-ev-rec" ${ev.recurrence === 'yearly' ? 'checked' : ''}/> yearly</label>
      </div>
      <div class="pf-actions"><button class="pf-btn add" data-act="ev-save" data-id="${esc(ev.id || '')}">Save</button><button class="pf-btn" data-act="cancel">Cancel</button></div>
    </div></div>`;
}
function renderTimeline() {
    const sorted = [...events].sort((a, b) => (b.occurred_on || '').localeCompare(a.occurred_on || ''));
    const rows = sorted.map(eventRow).join('');
    const adder = editing === 'ev:new' ? eventEditor({}) : '<button class="pf-btn add" data-act="ev-add">+ Add a date or moment</button>';
    return `<section class="ap-card pf-area"><div class="pf-area-head"><h2 class="pf-area-title">Dates & moments</h2><span class="pf-area-count">${events.length}</span></div>
      <p class="pf-area-blurb">Things coming up, and moments worth remembering.</p>${rows}<div class="pf-ent-add">${adder}</div></section>`;
}

// ── render: goals & growth (#31–35) — identity-based, non-punitive ───────────
const GOAL_KIND_LABEL = { goal: 'Goal', habit: 'Habit', dream: 'Dream', win: 'Win' };
const todayISO = () => new Date().toISOString().slice(0, 10);
const isToday = (iso) => iso === todayISO();
function goalRow(g) {
    if (editing === 'goal:' + g.id) return goalEditor(g);
    const done = g.status === 'done';
    const dd = g.target_date ? daysUntil(g.target_date) : null;
    const sub = [g.identity, g.target_date ? `by ${fmtDate(g.target_date)}${dd != null && dd >= 0 ? ` · ${countdown(dd)}` : ''}` : ''].filter(Boolean).join(' · ');
    const streak = (g.kind === 'habit' && g.streak > 0) ? `<span class="pf-chip you">🔥 ${g.streak}-day streak</span>` : '';
    const statusChip = done ? '<span class="pf-chip you">✓ done</span>' : g.status === 'paused' ? '<span class="pf-chip">paused</span>' : '';
    const acts = [];
    if (g.kind === 'habit' && !done) acts.push(`<button class="pf-link ok" data-act="goal-checkin" data-id="${esc(g.id)}" ${isToday(g.last_checked_on) ? 'disabled' : ''}>${isToday(g.last_checked_on) ? '✓ done today' : '✓ did it today'}</button>`);
    if (!done && g.kind !== 'win') acts.push(`<button class="pf-link" data-act="goal-done" data-id="${esc(g.id)}">mark done</button>`);
    return `<div class="pf-row ${done ? 'goal-done' : ''}"><div class="pf-row-main">
        <p class="pf-row-val">${esc(g.title)}</p>${sub ? `<p class="pf-row-label">${esc(sub)}</p>` : ''}
        <div class="pf-chips">${streak}${statusChip}<span class="pf-chip">${GOAL_KIND_LABEL[g.kind] || esc(g.kind)}</span></div>
        ${acts.length ? `<div class="pf-microbar">${acts.join('')}</div>` : ''}
      </div><div class="pf-actions">
        <button class="pf-btn" data-act="goal-edit" data-id="${esc(g.id)}">Edit</button>
        <button class="pf-btn danger" data-act="goal-del" data-id="${esc(g.id)}">Delete</button>
      </div></div>`;
}
function goalEditor(g) {
    return `<div class="pf-row"><div class="pf-form col">
      <input class="pf-input" id="pf-goal-title" value="${esc(g.title || '')}" placeholder="What are you working toward?" />
      <input class="pf-input" id="pf-goal-identity" value="${esc(g.identity || '')}" placeholder="Who you’re becoming (e.g. someone who runs)" />
      <div class="pf-form">
        <select class="pf-input key" id="pf-goal-kind">${['goal', 'habit', 'dream', 'win'].map(k => `<option value="${k}" ${g.kind === k ? 'selected' : ''}>${GOAL_KIND_LABEL[k]}</option>`).join('')}</select>
        <input class="pf-input key" id="pf-goal-date" type="date" value="${esc(g.target_date || '')}" />
      </div>
      <label class="pf-mini">⏰ remind me<input class="pf-input key" id="pf-goal-remind" type="datetime-local" /></label>
      <div class="pf-actions"><button class="pf-btn add" data-act="goal-save" data-id="${esc(g.id || '')}">Save</button><button class="pf-btn" data-act="cancel">Cancel</button></div>
    </div></div>`;
}
function renderGoals() {
    const active = goals.filter(g => g.status !== 'done' && g.kind !== 'win');
    const wins = goals.filter(g => g.kind === 'win' || g.status === 'done');
    const rows = active.map(goalRow).join('');
    const winRows = wins.length ? `<div class="pf-wins"><p class="pf-area-blurb pf-wins-h">🎉 Wins worth remembering</p>${wins.map(goalRow).join('')}</div>` : '';
    const adder = editing === 'goal:new' ? goalEditor({}) : '<button class="pf-btn add" data-act="goal-add">+ Add a goal or habit</button>';
    return `<section class="ap-card pf-area"><div class="pf-area-head"><h2 class="pf-area-title">Goals & growth</h2><span class="pf-area-count">${goals.length}</span></div>
      <p class="pf-area-blurb">Who you’re becoming — gently tracked, never nagged.</p>${rows}${winRows}<div class="pf-ent-add">${adder}</div></section>`;
}
async function saveGoal(id) {
    const title = byId('pf-goal-title')?.value.trim();
    if (!title) { editing = null; render(); return; }
    const kind = byId('pf-goal-kind')?.value || 'goal';
    const remindVal = byId('pf-goal-remind')?.value;
    const rowData = { title, identity: byId('pf-goal-identity')?.value.trim() || null, kind, target_date: byId('pf-goal-date')?.value || null, source: 'user' };
    let error, goalId = id;
    if (id) ({ error } = await supabase.from('symp_goals').update(rowData).eq('id', id));
    else { const r = await supabase.from('symp_goals').insert({ user_id: user.id, ...rowData, status: kind === 'win' ? 'done' : 'active' }).select('id').single(); error = r.error; goalId = r.data?.id; }
    if (error) { alert('Could not save: ' + error.message); return; }
    // Optional reminder (#34): create a blak_reminders row and link it to the goal.
    if (remindVal && goalId) {
        try {
            const remind_at = new Date(remindVal).toISOString();
            const { data: rem } = await supabase.from('blak_reminders').insert({ user_id: user.id, text: 'Goal: ' + title, remind_at }).select('id').single();
            if (rem) await supabase.from('symp_goals').update({ reminder_id: rem.id }).eq('id', goalId);
        } catch (e) { /* reminder is best-effort */ }
    }
    editing = null; await reload();
}
async function checkInHabit(id) {
    const g = goals.find(x => x.id === id);
    if (!g || isToday(g.last_checked_on)) return;
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    // Non-punitive: continue if yesterday, else gently restart at 1 — never shamed for a gap.
    const streak = g.last_checked_on === yest ? (g.streak || 0) + 1 : 1;
    const { error } = await supabase.from('symp_goals').update({ streak, best_streak: Math.max(streak, g.best_streak || 0), last_checked_on: todayISO() }).eq('id', id);
    if (error) { alert('Could not update: ' + error.message); return; }
    await reload();
}
async function completeGoal(id) {
    const { error } = await supabase.from('symp_goals').update({ status: 'done', celebrate: true }).eq('id', id);
    if (error) { alert('Could not update: ' + error.message); return; }
    await reload();
}

// ── render: a single fact row (facts + trust controls) ───────────────────────
function factChips(f) {
    const chips = [provChip(f), '<span class="pf-chip">' + esc(relTime(f.updated_at || f.last_seen_at)) + '</span>', visBadge(f)];
    if (f.never_raise) chips.push('<span class="pf-chip lock">won’t raise</span>');
    if (factStale(f)) chips.push('<span class="pf-chip stale">may be dated</span>');
    return '<div class="pf-chips">' + chips.filter(Boolean).join('') + '</div>';
}
function whyBlock(f) {
    if (!whyOpen[f.id]) return '';
    const src = f.source === 'user' ? 'You told Blak this' : (f.evidence ? esc(f.evidence) : 'Blak picked this up as you talked');
    const via = f.source_kind && f.source_kind !== 'user' ? ` · via ${esc(f.source_kind)}` : '';
    const when = f.evidence_at ? ` · ${esc(relTime(f.evidence_at))}` : '';
    return `<div class="pf-why">“${src}”${via}${when}</div>`;
}
function histBlock(f) {
    const h = histOpen[f.id];
    if (h === undefined) return '';
    if (h === 'loading') return '<div class="pf-why">loading history…</div>';
    if (!h || !h.length) return '<div class="pf-why">No earlier versions — this is the first thing Blak knew here.</div>';
    return '<div class="pf-hist">' + h.map(r => `<div class="pf-hist-row"><s>${esc(r.old_value)}</s> → ${esc(r.new_value)} <span class="pf-faint">${esc(relTime(r.changed_at))}</span></div>`).join('') + '</div>';
}
function factRow(f, label) {
    const id = f.area + ':' + f.key;
    if (editing === id) return editorRow(f.area, f.key, label, f.value);
    const stale = factStale(f);
    const isHunch = f.source === 'blak' && (f.confidence ?? 1) < 0.6;
    return (
        '<div class="pf-row">' +
          '<div class="pf-row-main">' +
            '<p class="pf-row-label">' + esc(label) + '</p>' +
            '<p class="pf-row-val">' + esc(f.value) + '</p>' +
            factChips(f) + whyBlock(f) + histBlock(f) +
            '<div class="pf-microbar">' +
              (isHunch ? '<button class="pf-link ok" data-act="confirm-hunch" data-id="' + esc(f.id) + '">✓ yes, that’s me</button>' : '') +
              '<button class="pf-link" data-act="why" data-id="' + esc(f.id) + '">why?</button>' +
              '<button class="pf-link" data-act="history" data-id="' + esc(f.id) + '">history</button>' +
              '<button class="pf-link" data-act="vis" data-id="' + esc(f.id) + '" title="who can see this">' + esc(VISIBILITY_META[f.visibility]?.label || 'Shared') + '</button>' +
              '<button class="pf-link" data-act="never" data-id="' + esc(f.id) + '">' + (f.never_raise ? 'allow raising' : 'don’t raise') + '</button>' +
              (stale ? '<button class="pf-link ok" data-act="confirm" data-id="' + esc(f.id) + '">✓ still true</button>' : '') +
            '</div>' +
          '</div>' +
          '<div class="pf-actions">' +
            '<button class="pf-btn" data-act="edit" data-area="' + esc(f.area) + '" data-key="' + esc(f.key) + '">Edit</button>' +
            '<button class="pf-btn danger" data-act="delete" data-id="' + esc(f.id) + '">Delete</button>' +
          '</div>' +
        '</div>'
    );
}
function rowEmpty(area, key, label) {
    const id = area + ':' + key;
    if (editing === id) return editorRow(area, key, label, '');
    return (
        '<div class="pf-row is-empty"><div class="pf-row-main"><p class="pf-row-label">' + esc(label) + '</p>' +
        '<p class="pf-row-val">Blak hasn’t picked this up yet</p></div>' +
        '<div class="pf-actions"><button class="pf-btn add" data-act="edit" data-area="' + esc(area) + '" data-key="' + esc(key) + '">+ Add</button></div></div>'
    );
}
function editorRow(area, key, label, value) {
    return (
        '<div class="pf-row"><div class="pf-form">' +
          '<input class="pf-input" id="pf-edit-input" value="' + esc(value) + '" placeholder="' + esc(label) + '" />' +
          '<div class="pf-actions">' +
            '<button class="pf-btn add" data-act="save" data-area="' + esc(area) + '" data-key="' + esc(key) + '" data-label="' + esc(label) + '">Save</button>' +
            '<button class="pf-btn" data-act="cancel">Cancel</button>' +
          '</div></div></div>'
    );
}
function openAddRow() {
    if (editing !== 'open:__new__') return '<div class="pf-row"><div class="pf-actions"><button class="pf-btn add" data-act="open-new">+ Add something Blak should know</button></div></div>';
    return (
        '<div class="pf-row"><div class="pf-form">' +
          '<input class="pf-input key" id="pf-open-label" placeholder="What is it? (e.g. Favourite team)" />' +
          '<input class="pf-input" id="pf-open-value" placeholder="The detail" />' +
          '<div class="pf-actions"><button class="pf-btn add" data-act="open-save">Save</button><button class="pf-btn" data-act="cancel">Cancel</button></div>' +
        '</div></div>'
    );
}

function matchesQuery(text) { return !query || String(text || '').toLowerCase().includes(query); }

function renderArea(area) {
    let rows, count;
    if (area.id === OPEN_AREA_ID) {
        const mine = facts.filter((f) => f.area === OPEN_AREA_ID && matchesQuery(f.value + ' ' + (f.label || f.key)));
        count = facts.filter(f => f.area === OPEN_AREA_ID).length;
        rows = mine.map((f) => factRow(f, f.label || f.key.replace(/_/g, ' '))).join('') + (query ? '' : openAddRow());
    } else {
        const filled = area.fields.filter((fl) => factFor(area.id, fl.key)).length;
        count = filled + '/' + area.fields.length;
        rows = area.fields.map((fl) => {
            const f = factFor(area.id, fl.key);
            if (query) { return (f && matchesQuery(f.value + ' ' + fl.label)) ? factRow(f, fl.label) : ''; }
            return f ? factRow(f, fl.label) : rowEmpty(area.id, fl.key, fl.label);
        }).join('');
    }
    if (query && !rows.trim()) return '';
    return (
        '<section class="ap-card pf-area"><div class="pf-area-head">' +
        '<h2 class="pf-area-title">' + esc(area.label) + '</h2><span class="pf-area-count">' + esc(count) + '</span></div>' +
        (area.blurb ? '<p class="pf-area-blurb">' + esc(area.blurb) + '</p>' : '') + rows + '</section>'
    );
}

// ── render: possible duplicates (#15) — same thing noted twice ───────────────
function findDupeGroups() {
    const map = {};
    for (const f of facts) {
        const n = normalizeValue(f.value);
        if (!n || n.length < 4) continue;
        (map[n] ||= []).push(f);
    }
    return Object.values(map).filter(g => g.length > 1);
}
function renderDupes() {
    const groups = findDupeGroups();
    if (!groups.length) return '';
    return `<section class="ap-card pf-area"><div class="pf-area-head"><h2 class="pf-area-title">Possible duplicates</h2><span class="pf-area-count">${groups.length}</span></div>
      <p class="pf-area-blurb">Blak may have noted the same thing twice — keep one, delete the rest.</p>` +
        groups.map(g => `<div class="pf-dupe">${g.map(f => `<div class="pf-row"><div class="pf-row-main"><p class="pf-row-val">${esc(f.value)}</p><p class="pf-row-label">${esc(f.label || f.key)} · ${esc(f.area)}</p></div><div class="pf-actions"><button class="pf-btn danger" data-act="delete" data-id="${esc(f.id)}">Delete</button></div></div>`).join('')}</div>`).join('') +
        `</section>`;
}

// ── render: privacy, sharing & enrichment (#16/#18/#19/#41/#44/#46–50) ───────
function settingOn(col, dflt) { return settings ? !!settings[col] : !!dflt; }
function toggleRow(col, title, sub, opts) {
    const soon = !!(opts && opts.soon);
    const on = settingOn(col, opts && opts.dflt);
    const tag = soon ? ' <span class="pf-chip">soon</span>' : '';
    // "soon" rows are inert — disabled, no data-act — so flipping them can't persist
    // a consent flag that does nothing (was misleading: it stuck on but did nothing).
    const sw = soon
      ? `<button class="pf-switch" disabled aria-disabled="true" title="Coming soon" style="opacity:.4;cursor:default"><span></span></button>`
      : `<button class="pf-switch ${on ? 'on' : ''}" data-act="set-toggle" data-col="${col}" aria-pressed="${on ? 'true' : 'false'}"><span></span></button>`;
    return `<div class="pf-toggle"><div><b>${title}${tag}</b><span class="pf-ent-sub">${sub}</span></div>${sw}</div>`;
}
function renderPrivacy() {
    return `<section class="ap-card pf-privacy"><div class="pf-area-head"><h2 class="pf-area-title">Privacy & control</h2></div>
      ${toggleRow('learning_paused', 'Pause learning', 'Blak chats normally but learns nothing new. Off-the-record.')}
      <div class="pf-sub-h">Who Blak can share with</div>
      ${toggleRow('share_minit', 'Minit listeners', 'Let Blak prep a “context, not content” brief so a listener gets your situation without you re-explaining — always previewed first.', { dflt: true })}
      ${toggleRow('share_persona', 'Your Persona', 'Let your profile shape your Real Persona — your evolving digital self.', { dflt: true })}
      ${toggleRow('share_nexus', 'Nexus tribes', 'Use your interests to suggest tribes. Never reveals who you are.')}
      <div class="pf-microbar"><button class="pf-link" data-act="minit-preview">👁 Preview what a Minit listener would see</button></div>
      <div id="pf-minit-brief"></div>
      <div class="pf-sub-h">Learn from your apps · off by default</div>
      ${toggleRow('enrich_gmail', 'Gmail receipts', 'Learn light preferences from receipts (e.g. a favourite cuisine). Each fact is tagged “learned from Gmail.”', { soon: true })}
      ${toggleRow('enrich_calendar', 'Calendar', 'Pull upcoming plans onto your timeline.', { soon: true })}
      ${toggleRow('enrich_music', 'Music', 'Enrich your tastes from what you listen to.', { soon: true })}
      ${toggleRow('enrich_location', 'Place & rhythm', 'Use city / time-of-day to colour Blak’s greeting.', { soon: true })}
      <div class="pf-toggle"><div><b>Export everything</b><span class="pf-ent-sub">Download all of this as a file. It’s yours.</span></div>
        <button class="pf-btn" data-act="export">Download</button></div>
      <div class="pf-toggle"><div><b>Erase everything Blak knows</b><span class="pf-ent-sub">Permanently delete every fact, person, event &amp; goal Blak has learned about you.</span></div>
        <button class="pf-btn danger" data-act="erase-all">Erase</button></div></section>`;
}

// The "context, not content" brief — computed client-side from SHARED items only,
// so the user sees exactly what a Minit listener would (and what stays hidden).
function buildMinitBrief() {
    const get = (a, k) => { const f = factFor(a, k); return (f && f.visibility !== 'private' && !f.never_raise) ? f.value : null; };
    const lines = [];
    const push = (lbl, v) => { if (v) lines.push(`${lbl}: ${v}`); };
    push('Who they are', get('identity', 'self_summary'));
    push('What’s going on right now', get('world', 'current_situation'));
    push('Work / study', get('world', 'work') || get('world', 'study'));
    push('Handle gently', get('inner', 'sensitivities'));
    push('How they like to be talked to', get('tastes', 'comms_prefs'));
    const hidden = facts.filter(f => f.never_raise || f.visibility === 'private').length;
    return { lines, hidden };
}
function showMinitBrief() {
    const el = byId('pf-minit-brief'); if (!el) return;
    if (el.innerHTML) { el.innerHTML = ''; return; }
    const b = buildMinitBrief();
    el.innerHTML = `<div class="pf-brief"><div class="pf-brief-h">Your listener would see — context, not content</div>` +
        (b.lines.length ? b.lines.map(l => `<div class="pf-brief-row">• ${esc(l)}</div>`).join('') : '<div class="pf-faint">Not enough shared yet to brief a listener.</div>') +
        (b.hidden ? `<div class="pf-brief-foot">🔒 ${b.hidden} private item${b.hidden > 1 ? 's' : ''} stay hidden — never shared.</div>` : '') +
        `<div class="pf-brief-foot pf-faint">Built only from “shared” items. You control every line.</div></div>`;
}
async function setSetting(col) {
    const cur = settingOn(col);
    const { error } = await supabase.from('symp_profile_settings').upsert({ user_id: user.id, [col]: !cur, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) { alert('Could not update: ' + error.message); return; }
    await reload();
}

// ── render: recently learned (#13, #39) ──────────────────────────────────────
function renderRecent() {
    const items = [
        ...facts.map(f => ({ when: f.updated_at, txt: `${f.label || f.key}: ${f.value}`, kind: f.source === 'user' ? 'you' : 'blak' })),
        ...entities.map(e => ({ when: e.updated_at, txt: `${e.name}${e.role ? ` (${e.role})` : ''}`, kind: 'person' })),
        ...events.map(e => ({ when: e.updated_at, txt: e.title, kind: 'date' })),
    ].filter(x => x.when).sort((a, b) => new Date(b.when) - new Date(a.when)).slice(0, 6);
    if (!items.length) return '';
    return `<section class="ap-card pf-recent"><div class="pf-area-head"><h2 class="pf-area-title">Recently picked up</h2></div>` +
        items.map(i => `<div class="pf-recent-row"><span class="pf-chip ${i.kind === 'you' ? 'you' : ''}">${i.kind === 'you' ? 'you said' : i.kind === 'person' ? 'person' : i.kind === 'date' ? 'date' : 'Blak'}</span><span class="pf-recent-tx">${esc(i.txt)}</span><span class="pf-faint">${esc(relTime(i.when))}</span></div>`).join('') +
        `</section>`;
}

// ── master render ────────────────────────────────────────────────────────────
function render() {
    const n = facts.filter(f => f && f.value).length + entities.length + events.length + goals.length;
    if (pctEl) pctEl.textContent = n ? ('Blak has picked up ' + n + ' thing' + (n > 1 ? 's' : '') + ' about you') : 'Blak is just getting to know you';

    const searchBar = `<div class="pf-search"><input id="pf-search" class="pf-input" placeholder="Search everything Blak knows…" value="${esc(query)}" />${query ? '<button class="pf-link" data-act="search-clear">clear</button>' : ''}</div>`;
    const areas = KNOWLEDGE_AREAS.concat([OPEN_AREA]).map(renderArea).join('');

    root.innerHTML =
        (query ? '' : renderMirror() + renderCuriosity() + renderRecent() + renderEnergy() + renderPeople() + renderTimeline() + renderGoals()) +
        searchBar + areas +
        (query ? '' : renderDupes() + renderPrivacy());

    const input = byId('pf-edit-input') || byId('pf-open-label') || byId('pf-ent-name') || byId('pf-ev-title');
    if (input && editing) input.focus();
    const s = byId('pf-search'); if (s && query) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

// ── mutations ────────────────────────────────────────────────────────────────
async function saveFact(area, key, label, value) {
    const v = String(value || '').trim();
    if (!v) { editing = null; render(); return; }
    const row = { user_id: user.id, area, key, label: label || null, value: v, source: 'user', status: 'user_edited', confidence: 1, last_seen_at: new Date().toISOString() };
    const { error } = await supabase.from('symp_knowledge_facts').upsert(row, { onConflict: 'user_id,area,key' });
    if (error) { alert('Could not save: ' + error.message); return; }
    editing = null; await reload();
}
async function deleteFact(id) {
    const f = facts.find(x => x.id === id);
    const forget = confirm('Delete this?\n\nOK = delete. Blak may notice it again later.\nTo make Blak forget it for good, you\'ll be asked next.');
    if (!forget) return;
    if (f && confirm('Also make Blak NEVER relearn this? (a permanent “forget”)')) {
        await supabase.from('symp_knowledge_tombstones').insert({ user_id: user.id, scope: 'fact', area: f.area, key: f.key, value_norm: normalizeValue(f.value), reason: 'user_forget' });
    }
    const { error } = await supabase.from('symp_knowledge_facts').delete().eq('id', id);
    if (error) { alert('Could not delete: ' + error.message); return; }
    await reload();
}
async function patchFact(id, patch) {
    const { error } = await supabase.from('symp_knowledge_facts').update(patch).eq('id', id);
    if (error) { alert('Could not update: ' + error.message); return; }
    await reload();
}
async function loadHistory(id) {
    histOpen[id] = 'loading'; render();
    const { data } = await supabase.from('symp_knowledge_fact_history').select('old_value,new_value,changed_at').eq('fact_id', id).order('changed_at', { ascending: false });
    histOpen[id] = data || []; render();
}

async function uploadPhoto(file) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${user.id}/entity-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('chat_images').upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
    if (error) throw error;
    return supabase.storage.from('chat_images').getPublicUrl(path).data.publicUrl;
}
async function onEntityPhoto(file) {
    try {
        const url = await uploadPhoto(file);
        if (url) { pendingAvatar = url; const prev = byId('pf-ent-photo-prev'); if (prev) { prev.src = url; prev.style.display = 'block'; } }
    } catch (e) { alert('Photo upload failed: ' + (e.message || e)); }
}
async function saveEntity(id) {
    const kind = byId('pf-ent-kind')?.value, name = byId('pf-ent-name')?.value.trim();
    if (!name) { editing = null; render(); return; }
    const rowData = { kind, name, role: byId('pf-ent-role')?.value.trim() || null, notes: byId('pf-ent-notes')?.value.trim() || null, avatar_url: pendingAvatar, source: 'user', status: 'user_edited', confidence: 1, last_seen_at: new Date().toISOString() };
    let error;
    if (id) ({ error } = await supabase.from('symp_knowledge_entities').update(rowData).eq('id', id));
    else ({ error } = await supabase.from('symp_knowledge_entities').upsert({ user_id: user.id, ...rowData }, { onConflict: 'user_id,kind,name' }));
    if (error) { alert('Could not save: ' + error.message); return; }
    editing = null; await reload();
}
async function saveEvent(id) {
    const title = byId('pf-ev-title')?.value.trim();
    if (!title) { editing = null; render(); return; }
    const rowData = { title, occurred_on: byId('pf-ev-date')?.value || null, kind: byId('pf-ev-kind')?.value || 'event', recurrence: byId('pf-ev-rec')?.checked ? 'yearly' : null, source: 'user', status: 'user_edited' };
    let error;
    if (id) ({ error } = await supabase.from('symp_knowledge_events').update(rowData).eq('id', id));
    else ({ error } = await supabase.from('symp_knowledge_events').insert({ user_id: user.id, ...rowData }));
    if (error) { alert('Could not save: ' + error.message); return; }
    editing = null; await reload();
}

async function togglePause() {
    const next = !(settings && settings.learning_paused);
    const { error } = await supabase.from('symp_profile_settings').upsert({ user_id: user.id, learning_paused: next, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) { alert('Could not update: ' + error.message); return; }
    await reload();
}
async function exportAll() {
    // "Download everything" must mean everything — goals + the About-you synthesis
    // were loaded but previously dropped from the export (DPDP portability gap).
    const payload = { exported_at: new Date().toISOString(), facts, entities, events, goals, synthesis, settings };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'blak-profile.json'; a.click();
    URL.revokeObjectURL(a.href);
}
// DPDP "right to be forgotten" — wipe everything Blak has learned about the user.
// Deletes are RLS-scoped to the caller's own rows. Two confirms (this is permanent),
// and we suggest exporting first.
async function eraseAll(btn) {
    if (!confirm('Permanently delete everything Blak knows about you — every fact, person, event and goal? This cannot be undone.\n\nTip: “Download” first if you want a copy.')) return;
    if (!confirm('Last check: erase it all for good?')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Erasing…'; }
    const uid = user.id;
    try {
        await Promise.all([
            supabase.from('symp_knowledge_facts').delete().eq('user_id', uid),
            supabase.from('symp_knowledge_entities').delete().eq('user_id', uid),
            supabase.from('symp_knowledge_events').delete().eq('user_id', uid),
            supabase.from('symp_goals').delete().eq('user_id', uid),
            supabase.from('symp_profile_synthesis').delete().eq('user_id', uid),
            supabase.from('symp_knowledge_tombstones').delete().eq('user_id', uid),
        ]);
        facts = []; entities = []; events = []; goals = []; synthesis = null;
        alert('Done — Blak’s memory of you has been erased.');
        await reload();
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Erase'; }
        alert('Could not erase everything — please try again.');
    }
}
async function refreshSynthesis(btn) {
    try {
        if (btn) { btn.disabled = true; btn.textContent = '…reflecting'; }
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch('/.netlify/functions/blak-profile-synthesis', { method: 'POST', headers: { Authorization: `Bearer ${session?.access_token || ''}` } });
        const out = await res.json().catch(() => ({}));
        if (out && out.narrative) { synthesis = { narrative: out.narrative, generated_at: out.generated_at }; render(); }
        else if (out && out.reason === 'not_enough_yet') { alert('Talk to Blak a little more first — there isn’t enough yet to reflect.'); render(); }
        else { alert('Couldn’t generate a reflection right now.'); render(); }
    } catch (e) { alert('Couldn’t reach the reflection service.'); render(); }
}

// ── events ────────────────────────────────────────────────────────────────────
root.addEventListener('input', (e) => {
    if (e.target.id === 'pf-search') { query = e.target.value.trim().toLowerCase(); render(); }
});
root.addEventListener('change', (e) => {
    if (e.target.id === 'pf-ent-photo' && e.target.files && e.target.files[0]) onEntityPhoto(e.target.files[0]);
});
root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act, id = btn.dataset.id;
    switch (act) {
        case 'edit': editing = btn.dataset.area + ':' + btn.dataset.key; render(); break;
        case 'cancel': editing = null; render(); break;
        case 'delete': deleteFact(id); break;
        case 'save': { const i = byId('pf-edit-input'); saveFact(btn.dataset.area, btn.dataset.key, btn.dataset.label || null, i ? i.value : ''); break; }
        case 'open-new': editing = 'open:__new__'; render(); break;
        case 'open-save': { const l = byId('pf-open-label')?.value.trim(), v = byId('pf-open-value')?.value.trim(); if (!l || !v) { editing = null; render(); return; } saveFact(OPEN_AREA_ID, slug(l) || ('note_' + Date.now()), l, v); break; }
        case 'why': whyOpen[id] = !whyOpen[id]; render(); break;
        case 'history': if (histOpen[id] === undefined) loadHistory(id); else { delete histOpen[id]; render(); } break;
        case 'vis': { const f = facts.find(x => x.id === id); const cur = VISIBILITY_IDS.indexOf(f.visibility); patchFact(id, { visibility: VISIBILITY_IDS[(cur + 1) % VISIBILITY_IDS.length] }); break; }
        case 'never': { const f = facts.find(x => x.id === id); patchFact(id, { never_raise: !f.never_raise }); break; }
        case 'confirm': patchFact(id, { last_confirmed_at: new Date().toISOString() }); break;
        case 'confirm-hunch': patchFact(id, { confidence: 1, source: 'user', status: 'user_edited', last_confirmed_at: new Date().toISOString() }); break;
        case 'ent-add': pendingAvatar = null; editing = 'ent:new'; render(); break;
        case 'ent-edit': { const en = entities.find(x => x.id === id); pendingAvatar = en?.avatar_url || null; editing = 'ent:' + id; render(); break; }
        case 'ent-save': saveEntity(id); break;
        case 'ent-del': if (confirm('Delete this person/pet?')) supabase.from('symp_knowledge_entities').delete().eq('id', id).then(reload); break;
        case 'ev-add': editing = 'ev:new'; render(); break;
        case 'ev-edit': editing = 'ev:' + id; render(); break;
        case 'ev-save': saveEvent(id); break;
        case 'ev-del': if (confirm('Delete this date?')) supabase.from('symp_knowledge_events').delete().eq('id', id).then(reload); break;
        case 'goal-add': editing = 'goal:new'; render(); break;
        case 'goal-edit': editing = 'goal:' + id; render(); break;
        case 'goal-save': saveGoal(id); break;
        case 'goal-del': if (confirm('Delete this goal?')) supabase.from('symp_goals').delete().eq('id', id).then(reload); break;
        case 'goal-checkin': checkInHabit(id); break;
        case 'goal-done': completeGoal(id); break;
        case 'toggle-pause': togglePause(); break;
        case 'set-toggle': setSetting(btn.dataset.col); break;
        case 'minit-preview': showMinitBrief(); break;
        case 'export': exportAll(); break;
        case 'erase-all': eraseAll(btn); break;
        case 'synth-refresh': refreshSynthesis(btn); break;
        case 'curio-add': editing = btn.dataset.area + ':' + btn.dataset.key; render(); break;
        case 'curio-dismiss': curiosityDismissed = true; render(); break;
        case 'search-clear': query = ''; render(); break;
    }
});
root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const saveBtn = root.querySelector('[data-act="save"], [data-act="open-save"], [data-act="ent-save"], [data-act="ev-save"], [data-act="goal-save"]');
    const ids = ['pf-edit-input', 'pf-open-value', 'pf-open-label', 'pf-ent-name', 'pf-ent-role', 'pf-ent-notes', 'pf-ev-title', 'pf-goal-title', 'pf-goal-identity'];
    if (saveBtn && ids.includes(e.target.id)) { e.preventDefault(); saveBtn.click(); }
});

// ── boot ──────────────────────────────────────────────────────────────────────
(async () => {
    if (!supabase) { root.innerHTML = '<div class="pf-loading">Sign-in isn’t configured in this environment yet.</div>'; return; }
    try { const { data } = await supabase.auth.getSession(); user = data?.session?.user || null; } catch (e) { user = null; }
    if (!user) return; // AppLayout's auth gate bounces to sign-in
    await loadAll();
    render();
})();
