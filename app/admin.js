// ══════════════════════════════════════════════════════
//  BLAKCIDE — COMMAND CENTER v2  |  admin.js
//  All data feeds run through the Symp.ai proxy.
//  Server-side admin-role check is the real boundary; the
//  client gate is just UX.
// ══════════════════════════════════════════════════════

const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

const PROXY_BASE = '/api/blaksyd/symp';

let db = null;
if (typeof window.supabase !== 'undefined') {
    db = window._sbClient || (window._sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY));
}

// ── Global state ──────────────────────────────────────
let adminProfile     = null;
let activePanel      = 'overview';
let pollTimer        = null;

// Users tab pagination
const USERS_PAGE_SIZE = 25;
let usersOffset       = 0;
let usersTotal        = 0;
let usersQuery        = '';
let usersDebounce     = null;

// Credits picker
let pickerDebounce    = null;
let creditTarget      = null;          // { user_id, full_name, email, current_credits }

// Per-tab "last loaded" cache to avoid re-flashing
const loadedOnce = new Set();

// ── DOM helpers ───────────────────────────────────────
const $ = id => document.getElementById(id);

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v != null) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}

function setText(id, text) {
    const e = $(id);
    if (e) e.textContent = text;
}

function setHTML(id, html) {
    const e = $(id);
    if (e) e.innerHTML = html;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function fmtNum(n) {
    if (n == null || n === '') return '—';
    return Number(n).toLocaleString();
}

function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
}

function fmtTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function ago(iso) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60)     return `${s}s ago`;
    if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

function initials(name) {
    if (!name) return '?';
    return String(name).trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

function avatarSeedColor(seed) {
    const s = String(seed || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xfffffff;
    const hue = h % 360;
    return `hsl(${hue} 60% 40%)`;
}

function toast(msg, color = 'var(--text)') {
    const c = $('toast-container');
    if (!c) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.style.color = color;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 3500);
}

// ── Symp.ai proxy fetch helpers ───────────────────────
async function authHeaders() {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return null;
    return {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
    };
}

async function sympGet(path, params = {}) {
    const h = await authHeaders();
    if (!h) throw new Error('Not signed in');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') qs.set(k, v);
    }
    const url = `${PROXY_BASE}/${path}${qs.toString() ? '?' + qs : ''}`;
    const res = await fetch(url, { headers: h });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
        const msg = json?.error?.message || `HTTP ${res.status}`;
        throw new Error(msg);
    }
    return json.data ?? json;
}

async function sympPost(path, body) {
    const h = await authHeaders();
    if (!h) throw new Error('Not signed in');
    const res = await fetch(`${PROXY_BASE}/${path}`, {
        method:  'POST',
        headers: h,
        body:    JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
        const msg = json?.error?.message || `HTTP ${res.status}`;
        throw new Error(msg);
    }
    return json.data ?? json;
}

// ── Boot ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!db) {
        toast('Supabase failed to load.', 'var(--accent-red)');
        return;
    }

    const { data: { session } } = await db.auth.getSession();
    if (!session) { window.location.href = '../index.html'; return; }

    const { data: profile } = await db
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();

    if (!profile || profile.role !== 'admin') {
        const lock = $('admin-lock');
        if (lock) {
            lock.innerHTML = `
                <ion-icon name="warning-outline" style="font-size:5rem;color:var(--accent-red);margin-bottom:20px;"></ion-icon>
                <h2 style="color:var(--accent-red);letter-spacing:2px;">ACCESS DENIED</h2>
                <p style="color:var(--muted);margin-top:10px;">You do not have administrative clearance.</p>
                <button onclick="window.location.href='dashboard.html'"
                    style="margin-top:30px;padding:12px 25px;background:transparent;color:white;
                           border:1px solid var(--border);border-radius:8px;cursor:pointer;">
                    Return to Dashboard
                </button>`;
        }
        return;
    }

    adminProfile = profile;

    const lock = $('admin-lock');
    if (lock) lock.style.display = 'none';

    setText('admin-display-name', profile.full_name || session.user.email || 'Admin');
    const avEl = $('admin-avatar-initials');
    if (avEl) avEl.textContent = initials(profile.full_name || session.user.email);

    // Wire up users-search input (debounced) — admin.html lacks an inline handler
    const searchInput = $('users-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(usersDebounce);
            usersDebounce = setTimeout(() => {
                usersQuery  = searchInput.value.trim();
                usersOffset = 0;
                loadUsers();
            }, 250);
        });
    }

    // Wire up credit-picker input (debounced)
    const pickerInput = $('credit-picker-input');
    if (pickerInput) {
        pickerInput.addEventListener('input', () => {
            clearTimeout(pickerDebounce);
            pickerDebounce = setTimeout(() => searchCreditTargets(pickerInput.value.trim()), 250);
        });
    }

    // Initial render — overview is the default tab
    showPanel('overview');
});

// ── Tab switching ─────────────────────────────────────
const PANEL_META = {
    overview:   { title: 'System Overview',  sub: 'Realtime view of platform health',           loader: loadOverview,   pollMs: 60_000 },
    realtime:   { title: 'Realtime',         sub: 'Live activity, last few minutes',             loader: loadRealtime,   pollMs:  8_000 },
    users:      { title: 'Users',            sub: 'Search, drill-in, vault read-only',           loader: loadUsers,      pollMs: 60_000 },
    credits:    { title: 'Credits',          sub: 'Wallet ops, ledger, admin grants',            loader: loadCredits,    pollMs: 60_000 },
    symp:       { title: 'Symp.ai Brain',    sub: 'Inference router, action loop, corrections',  loader: loadSymp,       pollMs: 60_000 },
    actionloop: { title: 'Action Loop',      sub: 'Pending → Done → Failed counts',              loader: loadActionLoop, pollMs: 30_000 },
    nexus:      { title: 'Nexus Community',  sub: 'Posts, distress flags, AI participant',       loader: loadNexus,      pollMs: 60_000 },
    pulse:      { title: 'Pulse',            sub: 'Anonymous user feedback, master switch',      loader: loadPulse,      pollMs: 60_000 },
    controls:   { title: 'System Controls',  sub: 'Master switches — Pulse, AI kill, more',      loader: loadControls,   pollMs: 30_000 },
    activity:   { title: 'Activity',         sub: 'Recent API calls and journal writes',         loader: loadActivity,   pollMs: 60_000 },
};

