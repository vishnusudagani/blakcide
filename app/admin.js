// ══════════════════════════════════════════════════════
//  BLAKCIDE — COMMAND CENTER  |  admin.js
// ══════════════════════════════════════════════════════

const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

let db;
if (typeof window.supabase !== 'undefined') {
    db = window._sbClient || (window._sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY));
}

// ── Global state ──────────────────────────────────────
let allUsers       = [];
let allSessions    = [];
let sessionFilter  = 'all';
let sessionChart   = null;
let typeChart      = null;
let liveEventCount = 0;
let adminProfile   = null;

// ── Helpers ───────────────────────────────────────────
const $  = id => document.getElementById(id);
const fx = id => { const el = $(id); return el; };

function toast(msg, color = 'var(--text)') {
    const t = document.createElement('div');
    t.className = 'toast';
    t.style.color = color;
    t.innerText = msg;
    $('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 3500);
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
    const s = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return `${Math.floor(s/86400)}d ago`;
}

function initials(name) {
    if (!name) return '?';
    return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

// ── Boot ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!db) {
        toast('Supabase failed to load.', 'var(--accent-red)');
        return;
    }

    // Auth check
    const { data: { session } } = await db.auth.getSession();
    if (!session) { window.location.href = '../index.html'; return; }

    // Role check
    const { data: profile } = await db.from('profiles').select('*').eq('id', session.user.id).maybeSingle();

    if (!profile || profile.role !== 'admin') {
        $('admin-lock').innerHTML = `
            <ion-icon name="warning-outline" style="font-size:5rem;color:var(--accent-red);margin-bottom:20px;"></ion-icon>
            <h2 style="color:var(--accent-red);letter-spacing:2px;">ACCESS DENIED</h2>
            <p style="color:var(--muted);margin-top:10px;">You do not have administrative clearance.</p>
            <button onclick="window.location.href='dashboard.html'"
                style="margin-top:30px;padding:12px 25px;background:transparent;color:white;
                       border:1px solid var(--border);border-radius:8px;cursor:pointer;">
                Return to Dashboard
            </button>`;
        return;
    }

    adminProfile = profile;

    // Set admin pill
    const dispName = profile.full_name || session.user.email || 'Admin';
    $('admin-display-name').innerText = dispName;
    $('admin-avatar-initials').innerText = initials(dispName);

    // Fade lock screen
    setTimeout(() => {
        $('admin-lock').style.transition = 'opacity 0.5s';
        $('admin-lock').style.opacity = '0';
        setTimeout(() => $('admin-lock').style.display = 'none', 500);
    }, 900);

    // Load data + realtime
    await loadAll();
    setupRealtime();

    // Auto-refresh every 60s
    setInterval(loadStats, 60000);
});

// ── Panel Navigation ──────────────────────────────────
const PANELS = {
    overview:  { title: 'System Overview',        sub: 'Platform health and key metrics' },
    live:      { title: 'Live Event Feed',         sub: 'Realtime database activity stream' },
    users:     { title: 'User Management',         sub: 'All registered users on the platform' },
    listeners: { title: 'Listener Roster',         sub: 'Human Connect listener profiles & stats' },
    sessions:  { title: 'Session Registry',        sub: 'All calls and chat sessions' },
    ai:        { title: 'AI & Journals',           sub: 'AI conversations and journal entries' },
    activity:  { title: 'User Activity',           sub: 'Calendar-style activity tracker across all users' },
    controls:  { title: 'Admin Controls',          sub: 'Platform toggles and bulk operations' },
};

window.showPanel = function(name) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(el => el.classList.remove('active'));

    const navItem = document.querySelector(`.nav-item[onclick*="'${name}'"]`);
    if (navItem) navItem.classList.add('active');

    const panel = $(`panel-${name}`);
    if (panel) panel.classList.add('active');

    const info = PANELS[name] || { title: name, sub: '' };
    $('panel-title').innerText = info.title;
    $('panel-sub').innerText   = info.sub;

    // Lazy-load panel data on first visit
    if (name === 'users')     loadUsers();
    if (name === 'listeners') loadListeners();
    if (name === 'sessions')  loadSessions();
    if (name === 'ai')        loadAIPanel();
    if (name === 'activity')  loadActivityPanel();
};

// ── Refresh ───────────────────────────────────────────
window.refreshAll = async function() {
    toast('Refreshing all data…');
    await loadAll();
};

async function loadAll() {
    await loadStats();
    renderRecentSessions();
}

// ── Overview Stats ────────────────────────────────────
async function loadStats() {
    const now = new Date();
    const weekAgo  = new Date(now - 7  * 86400000).toISOString();
    const monthAgo = new Date(now - 30 * 86400000).toISOString();

    try {
        // Users
        const [
            { count: totalUsers },
            { count: weekUsers },
            { count: totalListeners },
            { data: onlineListeners },
            { count: activeSessions },
            { count: completedSessions },
            { count: totalMessages },
            { count: totalAIChats },
            { count: totalJournals },
            { count: weekJournals },
        ] = await Promise.all([
            db.from('profiles').select('*', { count: 'exact', head: true }).neq('role', 'admin'),
            db.from('profiles').select('*', { count: 'exact', head: true }).neq('role', 'admin').gte('created_at', weekAgo),
            db.from('listeners').select('*', { count: 'exact', head: true }),
            db.from('listeners').select('id').eq('is_online', true),
            db.from('sessions').select('*', { count: 'exact', head: true }).eq('status', 'active'),
            db.from('sessions').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
            db.from('messages').select('*', { count: 'exact', head: true }),
            db.from('chats').select('*', { count: 'exact', head: true }),
            db.from('journals').select('*', { count: 'exact', head: true }),
            db.from('journals').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo),
        ]);

        $('m-users').innerText             = totalUsers  || 0;
        $('m-users-week').innerText        = `+${weekUsers || 0}`;
        $('m-listeners-online').innerText  = (onlineListeners || []).length;
        $('m-listeners-total').innerText   = totalListeners  || 0;
        $('m-active-sessions').innerText   = activeSessions  || 0;
        $('m-completed-sessions').innerText= completedSessions || 0;
        $('m-messages').innerText          = totalMessages   || 0;
        $('m-ai-chats').innerText          = totalAIChats    || 0;
        $('m-journals').innerText          = totalJournals   || 0;
        $('m-journals-week').innerText     = `+${weekJournals || 0}`;
        $('users-count').innerText         = totalUsers  || 0;

        // Last updated
        $('last-updated').innerText = 'Updated ' + new Date().toLocaleTimeString();

        // Charts
        await buildSessionChart(monthAgo);
        buildTypeChart();

    } catch(e) {
        console.error('loadStats error:', e);
    }
}

// ── Session line chart ─────────────────────────────────
async function buildSessionChart(fromDate) {
    const { data } = await db.from('sessions')
        .select('created_at')
        .gte('created_at', fromDate)
        .order('created_at', { ascending: true });

    // Group by day
    const counts = {};
    for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        const key = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        counts[key] = 0;
    }
    (data || []).forEach(s => {
        const key = new Date(s.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        if (key in counts) counts[key]++;
    });

    const labels = Object.keys(counts);
    const values = Object.values(counts);

    const ctx = $('chart-sessions').getContext('2d');
    if (sessionChart) sessionChart.destroy();
    sessionChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Sessions',
                data: values,
                borderColor: '#00e5b0',
                backgroundColor: 'rgba(0,229,176,0.08)',
                fill: true,
                tension: 0.4,
                pointRadius: 3,
                pointBackgroundColor: '#00e5b0',
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    ticks: { color: '#6b7280', font: { size: 10 }, maxTicksLimit: 8 },
                    grid: { color: 'rgba(255,255,255,0.04)' }
                },
                y: {
                    ticks: { color: '#6b7280', font: { size: 10 }, stepSize: 1 },
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    beginAtZero: true,
                }
            }
        }
    });
}

