document.addEventListener('DOMContentLoaded', () => {
    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    let supabaseClient = null;
    if (typeof window.supabase !== 'undefined') {
        supabaseClient = window._sbClient || (window._sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY));
    }

    const track = document.getElementById('world-track');
    const viewport = document.getElementById('world-viewport');
    const navButtons = [...document.querySelectorAll('.nav-pill')];
    const title = document.getElementById('world-name');
    const kicker = document.getElementById('world-kicker');
    const menuBtn = document.getElementById('context-menu-btn');
    const drawer = document.getElementById('activity-drawer');
    const drawerClose = document.getElementById('drawer-close');
    const drawerTitle = document.getElementById('drawer-title');
    const drawerKicker = document.getElementById('drawer-kicker');
    const drawerList = document.getElementById('drawer-list');
    const profileBtn = document.getElementById('open-profile-btn');
    const personaOpen = document.getElementById('persona-open');
    const personaPanel = document.getElementById('persona-panel');
    const personaClose = document.getElementById('persona-close');
    const toastContainer = document.getElementById('toast-container');
    const blakHome = document.getElementById('blak-home');
    const blakComposer = document.getElementById('blak-composer');
    const themeToggle = document.getElementById('theme-toggle');

    const worlds = [
        { name: 'Minit', kicker: 'Human now' },
        { name: 'Blak', kicker: 'Live home' },
        { name: 'Nexus', kicker: 'Social life' },
    ];

    const drawerContent = {
        blak: [
            ['Last night plan', 'You mapped tomorrow into three lightweight moves.'],
            ['CA call thread', 'Tax questions, documents, and the next call.'],
            ['Connected apps', 'Calendar and Spotify signals Blak can use.'],
            ['Voice check-in', 'A short call about feeling clearer after midnight.'],
        ],
        minit: [
            ['Instant session', '12 min text session. Listener: Priya.'],
            ['Reconnect available', 'Same listener is currently online.'],
            ['Blak brief', 'Context shape ready: overwhelmed, practical support.'],
            ['Safety note', 'Anonymous mode is on by default.'],
        ],
        nexus: [
            ['Anonymous texts', '3 unread replies from people you resonated with.'],
            ['Late thoughts', 'Live room has 42 people active now.'],
            ['Minds in motion', 'A tribe post is getting thoughtful replies.'],
            ['Blak mention', 'Someone asked Blak to summarize a thread.'],
        ],
    };

    let index = 1;
    let startX = 0;
    let startY = 0;
    let dragX = 0;
    let isDragging = false;
    let lockedAxis = null;

    function showToast(message) {
        if (!toastContainer) return;
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        toastContainer.appendChild(toast);
        setTimeout(() => toast.remove(), 3200);
    }

    function worldKey() {
        return worlds[index].name.toLowerCase();
    }

    function renderDrawerList() {
        const key = worldKey();
        const items = drawerContent[key] || drawerContent.blak;
        if (drawerKicker) drawerKicker.textContent = key === 'minit' ? 'Minit activity' : key === 'nexus' ? 'Nexus activity' : 'Blak history';
        if (drawerTitle) drawerTitle.textContent = key === 'minit' ? 'Recent sessions' : key === 'nexus' ? 'What is alive' : 'Recent threads';
        if (!drawerList) return;
        drawerList.innerHTML = items.map(([heading, body]) => (
            `<div class="history-item"><strong>${heading}</strong><span>${body}</span></div>`
        )).join('');
    }

    function setIndex(next, opts = {}) {
        index = Math.max(0, Math.min(2, next));
        if (!track) return;
        track.classList.toggle('dragging', Boolean(opts.dragging));
        const offset = opts.dragging ? (-index * window.innerWidth + dragX) : (-index * window.innerWidth);
        track.style.transform = `translate3d(${offset}px, 0, 0)`;
        navButtons.forEach((btn, i) => btn.classList.toggle('active', i === index));
        if (title) title.textContent = worlds[index].name;
        if (kicker) kicker.textContent = worlds[index].kicker;
        renderDrawerList();
    }

    function openDrawer() {
        renderDrawerList();
        drawer?.classList.add('open');
        drawer?.setAttribute('aria-hidden', 'false');
    }

    function closeDrawer() {
        drawer?.classList.remove('open');
        drawer?.setAttribute('aria-hidden', 'true');
    }

    function openPersona() {
        personaPanel?.classList.add('open');
        personaPanel?.setAttribute('aria-hidden', 'false');
    }

    function closePersona() {
        personaPanel?.classList.remove('open');
        personaPanel?.setAttribute('aria-hidden', 'true');
    }

    function enterBlakChatMode() {
        blakHome?.classList.add('chatting');
    }

    function applyTheme(theme) {
        const isLight = theme === 'light';
        document.body.classList.toggle('light-mode', isLight);
        document.body.classList.toggle('dark-mode', !isLight);
        try { localStorage.setItem('blaksyd-beta-theme', isLight ? 'light' : 'dark'); } catch (_) {}
    }

    function onPointerDown(event) {
        if (!viewport || event.target.closest('button, a, input, textarea')) return;
        isDragging = true;
        lockedAxis = null;
        startX = event.clientX;
        startY = event.clientY;
        dragX = 0;
        track?.classList.add('dragging');
        viewport.setPointerCapture?.(event.pointerId);
    }

    function onPointerMove(event) {
        if (!isDragging) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!lockedAxis && Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
            lockedAxis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        }
        if (lockedAxis !== 'x') return;
        event.preventDefault();
        const atLeft = index === 0 && dx > 0;
        const atRight = index === 2 && dx < 0;
        dragX = atLeft || atRight ? dx * 0.22 : dx;
        setIndex(index, { dragging: true });
    }

    function onPointerUp() {
        if (!isDragging) return;
        isDragging = false;
        track?.classList.remove('dragging');
        const threshold = Math.min(120, window.innerWidth * 0.22);
        if (lockedAxis === 'x' && dragX < -threshold) setIndex(index + 1);
        else if (lockedAxis === 'x' && dragX > threshold) setIndex(index - 1);
        else setIndex(index);
        dragX = 0;
        lockedAxis = null;
    }

    async function enforceSession() {
        if (!supabaseClient) return;
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (!session) {
            if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
                showToast('Local preview mode. Production still requires sign-in.');
                return;
            }
            window.location.href = '../index.html';
            return;
        }

        const currentUser = session.user;
        hydrateProfile(currentUser);

        const { data: profile } = await supabaseClient.from('profiles').select('role, full_name, avatar_url').eq('id', currentUser.id).maybeSingle();
        if (profile?.role === 'admin') {
            window.location.href = 'admin.html';
            return;
        }

        const { data: listener } = await supabaseClient.from('listeners').select('id').eq('user_id', currentUser.id).maybeSingle();
        if (listener) {
            window.location.href = 'listener-console.html';
            return;
        }

        hydrateProfile(currentUser, profile);
    }

    function hydrateProfile(user, profile = {}) {
        const profileImg = profileBtn?.querySelector('img');
        const profileIcon = profileBtn?.querySelector('ion-icon');
        const avatarUrl = profile?.avatar_url || user?.user_metadata?.avatar_url || '';
        if (profileImg && avatarUrl) {
            profileImg.src = avatarUrl;
            profileImg.style.display = 'block';
            if (profileIcon) profileIcon.style.display = 'none';
        }
    }

    navButtons.forEach((button) => {
        button.addEventListener('click', () => setIndex(Number(button.dataset.go)));
    });

    viewport?.addEventListener('pointerdown', onPointerDown);
    viewport?.addEventListener('pointermove', onPointerMove, { passive: false });
    viewport?.addEventListener('pointerup', onPointerUp);
    viewport?.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', () => setIndex(index));

    menuBtn?.addEventListener('click', openDrawer);
    drawerClose?.addEventListener('click', closeDrawer);
    drawer?.addEventListener('click', (event) => {
        if (event.target === drawer) closeDrawer();
    });

    profileBtn?.addEventListener('click', () => {
        const profileModal = document.getElementById('global-profile-modal');
        if (profileModal) profileModal.style.display = 'flex';
        else showToast('Profile is loading.');
    });

    personaOpen?.addEventListener('click', openPersona);
    personaClose?.addEventListener('click', closePersona);
    personaPanel?.addEventListener('click', (event) => {
        if (event.target === personaPanel) closePersona();
    });

    blakComposer?.addEventListener('focusin', enterBlakChatMode);
    blakComposer?.addEventListener('click', enterBlakChatMode);
    blakComposer?.addEventListener('input', enterBlakChatMode);
    blakComposer?.addEventListener('submit', enterBlakChatMode);

    themeToggle?.addEventListener('click', () => {
        applyTheme(document.body.classList.contains('light-mode') ? 'dark' : 'light');
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') setIndex(index - 1);
        if (event.key === 'ArrowRight') setIndex(index + 1);
        if (event.key === 'Escape') {
            closeDrawer();
            closePersona();
        }
    });

    let savedTheme = 'dark';
    try { savedTheme = localStorage.getItem('blaksyd-beta-theme') || 'dark'; } catch (_) {}
    applyTheme(savedTheme);
    setIndex(1);
    enforceSession();
});