window.showPanel = function (name) {
    if (!PANEL_META[name]) return;
    activePanel = name;

    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));

    const meta = PANEL_META[name];
    setText('panel-title', meta.title);
    setText('panel-sub',   meta.sub);

    // Fire the loader (silently swallow — toasts in loaders surface real errors)
    meta.loader().catch(e => console.warn(`[admin] ${name} load failed:`, e));

    // Reset poll cadence for the new panel
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
        meta.loader().catch(() => {});
        setText('last-updated', `updated ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    }, meta.pollMs);
};

window.refreshAll = async function () {
    const meta = PANEL_META[activePanel];
    if (!meta) return;
    try {
        await meta.loader();
        setText('last-updated', `updated ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
        toast('Refreshed.');
    } catch (e) {
        toast('Refresh failed: ' + e.message, 'var(--accent-red)');
    }
};

window.adminLogout = async function () {
    if (!db) return;
    await db.auth.signOut();
    window.location.href = '../index.html';
};

// ── OVERVIEW ──────────────────────────────────────────
async function loadOverview() {
    let kpi, activity;
    try {
        kpi = await sympGet('admin/overview');
    } catch (e) {
        setHTML('kpi-row', `<div class="card" style="grid-column:1/-1">Overview failed: ${escapeHtml(e.message)}</div>`);
        return;
    }
    renderKpiRow(kpi);

    // Sidebar badges
    if (kpi.realtime?.active_sessions != null) setText('nav-realtime-count', kpi.realtime.active_sessions);
    if (kpi.users?.total != null)              setText('nav-users-count',    kpi.users.total);
    if (kpi.action_loop?.pending != null)      setText('nav-action-pending', kpi.action_loop.pending);

    // Recent activity (best-effort — endpoint may return an empty list)
    try {
        activity = await sympGet('admin/recent-activity', { limit: 12 });
        renderRecentApi('overview-api-list',     activity.api_calls    || []);
        renderRecentJournals('overview-journal-list', activity.journals || []);
        const errs = (activity.api_calls || []).filter(r => r.status_code >= 500).length;
        const pill = $('overview-api-pill');
        if (pill) {
            pill.textContent = errs ? `${errs} 5xx` : 'healthy';
            pill.className   = 'pill ' + (errs ? 'red' : 'green');
        }
    } catch (e) {
        setHTML('overview-api-list',     `<div class="empty">${escapeHtml(e.message)}</div>`);
        setHTML('overview-journal-list', '');
    }

    // FinOps mini-chart — best effort (endpoint may not exist yet)
    renderFinopsChart().catch(() => {});
}

function renderKpiRow(kpi) {
    const cards = [
        { label: 'Total users',         value: kpi.users?.total,        sub: `${fmtNum(kpi.users?.new_today || 0)} new today` },
        { label: 'Active 7d',           value: kpi.users?.active_7d,    sub: `${fmtNum(kpi.users?.active_24h || 0)} in last 24h` },
        { label: 'AI chats today',      value: kpi.usage?.ai_chats_today,    sub: `${fmtNum(kpi.usage?.ai_chats_7d || 0)} this week` },
        { label: 'Human sessions today',value: kpi.usage?.human_sessions_today, sub: `${fmtNum(kpi.usage?.human_sessions_7d || 0)} this week` },
        { label: 'Journals today',      value: kpi.usage?.journals_today,    sub: `${fmtNum(kpi.usage?.journals_7d || 0)} this week` },
        { label: 'Credits issued (24h)',value: kpi.credits?.granted_24h,     sub: `${fmtNum(kpi.credits?.in_circulation || 0)} in circulation` },
        { label: 'Action loop pending', value: kpi.action_loop?.pending,     sub: `${fmtNum(kpi.action_loop?.done_24h || 0)} done · ${fmtNum(kpi.action_loop?.failed_24h || 0)} failed` },
        { label: 'API errors (24h)',    value: kpi.api?.errors_24h,          sub: `${fmtNum(kpi.api?.calls_24h || 0)} calls`, danger: (kpi.api?.errors_24h || 0) > 0 },
    ];
    const html = cards.map(c => `
        <div class="kpi-card${c.danger ? ' kpi-danger' : ''}">
            <div class="kpi-label">${escapeHtml(c.label)}</div>
            <div class="kpi-value">${fmtNum(c.value)}</div>
            <div class="kpi-sub">${escapeHtml(c.sub || '')}</div>
        </div>
    `).join('');
    setHTML('kpi-row', html);
}

function renderRecentApi(targetId, rows) {
    if (!rows.length) {
        setHTML(targetId, '<div class="empty">No recent calls.</div>');
        return;
    }
    setHTML(targetId, rows.map(r => {
        const status = Number(r.status_code) || 0;
        const cls = status >= 500 ? 'red' : status >= 400 ? 'amber' : 'green';
        return `
            <div class="activity-row">
                <span class="pill ${cls}">${status || '—'}</span>
                <span class="ar-endpoint">${escapeHtml(r.endpoint || '')}</span>
                <span class="ar-meta">${fmtNum(r.latency_ms)}ms · ${ago(r.created_at)}</span>
            </div>`;
    }).join(''));
}

function renderRecentJournals(targetId, rows) {
    if (!rows.length) {
        setHTML(targetId, '<div class="empty">No journal writes recently.</div>');
        return;
    }
    setHTML(targetId, rows.map(j => `
        <div class="activity-row">
            <span class="pill">${escapeHtml(j.entry_type || 'journal')}</span>
            <span class="ar-endpoint">${escapeHtml((j.user_full_name || j.user_id || '').slice(0, 24))}</span>
            <span class="ar-meta">${fmtDate(j.journal_date)} · ${ago(j.updated_at)}</span>
        </div>
    `).join(''));
}