// ── Session type doughnut ─────────────────────────────
async function buildTypeChart() {
    const [{ count: calls }, { count: chats }] = await Promise.all([
        db.from('sessions').select('*', { count: 'exact', head: true }).eq('type', 'call'),
        db.from('sessions').select('*', { count: 'exact', head: true }).eq('type', 'chat'),
    ]);

    const ctx = $('chart-types').getContext('2d');
    if (typeChart) typeChart.destroy();
    typeChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Calls', 'Chats'],
            datasets: [{
                data: [calls || 0, chats || 0],
                backgroundColor: ['#3d9eff', '#a855f7'],
                borderWidth: 0,
                hoverOffset: 4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '70%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#6b7280', font: { size: 11 }, padding: 12, boxWidth: 12 }
                }
            }
        }
    });
}

// ── Recent Sessions (Overview) ────────────────────────
async function renderRecentSessions() {
    const tbody = $('recent-sessions-body');
    const { data } = await db.from('sessions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(8);

    if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><ion-icon name="swap-horizontal-outline"></ion-icon>No sessions yet</div></td></tr>`;
        return;
    }

    tbody.innerHTML = data.map(s => sessionRow(s, true)).join('');
}

// ── Users Panel ───────────────────────────────────────
async function loadUsers() {
    const tbody = $('users-table-body');
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><ion-icon name="sync-outline"></ion-icon>Loading users…</div></td></tr>`;

    const { data: users } = await db.from('profiles')
        .select('*')
        .neq('role', 'admin')
        .order('created_at', { ascending: false });

    if (!users) { tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Error loading users.</div></td></tr>`; return; }

    allUsers = users;
    $('users-display-count').innerText = `(${users.length})`;
    $('users-count').innerText = users.length;
    renderUsersTable(users);
}

function renderUsersTable(users) {
    const tbody = $('users-table-body');
    if (!users.length) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><ion-icon name="people-outline"></ion-icon>No users found</div></td></tr>`;
        return;
    }
    tbody.innerHTML = users.map(u => `
        <tr onclick="viewUser('${u.id}')">
            <td>
                <div class="user-cell">
                    <div class="u-avatar">${initials(u.full_name)}</div>
                    <div>
                        <div class="u-name">${u.full_name || 'Anonymous'}</div>
                        <div class="u-email">${u.email || ''}</div>
                    </div>
                </div>
            </td>
            <td>${fmtDate(u.created_at)}</td>
            <td class="text-muted">${ago(u.updated_at || u.created_at)}</td>
            <td>—</td>
            <td>—</td>
            <td>—</td>
            <td>${u.status === 'suspended'
                ? '<span class="badge badge-red">Suspended</span>'
                : '<span class="badge badge-green">Active</span>'}</td>
            <td><button class="btn btn-ghost" onclick="event.stopPropagation();viewUser('${u.id}')">View</button></td>
        </tr>
    `).join('');
}

window.filterUsers = function(q) {
    const filtered = allUsers.filter(u => {
        const name  = (u.full_name || '').toLowerCase();
        const email = (u.email || '').toLowerCase();
        return name.includes(q.toLowerCase()) || email.includes(q.toLowerCase());
    });
    renderUsersTable(filtered);
};

// ── User Detail Slide Panel ───────────────────────────
window.viewUser = async function(userId) {
    openSlidePanel('Loading user…', `<div class="empty-state"><ion-icon name="sync-outline"></ion-icon>Querying database…</div>`);

    const [
        { data: profile },
        { count: journalCount },
        { count: aiChatCount },
        { count: sessionCount },
        { data: recentChats },
        { data: recentJournals },
        { data: recentSessions },
    ] = await Promise.all([
        db.from('profiles').select('*').eq('id', userId).maybeSingle(),
        db.from('journals').select('*', { count: 'exact', head: true }).eq('user_id', userId),
        db.from('chats').select('*', { count: 'exact', head: true }).eq('user_id', userId),
        db.from('sessions').select('*', { count: 'exact', head: true }).eq('user_id', userId),
        db.from('chats').select('id, title, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
        db.from('journals').select('id, title, content, created_at, image_url, audio_url, spotify_url').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
        db.from('sessions').select('id, type, status, message_count, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
    ]);

    if (!profile) { $('slide-body').innerHTML = `<div class="empty-state">User not found.</div>`; return; }

    const isSuspended = profile.status === 'suspended';
    const isListener  = profile.role === 'listener';

    // Avatar — real image if available
    const avatarHtml = profile.avatar_url
        ? `<img src="${profile.avatar_url}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--accent);flex-shrink:0;">`
        : `<div class="p-avatar">${initials(profile.full_name)}</div>`;

    // AI Chats section
    const chatsHtml = (recentChats || []).length
        ? (recentChats || []).map(c => `
            <div class="cp-row" onclick="viewAIChat('${c.id}')">
                <div class="cp-icon" style="color:var(--accent-red)"><ion-icon name="sparkles-outline"></ion-icon></div>
                <div class="cp-body">
                    <div class="cp-title">${c.title || 'Untitled Chat'}</div>
                    <div class="cp-meta">${fmtDate(c.created_at)}</div>
                </div>
                <ion-icon name="chevron-forward-outline" style="color:var(--muted);font-size:0.85rem;flex-shrink:0;"></ion-icon>
            </div>`).join('')
        : '<div class="text-muted" style="font-size:0.82rem;padding:8px 0 4px;">No AI chats yet</div>';

    // Journals section
    const journalsHtml = (recentJournals || []).length
        ? (recentJournals || []).map(j => {
            const preview = (j.content || '').substring(0, 75).replace(/[<>]/g, '');
            const hasMedia = j.image_url || j.audio_url || j.spotify_url;
            return `
            <div class="cp-row" onclick="viewJournal('${j.id}')">
                <div class="cp-icon" style="color:#34d399"><ion-icon name="book-outline"></ion-icon></div>
                <div class="cp-body">
                    <div class="cp-title">${j.title || 'Untitled Entry'}</div>
                    <div class="cp-meta">${fmtDate(j.created_at)}${hasMedia ? ' · 📎 media' : ''}</div>
                    ${preview ? `<div class="cp-preview">${preview}${(j.content||'').length > 75 ? '…' : ''}</div>` : ''}
                </div>
                <ion-icon name="chevron-forward-outline" style="color:var(--muted);font-size:0.85rem;flex-shrink:0;"></ion-icon>
            </div>`;
        }).join('')
        : '<div class="text-muted" style="font-size:0.82rem;padding:8px 0 4px;">No journal entries yet</div>';

    // Recent Sessions section
    const sessionsHtml = (recentSessions || []).length
        ? (recentSessions || []).map(s => {
            const typeBadge = s.type === 'call'
                ? '<span class="badge badge-blue" style="font-size:0.65rem;padding:2px 7px;">Call</span>'
                : '<span class="badge badge-purple" style="font-size:0.65rem;padding:2px 7px;">Chat</span>';
            const statusBadge = s.status === 'active'
                ? '<span class="badge badge-yellow" style="font-size:0.65rem;padding:2px 7px;">● Active</span>'
                : '<span class="badge badge-grey" style="font-size:0.65rem;padding:2px 7px;">Done</span>';
            return `
            <div class="cp-row" onclick="viewSessionTranscript('${s.id}')">
                <div class="cp-icon" style="color:var(--accent-yellow)"><ion-icon name="swap-horizontal-outline"></ion-icon></div>
                <div class="cp-body">
                    <div style="display:flex;gap:5px;align-items:center;margin-bottom:3px;">${typeBadge} ${statusBadge}</div>
                    <div class="cp-meta">${s.message_count || 0} messages · ${fmtDate(s.created_at)}</div>
                </div>
                <ion-icon name="chevron-forward-outline" style="color:var(--muted);font-size:0.85rem;flex-shrink:0;"></ion-icon>
            </div>`;
        }).join('')
        : '<div class="text-muted" style="font-size:0.82rem;padding:8px 0 4px;">No sessions yet</div>';

    openSlidePanel(profile.full_name || 'User Profile', `
        <div class="profile-hero">
            ${avatarHtml}
            <div style="flex:1;min-width:0;">
                <div class="p-name">${profile.full_name || 'Anonymous'}</div>
                <div class="p-email">${profile.email || ''}</div>
                <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
                    <span class="badge ${isListener ? 'badge-blue' : 'badge-grey'}">${profile.role || 'user'}</span>
                    <span class="badge ${isSuspended ? 'badge-red' : 'badge-green'}">${isSuspended ? 'Suspended' : 'Active'}</span>
                    ${profile.spotify_display_name ? `<span class="badge" style="background:rgba(29,185,84,0.15);color:#1DB954;border:1px solid rgba(29,185,84,0.25);">🎵 Spotify</span>` : ''}
                </div>
            </div>
        </div>

        <div class="stats-mini">
            <div class="stat-mini-box">
                <div class="stat-mini-val text-accent">${aiChatCount || 0}</div>
                <div class="stat-mini-label">AI Chats</div>
            </div>
            <div class="stat-mini-box">
                <div class="stat-mini-val" style="color:#34d399;">${journalCount || 0}</div>
                <div class="stat-mini-label">Journals</div>
            </div>
            <div class="stat-mini-box">
                <div class="stat-mini-val" style="color:var(--accent-yellow);">${sessionCount || 0}</div>
                <div class="stat-mini-label">Sessions</div>
            </div>
        </div>

        <div class="section-title">Profile Details</div>
        <div class="detail-row"><span class="detail-label">User ID</span><span style="font-family:monospace;font-size:0.73rem;color:var(--muted)">${profile.id}</span></div>
        <div class="detail-row"><span class="detail-label">Joined</span><span>${fmtDate(profile.created_at)}</span></div>
        <div class="detail-row"><span class="detail-label">Last Updated</span><span>${ago(profile.updated_at)}</span></div>
        ${profile.gender ? `<div class="detail-row"><span class="detail-label">Gender</span><span>${profile.gender}</span></div>` : ''}
        ${profile.date_of_birth ? `<div class="detail-row"><span class="detail-label">Date of Birth</span><span>${profile.date_of_birth}</span></div>` : ''}
        ${profile.bio ? `<div class="detail-row" style="align-items:flex-start;"><span class="detail-label">Bio</span><span style="max-width:300px;text-align:right;color:var(--muted);font-size:0.8rem;line-height:1.5;">${profile.bio.substring(0,120)}${profile.bio.length>120?'…':''}</span></div>` : ''}
        ${profile.spotify_display_name ? `<div class="detail-row"><span class="detail-label">Spotify</span><span style="color:#1DB954;">🎵 ${profile.spotify_display_name}</span></div>` : ''}

        <div class="section-title" style="margin-top:24px;">
            Recent AI Chats
            <span style="color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0;">&nbsp;(${aiChatCount || 0} total)</span>
        </div>
        ${chatsHtml}

        <div class="section-title" style="margin-top:24px;">
            Recent Journals
            <span style="color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0;">&nbsp;(${journalCount || 0} total)</span>
        </div>
        ${journalsHtml}

        <div class="section-title" style="margin-top:24px;">
            Recent Sessions
            <span style="color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0;">&nbsp;(${sessionCount || 0} total)</span>
        </div>
        ${sessionsHtml}

        <div class="section-title" style="margin-top:28px;">Admin Actions</div>
        <div class="flex-gap mt-4">
            <button class="btn btn-ghost" onclick="viewUserActivity('${profile.id}')"><ion-icon name="calendar-outline"></ion-icon> Activity</button>
            ${!isListener
                ? `<button class="btn btn-primary" onclick="promoteToListener('${profile.id}')"><ion-icon name="headset-outline"></ion-icon> Make Listener</button>`
                : `<button class="btn btn-warning" onclick="demoteToUser('${profile.id}')"><ion-icon name="person-outline"></ion-icon> Remove Listener</button>`}
            ${!isSuspended
                ? `<button class="btn btn-danger" onclick="suspendUser('${profile.id}')"><ion-icon name="ban-outline"></ion-icon> Suspend</button>`
                : `<button class="btn" style="background:rgba(0,229,176,0.12);color:var(--accent);border:1px solid rgba(0,229,176,0.3);" onclick="reactivateUser('${profile.id}')"><ion-icon name="checkmark-circle-outline"></ion-icon> Reactivate</button>`}
        </div>
    `);
};

// ── User Activity Calendar (Slide Panel) ──────────────
window.viewUserActivity = async function(userId) {
    openSlidePanel('User Activity', `<div class="empty-state"><ion-icon name="sync-outline"></ion-icon>Building activity graph…</div>`);

    const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();

    const [
        { data: profile },
        { data: journals },
        { data: chats },
        { data: sessions },
    ] = await Promise.all([
        db.from('profiles').select('full_name, avatar_url').eq('id', userId).maybeSingle(),
        db.from('journals').select('created_at').eq('user_id', userId).gte('created_at', yearAgo),
        db.from('chats').select('created_at').eq('user_id', userId).gte('created_at', yearAgo),
        db.from('sessions').select('created_at, type').eq('user_id', userId).gte('created_at', yearAgo),
    ]);

    // Build day activity map
    const dayMap = {};
    const inc = (item, key) => {
        const d = (item.created_at || '').split('T')[0];
        if (!d) return;
        if (!dayMap[d]) dayMap[d] = { journals: 0, chats: 0, sessions: 0, total: 0 };
        dayMap[d][key]++;
        dayMap[d].total++;
    };
    (journals  || []).forEach(j => inc(j, 'journals'));
    (chats     || []).forEach(c => inc(c, 'chats'));
    (sessions  || []).forEach(s => inc(s, 'sessions'));

    const totalJournals = (journals  || []).length;
    const totalChats    = (chats     || []).length;
    const totalSessions = (sessions  || []).length;
    const activeDays    = Object.keys(dayMap).length;
    const maxDay        = Math.max(...Object.values(dayMap).map(d => d.total), 1);

    // Build 53-week grid aligned to Sunday
    const today = new Date(); today.setHours(0,0,0,0);
    const gridStart = new Date(today);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay() - 52 * 7);

    const weeks = [];
    const cursor = new Date(gridStart);
    while (cursor <= today) {
        const week = [];
        for (let i = 0; i < 7; i++) {
            const key = cursor.toISOString().split('T')[0];
            week.push({ date: key, data: dayMap[key] || null, future: cursor > today });
            cursor.setDate(cursor.getDate() + 1);
        }
        weeks.push(week);
    }

    const getColor = t => {
        if (!t) return 'rgba(255,255,255,0.05)';
        const p = t / maxDay;
        if (p < 0.25) return 'rgba(0,229,176,0.2)';
        if (p < 0.5)  return 'rgba(0,229,176,0.45)';
        if (p < 0.75) return 'rgba(0,229,176,0.7)';
        return '#00e5b0';
    };

    // Month labels
    const seenM = new Set();
    const monthLabels = [];
    weeks.forEach((wk, wi) => {
        const d = wk[0];
        if (!d.future) {
            const key = d.date.substring(0, 7);
            if (!seenM.has(key)) {
                seenM.add(key);
                monthLabels.push({ wi, label: new Date(d.date + 'T12:00:00').toLocaleString('en', { month: 'short' }) });
            }
        }
    });

    const CELL = 13, GAP = 3, STRIDE = CELL + GAP;
    const monthRow = monthLabels.map(m =>
        `<span style="position:absolute;left:${m.wi * STRIDE}px;font-size:0.62rem;color:var(--muted);">${m.label}</span>`
    ).join('');

    const grid = weeks.map(wk =>
        `<div style="display:flex;flex-direction:column;gap:${GAP}px;">${
            wk.map(day => {
                const count = day.data?.total || 0;
                const tip = day.data
                    ? `${day.date}: ${count} total (📓${day.data.journals} ✨${day.data.chats} 🔗${day.data.sessions})`
                    : day.future ? '' : `${day.date}: no activity`;
                return `<div style="width:${CELL}px;height:${CELL}px;border-radius:2px;background:${day.future?'transparent':getColor(count)};flex-shrink:0;cursor:${day.data?'pointer':'default'};" title="${tip}"></div>`;
            }).join('')
        }</div>`
    ).join('');

    const name = profile?.full_name || 'User';
    const gridW = weeks.length * STRIDE;

    openSlidePanel(`${name} — Activity`, `
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px;">
            <div class="stat-mini-box">
                <div class="stat-mini-val" style="color:#34d399;">${totalJournals}</div>
                <div class="stat-mini-label">📓 Journals</div>
            </div>
            <div class="stat-mini-box">
                <div class="stat-mini-val" style="color:var(--accent-red);">${totalChats}</div>
                <div class="stat-mini-label">✨ AI Chats</div>
            </div>
            <div class="stat-mini-box">
                <div class="stat-mini-val" style="color:var(--accent-yellow);">${totalSessions}</div>
                <div class="stat-mini-label">🔗 Sessions</div>
            </div>
            <div class="stat-mini-box">
                <div class="stat-mini-val">${activeDays}</div>
                <div class="stat-mini-label">Active Days</div>
            </div>
        </div>

        <div class="section-title">Activity — Past 12 Months</div>
        <div style="overflow-x:auto;padding-bottom:12px;margin-top:10px;">
            <div style="position:relative;height:16px;margin-bottom:5px;min-width:${gridW}px;">${monthRow}</div>
            <div style="display:flex;gap:${GAP}px;min-width:${gridW}px;">${grid}</div>
            <div style="display:flex;align-items:center;gap:5px;margin-top:12px;font-size:0.7rem;color:var(--muted);">
                Less
                ${['rgba(255,255,255,0.05)','rgba(0,229,176,0.2)','rgba(0,229,176,0.45)','rgba(0,229,176,0.7)','#00e5b0'].map(c =>
                    `<div style="width:${CELL}px;height:${CELL}px;border-radius:2px;background:${c};"></div>`
                ).join('')}
                More
            </div>
        </div>
    `);
};

// ── Listeners Panel ───────────────────────────────────
async function loadListeners() {
    const tbody = $('listeners-table-body');
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><ion-icon name="sync-outline"></ion-icon>Loading listeners…</div></td></tr>`;

    // Fetch from listeners table (real data)
    const { data: listeners } = await db.from('listeners').select('*').order('created_at', { ascending: false });

    if (!listeners || listeners.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><ion-icon name="headset-outline"></ion-icon>No listeners registered</div></td></tr>`;
        return;
    }

    // Also fetch profiles for names
    const userIds = listeners.map(l => l.user_id).filter(Boolean);
    const { data: profiles } = await db.from('profiles').select('id, full_name, email, avatar_url').in('id', userIds);
    const profileMap = {};
    (profiles || []).forEach(p => profileMap[p.id] = p);

    tbody.innerHTML = listeners.map(l => {
        const p = profileMap[l.user_id] || {};
        const statusBadge = l.is_online
            ? '<span class="badge badge-green">● Online</span>'
            : '<span class="badge badge-grey">Offline</span>';
        const langs = Array.isArray(l.languages) ? l.languages.join(', ') : (l.languages || '—');
        return `
            <tr onclick="viewListener('${l.id}')">
                <td>
                    <div class="user-cell">
                        <div class="u-avatar">${initials(p.full_name)}</div>
                        <div>
                            <div class="u-name">${p.full_name || 'Unnamed'}</div>
                            <div class="u-email">${p.email || ''}</div>
                        </div>
                    </div>
                </td>
                <td>${statusBadge}</td>
                <td class="text-muted" style="font-size:0.8rem;">${langs}</td>
                <td>⭐ ${l.rating ? l.rating.toFixed(1) : '—'}</td>
                <td>—</td>
                <td>—</td>
                <td>₹${l.chat_price_per_min || 0}/m</td>
                <td>₹${l.call_price_per_min || 0}/m</td>
                <td class="text-muted">${ago(l.last_seen || l.created_at)}</td>
                <td>
                    <div class="flex-gap">
                        <button class="btn btn-ghost" onclick="event.stopPropagation();viewListener('${l.id}')">View</button>
                        ${l.is_online
                            ? `<button class="btn btn-warning" onclick="event.stopPropagation();forceListenerOffline('${l.id}')">Offline</button>`
                            : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// ── Listener Detail Slide Panel ───────────────────────
window.viewListener = async function(listenerId) {
    openSlidePanel('Loading…', `<div class="empty-state"><ion-icon name="sync-outline"></ion-icon>Loading listener data…</div>`);

    const { data: listener } = await db.from('listeners').select('*').eq('id', listenerId).maybeSingle();
    if (!listener) { $('slide-body').innerHTML = `<div class="empty-state">Listener not found.</div>`; return; }

    const { data: profile } = await db.from('profiles').select('*').eq('id', listener.user_id).maybeSingle();
    const p = profile || {};

    // Fetch session count for this listener
    const { count: sessionCount } = await db.from('sessions').select('*', { count: 'exact', head: true }).eq('listener_id', listener.id);

    openSlidePanel(p.full_name || 'Listener Profile', `
        <div class="profile-hero">
            <div class="p-avatar">${initials(p.full_name)}</div>
            <div>
                <div class="p-name">${p.full_name || 'Unnamed'}</div>
                <div class="p-email">${p.email || ''}</div>
                <div style="margin-top:8px;display:flex;gap:6px;">
                    ${listener.is_online
                        ? '<span class="badge badge-green">● Online</span>'
                        : '<span class="badge badge-grey">Offline</span>'}
                    <span class="badge badge-blue">Listener</span>
                </div>
            </div>
        </div>

        <div class="stats-mini">
            <div class="stat-mini-box">
                <div class="stat-mini-val text-accent">${sessionCount || 0}</div>
                <div class="stat-mini-label">Sessions</div>
            </div>
            <div class="stat-mini-box">
                <div class="stat-mini-val">⭐ ${listener.rating ? listener.rating.toFixed(1) : '—'}</div>
                <div class="stat-mini-label">Rating</div>
            </div>
            <div class="stat-mini-box">
                <div class="stat-mini-val">${Array.isArray(listener.languages) ? listener.languages.length : 1}</div>
                <div class="stat-mini-label">Languages</div>
            </div>
        </div>

        <div class="section-title">Pricing (₹/min)</div>
        <div class="detail-row">
            <span class="detail-label">Chat price</span>
            <input class="inline-edit" id="edit-chat-price" type="number" value="${listener.chat_price_per_min || 0}" style="width:100px;text-align:right;">
        </div>
        <div class="detail-row">
            <span class="detail-label">Call price</span>
            <input class="inline-edit" id="edit-call-price" type="number" value="${listener.call_price_per_min || 0}" style="width:100px;text-align:right;">
        </div>
        <button class="btn btn-primary mt-4" onclick="saveListenerPricing('${listenerId}')">Save Pricing</button>

        <div class="section-title" style="margin-top:28px;">Bio</div>
        <p style="font-size:0.85rem;color:var(--muted);line-height:1.6;">${listener.bio || 'No bio set.'}</p>

        <div class="section-title" style="margin-top:28px;">Actions</div>
        <div class="flex-gap mt-4">
            ${listener.is_online
                ? `<button class="btn btn-warning" onclick="forceListenerOffline('${listenerId}')"><ion-icon name="wifi-outline"></ion-icon> Force Offline</button>`
                : ''}
            <button class="btn btn-danger" onclick="removeListener('${listenerId}', '${listener.user_id}')"><ion-icon name="trash-outline"></ion-icon> Remove Listener</button>
        </div>
    `);
};

window.saveListenerPricing = async function(listenerId) {
    const chatP = parseFloat($('edit-chat-price').value) || 0;
    const callP = parseFloat($('edit-call-price').value) || 0;
    const { error } = await db.from('listeners').update({ chat_price_per_min: chatP, call_price_per_min: callP }).eq('id', listenerId);
    if (error) toast('Failed to save pricing.', 'var(--accent-red)');
    else { toast('Pricing saved!', 'var(--accent)'); loadListeners(); }
};

window.forceListenerOffline = async function(listenerId) {
    if (!confirm('Force this listener offline?')) return;
    const { error } = await db.from('listeners').update({ is_online: false }).eq('id', listenerId);
    if (error) toast('Error: ' + error.message, 'var(--accent-red)');
    else { toast('Listener set offline.'); loadListeners(); }
};

window.removeListener = async function(listenerId, userId) {
    if (!confirm('Remove listener status? Their profile will remain as a regular user.')) return;
    await db.from('listeners').delete().eq('id', listenerId);
    await db.from('profiles').update({ role: 'user' }).eq('id', userId);
    closeSlidePanel(null);
    toast('Listener removed.');
    loadListeners();
};

// ── Add Listener Panel ────────────────────────────────
window.showAddListenerPanel = async function() {
    // Show a form to pick an existing user and make them a listener
    const { data: users } = await db.from('profiles').select('id, full_name, email').eq('role', 'user').order('full_name');
    const options = (users || []).map(u => `<option value="${u.id}">${u.full_name || 'Unnamed'} (${u.email || u.id.slice(0,8)})</option>`).join('');

    openSlidePanel('Add New Listener', `
        <p style="color:var(--muted);font-size:0.85rem;margin-bottom:20px;">Select an existing user to promote to Listener status.</p>

        <div class="section-title">Select User</div>
        <select id="new-listener-user" class="inline-edit" style="margin-bottom:16px;">
            <option value="">-- choose user --</option>
            ${options}
        </select>

        <div class="section-title">Bio</div>
        <textarea id="new-listener-bio" class="inline-edit" rows="3" placeholder="Short bio..." style="resize:vertical;margin-bottom:16px;"></textarea>

        <div class="section-title">Languages (comma-separated)</div>
        <input id="new-listener-langs" class="inline-edit" placeholder="English, Hindi" style="margin-bottom:16px;">

        <div class="section-title">Chat Price (₹/min)</div>
        <input id="new-listener-chat-price" class="inline-edit" type="number" value="2" style="margin-bottom:16px;">

        <div class="section-title">Call Price (₹/min)</div>
        <input id="new-listener-call-price" class="inline-edit" type="number" value="3" style="margin-bottom:16px;">

        <button class="btn btn-primary" style="width:100%;justify-content:center;padding:12px;" onclick="createListenerRecord()">
            <ion-icon name="add-circle-outline"></ion-icon> Create Listener
        </button>
    `);
};

window.createListenerRecord = async function() {
    const userId    = $('new-listener-user').value;
    const bio       = $('new-listener-bio').value.trim();
    const langsRaw  = $('new-listener-langs').value.trim();
    const chatPrice = parseFloat($('new-listener-chat-price').value) || 2;
    const callPrice = parseFloat($('new-listener-call-price').value) || 3;
    const langs     = langsRaw ? langsRaw.split(',').map(s => s.trim()) : ['English'];

    if (!userId) { toast('Please select a user.', 'var(--accent-red)'); return; }

    const { error: insErr } = await db.from('listeners').insert([{
        user_id: userId,
        bio,
        languages: langs,
        chat_price_per_min: chatPrice,
        call_price_per_min: callPrice,
        is_online: false,
        rating: null,
    }]);
    if (insErr) { toast('Insert failed: ' + insErr.message, 'var(--accent-red)'); return; }

    await db.from('profiles').update({ role: 'listener' }).eq('id', userId);
    closeSlidePanel(null);
    toast('Listener created successfully!', 'var(--accent)');
    loadListeners();
};

// ── Sessions Panel ────────────────────────────────────
async function loadSessions() {
    const tbody = $('sessions-table-body');
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><ion-icon name="sync-outline"></ion-icon>Loading sessions…</div></td></tr>`;

    const { data } = await db.from('sessions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);

    allSessions = data || [];
    renderSessionsTable();
}

function renderSessionsTable() {
    const tbody = $('sessions-table-body');
    let filtered = allSessions;
    if (sessionFilter === 'active')    filtered = allSessions.filter(s => s.status === 'active');
    if (sessionFilter === 'completed') filtered = allSessions.filter(s => s.status === 'completed');
    if (sessionFilter === 'call')      filtered = allSessions.filter(s => s.type === 'call');
    if (sessionFilter === 'chat')      filtered = allSessions.filter(s => s.type === 'chat');

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><ion-icon name="swap-horizontal-outline"></ion-icon>No sessions found</div></td></tr>`;
        return;
    }
    tbody.innerHTML = filtered.map(s => sessionRow(s, false)).join('');
}

function sessionRow(s, compact) {
    const statusBadge = s.status === 'active'
        ? '<span class="badge badge-yellow">● Active</span>'
        : s.status === 'completed'
        ? '<span class="badge badge-green">Done</span>'
        : '<span class="badge badge-red">Cancelled</span>';

    const typeBadge = s.type === 'call'
        ? '<span class="badge badge-blue"><ion-icon name="call-outline"></ion-icon> Call</span>'
        : '<span class="badge badge-purple"><ion-icon name="chatbubble-outline"></ion-icon> Chat</span>';

    const userId     = s.user_id     ? s.user_id.slice(0,8)     : '—';
    const listenerId = s.listener_id ? String(s.listener_id).slice(0,8) : '—';

    if (compact) {
        return `<tr onclick="viewSessionTranscript('${s.id}')">
            <td class="text-muted" style="font-size:0.78rem;">${userId}</td>
            <td class="text-muted" style="font-size:0.78rem;">${listenerId}</td>
            <td>${typeBadge}</td>
            <td>${statusBadge}</td>
            <td class="text-muted">${s.message_count || 0}</td>
            <td class="text-muted">${fmtDate(s.created_at)}</td>
            <td><button class="btn btn-ghost" onclick="event.stopPropagation();viewSessionTranscript('${s.id}')">View</button></td>
        </tr>`;
    }

    return `<tr onclick="viewSessionTranscript('${s.id}')">
        <td class="text-muted" style="font-size:0.78rem;">${userId}</td>
        <td class="text-muted" style="font-size:0.78rem;">${listenerId}</td>
        <td>${typeBadge}</td>
        <td>${statusBadge}</td>
        <td>${s.message_count || 0}</td>
        <td>${s.is_anonymous ? '<span class="badge badge-yellow">Yes</span>' : 'No'}</td>
        <td class="text-muted">${fmtDate(s.created_at)}</td>
        <td>
            <div class="flex-gap">
                <button class="btn btn-ghost" onclick="event.stopPropagation();viewSessionTranscript('${s.id}')">Transcript</button>
                ${s.status === 'active' ? `<button class="btn btn-danger" onclick="event.stopPropagation();endSession('${s.id}')">End</button>` : ''}
            </div>
        </td>
    </tr>`;
}

window.filterSessions = function(type) {
    sessionFilter = type;
    document.querySelectorAll('[id^="sf-"]').forEach(b => b.classList.remove('active'));
    $(`sf-${type}`) && $(`sf-${type}`).classList.add('active');
    renderSessionsTable();
};

// ── Session Transcript Slide Panel ───────────────────
window.viewSessionTranscript = async function(sessionId) {
    openSlidePanel('Loading transcript…', `<div class="empty-state"><ion-icon name="sync-outline"></ion-icon>Fetching messages…</div>`);

    const [{ data: session }, { data: msgs }] = await Promise.all([
        db.from('sessions').select('*').eq('id', sessionId).maybeSingle(),
        db.from('messages').select('*').eq('session_id', sessionId).order('created_at', { ascending: true }),
    ]);

    if (!session) { $('slide-body').innerHTML = `<div class="empty-state">Session not found.</div>`; return; }

    const typeBadge = session.type === 'call'
        ? '<span class="badge badge-blue">Call</span>'
        : '<span class="badge badge-purple">Chat</span>';
    const statusBadge = session.status === 'active'
        ? '<span class="badge badge-yellow">Active</span>'
        : '<span class="badge badge-green">Completed</span>';

    const transcript = (msgs || []).length
        ? (msgs || []).map(m => {
            const cls = m.sender_type === 'user' ? 'transcript-user'
                      : m.sender_type === 'system' ? 'transcript-system'
                      : 'transcript-listener';
            return `<div class="transcript-msg ${cls}">
                ${m.sender_type !== 'system' ? `<div style="font-size:0.72rem;opacity:0.6;margin-bottom:4px;">${m.sender_type === 'user' ? 'User' : 'Listener'} · ${fmtTime(m.created_at)}</div>` : ''}
                ${m.content || ''}
            </div>`;
        }).join('')
        : '<div class="empty-state" style="padding:20px 0;"><ion-icon name="chatbubble-outline"></ion-icon>No messages in this session</div>';

    openSlidePanel('Session Transcript', `
        <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;">
            ${typeBadge} ${statusBadge}
            <span class="badge badge-grey">${(msgs || []).length} messages</span>
        </div>
        <div class="detail-row"><span class="detail-label">Session ID</span><span style="font-family:monospace;font-size:0.75rem;">${session.id}</span></div>
        <div class="detail-row"><span class="detail-label">User</span><span class="text-muted" style="font-size:0.78rem;">${session.user_id ? session.user_id.slice(0,8) : '—'}</span></div>
        <div class="detail-row"><span class="detail-label">Listener</span><span class="text-muted" style="font-size:0.78rem;">${session.listener_id ? String(session.listener_id).slice(0,8) : '—'}</span></div>
        <div class="detail-row"><span class="detail-label">Created</span><span>${fmtDate(session.created_at)} ${fmtTime(session.created_at)}</span></div>
        ${session.status === 'active' ? `<button class="btn btn-danger mt-4" onclick="endSession('${session.id}')"><ion-icon name="close-circle-outline"></ion-icon> End Session</button>` : ''}

        <div class="section-title" style="margin-top:24px;">Messages</div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:12px;">${transcript}</div>
    `);
};

window.endSession = async function(sessionId) {
    if (!confirm('Force-end this active session?')) return;
    const { error } = await db.from('sessions').update({ status: 'completed', ended_at: new Date().toISOString() }).eq('id', sessionId);
    if (error) toast('Error: ' + error.message, 'var(--accent-red)');
    else { toast('Session ended.'); loadSessions(); closeSlidePanel(null); }
};

// ── AI & Journals Panel ───────────────────────────────
async function loadAIPanel() {
    const [
        { count: chatCount },
        { count: msgCount },
        { count: journalCount },
        { data: recentChats },
        { data: recentJournals },
    ] = await Promise.all([
        db.from('chats').select('*', { count: 'exact', head: true }),
        db.from('messages').select('*', { count: 'exact', head: true }),
        db.from('journals').select('*', { count: 'exact', head: true }),
        db.from('chats').select('*').order('created_at', { ascending: false }).limit(25),
        db.from('journals').select('*').order('created_at', { ascending: false }).limit(25),
    ]);

    $('ai-m-chats').innerText    = chatCount || 0;
    $('ai-m-messages').innerText = msgCount  || 0;
    $('ai-m-journals').innerText = journalCount || 0;
    $('ai-m-avg').innerText      = chatCount ? (msgCount / chatCount).toFixed(1) : '—';

    // AI Chats table
    const aiTbody = $('ai-chats-body');
    aiTbody.innerHTML = (recentChats || []).map(c => `
        <tr onclick="viewAIChat('${c.id}')">
            <td class="text-muted" style="font-size:0.78rem;">${c.user_id ? c.user_id.slice(0,8) : '—'}</td>
            <td>${c.title || '<span class="text-muted">Untitled</span>'}</td>
            <td class="text-muted">—</td>
            <td class="text-muted">${fmtDate(c.created_at)}</td>
        </tr>
    `).join('') || `<tr><td colspan="4"><div class="empty-state">No AI chats</div></td></tr>`;

    // Journals table
    const jTbody = $('journals-body');
    jTbody.innerHTML = (recentJournals || []).map(j => {
        const media = [];
        if (j.image_url)   media.push('<span class="badge badge-blue">📷 Photo</span>');
        if (j.audio_url)   media.push('<span class="badge badge-purple">🎙 Voice</span>');
        if (j.spotify_url) media.push('<span class="badge badge-green">🎵 Music</span>');
        return `
            <tr onclick="viewJournal('${j.id}')">
                <td class="text-muted" style="font-size:0.78rem;">${j.user_id ? j.user_id.slice(0,8) : '—'}</td>
                <td>${j.title || '<span class="text-muted">Untitled</span>'}</td>
                <td>${media.join(' ') || '—'}</td>
                <td class="text-muted">${fmtDate(j.created_at)}</td>
            </tr>
        `;
    }).join('') || `<tr><td colspan="4"><div class="empty-state">No journal entries</div></td></tr>`;
}

window.viewAIChat = async function(chatId) {
    openSlidePanel('AI Conversation', `<div class="empty-state"><ion-icon name="sync-outline"></ion-icon>Loading…</div>`);

    const [{ data: chat }, { data: msgs }] = await Promise.all([
        db.from('chats').select('*').eq('id', chatId).maybeSingle(),
        db.from('messages').select('*').eq('chat_id', chatId).order('created_at', { ascending: true }),
    ]);

    if (!chat) { $('slide-body').innerHTML = `<div class="empty-state">Chat not found.</div>`; return; }

    const transcript = (msgs || []).map(m => {
        const isUser = m.role === 'user';
        return `<div class="transcript-msg ${isUser ? 'transcript-user' : 'transcript-listener'}">
            <div style="font-size:0.72rem;opacity:0.6;margin-bottom:4px;">${isUser ? 'User' : 'AI'} · ${fmtTime(m.created_at)}</div>
            ${m.content || ''}
        </div>`;
    }).join('') || '<div class="empty-state">No messages.</div>';

    openSlidePanel(chat.title || 'AI Conversation', `
        <div class="detail-row"><span class="detail-label">Chat ID</span><span style="font-family:monospace;font-size:0.75rem;">${chat.id}</span></div>
        <div class="detail-row"><span class="detail-label">User</span><span class="text-muted">${chat.user_id ? chat.user_id.slice(0,8) : '—'}</span></div>
        <div class="detail-row"><span class="detail-label">Created</span><span>${fmtDate(chat.created_at)}</span></div>
        <div class="detail-row"><span class="detail-label">Messages</span><span>${(msgs || []).length}</span></div>
        <div class="section-title" style="margin-top:24px;">Conversation</div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:12px;">${transcript}</div>
    `);
};

window.viewJournal = async function(journalId) {
    openSlidePanel('Journal Entry', `<div class="empty-state"><ion-icon name="sync-outline"></ion-icon>Loading…</div>`);

    const { data: entry } = await db.from('journals').select('*').eq('id', journalId).maybeSingle();
    if (!entry) { $('slide-body').innerHTML = `<div class="empty-state">Entry not found.</div>`; return; }

    const media = [];
    if (entry.image_url) media.push(`<img src="${entry.image_url}" style="width:100%;border-radius:10px;margin-top:12px;" loading="lazy">`);
    if (entry.audio_url) media.push(`<audio controls src="${entry.audio_url}" style="width:100%;margin-top:12px;"></audio>`);
    if (entry.spotify_url) media.push(`<iframe src="https://open.spotify.com/embed/track/${entry.spotify_url}" width="100%" height="80" style="border:none;border-radius:8px;margin-top:12px;" allow="encrypted-media"></iframe>`);

    openSlidePanel(entry.title || 'Journal Entry', `
        <div class="detail-row"><span class="detail-label">User</span><span class="text-muted">${entry.user_id ? entry.user_id.slice(0,8) : '—'}</span></div>
        <div class="detail-row"><span class="detail-label">Written</span><span>${fmtDate(entry.created_at)} ${fmtTime(entry.created_at)}</span></div>
        <div class="section-title" style="margin-top:20px;">Content</div>
        <p style="font-size:0.88rem;line-height:1.7;color:var(--text);margin-top:10px;">${entry.content || '<em style="color:var(--muted)">No text content.</em>'}</p>
        ${entry.location_name ? `<div class="detail-row" style="margin-top:12px;"><span class="detail-label">📍 Location</span><span>${entry.location_name}</span></div>` : ''}
        ${media.length ? `<div class="section-title" style="margin-top:20px;">Media</div>${media.join('')}` : ''}
    `);
};

// ── Platform Activity Panel ───────────────────────────
async function loadActivityPanel() {
    const container = $('activity-heatmap-wrap');
    const statsEl   = $('activity-stats-row');
    if (container) container.innerHTML = `<div class="empty-state" style="padding:24px 0;"><ion-icon name="sync-outline"></ion-icon>Loading activity data…</div>`;

    const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();

    const [
        { data: journals },
        { data: chats },
        { data: sessions },
        { data: allProfiles },
    ] = await Promise.all([
        db.from('journals').select('created_at, user_id').gte('created_at', yearAgo),
        db.from('chats').select('created_at, user_id').gte('created_at', yearAgo),
        db.from('sessions').select('created_at, user_id').gte('created_at', yearAgo),
        db.from('profiles').select('id, full_name, email').neq('role','admin').order('full_name'),
    ]);

    // Populate user picker
    const picker = $('activity-user-picker');
    if (picker) {
        picker.innerHTML = `<option value="">All users (platform-wide)</option>`
            + (allProfiles || []).map(p =>
                `<option value="${p.id}">${p.full_name || 'Unnamed'} (${p.email ? p.email.substring(0,20) : p.id.slice(0,8)})</option>`
            ).join('');
        picker.onchange = () => renderActivityHeatmap(
            picker.value,
            journals || [], chats || [], sessions || []
        );
    }

    renderActivityHeatmap('', journals || [], chats || [], sessions || []);

    // Build "Most Active Users" table (last 30 days)
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const allRecent = [
        ...(journals || []).filter(j => j.created_at >= monthAgo).map(j => ({ uid: j.user_id, type: 'journals' })),
        ...(chats    || []).filter(c => c.created_at >= monthAgo).map(c => ({ uid: c.user_id, type: 'chats' })),
        ...(sessions || []).filter(s => s.created_at >= monthAgo).map(s => ({ uid: s.user_id, type: 'sessions' })),
    ];
    const userTotals = {};
    allRecent.forEach(({ uid, type }) => {
        if (!uid) return;
        if (!userTotals[uid]) userTotals[uid] = { journals: 0, chats: 0, sessions: 0 };
        userTotals[uid][type]++;
    });
    const profileMap = {};
    (allProfiles || []).forEach(p => profileMap[p.id] = p);
    const sorted = Object.entries(userTotals)
        .map(([uid, counts]) => ({ uid, ...counts, total: counts.journals + counts.chats + counts.sessions }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 20);

    const tbody = $('activity-top-users-body');
    if (tbody) {
        tbody.innerHTML = sorted.length
            ? sorted.map(u => {
                const p = profileMap[u.uid] || {};
                return `<tr onclick="viewUser('${u.uid}')">
                    <td>
                        <div class="user-cell">
                            <div class="u-avatar">${initials(p.full_name)}</div>
                            <div>
                                <div class="u-name">${p.full_name || 'Unnamed'}</div>
                                <div class="u-email">${p.email || u.uid.slice(0,12)}</div>
                            </div>
                        </div>
                    </td>
                    <td><span style="color:#34d399;font-weight:600;">${u.journals}</span></td>
                    <td><span style="color:var(--accent-red);font-weight:600;">${u.chats}</span></td>
                    <td><span style="color:var(--accent-yellow);font-weight:600;">${u.sessions}</span></td>
                    <td><strong>${u.total}</strong></td>
                    <td><button class="btn btn-ghost" onclick="event.stopPropagation();viewUser('${u.uid}')">View</button></td>
                </tr>`;
            }).join('')
            : `<tr><td colspan="6"><div class="empty-state"><ion-icon name="people-outline"></ion-icon>No activity in last 30 days</div></td></tr>`;
    }
}

function renderActivityHeatmap(filterUserId, journals, chats, sessions) {
    const container = $('activity-heatmap-wrap');
    const statsEl   = $('activity-stats-row');
    if (!container) return;

    const jFiltered = filterUserId ? journals.filter(j => j.user_id === filterUserId) : journals;
    const cFiltered = filterUserId ? chats.filter(c => c.user_id === filterUserId)    : chats;
    const sFiltered = filterUserId ? sessions.filter(s => s.user_id === filterUserId) : sessions;

    // Build day map
    const dayMap = {};
    const inc = (item, key) => {
        const d = (item.created_at || '').split('T')[0];
        if (!d) return;
        if (!dayMap[d]) dayMap[d] = { journals: 0, chats: 0, sessions: 0, total: 0 };
        dayMap[d][key]++;
        dayMap[d].total++;
    };
    jFiltered.forEach(j => inc(j, 'journals'));
    cFiltered.forEach(c => inc(c, 'chats'));
    sFiltered.forEach(s => inc(s, 'sessions'));

    const activeDays = Object.keys(dayMap).length;
    const maxDay     = Math.max(...Object.values(dayMap).map(d => d.total), 1);

    if (statsEl) {
        statsEl.innerHTML = `
            <div class="stat-mini-box">
                <div class="stat-mini-val" style="color:#34d399;">${jFiltered.length}</div>
                <div class="stat-mini-label">📓 Journals</div>
            </div>
            <div class="stat-mini-box">
                <div class="stat-mini-val" style="color:var(--accent-red);">${cFiltered.length}</div>
                <div class="stat-mini-label">✨ AI Chats</div>
            </div>
            <div class="stat-mini-box">
                <div class="stat-mini-val" style="color:var(--accent-yellow);">${sFiltered.length}</div>
                <div class="stat-mini-label">🔗 Sessions</div>
            </div>
            <div class="stat-mini-box">
                <div class="stat-mini-val">${activeDays}</div>
                <div class="stat-mini-label">Active Days</div>
            </div>`;
    }

    // Build 53-week grid aligned to Sunday
    const today = new Date(); today.setHours(0,0,0,0);
    const gridStart = new Date(today);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay() - 52 * 7);

    const weeks = [];
    const cursor = new Date(gridStart);
    while (cursor <= today) {
        const week = [];
        for (let i = 0; i < 7; i++) {
            const key = cursor.toISOString().split('T')[0];
            week.push({ date: key, data: dayMap[key] || null, future: cursor > today });
            cursor.setDate(cursor.getDate() + 1);
        }
        weeks.push(week);
    }

    const getColor = t => {
        if (!t) return 'rgba(255,255,255,0.05)';
        const p = t / maxDay;
        if (p < 0.25) return 'rgba(0,229,176,0.2)';
        if (p < 0.5)  return 'rgba(0,229,176,0.45)';
        if (p < 0.75) return 'rgba(0,229,176,0.7)';
        return '#00e5b0';
    };

    // Month labels
    const seenM = new Set();
    const monthLabels = [];
    weeks.forEach((wk, wi) => {
        if (!wk[0].future) {
            const key = wk[0].date.substring(0, 7);
            if (!seenM.has(key)) {
                seenM.add(key);
                monthLabels.push({ wi, label: new Date(wk[0].date + 'T12:00:00').toLocaleString('en', { month: 'short' }) });
            }
        }
    });

    const CELL = 14, GAP = 3, STRIDE = CELL + GAP;
    const gridW = weeks.length * STRIDE;

    const monthRow = monthLabels.map(m =>
        `<span style="position:absolute;left:${m.wi * STRIDE}px;font-size:0.65rem;color:var(--muted);">${m.label}</span>`
    ).join('');

    const grid = weeks.map(wk =>
        `<div style="display:flex;flex-direction:column;gap:${GAP}px;">${
            wk.map(day => {
                const count = day.data?.total || 0;
                const tip = day.data
                    ? `${day.date}: ${count} total (📓${day.data.journals} ✨${day.data.chats} 🔗${day.data.sessions})`
                    : day.future ? '' : `${day.date}: no activity`;
                return `<div style="width:${CELL}px;height:${CELL}px;border-radius:2px;background:${day.future?'transparent':getColor(count)};flex-shrink:0;" title="${tip}"></div>`;
            }).join('')
        }</div>`
    ).join('');

    container.innerHTML = `
        <div style="position:relative;height:18px;margin-bottom:5px;min-width:${gridW}px;">${monthRow}</div>
        <div style="display:flex;gap:${GAP}px;min-width:${gridW}px;">${grid}</div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:14px;font-size:0.72rem;color:var(--muted);">
            Less
            ${['rgba(255,255,255,0.05)','rgba(0,229,176,0.2)','rgba(0,229,176,0.45)','rgba(0,229,176,0.7)','#00e5b0'].map(c =>
                `<div style="width:${CELL}px;height:${CELL}px;border-radius:2px;background:${c};"></div>`
            ).join('')}
            More
        </div>`;
}

// ── Controls / Bulk Actions ───────────────────────────
window.forceAllListenersOffline = async function() {
    if (!confirm('Force ALL listeners offline? This will interrupt active sessions.')) return;
    const { error } = await db.from('listeners').update({ is_online: false }).neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) toast('Error: ' + error.message, 'var(--accent-red)');
    else { toast('All listeners set offline.', 'var(--accent-yellow)'); loadStats(); }
};

window.cancelAllActiveSessions = async function() {
    if (!confirm('Cancel ALL active sessions? Users will be disconnected immediately.')) return;
    const { error } = await db.from('sessions').update({ status: 'cancelled', ended_at: new Date().toISOString() }).eq('status', 'active');
    if (error) toast('Error: ' + error.message, 'var(--accent-red)');
    else { toast('All active sessions cancelled.', 'var(--accent-red)'); loadStats(); }
};

window.exportUserCSV = async function() {
    const { data: users } = await db.from('profiles').select('id, full_name, email, role, status, created_at').neq('role', 'admin').order('created_at', { ascending: false });
    if (!users) { toast('No data to export.'); return; }
    const headers = ['ID', 'Name', 'Email', 'Role', 'Status', 'Joined'];
    const rows = users.map(u => [u.id, u.full_name || '', u.email || '', u.role || '', u.status || 'active', u.created_at]);
    downloadCSV('blakcide_users.csv', headers, rows);
};

window.exportSessionCSV = async function() {
    const { data: sessions } = await db.from('sessions').select('id, user_id, listener_id, type, status, message_count, created_at, ended_at').order('created_at', { ascending: false });
    if (!sessions) { toast('No data to export.'); return; }
    const headers = ['ID', 'User ID', 'Listener ID', 'Type', 'Status', 'Messages', 'Created', 'Ended'];
    const rows = sessions.map(s => [s.id, s.user_id || '', s.listener_id || '', s.type || '', s.status || '', s.message_count || 0, s.created_at, s.ended_at || '']);
    downloadCSV('blakcide_sessions.csv', headers, rows);
};

function downloadCSV(filename, headers, rows) {
    const csvContent = [headers, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    toast(`${filename} downloaded.`, 'var(--accent)');
}

// ── Slide-Over Panel ──────────────────────────────────
function openSlidePanel(title, html) {
    $('slide-title').innerText = title;
    $('slide-body').innerHTML  = html;
    $('detail-overlay').classList.add('open');
}

window.closeSlidePanel = function(e) {
    if (e && e.target !== $('detail-overlay')) return;
    $('detail-overlay').classList.remove('open');
};

// ── Admin Operations (User) ───────────────────────────
window.promoteToListener = async function(userId) {
    if (!confirm('Promote this user to a Listener?')) return;
    const { error } = await db.from('profiles').update({ role: 'listener' }).eq('id', userId);
    if (error) toast('Error: ' + error.message, 'var(--accent-red)');
    else { toast('User promoted to Listener!', 'var(--accent)'); viewUser(userId); loadUsers(); }
};

window.demoteToUser = async function(userId) {
    if (!confirm('Revoke listener access?')) return;
    await db.from('listeners').delete().eq('user_id', userId);
    const { error } = await db.from('profiles').update({ role: 'user' }).eq('id', userId);
    if (error) toast('Error: ' + error.message, 'var(--accent-red)');
    else { toast('Listener access revoked.', 'var(--accent-yellow)'); viewUser(userId); loadUsers(); }
};

window.suspendUser = async function(userId) {
    if (!confirm('Suspend this account? They will be locked out.')) return;
    const { error } = await db.from('profiles').update({ status: 'suspended' }).eq('id', userId);
    if (error) toast('Error: ' + error.message, 'var(--accent-red)');
    else { toast('Account suspended.', 'var(--accent-red)'); viewUser(userId); }
};

window.reactivateUser = async function(userId) {
    const { error } = await db.from('profiles').update({ status: 'active' }).eq('id', userId);
    if (error) toast('Error: ' + error.message, 'var(--accent-red)');
    else { toast('Account reactivated!', 'var(--accent)'); viewUser(userId); }
};

// ── Realtime Subscriptions ────────────────────────────
function setupRealtime() {
    // Sessions channel
    db.channel('admin-sessions')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, (payload) => {
            handleRealtimeEvent('session', payload);
            loadStats();
        })
        .subscribe();

    // Listeners channel
    db.channel('admin-listeners')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'listeners' }, (payload) => {
            handleRealtimeEvent('listener', payload);
            loadStats();
        })
        .subscribe();

    // Messages channel
    db.channel('admin-messages')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
            handleRealtimeEvent('message', payload);
        })
        .subscribe();

    // Profiles channel
    db.channel('admin-profiles')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'profiles' }, (payload) => {
            handleRealtimeEvent('profile', payload);
            loadStats();
        })
        .subscribe();
}

function handleRealtimeEvent(type, payload) {
    const ev = payload.eventType; // INSERT | UPDATE | DELETE
    let icon, color, text;

    if (type === 'session') {
        icon  = 'swap-horizontal-outline';
        color = 'var(--accent-yellow)';
        const s = payload.new || payload.old || {};
        if      (ev === 'INSERT') text = `New session started (${s.type || 'chat'})`;
        else if (ev === 'UPDATE' && s.status === 'completed') text = `Session completed`;
        else if (ev === 'UPDATE' && s.status === 'active') text = `Session went active`;
        else text = `Session updated`;
    } else if (type === 'listener') {
        icon  = 'headset-outline';
        color = 'var(--accent-blue)';
        const l = payload.new || {};
        if   (ev === 'INSERT') text = `New listener joined`;
        else text = `Listener ${l.is_online ? 'came online' : 'went offline'}`;
    } else if (type === 'message') {
        icon  = 'chatbubble-outline';
        color = 'var(--accent-purple)';
        text  = `New message in session`;
    } else if (type === 'profile') {
        icon  = 'person-add-outline';
        color = 'var(--accent)';
        const p = payload.new || {};
        text  = `New user registered${p.full_name ? ': ' + p.full_name : ''}`;
    } else {
        icon  = 'ellipse-outline';
        color = 'var(--muted)';
        text  = `${type} ${ev}`;
    }

    addLiveFeedEvent(icon, color, text);
}

function addLiveFeedEvent(icon, color, text) {
    const feed = $('live-feed-list');

    // Remove placeholder
    const empty = feed.querySelector('.empty-state');
    if (empty) empty.remove();

    const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const el = document.createElement('div');
    el.className = 'feed-event';
    el.innerHTML = `
        <div class="feed-icon" style="background:${color}22;color:${color};">
            <ion-icon name="${icon}"></ion-icon>
        </div>
        <div class="feed-text">
            <div>${text}</div>
            <div class="feed-time">${time}</div>
        </div>
    `;
    feed.insertBefore(el, feed.firstChild);

    // Keep max 100 events
    const events = feed.querySelectorAll('.feed-event');
    if (events.length > 100) events[events.length - 1].remove();

    // Update live count badge
    liveEventCount++;
    $('live-count').innerText = liveEventCount > 99 ? '99+' : liveEventCount;
}

// ── Admin Logout ──────────────────────────────────────
window.adminLogout = async function() {
    await db.auth.signOut();
    window.location.href = '../index.html';
};
