document.addEventListener('DOMContentLoaded', () => {

    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    let supabase;
    if (typeof window.supabase !== 'undefined') {
        supabase = window._sbClient || (window._sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY));
    }

    let currentUser = null;
    const getEl = (id) => document.getElementById(id);
    const click = (id, fn) => { const el = getEl(id); if(el) el.addEventListener('click', fn); };
    
    function showToast(msg) {
        const t = document.createElement('div'); t.className='toast'; t.innerText=msg;
        getEl('toast-container').appendChild(t); setTimeout(()=>t.remove(), 3000);
    }

    // 1. Session Enforcement + Listener Routing
    async function enforceSession() {
        if(!supabase) return;
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) { window.location.href = '../index.html'; return; }

        currentUser = session.user;

        // Check if this user is an admin — redirect to admin console
        const { data: profile } = await supabase.from('profiles').select('role').eq('id', currentUser.id).maybeSingle();
        if (profile?.role === 'admin') {
            window.location.href = 'admin.html';
            return;
        }

        // Check if this user is a listener — redirect to listener console
        const { data: listener } = await supabase.from('listeners').select('id').eq('user_id', currentUser.id).maybeSingle();
        if (listener) {
            window.location.href = 'listener-console.html';
            return;
        }

        hydrateDashboardMetrics();
    }

    // Pulls real per-user counts (chats, journals, streak) and online-listener
    // count, then patches the v3 hero. Falls back silently if any query fails
    // so the dashboard never shows a broken state.
    async function hydrateDashboardMetrics() {
        if (!supabase || !currentUser) return;
        try {
            const [chatsRes, journalsRes, listenersRes, streakRes] = await Promise.all([
                supabase.from('chats').select('id', { count: 'exact', head: true }).eq('user_id', currentUser.id),
                supabase.from('journals').select('id', { count: 'exact', head: true }).eq('user_id', currentUser.id),
                supabase.from('listeners').select('id', { count: 'exact', head: true }).eq('is_online', true),
                computeStreakDays(currentUser.id),
            ]);

            const chats     = chatsRes.count     ?? 0;
            const journals  = journalsRes.count  ?? 0;
            const onlineLs  = listenersRes.count ?? 0;
            const streak    = streakRes;

            const elChats     = getEl('dash-meta-chats');
            const elEntries   = getEl('dash-meta-entries');
            const elListeners = getEl('dash-meta-listeners');
            const elStreakNum = getEl('dash-streak-num');
            const elRing      = getEl('dash-streak-ring');
            const elHeroTitle = document.querySelector('.v3-hero-title');

            if (elChats)     elChats.innerHTML     = `${chats}<small>×</small>`;
            if (elEntries)   elEntries.innerHTML   = `${journals}<small>×</small>`;
            if (elListeners) elListeners.textContent = String(onlineLs);
            if (elStreakNum) elStreakNum.textContent = String(streak);

            if (elRing) {
                const pct = Math.min(100, Math.round((streak / 7) * 100));
                elRing.setAttribute('data-target', String(pct));
                if (window.blakcideAnimateRings) window.blakcideAnimateRings();
            }

            if (elHeroTitle) {
                if (streak === 0) {
                    elHeroTitle.innerHTML = `Welcome back. <span style="color:var(--pulse-1);">Today is a fresh start.</span>`;
                } else if (streak === 1) {
                    elHeroTitle.innerHTML = `You showed up <span style="color:var(--pulse-1);">today</span>. That's the hardest part.`;
                } else {
                    const wordMap = ['zero','one','two','three','four','five','six','seven'];
                    const word = streak <= 7 ? wordMap[streak] : String(streak);
                    elHeroTitle.innerHTML = `You showed up <span style="color:var(--pulse-1);">${word} days in a row</span>.`;
                }
            }

            try { localStorage.setItem('blakcide-streak', JSON.stringify({ days: streak, ts: Date.now() })); } catch (_) {}
        } catch (e) {
            console.warn('[dashboard] metric hydration skipped:', e?.message || e);
        }
    }

    // Walks the user's chat + journal activity (last 60 days) and counts
    // consecutive days ending at today (or yesterday if nothing today yet).
    async function computeStreakDays(userId) {
        const since = new Date(Date.now() - 60 * 86400_000).toISOString();
        const [{ data: chatRows = [] }, { data: jrnRows = [] }] = await Promise.all([
            supabase.from('chats').select('created_at').eq('user_id', userId).gte('created_at', since),
            supabase.from('journals').select('created_at').eq('user_id', userId).gte('created_at', since),
        ]);
        const days = new Set();
        const toDayKey = (ts) => {
            const d = new Date(ts);
            return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        };
        chatRows.forEach(r => r.created_at && days.add(toDayKey(r.created_at)));
        jrnRows.forEach(r => r.created_at && days.add(toDayKey(r.created_at)));
        if (days.size === 0) return 0;

        let streak = 0;
        const cursor = new Date();
        // If nothing today, start counting from yesterday so a missed day at the
        // very start of the day doesn't zero out an active streak.
        if (!days.has(toDayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
        while (days.has(toDayKey(cursor))) {
            streak += 1;
            cursor.setDate(cursor.getDate() - 1);
        }
        return streak;
    }

    // 2. Dashboard Navigation Routing
    click('logout-btn', async () => { await supabase.auth.signOut(); window.location.href = '../index.html'; });
    
    click('btn-ai-connect', () => { window.location.href = 'chat.html'; }); // Routes to AI Chat
    
    click('nav-connect-btn', () => window.location.href = 'connect.html');

    // 3. Living Journal Logic
    const journalModal = getEl('journal-modal');
    const journalListView = getEl('journal-list-view');
    const journalWriteView = getEl('journal-write-view');

    click('btn-journal', () => {
        journalModal.classList.add('active');
        showJournalList();
    });

    click('close-journal-btn', () => { journalModal.classList.remove('active'); });

    click('write-new-journal-btn', () => {
        journalListView.style.display = 'none';
        journalWriteView.style.display = 'flex';
        getEl('journal-entry-title').value = '';
        getEl('journal-entry-content').value = '';
    });

    click('save-journal-entry', async () => {
        const title = getEl('journal-entry-title').value.trim();
        const content = getEl('journal-entry-content').value.trim();
        if (!title || !content) return showToast("Title and content are required.");

        const saveBtn = getEl('save-journal-entry');
        saveBtn.innerText = "Saving..."; saveBtn.disabled = true;

        const { error } = await supabase.from('journals').insert([
            { user_id: currentUser.id, title: title, content: content }
        ]);

        saveBtn.innerText = "Save to Journal"; saveBtn.disabled = false;

        if (error) { showToast("Failed to save entry."); } 
        else { showToast("Journal Entry Saved!"); showJournalList(); }
    });

    async function showJournalList() {
        journalWriteView.style.display = 'none';
        journalListView.style.display = 'flex';
        journalListView.innerHTML = '<p style="text-align:center; opacity:0.6;">Loading your thoughts...</p>';

        const { data, error } = await supabase.from('journals')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: false });

        if (error) return journalListView.innerHTML = '<p>Error loading journal.</p>';
        
        if (data.length === 0) {
            journalListView.innerHTML = '<div style="text-align:center; padding: 40px 20px; opacity:0.6;"><ion-icon name="book-outline" style="font-size: 3rem; margin-bottom:10px;"></ion-icon><p>Your journal is empty. Tap the pen icon to capture a moment.</p></div>';
            return;
        }

        journalListView.innerHTML = '';
        data.forEach(entry => {
            const dateStr = new Date(entry.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const card = document.createElement('div');
            card.className = 'journal-card';
            card.innerHTML = `<div class="journal-card-title">${entry.title}</div><div class="journal-card-date">${dateStr}</div><div class="journal-card-preview">${entry.content}</div>`;
            card.onclick = () => readJournalEntry(entry);
            journalListView.appendChild(card);
        });
    }

    function readJournalEntry(entry) {
        journalListView.style.display = 'none';
        journalWriteView.style.display = 'flex';
        getEl('journal-entry-title').value = entry.title;
        getEl('journal-entry-content').value = entry.content;
        getEl('save-journal-entry').style.display = 'none';
        
        const writeBtn = getEl('write-new-journal-btn');
        writeBtn.innerHTML = '<ion-icon name="arrow-back-outline" style="font-size: 1.5rem;"></ion-icon>';
        writeBtn.onclick = () => {
            getEl('save-journal-entry').style.display = 'flex';
            writeBtn.innerHTML = '<ion-icon name="create-outline" style="font-size: 1.5rem;"></ion-icon>';
            writeBtn.onclick = () => {
                journalListView.style.display = 'none';
                journalWriteView.style.display = 'flex';
                getEl('journal-entry-title').value = '';
                getEl('journal-entry-content').value = '';
            };
            showJournalList();
        };
    }

    enforceSession();
});