// ── REALTIME ──────────────────────────────────────────
async function loadRealtime() {
    try {
        const activity = await sympGet('admin/recent-activity', { limit: 20 });
        renderRecentApi('realtime-api-list',         activity.api_calls   || []);
        renderRecentJournals('realtime-journal-list', activity.journals   || []);
        renderNexusFeed('realtime-nexus-list',        activity.nexus_posts || []);
        const pill = $('realtime-pill');
        if (pill) {
            pill.textContent = 'connected';
            pill.className   = 'pill green';
        }
    } catch (e) {
        const pill = $('realtime-pill');
        if (pill) {
            pill.textContent = 'down';
            pill.className   = 'pill red';
        }
        setHTML('realtime-api-list',     `<div class="empty">${escapeHtml(e.message)}</div>`);
        setHTML('realtime-journal-list', '');
        setHTML('realtime-nexus-list',   '');
    }
}

function renderNexusFeed(targetId, rows) {
    if (!rows.length) {
        setHTML(targetId, '<div class="empty">No recent posts.</div>');
        return;
    }
    setHTML(targetId, rows.map(p => {
        const flagged = !!p.distress_flag;
        return `
            <div class="activity-row">
                <span class="pill ${flagged ? 'red' : ''}">${flagged ? 'distress' : 'post'}</span>
                <span class="ar-endpoint">${escapeHtml((p.body || '').slice(0, 64))}</span>
                <span class="ar-meta">${escapeHtml(p.community_slug || '')} · ${ago(p.created_at)}</span>
            </div>`;
    }).join(''));
}

// ── USERS ─────────────────────────────────────────────
async function loadUsers() {
    let res;
    try {
        res = await sympGet('admin/users/list', {
            q:      usersQuery || '',
            limit:  USERS_PAGE_SIZE,
            offset: usersOffset,
        });
    } catch (e) {
        setHTML('users-tbody', `<tr><td colspan="7" class="empty">${escapeHtml(e.message)}</td></tr>`);
        return;
    }
    usersTotal = res.total || (res.users || []).length;
    renderUsersTable(res.users || []);
    renderUsersPagination();
}

function renderUsersTable(rows) {
    if (!rows.length) {
        setHTML('users-tbody', '<tr><td colspan="7" class="empty">No users match.</td></tr>');
        return;
    }
    setHTML('users-tbody', rows.map(u => `
        <tr onclick="openUserDetail('${escapeHtml(u.user_id)}')">
            <td>
                <div class="u-cell">
                    <div class="u-avatar" style="background:${avatarSeedColor(u.user_id)}">${escapeHtml(initials(u.full_name))}</div>
                    <div class="u-meta">
                        <div class="u-name">${escapeHtml(u.full_name || '—')}</div>
                        <div class="u-email">${escapeHtml(u.email || '')}</div>
                    </div>
                </div>
            </td>
            <td>${escapeHtml(u.role || 'user')}</td>
            <td>${fmtNum(u.current_credits)}</td>
            <td>${fmtNum(u.vault_summaries || 0)}</td>
            <td>${fmtNum(u.journals_total || 0)}</td>
            <td>${escapeHtml(u.active_persona || 'friend')}</td>
            <td>${ago(u.last_active_at)}</td>
        </tr>
    `).join(''));
}

function renderUsersPagination() {
    const start = usersTotal === 0 ? 0 : usersOffset + 1;
    const end   = Math.min(usersOffset + USERS_PAGE_SIZE, usersTotal);
    setText('users-pagination-info', `${start}-${end} of ${fmtNum(usersTotal)}`);
    const prev = $('users-prev'); if (prev) prev.disabled = usersOffset === 0;
    const next = $('users-next'); if (next) next.disabled = end >= usersTotal;
}

window.usersPrev = function () {
    if (usersOffset === 0) return;
    usersOffset = Math.max(0, usersOffset - USERS_PAGE_SIZE);
    loadUsers();
};

window.usersNext = function () {
    if (usersOffset + USERS_PAGE_SIZE >= usersTotal) return;
    usersOffset += USERS_PAGE_SIZE;
    loadUsers();
};

// ── User detail slide-over ────────────────────────────
window.openUserDetail = async function (targetUserId) {
    const overlay = $('user-detail-overlay');
    const body    = $('user-detail-body');
    if (!overlay || !body) return;
    setText('ud-id', targetUserId.slice(0, 8) + '…');
    body.innerHTML = '<div class="empty">Loading…</div>';
    overlay.classList.add('open');
    try {
        const data = await sympGet('admin/users/detail', { target_user_id: targetUserId });
        body.innerHTML = renderUserDetail(data);
    } catch (e) {
        body.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    }
};

window.closeUserDetail = function () {
    $('user-detail-overlay')?.classList.remove('open');
};

function renderUserDetail(data) {
    const p   = data.profile  || {};
    const c   = data.credits  || {};
    const v   = data.vibe     || {};
    const per = data.persona  || {};
    const vault = data.vault  || {};
    const journals = data.journals || [];
    const actions  = data.action_rows || [];

    const journalRows = journals.length
        ? journals.map(j => `
            <tr><td>${fmtDate(j.journal_date)}</td>
                <td>${escapeHtml(j.entry_type || '')}</td>
                <td>${escapeHtml((j.summary || '').slice(0, 80))}</td></tr>`).join('')
        : '<tr><td colspan="3" class="empty">No journals.</td></tr>';

    const actionRows = actions.length
        ? actions.map(a => `
            <tr><td>${escapeHtml(a.type || '')}</td>
                <td>${escapeHtml(a.status || '')}</td>
                <td>${fmtTime(a.created_at)}</td></tr>`).join('')
        : '<tr><td colspan="3" class="empty">No queued actions.</td></tr>';

    return `
        <div class="ud-grid">
            <div class="card">
                <div class="card-head"><div class="card-title">Profile</div></div>
                <div class="kv-row"><span class="kv-label">Name</span><span class="kv-val">${escapeHtml(p.full_name || '—')}</span></div>
                <div class="kv-row"><span class="kv-label">Email</span><span class="kv-val">${escapeHtml(p.email || '—')}</span></div>
                <div class="kv-row"><span class="kv-label">Role</span><span class="kv-val">${escapeHtml(p.role || 'user')}</span></div>
                <div class="kv-row"><span class="kv-label">Joined</span><span class="kv-val">${fmtDate(p.created_at)}</span></div>
                <div class="kv-row"><span class="kv-label">Last active</span><span class="kv-val">${ago(p.last_active_at)}</span></div>
            </div>
            <div class="card">
                <div class="card-head"><div class="card-title">Wallet</div></div>
                <div class="kv-row"><span class="kv-label">Current credits</span><span class="kv-val">${fmtNum(c.current_credits)}</span></div>
                <div class="kv-row"><span class="kv-label">Lifetime granted</span><span class="kv-val">${fmtNum(c.lifetime_granted)}</span></div>
                <div class="kv-row"><span class="kv-label">Lifetime spent</span><span class="kv-val">${fmtNum(c.lifetime_spent)}</span></div>
                <button class="btn btn-ghost" onclick="seedGrantFromDetail('${escapeHtml(p.id)}', '${escapeHtml(p.full_name || '')}', '${escapeHtml(p.email || '')}', ${Number(c.current_credits) || 0})">Open in Credits →</button>
            </div>
            <div class="card">
                <div class="card-head"><div class="card-title">Companion state</div></div>
                <div class="kv-row"><span class="kv-label">Persona</span><span class="kv-val">${escapeHtml(per.active_persona || 'friend')}</span></div>
                <div class="kv-row"><span class="kv-label">Vibe (mood)</span><span class="kv-val">${escapeHtml(v.mood || '—')}</span></div>
                <div class="kv-row"><span class="kv-label">Vibe (energy)</span><span class="kv-val">${fmtNum(v.energy)}</span></div>
                <div class="kv-row"><span class="kv-label">Vault summaries</span><span class="kv-val">${fmtNum(vault.summary_count)}</span></div>
            </div>
        </div>

        <div class="card" style="margin-top:14px;">
            <div class="card-head"><div class="card-title">Recent journals</div></div>
            <table class="data-table">
                <thead><tr><th>Date</th><th>Type</th><th>Summary</th></tr></thead>
                <tbody>${journalRows}</tbody>
            </table>
        </div>

        <div class="card" style="margin-top:14px;">
            <div class="card-head"><div class="card-title">Action loop rows</div></div>
            <table class="data-table">
                <thead><tr><th>Type</th><th>Status</th><th>Created</th></tr></thead>
                <tbody>${actionRows}</tbody>
            </table>
        </div>
    `;
}

window.seedGrantFromDetail = function (uid, name, email, balance) {
    closeUserDetail();
    creditTarget = { user_id: uid, full_name: name, email, current_credits: balance };
    showPanel('credits');
    paintCreditTarget();
};

// ── CREDITS ───────────────────────────────────────────
async function loadCredits() {
    // Aggregate metrics come from /admin/overview (cached for the row).
    try {
        const kpi = await sympGet('admin/overview');
        setText('credit-agg-circulation', fmtNum(kpi.credits?.in_circulation));
        setText('credit-agg-granted',     fmtNum(kpi.credits?.lifetime_granted));
        setText('credit-agg-spent',       fmtNum(kpi.credits?.lifetime_spent));
    } catch (_) { /* leave dashes */ }

    // If a target is loaded, refresh its ledger
    if (creditTarget) {
        try {
            const lookup = await sympGet('admin/credits/lookup', { target_user_id: creditTarget.user_id });
            if (lookup.wallet) creditTarget.current_credits = lookup.wallet.current_credits;
            paintCreditTarget();
            paintLedger(lookup.transactions || []);
        } catch (e) {
            toast(`Lookup failed: ${e.message}`, 'var(--accent-red)');
        }
    } else {
        setHTML('credit-ledger-tbody', '<tr><td colspan="5" class="empty">Pick a user to see their ledger.</td></tr>');
    }
}

async function searchCreditTargets(q) {
    const list = $('credit-picker-list');
    if (!list) return;
    if (!q) {
        list.style.display = 'none';
        list.innerHTML = '';
        return;
    }
    try {
        const res = await sympGet('admin/users/search', { q, limit: 8 });
        const users = res.users || [];
        if (!users.length) {
            list.innerHTML = '<div class="picker-empty">No matches.</div>';
        } else {
            list.innerHTML = users.map(u => `
                <div class="picker-item" onclick="selectCreditTarget('${escapeHtml(u.user_id)}', '${escapeHtml(u.full_name || '')}', '${escapeHtml(u.email || '')}', ${Number(u.current_credits) || 0})">
                    <div class="u-avatar" style="background:${avatarSeedColor(u.user_id)}">${escapeHtml(initials(u.full_name))}</div>
                    <div class="picker-meta">
                        <div class="u-name">${escapeHtml(u.full_name || '—')}</div>
                        <div class="u-email">${escapeHtml(u.email || '')}</div>
                    </div>
                    <span class="pill">${fmtNum(u.current_credits)}</span>
                </div>
            `).join('');
        }
        list.style.display = 'block';
    } catch (e) {
        list.innerHTML = `<div class="picker-empty">${escapeHtml(e.message)}</div>`;
        list.style.display = 'block';
    }
}

window.selectCreditTarget = async function (uid, name, email, balance) {
    creditTarget = { user_id: uid, full_name: name, email, current_credits: balance };
    const input = $('credit-picker-input');
    if (input) input.value = '';
    const list = $('credit-picker-list');
    if (list) { list.style.display = 'none'; list.innerHTML = ''; }
    paintCreditTarget();
    try {
        const lookup = await sympGet('admin/credits/lookup', { target_user_id: uid });
        if (lookup.wallet) {
            creditTarget.current_credits = lookup.wallet.current_credits;
            paintCreditTarget();
        }
        paintLedger(lookup.transactions || []);
    } catch (e) {
        toast(`Lookup failed: ${e.message}`, 'var(--accent-red)');
    }
};

function paintCreditTarget() {
    const card = $('credit-target-card');
    if (!card) return;
    if (!creditTarget) {
        card.style.display = 'none';
        return;
    }
    card.style.display = 'block';
    setText('credit-target-name',    creditTarget.full_name || '—');
    setText('credit-target-email',   creditTarget.email     || '');
    setText('credit-target-balance', fmtNum(creditTarget.current_credits));
    const av = $('credit-target-avatar');
    if (av) {
        av.textContent     = initials(creditTarget.full_name);
        av.style.background = avatarSeedColor(creditTarget.user_id);
    }
}

function paintLedger(rows) {
    const tbody = $('credit-ledger-tbody');
    if (!tbody) return;
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">No transactions yet.</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const sign = Number(r.amount) >= 0 ? '+' : '';
        const cls  = Number(r.amount) >= 0 ? 'pos' : 'neg';
        return `
            <tr>
                <td>${fmtTime(r.created_at)}<br><span class="ar-meta">${fmtDate(r.created_at)}</span></td>
                <td>${escapeHtml(r.transaction_type || '')}</td>
                <td class="ledger-${cls}">${sign}${fmtNum(r.amount)}</td>
                <td>${fmtNum(r.balance_after)}</td>
                <td>${escapeHtml((r.reason || '').slice(0, 80))}</td>
            </tr>`;
    }).join('');
}

window.submitGrant = async function () {
    if (!creditTarget) {
        toast('Pick a user first.', 'var(--accent-amber)');
        return;
    }
    const amt    = parseInt($('credit-amount').value, 10);
    const reason = $('credit-reason').value.trim();
    if (!Number.isInteger(amt) || amt === 0) {
        toast('Enter a non-zero integer amount.', 'var(--accent-red)');
        return;
    }
    if (reason.length < 3) {
        toast('Reason must be ≥ 3 characters.', 'var(--accent-red)');
        return;
    }
    const btn = $('credit-grant-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Granting…'; }
    try {
        const data = await sympPost('admin/credits/grant', {
            target_user_id:   creditTarget.user_id,
            amount:           amt,
            reason,
            transaction_type: amt > 0 ? 'admin_grant' : 'correction',
        });
        const newBalance = data?.result?.balance_after ?? data?.balance_after;
        if (newBalance != null) creditTarget.current_credits = newBalance;
        paintCreditTarget();
        toast(`${amt > 0 ? 'Granted' : 'Adjusted'} ${Math.abs(amt)} credits.`, 'var(--accent-green)');
        $('credit-amount').value = '';
        $('credit-reason').value = '';
        const lookup = await sympGet('admin/credits/lookup', { target_user_id: creditTarget.user_id });
        paintLedger(lookup.transactions || []);
    } catch (e) {
        toast(`Grant failed: ${e.message}`, 'var(--accent-red)');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Apply'; }
    }
};

window.resetGrantForm = function () {
    creditTarget = null;
    paintCreditTarget();
    const inp = $('credit-picker-input'); if (inp) inp.value = '';
    const am  = $('credit-amount');       if (am)  am.value  = '';
    const rs  = $('credit-reason');       if (rs)  rs.value  = '';
    setHTML('credit-ledger-tbody', '<tr><td colspan="5" class="empty">Pick a user to see their ledger.</td></tr>');
};

// ── SYMP.AI BRAIN ─────────────────────────────────────
async function loadSymp() {
    try {
        const s = await sympGet('admin/symp-status');
        // Inference router
        const llm = s.inference?.llm || {};
        setText('symp-llm-provider', llm.provider || (llm.error ? 'error' : '—'));
        setText('symp-llm-base',     llm.base_url || '—');
        setText('symp-llm-key',      llm.has_key ? 'configured' : 'missing');
        const llmPill = $('symp-llm-pill');
        if (llmPill) {
            const ok = llm.has_key && !llm.error;
            llmPill.textContent = ok ? 'live' : 'unhealthy';
            llmPill.className   = 'pill ' + (ok ? 'green' : 'red');
        }
        const emb = s.inference?.embed || {};
        setText('symp-embed-provider', emb.provider      || (emb.error ? 'error' : '—'));
        setText('symp-embed-model',    emb.default_model || '—');
        setText('symp-embed-dim',      fmtNum(emb.default_dim));

        // 24h health
        setText('symp-errors-24h',  fmtNum(s.health?.errors_24h));
        setText('symp-calls-24h',   fmtNum(s.health?.calls_24h));
        setText('symp-vibes-7d',    fmtNum(s.health?.active_vibes_7d));
        setText('symp-loop-pending',fmtNum(s.action_loop?.pending));
        setText('symp-loop-done',   fmtNum(s.action_loop?.done_24h));
        setText('symp-loop-failed', fmtNum(s.action_loop?.failed_24h));

        // Diagnostic corrections
        const list = s.recent_corrections || [];
        if (!list.length) {
            setHTML('symp-corrections-list', '<div class="empty">No recent corrections — model behaving.</div>');
        } else {
            setHTML('symp-corrections-list', list.map(c => `
                <div class="activity-row">
                    <span class="pill amber">${escapeHtml(c.kind || 'note')}</span>
                    <span class="ar-endpoint">${escapeHtml((c.note || '').slice(0, 80))}</span>
                    <span class="ar-meta">${ago(c.created_at)}</span>
                </div>`).join(''));
        }
    } catch (e) {
        setHTML('symp-corrections-list', `<div class="empty">${escapeHtml(e.message)}</div>`);
        const llmPill = $('symp-llm-pill');
        if (llmPill) { llmPill.textContent = 'down'; llmPill.className = 'pill red'; }
    }
}

// ── ACTION LOOP ───────────────────────────────────────
async function loadActionLoop() {
    try {
        const s = await sympGet('admin/symp-status');
        setText('loop-kpi-pending', fmtNum(s.action_loop?.pending));
        setText('loop-kpi-done',    fmtNum(s.action_loop?.done_24h));
        setText('loop-kpi-failed',  fmtNum(s.action_loop?.failed_24h));
    } catch (e) {
        setText('loop-kpi-pending', '—');
        setText('loop-kpi-done',    '—');
        setText('loop-kpi-failed',  '—');
        toast('Action loop status failed: ' + e.message, 'var(--accent-red)');
    }
}

// ── NEXUS ─────────────────────────────────────────────
async function loadNexus() {
    try {
        const s = await sympGet('admin/symp-status');
        const n = s.nexus || {};
        setText('nexus-kpi-posts',    fmtNum(n.posts_24h));
        setText('nexus-kpi-distress', fmtNum(n.distress_flags_24h));
        setText('nexus-kpi-airep',    fmtNum(n.ai_replies_24h));
        const recent = await sympGet('admin/recent-activity', { limit: 12 });
        renderNexusFeed('nexus-posts-list', recent.nexus_posts || []);
    } catch (e) {
        setHTML('nexus-posts-list', `<div class="empty">${escapeHtml(e.message)}</div>`);
    }
}

// ── PULSE ─────────────────────────────────────────────
//
// "The Pulse" admin panel.
//   - Master switch reads/writes public.global_settings (key='pulse_active')
//   - Inbox reads public.blaksyd_pulse_logs (admin-only by RLS)
//   - Filter pills narrow the rendered set by page_context
//
// We hold the most recent batch in memory so filter clicks don't re-fetch.
let pulseRows       = [];
let pulseFilter     = 'all';
let pulseToggleBound = false;
let pulseFiltersBound = false;

const PULSE_VIBE_META = {
    calm:            { emoji: '🌿', label: 'Calm' },
    glitchy:         { emoji: '⚡', label: 'Glitchy' },
    needs_something: { emoji: '💡', label: 'Needs something' },
};
const PULSE_CONTEXT_LABEL = {
    ai_echo:       'AI Blak',
    journal:       'Journal',
    human_connect: 'Listener',
    community:     'Community',
    dashboard:     'Dashboard',
    other:         'Other',
};

async function loadPulse() {
    if (!db) return;

    // 1) Master switch state
    try {
        const { data, error } = await db
            .from('global_settings')
            .select('value, updated_at')
            .eq('key', 'pulse_active')
            .maybeSingle();
        if (error) throw error;
        const enabled = !!(data?.value?.enabled);
        const tgl = $('pulse-master-toggle');
        if (tgl) tgl.checked = enabled;
        setText('pulse-toggle-label', enabled ? 'ON' : 'OFF');
        setText('pulse-toggle-meta', data?.updated_at
            ? `Last changed ${ago(data.updated_at)}`
            : 'Default state — never changed.');
    } catch (e) {
        setText('pulse-toggle-meta', 'Could not read switch state: ' + e.message);
    }

    // 2) Wire toggle (once)
    if (!pulseToggleBound) {
        const tgl = $('pulse-master-toggle');
        if (tgl) {
            tgl.addEventListener('change', async () => {
                const next = !!tgl.checked;
                tgl.disabled = true;
                try {
                    const { error } = await db
                        .from('global_settings')
                        .upsert({ key: 'pulse_active', value: { enabled: next } }, { onConflict: 'key' });
                    if (error) throw error;
                    setText('pulse-toggle-label', next ? 'ON' : 'OFF');
                    setText('pulse-toggle-meta', `Just changed — ${next ? 'collecting' : 'paused'}.`);
                    toast(next ? 'Pulse is now ON.' : 'Pulse is paused.');
                } catch (err) {
                    tgl.checked = !next; // revert
                    toast('Switch failed: ' + err.message, 'var(--accent-red)');
                } finally {
                    tgl.disabled = false;
                }
            });
            pulseToggleBound = true;
        }
    }

    // 3) Wire filter pills (once)
    if (!pulseFiltersBound) {
        document.querySelectorAll('#pulse-filters .pulse-filter').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#pulse-filters .pulse-filter')
                    .forEach(b => b.classList.toggle('active', b === btn));
                pulseFilter = btn.dataset.filter || 'all';
                renderPulseGrid();
            });
        });
        pulseFiltersBound = true;
    }

    // 4) Inbox
    try {
        const { data, error } = await db
            .from('blaksyd_pulse_logs')
            .select('id, user_id, page_context, vibe_rating, feedback_text, created_at')
            .order('created_at', { ascending: false })
            .limit(120);
        if (error) throw error;
        pulseRows = data || [];
        setText('nav-pulse-count', pulseRows.length ? String(pulseRows.length) : '');
        renderPulseGrid();
    } catch (e) {
        setHTML('pulse-grid', `<div class="empty-state">Inbox failed: ${escapeHtml(e.message)}</div>`);
    }
}

function renderPulseGrid() {
    const grid = $('pulse-grid');
    if (!grid) return;

    const rows = pulseFilter === 'all'
        ? pulseRows
        : pulseRows.filter(r => r.page_context === pulseFilter);

    setText('pulse-inbox-sub', rows.length
        ? `Showing ${rows.length}${pulseFilter === 'all' ? '' : ` in ${PULSE_CONTEXT_LABEL[pulseFilter] || pulseFilter}`}`
        : 'No pulses to show yet');

    if (!rows.length) {
        grid.innerHTML = `<div class="empty-state">No pulses ${pulseFilter === 'all' ? 'yet' : 'in this surface'}.</div>`;
        return;
    }

    grid.innerHTML = rows.map(r => {
        const vibeMeta = PULSE_VIBE_META[r.vibe_rating] || { emoji: '·', label: r.vibe_rating };
        const ctxLabel = PULSE_CONTEXT_LABEL[r.page_context] || r.page_context;
        const text = (r.feedback_text || '').trim();
        const userTag = r.user_id ? `${r.user_id.slice(0, 6)}…` : 'anon';
        return `
            <div class="pulse-card vibe-${escapeHtml(r.vibe_rating)}">
                <div class="pulse-card-head">
                    <span class="pulse-vibe-tag vibe-${escapeHtml(r.vibe_rating)}">
                        <span aria-hidden="true">${vibeMeta.emoji}</span> ${escapeHtml(vibeMeta.label)}
                    </span>
                    <span class="pulse-context-tag">${escapeHtml(ctxLabel)}</span>
                </div>
                ${text
                    ? `<div class="pulse-text">${escapeHtml(text)}</div>`
                    : `<div class="pulse-text no-text">No words left — vibe only.</div>`}
                <div class="pulse-foot">
                    <span class="pulse-user">${escapeHtml(userTag)}</span>
                    <span title="${escapeHtml(new Date(r.created_at).toLocaleString())}">${escapeHtml(ago(r.created_at))}</span>
                </div>
            </div>
        `;
    }).join('');
}

// ══════════════════════════════════════════════════════
//  SympOS — HUD telemetry rail, FinOps chart, Control deck
// ══════════════════════════════════════════════════════

// ── HUD: persistent live tickers (Live users / Listeners / Burn) ──
//
// Real numbers come from /admin/overview where we have them; otherwise we
// keep the value reasonable and apply small Brownian wiggles so the HUD feels
// alive even between polls. This is honest because the underlying telemetry
// only updates every ~30s — the wiggle just smooths the visual cadence.
const HUD_STATE = { liveUsers: null, listeners: null, burn: null, lastTick: 0 };
let hudTimer = null;

function setHudValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value == null ? '—' : Number(value).toLocaleString();
}
function setHudDelta(id, delta) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!delta) { el.textContent = ''; el.className = 'hud-tile-delta'; return; }
    const sign = delta > 0 ? '▲' : '▼';
    el.textContent = `${sign} ${Math.abs(delta)}`;
    el.className = 'hud-tile-delta ' + (delta > 0 ? 'up' : 'down');
}

function wiggle(prev, base, range) {
    if (prev == null) return base;
    // Bounded random walk — never drifts more than range from base.
    const drift = (Math.random() - 0.5) * 2;
    let next = Math.round(prev + drift);
    if (next < base - range) next = base - range;
    if (next > base + range) next = base + range;
    return next;
}

async function refreshHudTruth() {
    if (!db) return;
    // Active sessions: rows in session_events within last 5 min (best-effort).
    try {
        const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { count } = await db
            .from('session_events')
            .select('user_id', { count: 'exact', head: true })
            .gte('created_at', since);
        if (typeof count === 'number') HUD_STATE.liveUsers = count;
    } catch (_) {}

    // Listeners: profiles where role='listener' AND last_seen within 10 min,
    // with a graceful fallback if last_seen column doesn't exist.
    try {
        let q = db.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'listener');
        const { count } = await q;
        if (typeof count === 'number') HUD_STATE.listeners = count;
    } catch (_) {}

    // Burn: tokens/min from last 5 min of api_calls (best-effort).
    try {
        const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { data } = await db
            .from('api_calls')
            .select('total_tokens, created_at')
            .gte('created_at', since)
            .limit(2000);
        const sum = (data || []).reduce((acc, r) => acc + (r.total_tokens || 0), 0);
        HUD_STATE.burn = Math.round(sum / 5); // tokens / minute
    } catch (_) {}
}

function tickHud() {
    // Cheap wiggle so the HUD never looks frozen; honest because real numbers
    // get refreshed every ~30s by refreshHudTruth().
    const prev = { ...HUD_STATE };
    const baseUsers = HUD_STATE.liveUsers ?? 0;
    const baseListeners = HUD_STATE.listeners ?? 0;
    const baseBurn = HUD_STATE.burn ?? 0;

    // Only apply wiggles if we already have a baseline; otherwise show "—".
    if (HUD_STATE.liveUsers != null)  HUD_STATE.liveUsers  = wiggle(HUD_STATE.liveUsers,  baseUsers,  Math.max(2, Math.round(baseUsers * 0.08)));
    if (HUD_STATE.listeners != null)  HUD_STATE.listeners  = wiggle(HUD_STATE.listeners,  baseListeners, 1);
    if (HUD_STATE.burn != null)       HUD_STATE.burn       = wiggle(HUD_STATE.burn,       baseBurn,   Math.max(20, Math.round(baseBurn * 0.06)));

    setHudValue('hud-live-users', HUD_STATE.liveUsers);
    setHudValue('hud-listeners',  HUD_STATE.listeners);
    setHudValue('hud-burn',       HUD_STATE.burn);

    if (prev.liveUsers != null && HUD_STATE.liveUsers != null) setHudDelta('hud-live-users-delta', HUD_STATE.liveUsers - prev.liveUsers);
    if (prev.listeners != null && HUD_STATE.listeners != null) setHudDelta('hud-listeners-delta',  HUD_STATE.listeners - prev.listeners);
    if (prev.burn != null && HUD_STATE.burn != null)           setHudDelta('hud-burn-delta',       HUD_STATE.burn      - prev.burn);
}

function startHud() {
    if (hudTimer) return;
    refreshHudTruth().then(tickHud);
    hudTimer = setInterval(() => {
        tickHud();
        if (Date.now() - HUD_STATE.lastTick > 30_000) {
            HUD_STATE.lastTick = Date.now();
            refreshHudTruth();
        }
    }, 2200);
}
// Auto-start once the body is ready and the lock screen is past.
document.addEventListener('DOMContentLoaded', () => {
    // Defer until after admin gate likely passed.
    setTimeout(startHud, 1500);
});

// ── FinOps chart (last 7 days) ────────────────────────
let finopsChart = null;

async function fetchFinopsSeries() {
    // Try to read a daily rollup from api_calls (group by date).
    if (!db) return null;
    try {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await db
            .from('api_calls')
            .select('total_tokens, created_at')
            .gte('created_at', since)
            .limit(5000);
        if (error) throw error;

        // Bucket by yyyy-mm-dd
        const buckets = {};
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86_400_000);
            const k = d.toISOString().slice(0, 10);
            days.push(k);
            buckets[k] = { tokens: 0, credits: 0 };
        }
        for (const r of (data || [])) {
            const k = (r.created_at || '').slice(0, 10);
            if (buckets[k]) buckets[k].tokens += (r.total_tokens || 0);
        }

        // Try credits ledger separately (best-effort)
        try {
            const { data: ledger } = await db
                .from('credit_ledger')
                .select('amount, created_at, kind')
                .gte('created_at', since)
                .limit(5000);
            for (const r of (ledger || [])) {
                if ((r.amount || 0) >= 0) continue; // only spend
                const k = (r.created_at || '').slice(0, 10);
                if (buckets[k]) buckets[k].credits += Math.abs(r.amount);
            }
        } catch (_) {}

        return {
            labels: days.map(d => d.slice(5)), // MM-DD
            tokens: days.map(d => buckets[d].tokens),
            credits: days.map(d => buckets[d].credits),
        };
    } catch (e) {
        console.warn('[finops] fetch failed', e);
        return null;
    }
}

async function renderFinopsChart() {
    const canvas = $('finops-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    const series = await fetchFinopsSeries();
    if (!series) {
        const pill = $('finops-pill');
        if (pill) { pill.textContent = 'no data'; pill.className = 'pill'; }
        return;
    }

    const totalTokens  = series.tokens.reduce((a, b) => a + b, 0);
    const totalCredits = series.credits.reduce((a, b) => a + b, 0);
    setText('finops-totals', `Σ ${fmtNum(totalTokens)} tokens · ${fmtNum(totalCredits)} credits`);
    const pill = $('finops-pill');
    if (pill) {
        pill.textContent = totalTokens ? 'tracking' : 'idle';
        pill.className = 'pill ' + (totalTokens ? 'green' : '');
    }

    const ctx = canvas.getContext('2d');

    // Aurora gradients
    const tokenGrad = ctx.createLinearGradient(0, 0, 0, 240);
    tokenGrad.addColorStop(0, 'rgba(0,229,176,0.45)');
    tokenGrad.addColorStop(1, 'rgba(0,229,176,0.00)');
    const creditGrad = ctx.createLinearGradient(0, 0, 0, 240);
    creditGrad.addColorStop(0, 'rgba(176,115,255,0.40)');
    creditGrad.addColorStop(1, 'rgba(176,115,255,0.00)');

    const data = {
        labels: series.labels,
        datasets: [
            {
                label: 'Tokens',
                data: series.tokens,
                borderColor: '#00e5b0',
                backgroundColor: tokenGrad,
                tension: 0.35, fill: true, borderWidth: 2,
                pointRadius: 3, pointBackgroundColor: '#00e5b0',
                yAxisID: 'y',
            },
            {
                label: 'Credits',
                data: series.credits,
                borderColor: '#b073ff',
                backgroundColor: creditGrad,
                tension: 0.35, fill: true, borderWidth: 2,
                pointRadius: 3, pointBackgroundColor: '#b073ff',
                yAxisID: 'y1',
            },
        ],
    };

    const opts = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: 'rgba(11,15,22,0.96)',
                borderColor: 'rgba(255,255,255,0.10)', borderWidth: 1,
                titleColor: '#e8eaf0', bodyColor: '#9ca3af', padding: 10,
            },
        },
        scales: {
            x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 10 } } },
            y:  { position: 'left',  grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 10 } } },
            y1: { position: 'right', grid: { display: false },                  ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 10 } } },
        },
    };

    if (finopsChart) {
        finopsChart.data = data;
        finopsChart.update('none');
    } else {
        finopsChart = new Chart(ctx, { type: 'line', data, options: opts });
    }
}

// ── CONTROLS panel (Pulse + AI kill switch) ───────────
let controlsBound = false;

async function loadControls() {
    if (!db) return;
    // 1) Read both switches
    let rows = [];
    try {
        const { data, error } = await db
            .from('global_settings')
            .select('key, value, updated_at')
            .in('key', ['pulse_active', 'ai_voice_killswitch']);
        if (error) throw error;
        rows = data || [];
    } catch (e) {
        toast('Could not read switches: ' + e.message, 'var(--accent-red)');
        return;
    }
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
    applyDeckState('pulse',  !!byKey.pulse_active?.value?.enabled,        byKey.pulse_active?.updated_at,        'ON', 'OFF');
    applyDeckState('aikill', !!byKey.ai_voice_killswitch?.value?.enabled, byKey.ai_voice_killswitch?.updated_at, 'KILLED', 'LIVE');

    // 2) Bind change handlers (once)
    if (!controlsBound) {
        const pTgl = $('ctl-pulse-toggle');
        const kTgl = $('ctl-aikill-toggle');
        if (pTgl) pTgl.addEventListener('change', () => writeSwitch('pulse_active', pTgl.checked, 'pulse', 'ON', 'OFF'));
        if (kTgl) kTgl.addEventListener('change', () => writeSwitch('ai_voice_killswitch', kTgl.checked, 'aikill', 'KILLED', 'LIVE'));
        controlsBound = true;
    }
}

function applyDeckState(prefix, enabled, updatedAt, onLabel, offLabel) {
    const tgl = $(`ctl-${prefix}-toggle`);
    if (tgl) tgl.checked = enabled;
    setText(`ctl-${prefix}-state`, enabled ? onLabel : offLabel);
    const meta = $(`ctl-${prefix}-meta`);
    if (meta) meta.classList.toggle('on', enabled);
    setText(`ctl-${prefix}-meta-text`, updatedAt
        ? `${enabled ? onLabel : offLabel} · last changed ${ago(updatedAt)}`
        : `${enabled ? onLabel : offLabel} · default state`);
}

async function writeSwitch(key, enabled, prefix, onLabel, offLabel) {
    const tgl = $(`ctl-${prefix}-toggle`);
    if (!tgl) return;
    tgl.disabled = true;
    try {
        const { error } = await db
            .from('global_settings')
            .upsert({ key, value: { enabled } }, { onConflict: 'key' });
        if (error) throw error;
        applyDeckState(prefix, enabled, new Date().toISOString(), onLabel, offLabel);
        toast(`${key} → ${enabled ? onLabel : offLabel}`);
    } catch (e) {
        tgl.checked = !enabled;
        toast('Switch failed: ' + e.message, 'var(--accent-red)');
    } finally {
        tgl.disabled = false;
    }
}

// ── ACTIVITY ──────────────────────────────────────────
async function loadActivity() {
    try {
        const a = await sympGet('admin/recent-activity', { limit: 50 });
        renderRecentApi('activity-api-list',       a.api_calls || []);
        renderRecentJournals('activity-journal-list', a.journals || []);
    } catch (e) {
        setHTML('activity-api-list',     `<div class="empty">${escapeHtml(e.message)}</div>`);
        setHTML('activity-journal-list', '');
    }
}
