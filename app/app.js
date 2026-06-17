document.addEventListener('DOMContentLoaded', () => {

    // ==========================================
    // 1. SUPABASE & 3D CANVAS INITIALIZATION
    // ==========================================
    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    let supabase;
    if (typeof window.supabase !== 'undefined') {
        // Single shared client across all page JS files (app.js, profile-manager.js,
        // listener-console.js, etc). Without this guard the browser sees multiple
        // GoTrueClient instances on the same storage key and warns.
        supabase = window._sbClient || (window._sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY));
    } else {
        console.error("Supabase failed to load.");
    }

    // Symp.ai SDK init — routes through Blaksyd proxy with Supabase JWT.
    if (typeof window.SympClient === 'function' && supabase && !window.symp) {
        try {
            window.symp = new window.SympClient({
                getAuthToken: async () => {
                    const { data } = await supabase.auth.getSession();
                    return data?.session?.access_token || '';
                },
            });
        } catch (e) {
            console.warn('[symp] init failed:', e.message);
        }
    }

    const canvas = document.getElementById('pearl-canvas');
    if (canvas) {
        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });
        const resize = () => renderer.setSize(window.innerWidth, window.innerHeight);
        resize(); window.addEventListener('resize', resize);
        
        const uniforms = { uTime: { value: 0 }, uMouse: { value: new THREE.Vector2(0, 0) }, uScroll: { value: 0 } };
        window.addEventListener('mousemove', (e) => {
            uniforms.uMouse.value.x = (e.clientX / window.innerWidth) * 2 - 1;
            uniforms.uMouse.value.y = -(e.clientY / window.innerHeight) * 2 + 1;
        });
        
        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
            fragmentShader: `
                uniform float uTime; uniform vec2 uMouse; uniform float uScroll; varying vec2 vUv;
                vec3 palette( in float t ) { return vec3(0.9)+vec3(0.1)*cos(6.283*(vec3(1.0)*t+vec3(0.00,0.33,0.67))); }
                void main() {
                    vec2 uv = vUv * 2.0 - 1.0; float t = uTime * 0.15; vec2 uMu = uMouse * 0.1;
                    for(float i=1.0; i<3.0; i++){ uv.x+=0.3/i*sin(i*2.0*uv.y+t+uMu.x); uv.y+=0.3/i*cos(i*2.0*uv.x+t+uMu.y); }
                    float dist = length(uv); vec3 col = palette(dist * 0.4 - t + uScroll * 0.8);
                    col = mix(col, vec3(0.98, 0.97, 0.96), 0.4); gl_FragColor = vec4(col, 1.0);
                }
            `
        });
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
        const animate = () => { uniforms.uTime.value += 0.005; renderer.render(scene, camera); requestAnimationFrame(animate); };
        animate();
    }

    // ==========================================
    // 2. GLOBAL STATE & HELPERS
    // ==========================================
    let currentUser = null;
    let currentChatId = null;
    let openFolders = new Set();
    let isSidebarLoading = false;
    let currentView = 'main';

    // In-memory message history — eliminates per-message DB re-fetch
    let chatMessageHistory = [];

    const getPinKey = () => 'blakcide_pin_' + currentUser?.id;
    const getVaultKey = () => 'blakcide_vault_' + currentUser?.id;
    const getArchiveKey = () => 'blakcide_archive_' + currentUser?.id;

    const getVaultData = () => JSON.parse(localStorage.getItem(getVaultKey()) || '{"chats":[],"folders":[]}');
    const getArchiveData = () => JSON.parse(localStorage.getItem(getArchiveKey()) || '{"chats":[],"folders":[]}');
    const setVaultData = (d) => localStorage.setItem(getVaultKey(), JSON.stringify(d));
    const setArchiveData = (d) => localStorage.setItem(getArchiveKey(), JSON.stringify(d));

    const getEl = (id) => document.getElementById(id);
    
    // Bulletproof click helper: only attaches if the element exists
    const click = (id, fn) => { 
        const el = getEl(id); 
        if(el) el.addEventListener('click', fn); 
    };
    
    function showToast(msg) {
        const container = getEl('toast-container');
        if (!container) return;
        const t = document.createElement('div'); t.className='toast'; t.innerText=msg;
        container.appendChild(t); setTimeout(()=>t.remove(), 3000);
    }

    // ==========================================
    // 3. AUTHENTICATION & APP INIT
    // ==========================================
    async function enforceSession() {
        if(!supabase) return;
        try {
            const { data: { session }, error } = await supabase.auth.getSession();
            if (error || !session) { window.location.href = '../index.html'; } 
            else { currentUser = session.user; initializeApp(); }
        } catch (err) {
            console.error("Session fetch failed:", err);
            window.location.href = '../index.html';
        }
    }

    function initializeApp() {
        fetchProfile();
        loadUserContext();
        startNewChat(null, false);
        loadSidebar();

        // Symp.ai — silent fire-and-forget run of yesterday's Omniscient
        // Analyser. Idempotent server-side, so calling on every login is fine;
        // it skips when already analysed. Never blocks the UI.
        if (window.symp && currentUser) {
            window.symp.triggerAnalysis().then(r => {
                if (r?.ok && r?.data && !r.data.skipped) {
                    console.log('[symp] daily analysis updated for', r.data.analysis_date);
                }
            });
        }
    }

    // ── Load full "Context Engine" — profile, journals, Spotify ──────────
    // Cross-chat continuity is now handled server-side by Symp.ai: the /chat
    // endpoint reads symp_vault_profiles.symp_analysis (the daily Analyser
    // output) so the brain already knows recent moods/themes/people without
    // needing the browser to fetch a flat message list. We dropped the old
    // `messages !inner(chats)` join because (a) it was 400-ing in PostgREST
    // and (b) the Vault is the new source of truth.
    async function loadUserContext() {
        try {
            const [profileRes, journalsRes] = await Promise.all([
                supabase.from('profiles').select('full_name, bio, user_memory').eq('id', currentUser.id).maybeSingle(),
                supabase.from('journals').select('title, emotion, content, created_at').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(5),
            ]);

            const profile   = profileRes.data;
            const journals  = journalsRes.data || [];
            const crossMsgs = []; // legacy var kept so downstream code doesn't break

            // Spotify: currently playing, else most recent played
            let spotifyLine = '';
            try {
                const token = (typeof window.getSpotifyToken === 'function') ? window.getSpotifyToken() : null;
                if (token) {
                    let res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    let track = null, playing = false;
                    if (res.status === 200) {
                        const d = await res.json();
                        if (d?.item) { track = d.item; playing = !!d.is_playing; }
                    }
                    if (!track) {
                        res = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=1', {
                            headers: { Authorization: `Bearer ${token}` }
                        });
                        if (res.ok) {
                            const d = await res.json();
                            track = d?.items?.[0]?.track || null;
                        }
                    }
                    if (track) {
                        const name    = track.name;
                        const artists = (track.artists || []).map(a => a.name).join(', ');
                        spotifyLine = playing
                            ? `Currently listening to "${name}" by ${artists}.`
                            : `Last played on Spotify: "${name}" by ${artists}.`;
                    }
                }
            } catch(_) { /* spotify optional */ }

            let ctx = '';
            if (profile?.full_name) ctx += `User's name: ${profile.full_name}. `;
            if (profile?.bio)       ctx += `About them: ${profile.bio}. `;
            if (profile?.user_memory) ctx += `Notes from past sessions: ${profile.user_memory} `;

            if (journals.length) {
                const recent = journals.map(j => {
                    const when = j.created_at ? new Date(j.created_at).toLocaleDateString() : '';
                    return `[${when}] "${j.title}"${j.emotion ? ` (felt ${j.emotion})` : ''}${j.content ? ': ' + j.content.substring(0, 120) : ''}`;
                }).join(' | ');
                ctx += `Recent journal entries: ${recent}. `;
            }

            if (crossMsgs.length) {
                const recentTalk = crossMsgs.map(m =>
                    `${m.role === 'user' ? 'User' : 'You'}: ${String(m.content || '').substring(0, 140)}`
                ).join(' | ');
                ctx += `Recent messages between you two (carry this continuity forward even on a "New Chat"): ${recentTalk}. `;
            }

            if (spotifyLine) ctx += spotifyLine + ' ';

            window.blakcideUserContext = ctx.trim() || null;

            // Proactivity check — run once per session after context loads
            checkProactiveThought({ profile, journals, crossMsgs });
        } catch(e) {
            window.blakcideUserContext = null;
        }
    }

    // ── Proactivity: if recent journals show low mood, surface a gentle check-in ──────
    // Fires once per day (localStorage-gated) so we never nag.
    function checkProactiveThought({ journals = [], profile = null } = {}) {
        try {
            const key = `blakcide_proactive_${currentUser?.id || 'anon'}_${new Date().toDateString()}`;
            if (localStorage.getItem(key)) return;

            const LOW = ['sad','down','low','anxious','anxiety','stressed','stress','overwhelmed','depressed','hopeless','tired','lonely','angry','hurt'];
            const recentLow = journals.slice(0, 3).filter(j => {
                const blob = `${j.emotion || ''} ${j.content || ''}`.toLowerCase();
                return LOW.some(k => blob.includes(k));
            });
            if (recentLow.length < 2) return; // need sustained signal

            const hookJournal = recentLow[0];
            const hint = hookJournal.title || hookJournal.emotion || 'what you wrote recently';
            const name = profile?.full_name ? profile.full_name.split(' ')[0] : null;

            window.blakcideProactiveHook = {
                hint,
                message: name
                    ? `Hey ${name} — been thinking about you. You mentioned ${hint} in your journal. How's that sitting with you today?`
                    : `Hey — been thinking about you. You mentioned ${hint} recently. How's that sitting today?`
            };
            localStorage.setItem(key, '1');
        } catch(_) {}
    }

    // ==========================================
    // 4. SIDEBAR & NAVIGATION CONTROLS
    // ==========================================
    click('home-btn', () => { window.location.href = '../index.html?noredirect=true'; });
    click('nav-dashboard-btn', () => { window.location.href = 'dashboard.html'; });
    click('logout-btn', async (e) => { e.stopPropagation(); await supabase.auth.signOut(); window.location.href = '../index.html'; });
    
    click('toggle-sidebar-btn', () => {
        const sidebar = getEl('main-sidebar');
        if(!sidebar) return;
        if (window.innerWidth <= 768) { sidebar.classList.remove('open'); } 
        else { sidebar.classList.toggle('collapsed'); }
    });
    
    click('mobile-menu-btn', () => getEl('main-sidebar')?.classList.add('open'));

    // Auto-close sidebar on mobile
    document.addEventListener('click', (e) => {
        const sidebar = getEl('main-sidebar');
        const menuBtn = getEl('mobile-menu-btn');
        if (sidebar && menuBtn && window.innerWidth <= 768 && sidebar.classList.contains('open')) {
            if (!sidebar.contains(e.target) && !menuBtn.contains(e.target)) {
                sidebar.classList.remove('open');
            }
        }
    });

    // ==========================================
    // 5. CONTEXT MENU & MODALS
    // ==========================================
    let contextTarget = null;
    const ctxMenu = getEl('context-menu');

    function openContextMenu(e, id, type) {
        if (!ctxMenu) return;
        e.preventDefault(); e.stopPropagation();
        contextTarget = { id, type };
        ctxMenu.style.left = `${e.pageX}px`;
        ctxMenu.style.top = `${e.pageY}px`;
        ctxMenu.classList.add('active');
        
        if (getEl('cm-vault')) getEl('cm-vault').innerHTML = currentView === 'vault' ? '<ion-icon name="lock-open"></ion-icon> Remove from Vault' : '<ion-icon name="lock-closed"></ion-icon> Send to Vault';
        if (getEl('cm-archive')) getEl('cm-archive').innerHTML = currentView === 'archive' ? '<ion-icon name="arrow-undo"></ion-icon> Unarchive' : '<ion-icon name="archive"></ion-icon> Archive';
    }

    window.addEventListener('click', () => { if(ctxMenu) ctxMenu.classList.remove('active'); });

    click('cm-rename', () => {
        openModal('Rename', '', async (newName) => {
            if(!newName) return;
            if (contextTarget.type === 'folder') {
                await supabase.from('folders').update({ name: newName }).eq('id', contextTarget.id);
            } else {
                // Mark as user-renamed so auto-title stops overwriting it
                await supabase.from('chats').update({ title: newName, user_renamed: true }).eq('id', contextTarget.id);
                if (contextTarget.id === currentChatId && getEl('mobile-chat-title')) {
                    getEl('mobile-chat-title').innerText = newName;
                }
            }
            loadSidebar(); showToast("Renamed");
        });
    });

    click('cm-delete', async () => {
        const table = contextTarget.type === 'folder' ? 'folders' : 'chats';
        await supabase.from(table).delete().eq('id', contextTarget.id);
        if(contextTarget.id === currentChatId) startNewChat();
        loadSidebar(); showToast("Deleted permanently");
    });

    click('cm-vault', () => { moveToSystem(contextTarget.id, contextTarget.type, currentView === 'vault' ? 'main' : 'vault'); });
    click('cm-archive', () => { moveToSystem(contextTarget.id, contextTarget.type, currentView === 'archive' ? 'main' : 'archive'); });

    click('archive-view-btn', () => {
        currentView = currentView === 'archive' ? 'main' : 'archive';
        document.body.classList.remove('dark-mode'); 
        startNewChat(null, false); 
        updateViewUI(); loadSidebar(); getEl('main-sidebar')?.classList.remove('open');
    });

    click('vault-btn', () => {
        if(currentView === 'vault') {
            currentView = 'main'; 
            document.body.classList.remove('dark-mode'); 
            startNewChat(null, false); 
            updateViewUI(); loadSidebar();
        } else {
            getEl('pin-input').value = '';
            const existingPin = localStorage.getItem(getPinKey());
            getEl('pin-msg').innerText = existingPin ? "Enter your 4-digit PIN" : "Create a 4-digit PIN for the Vault";
            getEl('pin-modal')?.classList.add('active');
            getEl('pin-input')?.focus();
        }
    });

    click('pin-cancel', () => getEl('pin-modal')?.classList.remove('active'));
    click('pin-confirm', () => {
        const input = getEl('pin-input').value;
        if(input.length !== 4) return showToast("PIN must be 4 digits");
        
        const existingPin = localStorage.getItem(getPinKey());
        if(!existingPin) {
            localStorage.setItem(getPinKey(), input);
            showToast("Vault PIN Created"); unlockVault();
        } else {
            if(input === existingPin) unlockVault();
            else showToast("Incorrect PIN");
        }
    });

    function unlockVault() {
        getEl('pin-modal')?.classList.remove('active');
        currentView = 'vault'; 
        document.body.classList.add('dark-mode'); 
        startNewChat(null, false); 
        updateViewUI(); loadSidebar();
        getEl('main-sidebar')?.classList.remove('open');
    }

    function updateViewUI() {
        getEl('archive-view-btn')?.classList.toggle('active', currentView === 'archive');
        getEl('vault-btn')?.classList.toggle('active', currentView === 'vault');
        
        const vaultIcon = getEl('vault-btn')?.querySelector('ion-icon');
        if(vaultIcon) vaultIcon.setAttribute('name', currentView === 'vault' ? 'lock-open-outline' : 'lock-closed-outline');

        const titleEl = getEl('view-title');
        if(titleEl) {
            if(currentView === 'main') titleEl.style.display = 'none';
            else {
                titleEl.style.display = 'block';
                titleEl.innerText = currentView === 'vault' ? "The Vault" : "Archives";
            }
        }
    }

    // ==========================================
    // 6. DRAG AND DROP SAFEGUARD
    // ==========================================
    function moveToSystem(id, type, targetSystem) {
        let vData = getVaultData(); let aData = getArchiveData();
        const arrName = type === 'folder' ? 'folders' : 'chats';
        vData[arrName] = vData[arrName].filter(x => x !== id);
        aData[arrName] = aData[arrName].filter(x => x !== id);
        if (targetSystem === 'vault') vData[arrName].push(id);
        if (targetSystem === 'archive') aData[arrName].push(id);
        setVaultData(vData); setArchiveData(aData);
        loadSidebar(); showToast(`Moved to ${targetSystem}`);
    }

    const setupToolDropZone = (btnId, targetSystem) => {
        const btn = getEl(btnId);
        if (!btn) return; // THE CRASH FIX
        btn.ondragover = (e) => { e.preventDefault(); btn.classList.add('drag-hover'); };
        btn.ondragleave = () => btn.classList.remove('drag-hover');
        btn.ondrop = (e) => {
            e.preventDefault(); btn.classList.remove('drag-hover');
            try {
                const data = JSON.parse(e.dataTransfer.getData("itemData"));
                moveToSystem(data.id, data.type, targetSystem);
            } catch(err){}
        };
    };
    setupToolDropZone('vault-btn', 'vault');
    setupToolDropZone('archive-view-btn', 'archive');

    // ==========================================
    // 7. SIDEBAR RENDERING
    // ==========================================
    async function loadSidebar() {
        if (isSidebarLoading) return;
        isSidebarLoading = true;

        const list = getEl('history-list'); 
        if(!list) return;
        list.innerHTML = '';
        
        try {
            const { data: allFolders } = await supabase.from('folders').select('*').eq('user_id', currentUser.id).order('created_at');
            const { data: allChats } = await supabase.from('chats').select('*').eq('user_id', currentUser.id).order('created_at', {ascending: false});

            const vData = getVaultData(); const aData = getArchiveData();

            let folders = [], chats = [];
            if(allFolders && allChats) {
                if(currentView === 'vault') {
                    folders = allFolders.filter(f => vData.folders.includes(f.id));
                    chats = allChats.filter(c => vData.chats.includes(c.id) || (c.folder_id && vData.folders.includes(c.folder_id)));
                } else if (currentView === 'archive') {
                    folders = allFolders.filter(f => aData.folders.includes(f.id));
                    chats = allChats.filter(c => aData.chats.includes(c.id) || (c.folder_id && aData.folders.includes(c.folder_id)));
                } else { 
                    folders = allFolders.filter(f => !vData.folders.includes(f.id) && !aData.folders.includes(f.id));
                    chats = allChats.filter(c => !vData.chats.includes(c.id) && !aData.chats.includes(c.id) && (!c.folder_id || (!vData.folders.includes(c.folder_id) && !aData.folders.includes(c.folder_id))));
                }
            }

            if(folders) folders.forEach(folder => {
                const div = document.createElement('div');
                div.className = `folder-container ${openFolders.has(folder.id)?'open':''}`;
                div.innerHTML = `
                    <div class="folder-header" data-id="${folder.id}">
                        <span><ion-icon name="folder-outline"></ion-icon> ${folder.name}</span>
                        <button class="item-options-btn"><ion-icon name="ellipsis-horizontal"></ion-icon></button>
                    </div>
                    <div class="folder-content" id="folder-${folder.id}" style="${openFolders.has(folder.id)?'display:block;':'display:none;'}"></div>
                `;
                const h = div.querySelector('.folder-header');
                
                h.setAttribute('draggable', 'true');
                h.ondragstart = (e) => { 
                    document.body.classList.add('is-dragging');
                    e.dataTransfer.setData("itemData", JSON.stringify({id: folder.id, type: 'folder'})); 
                    h.style.opacity = '0.5'; 
                };
                h.ondragend = () => { 
                    document.body.classList.remove('is-dragging');
                    h.style.opacity = '1'; 
                };
                h.onclick = (e) => { 
                    if(e.target.closest('.item-options-btn')) { openContextMenu(e, folder.id, 'folder'); return; }
                    const content = getEl(`folder-${folder.id}`);
                    if(openFolders.has(folder.id)) { openFolders.delete(folder.id); content.style.display = 'none'; } 
                    else { openFolders.add(folder.id); content.style.display = 'block'; }
                };
                div.ondragover = (e) => { e.preventDefault(); div.classList.add('drag-over'); }; 
                div.ondragleave = () => div.classList.remove('drag-over');
                div.ondrop = async (e) => {
                    e.preventDefault(); div.classList.remove('drag-over');
                    try {
                        const data = JSON.parse(e.dataTransfer.getData("itemData"));
                        if(data.type === 'chat'){
                            await supabase.from('chats').update({folder_id:folder.id}).eq('id',data.id); 
                            openFolders.add(folder.id); loadSidebar(); showToast("Dropped in Folder");
                        }
                    } catch(err){}
                };
                list.appendChild(div);
            });

            if(chats) chats.forEach(chat => {
                const div = document.createElement('div');
                div.className = `history-item ${chat.id === currentChatId ? 'active' : ''} ${chat.is_ai_call ? 'call-thread' : ''}`;
                div.setAttribute('draggable', 'true');
                div.ondragstart = (e) => {
                    document.body.classList.add('is-dragging');
                    e.stopPropagation();
                    e.dataTransfer.setData("itemData", JSON.stringify({id: chat.id, type: 'chat'}));
                    div.style.opacity = '0.5';
                };
                div.ondragend = () => {
                    document.body.classList.remove('is-dragging');
                    div.style.opacity = '1';
                };
                const icon = chat.is_ai_call
                    ? `<ion-icon name="call-outline" style="font-size:0.85rem;opacity:0.7;flex-shrink:0;"></ion-icon>`
                    : `<ion-icon name="chatbubble-outline" style="font-size:0.85rem;opacity:0.45;flex-shrink:0;"></ion-icon>`;
                div.innerHTML = `<span style="display:flex;align-items:center;gap:6px;overflow:hidden;">${icon}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${chat.title}</span></span> <button class="item-options-btn"><ion-icon name="ellipsis-horizontal"></ion-icon></button>`;
                div.onclick = (e) => {
                    if(e.target.closest('.item-options-btn')) { openContextMenu(e, chat.id, 'chat'); return; }
                    loadThread(chat.id, chat.title);
                };
                if(chat.folder_id && getEl(`folder-${chat.folder_id}`)) { getEl(`folder-${chat.folder_id}`).appendChild(div); } 
                else { list.appendChild(div); }
            });
        } catch(error) {
            console.error("Sidebar load error:", error);
        }

        isSidebarLoading = false;
    }

    // ==========================================
    // 8. CHAT ENGINE & MESSAGE RENDERING
    // ==========================================
    async function loadThread(id, title) {
        // Auto-journal previous thread before switching
        if (currentChatId && currentUser && currentChatId !== id) {
            autoSaveChatAsJournal(currentChatId, currentUser.id); // fire-and-forget
        }

        currentChatId = id;
        chatMessageHistory = [];
        if(getEl('chat-feed')) getEl('chat-feed').innerHTML = '';
        if(getEl('mobile-chat-title')) getEl('mobile-chat-title').innerText = title || "Chat";
        loadSidebar();
        getEl('main-sidebar')?.classList.remove('open');

        try {
            const { data } = await supabase.from('messages').select('*').eq('chat_id', id).order('created_at');
            if (data) {
                data.forEach(m => {
                    renderMessage(m.content, m.role);
                    // Populate in-memory history (OpenAI format)
                    chatMessageHistory.push({
                        role: m.role === 'ai' ? 'assistant' : 'user',
                        content: m.content.startsWith('AUDIO::')
                            ? '[User sent a voice note]'
                            : m.content.startsWith('IMAGE::')
                                ? `[User shared an image: ${m.content.includes('||DESC::') ? m.content.split('||DESC::')[1] : 'a photo'}]`
                                : m.content
                    });
                });
            }
        } catch (err) { console.error(err); }
    }
    
    function startNewChat(fid = null, triggerSidebar = true) {
        // Auto-journal previous thread before switching away
        if (currentChatId && currentUser) {
            autoSaveChatAsJournal(currentChatId, currentUser.id);
        }

        currentChatId = null;
        chatMessageHistory = [];
        if(getEl('chat-feed')) getEl('chat-feed').innerHTML = '';
        if(getEl('mobile-chat-title')) getEl('mobile-chat-title').innerText = "New Chat";

        if(fid) openFolders.add(fid);
        if(triggerSidebar) loadSidebar();

        const chatForm = getEl('chat-form');
        if(chatForm) chatForm.dataset.pendingFolder = fid || '';
        getEl('main-sidebar')?.classList.remove('open');

        // Proactive check-in: if low-mood signal detected, open with a gentle friend-style message
        if (window.blakcideProactiveHook?.message) {
            const msg = window.blakcideProactiveHook.message;
            window.blakcideProactiveHook = null; // fire once
            renderMessage(msg, 'ai');
            chatMessageHistory.push({ role: 'assistant', content: msg });
        }
    }

    // ── Auto-save AI chat as journal entry (one entry per day — updates throughout day) ──
    async function autoSaveChatAsJournal(chatId, userId) {
        if (!chatId || !userId) return;
        try {
            // Skip if already journaled
            const { data: chat } = await supabase.from('chats').select('auto_journaled').eq('id', chatId).maybeSingle();
            if (chat?.auto_journaled) return;

            const { data: msgs } = await supabase.from('messages').select('role, content, created_at').eq('chat_id', chatId).order('created_at');
            if (!msgs || msgs.length < 2) return;

            // Collect image descriptions
            const imageDescs = msgs
                .filter(m => m.content?.startsWith('IMAGE::') && m.content.includes('||DESC::'))
                .map(m => m.content.split('||DESC::')[1])
                .filter(Boolean);

            const msgPayload = msgs.map(m => ({
                role: m.role === 'ai' ? 'assistant' : 'user',
                content: m.content
            }));

            // Symp.ai Vault — fire-and-forget ingest into daily AI-companion journal.
            if (window.symp) {
                window.symp.ingestSession({
                    session_type: 'ai_chat',
                    session_id:   chatId,
                    transcript:   msgPayload,
                    started_at:   msgs[0]?.created_at || new Date().toISOString(),
                    ended_at:     msgs[msgs.length - 1]?.created_at || new Date().toISOString(),
                }).catch(e => console.warn('[symp.ingest ai_chat] failed:', e.message));
            }

            const res = await fetch('/api/summarize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: msgPayload, type: 'chat', imageDescriptions: imageDescs })
            });
            if (!res.ok) return;

            const { title, content } = await res.json();
            if (!title || !content) return;

            // Check for an existing AI companion journal entry created today
            const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
            const { data: todayEntry } = await supabase
                .from('journals')
                .select('id, content')
                .eq('user_id', userId)
                .eq('ai_source', 'ai_chat')
                .gte('created_at', todayStart.toISOString())
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle();

            if (todayEntry) {
                // Append to today's existing AI companion entry
                const combined = todayEntry.content + '\n\n---\n\n' + content;
                await supabase.from('journals').update({ title, content: combined }).eq('id', todayEntry.id);
            } else {
                // Create fresh entry for today
                await supabase.from('journals').insert([{ user_id: userId, title, content, ai_source: 'ai_chat' }]);
            }

            await supabase.from('chats').update({ auto_journaled: true }).eq('id', chatId);
            showChatToast('💾 Chat saved to your journal');
            updateUserMemory(userId, content);
        } catch(e) { /* silent — non-blocking */ }
    }

    // ── Update rolling user memory after each journal save ───────────────────
    async function updateUserMemory(userId, journalContent) {
        try {
            // Get existing memory
            const { data: profile } = await supabase.from('profiles')
                .select('user_memory, full_name')
                .eq('id', userId).maybeSingle();

            const existing = profile?.user_memory || '';
            // Ask AI to extract a 1–2 sentence memory update from this session
            const memoryPrompt = [
                { role: 'system', content: 'You extract brief, factual notes from journal entries for future AI context. Output ONLY 1–2 sentences covering key themes, emotions, or personal details mentioned. No fluff. Max 120 words.' },
                { role: 'user', content: `Existing notes: "${existing}"\n\nNew journal entry to add context from:\n"${journalContent.substring(0, 800)}"` }
            ];
            const newMemory = await window.BlakcideAI.getResponse(memoryPrompt, null);
            if (newMemory && newMemory.length > 5) {
                await supabase.from('profiles').update({ user_memory: newMemory.trim() }).eq('id', userId);
                window.blakcideUserContext = newMemory.trim();
            }
        } catch(e) { /* non-blocking */ }
    }

    // Manual "Save to Journal" button
    const chatJournalBtn = getEl('chat-journal-btn');
    if (chatJournalBtn) {
        chatJournalBtn.addEventListener('click', async () => {
            if (!currentChatId || !currentUser) { showChatToast('Nothing to save yet'); return; }
            chatJournalBtn.disabled = true;
            chatJournalBtn.innerHTML = '<ion-icon name="sync-outline"></ion-icon>';
            try {
                // Force re-journal even if already done
                await supabase.from('chats').update({ auto_journaled: false }).eq('id', currentChatId);
                await autoSaveChatAsJournal(currentChatId, currentUser.id);
            } finally {
                chatJournalBtn.disabled = false;
                chatJournalBtn.innerHTML = '<ion-icon name="book-outline"></ion-icon>';
            }
        });
    }

    function renderMessage(text, role) {
        const feed = getEl('chat-feed');
        if (!feed) return;

        if (!text) {
            text = "I am here. Take your time.";
        } else if (typeof text !== 'string') {
            text = "I am listening.";
        }

        let contentHtml = text;
        let showConnectCue = false;

        if (text.startsWith('AUDIO::')) {
            const url = text.split('AUDIO::')[1];
            contentHtml = `<audio controls src="${url}" class="chat-audio-player"></audio>`;
        } else if (text.startsWith('IMAGE::')) {
            const parts = text.replace('IMAGE::', '').split('||DESC::');
            const imgUrl = parts[0];
            const desc   = parts[1] || '';
            contentHtml = `<div class="chat-img-wrap">
                <img src="${imgUrl}" class="chat-img-thumb" onclick="this.closest('.chat-img-wrap').classList.toggle('chat-img-expanded')" title="Click to expand">
                ${desc ? `<div class="chat-img-desc">${desc}</div>` : ''}
            </div>`;
        } else {
            // Check for Human Connect escalation cue
            if (text.includes('[SUGGEST_HUMAN_CONNECT]')) {
                showConnectCue = true;
                text = text.replace('[SUGGEST_HUMAN_CONNECT]', '').trim();
            }
            contentHtml = text.replace(/\n/g, '<br>');
        }

        const connectHtml = showConnectCue
            ? `<div class="connect-cue">
                 <a href="connect.html" class="connect-cue-btn"><ion-icon name="people-outline"></ion-icon> Talk to a Real Person</a>
                 <div class="connect-cue-help" style="font-size:0.72rem;opacity:0.72;margin-top:7px;line-height:1.55;">If it feels urgent, you don't have to wait — <a href="tel:18005990019" style="color:inherit;text-decoration:underline;">KIRAN 1800-599-0019</a> (free, 24/7) or <a href="tel:9152987821" style="color:inherit;text-decoration:underline;">iCall 9152987821</a>. In an emergency, call 112.</div>
               </div>`
            : '';

        feed.innerHTML += `<div class="message ${role==='user'?'user-msg':'ai-msg'}"><div class="msg-content">${contentHtml}</div>${connectHtml}</div>`;
        feed.scrollTop = feed.scrollHeight;
    }

    // ── Toast helper for chat page ──
    function showChatToast(msg) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const t = document.createElement('div');
        t.className = 'toast';
        t.innerText = msg;
        container.appendChild(t);
        setTimeout(() => t.remove(), 3200);
    }

    // SAFEGUARDED FORM SUBMISSION

    const chatForm = getEl('chat-form');
    if (chatForm) {
        chatForm.addEventListener('submit', async (e) => {
            e.preventDefault(); 
            const inp = getEl('chat-input'); 
            const text = inp.value.trim(); 
            if(!text) return;
            
            inp.value = '';
            renderMessage(text, 'user');

            // Capture the active chat ID NOW — prevents cross-thread contamination if
            // the user opens a new thread while AI is still thinking.
            let thisChatId = currentChatId;
            let isNewChat = false;

            try {
                // Create chat record if this is a brand-new thread
                if(!thisChatId) {
                    isNewChat = true;
                    const fid = getEl('chat-form').dataset.pendingFolder;
                    const payload = {user_id: currentUser.id, title: text.slice(0,20) + "..."};
                    if(fid) payload.folder_id = fid;

                    const { data, error } = await supabase.from('chats').insert([payload]).select();
                    if (error) throw error;

                    if (!data || data.length === 0) {
                        console.error("Database Error: Supabase RLS is blocking you from reading the new chat.");
                        showToast("Please disable RLS on the 'chats' table in Supabase.");
                        return;
                    }

                    thisChatId = data[0].id;
                    currentChatId = thisChatId;
                    if(currentView === 'vault') { let v = getVaultData(); v.chats.push(thisChatId); setVaultData(v); }
                    if(currentView === 'archive') { let a = getArchiveData(); a.chats.push(thisChatId); setArchiveData(a); }

                    getEl('mobile-chat-title').innerText = payload.title;
                    loadSidebar();
                }

                // Save user message first — must be in DB before AI reply
                await supabase.from('messages').insert({chat_id: thisChatId, role:'user', content:text});

                // Push to in-memory history immediately
                chatMessageHistory.push({ role: 'user', content: text });
                // Keep history to last 20 exchanges to avoid token bloat
                if (chatMessageHistory.length > 40) chatMessageHistory = chatMessageHistory.slice(-40);

                // Show streaming bubble
                const loadingId = "loading-" + Date.now();
                const feed = getEl('chat-feed');
                const loadingDiv = document.createElement('div');
                loadingDiv.id = loadingId;
                loadingDiv.className = 'message ai-msg';
                loadingDiv.innerHTML = '<div class="msg-content"><span class="stream-cursor">▌</span></div>';
                feed.appendChild(loadingDiv);
                feed.scrollTop = feed.scrollHeight;

                const msgContentEl = loadingDiv.querySelector('.msg-content');
                let streamedText = '';

                // Streaming callback — updates bubble in real-time
                const onToken = (delta, full) => {
                    if (currentChatId !== thisChatId) return;
                    streamedText = full;
                    msgContentEl.innerHTML = full.replace(/\n/g, '<br>') + '<span class="stream-cursor">▌</span>';
                    feed.scrollTop = feed.scrollHeight;
                };

                const aiResp = await window.BlakcideAI.getResponse(chatMessageHistory, onToken);

                // Strip the Human Connect cue from the stored/displayed text
                const aiRespClean = aiResp.replace('[SUGGEST_HUMAN_CONNECT]', '').trim();

                // Finalise bubble — remove cursor
                const loadingEl = document.getElementById(loadingId);
                if (loadingEl) loadingEl.remove();
                if (currentChatId === thisChatId) {
                    renderMessage(aiResp, 'ai');
                }

                // Push AI reply to in-memory history (without the cue marker)
                chatMessageHistory.push({ role: 'assistant', content: aiRespClean });

                // Save AI reply to DB
                await supabase.from('messages').insert({chat_id: thisChatId, role:'ai', content: aiRespClean});

                // Auto-title: generate on first exchange, then refresh every 4 AI replies
                const aiCount = chatMessageHistory.filter(m => m.role === 'assistant').length;
                if (isNewChat || aiCount % 4 === 0) generateAutoTitle(thisChatId);

            } catch (error) {
                console.error("Chat Error:", error);
                showToast("Connection issue. Please try again.");
                document.querySelectorAll('.msg-content').forEach(el => {
                    if(el.innerText === 'Thinking...') el.parentElement.remove();
                });
            }
        });
    }

    // Auto-title: summarises the conversation so far into 3-5 words.
    // Runs on first exchange and every 4 AI replies — stops once user manually renames.
    // Optional `messages` param lets call threads pass their own history instead of chatMessageHistory.
    async function generateAutoTitle(chatId, messages) {
        try {
            const { data: chat } = await supabase.from('chats').select('title, user_renamed').eq('id', chatId).maybeSingle();
            if (chat?.user_renamed) return;

            const src = messages || chatMessageHistory;
            const snippet = src
                .filter(m => typeof m.content === 'string')
                .slice(-10)
                .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content.substring(0, 120)}`)
                .join('\n');
            if (!snippet.trim()) return;

            const titlePrompt = [
                { role: 'system', content: 'You are a title generator. Reply with ONLY a 3-5 word title — no punctuation, no quotes, no emojis, nothing else. Capture the emotional core or main topic of the conversation.' },
                { role: 'user', content: `Generate a title for this conversation:\n${snippet}` }
            ];
            const aiTitle = await window.BlakcideAI.getResponse(titlePrompt, null);
            const cleanTitle = aiTitle.replace(/["'[\]]/g, '').replace(/^#+\s*/, '').replace('[SUGGEST_HUMAN_CONNECT]','').trim();
            if (cleanTitle && cleanTitle.length > 1 && cleanTitle.length < 60 && !cleanTitle.includes('{')) {
                await supabase.from('chats').update({ title: cleanTitle }).eq('id', chatId);
                if (currentChatId === chatId && getEl('mobile-chat-title')) {
                    getEl('mobile-chat-title').innerText = cleanTitle;
                }
                loadSidebar();
            }
        } catch(e) { /* silently skip */ }
    }

    // ==========================================
    // 9. VOICE RECORDING
    // ==========================================
    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;
    const voiceBtn = getEl('voice-btn');
    const chatInput = getEl('chat-input');

    if (voiceBtn) {
        voiceBtn.addEventListener('click', async () => {
            if (!isRecording) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    mediaRecorder = new MediaRecorder(stream);
                    mediaRecorder.start();
                    isRecording = true;
                    
                    voiceBtn.classList.add('recording');
                    voiceBtn.innerHTML = '<ion-icon name="square"></ion-icon>';
                    chatInput.placeholder = "Listening... (Telugu, Hindi, English)";
                    chatInput.disabled = true;

                    mediaRecorder.ondataavailable = e => { audioChunks.push(e.data); };

                    mediaRecorder.onstop = async () => {
                        const actualMimeType = mediaRecorder.mimeType || 'audio/webm';
                        const ext = actualMimeType.includes('mp4') ? 'mp4' : (actualMimeType.includes('mpeg') ? 'mp3' : 'webm');

                        const audioBlob = new Blob(audioChunks, { type: actualMimeType });
                        audioChunks = [];
                        
                        const tempId = "uploading-" + Date.now();
                        const feed = getEl('chat-feed');
                        feed.innerHTML += `<div id="${tempId}" class="message user-msg"><div class="msg-content">Processing Voice Note...</div></div>`;
                        feed.scrollTop = feed.scrollHeight;

                        const fileName = `${currentUser.id}-${Date.now()}.${ext}`;
                        const { error } = await supabase.storage.from('voice_notes').upload(fileName, audioBlob, { contentType: actualMimeType });
                        
                        const transcribedText = await window.BlakcideAI.transcribeAudio(audioBlob);

                        const uploadIndicator = document.getElementById(tempId);
                        if(uploadIndicator) uploadIndicator.remove();

                        if (!error && transcribedText) {
                            const { data: { publicUrl } } = supabase.storage.from('voice_notes').getPublicUrl(fileName);
                            sendAudioMessageAndProcessAI(publicUrl, transcribedText);
                        } else if (!error && !transcribedText) {
                            showToast("Voice uploaded, but transcription failed.");
                        } else {
                            showToast("Voice Note Upload Failed.");
                        }
                    };
                } catch (err) {
                    showToast("Microphone access needed for voice notes.");
                }
            } else {
                mediaRecorder.stop();
                isRecording = false;
                voiceBtn.classList.remove('recording');
                voiceBtn.innerHTML = '<ion-icon name="mic-outline"></ion-icon>';
                chatInput.placeholder = "Type a message...";
                chatInput.disabled = false;
                mediaRecorder.stream.getTracks().forEach(track => track.stop());
            }
        });
    }

    // ==========================================
    // 9b. IMAGE ATTACHMENT
    // ==========================================
    const chatAttachBtn  = getEl('chat-attach-btn');
    const chatImageInput = getEl('chat-image-input');

    if (chatAttachBtn && chatImageInput) {
        chatAttachBtn.addEventListener('click', () => chatImageInput.click());

        chatImageInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            chatImageInput.value = '';
            if (!file) return;
            if (!file.type.startsWith('image/')) { showChatToast('Please select an image file'); return; }
            if (file.size > 8 * 1024 * 1024) { showChatToast('Image must be under 8 MB'); return; }

            const feed = getEl('chat-feed');
            const tempId = 'img-upload-' + Date.now();
            feed.innerHTML += `<div id="${tempId}" class="message user-msg"><div class="msg-content" style="opacity:0.5;">📷 Uploading…</div></div>`;
            feed.scrollTop = feed.scrollHeight;

            try {
                // Ensure chat exists
                let thisChatId = currentChatId;
                if (!thisChatId) {
                    const fid = getEl('chat-form').dataset.pendingFolder || '';
                    const payload = { user_id: currentUser.id, title: 'Image conversation' };
                    if (fid) payload.folder_id = fid;
                    const { data } = await supabase.from('chats').insert([payload]).select();
                    if (!data || !data[0]) { showChatToast('Failed to create chat'); return; }
                    thisChatId = data[0].id;
                    currentChatId = thisChatId;
                    loadSidebar();
                }

                // Upload to Supabase Storage
                const ext  = file.name.split('.').pop() || 'jpg';
                const path = `${currentUser.id}/${Date.now()}.${ext}`;
                const { error: upErr } = await supabase.storage.from('chat_images').upload(path, file, { contentType: file.type });
                if (upErr) { document.getElementById(tempId)?.remove(); showChatToast('Upload failed'); return; }

                const { data: urlData } = supabase.storage.from('chat_images').getPublicUrl(path);
                const publicUrl = urlData.publicUrl;

                // Vision analysis
                let imageDesc = 'An image was shared.';
                try {
                    if (window.symp) {
                        const r = await window.symp.describeImage({ imageUrl: publicUrl });
                        imageDesc = r?.data?.description || imageDesc;
                    } else {
                        const vRes = await fetch('/api/vision', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ imageUrl: publicUrl })
                        });
                        const vData = await vRes.json();
                        imageDesc = vData.description || imageDesc;
                    }
                } catch(_) {}

                // Remove upload placeholder, render actual image
                document.getElementById(tempId)?.remove();
                const msgContent = `IMAGE::${publicUrl}||DESC::${imageDesc}`;
                renderMessage(msgContent, 'user');

                // Save to DB
                await supabase.from('messages').insert({ chat_id: thisChatId, role: 'user', content: msgContent });

                // Add image to in-memory history — use OpenAI vision format so the model can actually see it
                chatMessageHistory.push({
                    role: 'user',
                    content: [
                        { type: 'text', text: imageDesc ? `I'm sharing an image. Here's what it shows: ${imageDesc}` : "I'm sharing an image with you." },
                        { type: 'image_url', image_url: { url: publicUrl, detail: 'auto' } }
                    ]
                });
                if (chatMessageHistory.length > 40) chatMessageHistory = chatMessageHistory.slice(-40);

                // Streaming bubble
                const loadingId = 'loading-' + Date.now();
                const loadingDiv2 = document.createElement('div');
                loadingDiv2.id = loadingId;
                loadingDiv2.className = 'message ai-msg';
                loadingDiv2.innerHTML = '<div class="msg-content"><span class="stream-cursor">▌</span></div>';
                feed.appendChild(loadingDiv2);
                feed.scrollTop = feed.scrollHeight;

                const imgMsgEl = loadingDiv2.querySelector('.msg-content');
                const onToken2 = (delta, full) => {
                    if (currentChatId !== thisChatId) return;
                    imgMsgEl.innerHTML = full.replace(/\n/g, '<br>') + '<span class="stream-cursor">▌</span>';
                    feed.scrollTop = feed.scrollHeight;
                };

                const aiResp = await window.BlakcideAI.getResponse(chatMessageHistory, onToken2);
                const aiRespClean2 = aiResp.replace('[SUGGEST_HUMAN_CONNECT]', '').trim();
                document.getElementById(loadingId)?.remove();
                if (currentChatId === thisChatId) renderMessage(aiResp, 'ai');
                chatMessageHistory.push({ role: 'assistant', content: aiRespClean2 });
                await supabase.from('messages').insert({ chat_id: thisChatId, role: 'ai', content: aiRespClean2 });
                const aiCount2 = chatMessageHistory.filter(m => m.role === 'assistant').length;
                if (aiCount2 % 4 === 0) generateAutoTitle(thisChatId);

            } catch (err) {
                console.error('Image send error:', err);
                document.getElementById(tempId)?.remove();
                showChatToast('Failed to send image');
            }
        });
    }

    async function sendAudioMessageAndProcessAI(url, transcribedText) {
        try {
            let thisChatId = currentChatId;

            if(!thisChatId) {
                const fid = getEl('chat-form').dataset.pendingFolder;
                const payload = {user_id: currentUser.id, title: "Voice Note..."};
                if(fid) payload.folder_id = fid;
                const { data } = await supabase.from('chats').insert([payload]).select();
                if (!data || data.length === 0) { showToast("Failed to create chat."); return; }
                thisChatId = data[0].id;
                currentChatId = thisChatId;

                if(currentView === 'vault') { let v = getVaultData(); v.chats.push(thisChatId); setVaultData(v); }
                if(currentView === 'archive') { let a = getArchiveData(); a.chats.push(thisChatId); setArchiveData(a); }

                getEl('mobile-chat-title').innerText = payload.title;
                loadSidebar();
            }

            const audioMarker = `AUDIO::${url}`;
            renderMessage(audioMarker, 'user');
            await supabase.from('messages').insert({chat_id: thisChatId, role:'user', content: audioMarker});

            // Add to in-memory history as transcription context
            chatMessageHistory.push({ role: 'user', content: `[Voice Note Transcribed]: "${transcribedText}"` });
            if (chatMessageHistory.length > 40) chatMessageHistory = chatMessageHistory.slice(-40);

            const loadingId = "loading-" + Date.now();
            const feed = getEl('chat-feed');
            const loadingDiv = document.createElement('div');
            loadingDiv.id = loadingId;
            loadingDiv.className = 'message ai-msg';
            loadingDiv.innerHTML = '<div class="msg-content"><span class="stream-cursor">▌</span></div>';
            feed.appendChild(loadingDiv);
            feed.scrollTop = feed.scrollHeight;

            const msgContentEl = loadingDiv.querySelector('.msg-content');

            const onToken = (delta, full) => {
                if (currentChatId !== thisChatId) return;
                msgContentEl.innerHTML = full.replace(/\n/g, '<br>') + '<span class="stream-cursor">▌</span>';
                feed.scrollTop = feed.scrollHeight;
            };

            const aiResp = await window.BlakcideAI.getResponse(chatMessageHistory, onToken);

            const loadingEl = document.getElementById(loadingId);
            if (loadingEl) loadingEl.remove();
            if (currentChatId === thisChatId) renderMessage(aiResp, 'ai');

            chatMessageHistory.push({ role: 'assistant', content: aiResp });
            await supabase.from('messages').insert({chat_id: thisChatId, role:'ai', content:aiResp});
        } catch (err) {
            console.error("Audio Processing Error:", err);
            showToast("Failed to process audio message.");
        }
    }

    // ==========================================
    // 10. MODALS & PROFILE MANAGEMENT
    // ==========================================
    const modal = getEl('input-modal'); 
    const mInp = getEl('modal-input'); 
    let mCb = null;
    
    function openModal(t, v, cb) { 
        if(!modal || !mInp) return;
        getEl('modal-title').innerText=t; mInp.value=v; modal.classList.add('active'); mInp.focus(); mCb=cb; 
    }
    
    click('modal-confirm', ()=>{ if(mCb)mCb(mInp.value); modal?.classList.remove('active'); });
    click('modal-cancel', ()=>{ modal?.classList.remove('active'); });

    click('new-folder-btn', () => {
        getEl('main-sidebar')?.classList.remove('open');
        openModal('New Folder', '', async (name) => {
            if (name) {
                const { data, error } = await supabase.from('folders').insert([{ user_id: currentUser.id, name: name }]).select().single();
                if(error) { showToast("Error creating folder."); return; }

                if (currentView === 'vault') { 
                    let vaultInfo = getVaultData(); 
                    vaultInfo.folders.push(data.id); 
                    setVaultData(vaultInfo); 
                }
                if (currentView === 'archive') { 
                    let archiveInfo = getArchiveData(); 
                    archiveInfo.folders.push(data.id); 
                    setArchiveData(archiveInfo); 
                }
                loadSidebar(); 
            }
        });
    });
    
    click('new-chat-btn', ()=>startNewChat(null, true));
    
    click('open-profile-btn', ()=>{
        getEl('profile-modal')?.classList.add('active');
        getEl('main-sidebar')?.classList.remove('open');
    });
    click('close-profile-btn', ()=>getEl('profile-modal')?.classList.remove('active'));

    const avatarUpload = getEl('avatar-upload');
    if (avatarUpload) {
        avatarUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if(!file) return;

            getEl('profile-preview').src = URL.createObjectURL(file);
            getEl('profile-preview').style.display = 'block';
            getEl('profile-placeholder').style.display = 'none';
            showToast("Uploading Profile Picture...");

            const ext = file.name.split('.').pop();
            const fileName = `${currentUser.id}-${Date.now()}.${ext}`;
            
            const { error } = await supabase.storage.from('avatars').upload(fileName, file);

            if(!error) {
                const { data } = supabase.storage.from('avatars').getPublicUrl(fileName);
                await supabase.from('profiles').upsert({ id: currentUser.id, avatar_url: data.publicUrl });
                fetchProfile(); 
                showToast("Profile Picture Updated!");
            } else {
                showToast("Upload failed.");
            }
        });
    }

    async function fetchProfile() {
        if(!currentUser) return;
        try {
            const { data } = await supabase.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
            if(data) {
                if(data.avatar_url) { 
                    if(getEl('sidebar-avatar')) { getEl('sidebar-avatar').src=data.avatar_url; getEl('sidebar-avatar').style.display='flex'; }
                    if(getEl('sidebar-avatar-placeholder')) getEl('sidebar-avatar-placeholder').style.display='none'; 
                    if(getEl('profile-preview')) { getEl('profile-preview').src=data.avatar_url; getEl('profile-preview').style.display='block'; }
                    if(getEl('profile-placeholder')) getEl('profile-placeholder').style.display='none';
                }
                if(data.full_name && getEl('user-name-display')) getEl('user-name-display').innerText=data.full_name;
                if(getEl('profile-name')) getEl('profile-name').value = data.full_name || '';
                if(getEl('profile-bio')) getEl('profile-bio').value = data.bio || '';
                
                // 🛡️ NEW: THE SOFT REMINDER
                // If they don't have a name or DOB, show a gentle, dismissible reminder
                if (!data.full_name || !data.dob) {
                    showSoftReminder();
                }
            } else {
                // If the profile doesn't exist at all, also show the reminder
                showSoftReminder();
            }
        } catch (err) { console.error("Profile fetch error:", err); }
    }

    // Add this helper function right below fetchProfile()
    function showSoftReminder() {
        // Prevent showing it multiple times if they keep refreshing
        if (sessionStorage.getItem('blakcide_reminder_shown')) return; 
        
        const feed = getEl('chat-feed');
        if (!feed) return;

        const reminderHtml = `
            <div id="soft-reminder" style="background: var(--glass-inner); border: 1px solid var(--glass-border); padding: 15px; border-radius: 12px; margin: 20px; text-align: center; animation: fadeIn 0.5s;">
                <p style="margin: 0 0 10px 0; font-size: 0.9rem; opacity: 0.8;">
                    <ion-icon name="information-circle-outline"></ion-icon> Take a moment to complete your profile so we can personalize your sanctuary.
                </p>
                <div style="display: flex; justify-content: center; gap: 10px;">
                    <button onclick="document.getElementById('profile-modal').classList.add('active'); document.getElementById('soft-reminder').remove();" class="btn-solid" style="padding: 5px 15px; font-size: 0.8rem; width: auto;">Update Profile</button>
                    <button onclick="document.getElementById('soft-reminder').remove();" style="background: none; border: 1px solid var(--glass-border); color: var(--text-color); padding: 5px 15px; border-radius: 10px; cursor: pointer; font-size: 0.8rem;">Dismiss</button>
                </div>
            </div>
        `;
        feed.insertAdjacentHTML('afterbegin', reminderHtml);
        sessionStorage.setItem('blakcide_reminder_shown', 'true'); // Only show once per browser session
    }
    
    const profileForm = getEl('profile-form');
    if (profileForm) {
        profileForm.addEventListener('submit', async(e)=>{
            e.preventDefault();
            const updates = { id: currentUser.id, full_name: getEl('profile-name').value, bio: getEl('profile-bio').value };
            await supabase.from('profiles').upsert(updates); 
            showToast("Profile Saved!"); 
            fetchProfile(); 
            getEl('profile-modal')?.classList.remove('active');
        });
    }

    // ==========================================
    // 11. AI VOICE CALL ENGINE (GPT-4o Realtime)
    // Single WebSocket to OpenAI Realtime API — no Whisper, no TTS round-trips.
    // Browser gets an ephemeral key from /api/realtime-session, then opens
    // wss://api.openai.com/v1/realtime directly. Server-side VAD handles
    // turn detection and barge-in. PCM16@24kHz in both directions.
    // ==========================================

    // ── Core state ─────────────────────────────────────────────────────────
    let _rtActive        = false;
    let _rtMuted         = false;
    let _rtSpeaker       = true;
    // Mic ducking: when true, the mic-capture loop drops frames so background
    // noise (and the AI's own voice bleeding through speakers) can't trigger
    // server VAD speech_started → barge-in. Set when AI audio starts streaming,
    // cleared when AI audio fully drains. The user can still barge in by
    // speaking loudly enough to override the duck — handled in the mic loop.
    let _rtAiSpeaking    = false;
    let _rtTimerInt      = null;
    let _rtSecs          = 0;
    let _rtStartTime     = null;
    let _rtLangsUsed     = new Set();
    let _rtHistory       = [];       // [{role,content}] for saving at call end

    // ── WebSocket & audio ──────────────────────────────────────────────────
    let _rtWs            = null;     // WebSocket to OpenAI Realtime API
    let _rtAudioCtx      = null;     // Web AudioContext
    let _rtGain          = null;     // GainNode — mute instantly on barge-in
    let _rtMicStream     = null;     // getUserMedia stream
    let _rtMicSource     = null;     // MediaStreamSourceNode
    let _rtProcessor     = null;     // ScriptProcessorNode for PCM16 capture

    // ── Playback scheduling ────────────────────────────────────────────────
    let _rtNextPlayTime  = 0;        // ctx.currentTime of next scheduled chunk end
    let _rtAudioPlaying  = false;    // true while any scheduled chunk is in flight

    // ── State machine ──────────────────────────────────────────────────────
    let _rtState             = 'idle';   // idle | listening | thinking | speaking
    let _rtDetectedLang      = 'en';

    // ── Ghost-input & language guards ──────────────────────────────────────
    let _rtResponseId        = null;   // ID of current in-flight response
    let _rtResponseInProgress = false; // true between response.created and response.done
    let _rtSpeechStartMs     = 0;      // Date.now() when speech_started fired

    // ── Per-response transcript accumulation ───────────────────────────────
    let _rtCurAIText     = '';       // assembled AI reply text (for transcript + history)

    // ── UI helpers ────────────────────────────────────────────────────
    function _rtSetStatus(txt) {
        const el = document.getElementById('ai-call-status');
        if (el) el.innerText = txt;
    }

    function _rtAddMsg(speaker, text) {
        const el = document.getElementById('ai-call-transcript');
        if (!el) return;
        const wrap = document.createElement('div');
        wrap.className = 'ai-call-msg';
        wrap.innerHTML = `<span class="ai-call-msg-label">${speaker === 'user' ? 'You' : 'AI'}</span><span class="ai-call-msg-text-${speaker}">${text}</span>`;
        el.appendChild(wrap);
        el.scrollTop = el.scrollHeight;
        if (speaker === 'ai') {
            const av = document.getElementById('ai-call-avatar-el');
            if (av) av.classList.add('ai-speaking');
        }
    }

    function _rtTransition(state) {
        _rtState = state;
        const labels = { idle: '', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };
        _rtSetStatus(labels[state] || '');
        const av = document.getElementById('ai-call-avatar-el');
        if (av) av.classList.toggle('ai-speaking', state === 'speaking');
    }

    // ── System prompt — rebuilt each time language changes ────────────
    function _rtBuildSystem(lang) {
        const userCtx = window.blakcideUserContext
            ? `\n\nABOUT THIS USER (weave in naturally, never announce): ${window.blakcideUserContext.substring(0, 200)}`
            : '';
        const langRule = {
            te: `LANGUAGE: Respond ONLY in Telugu (casual spoken style, match user: Romanized or script).
FORBIDDEN: yaar, bhai, kya, hai (Hindi words — NEVER). Formal Telugu is also FORBIDDEN.
GOOD → "Aiyo ra, em jarigindi? Cheppu." / "Arre sare, adhe anipistundi naaku kuda"`,
            hi: `LANGUAGE: Respond ONLY in Hindi (casual spoken style, match user: Romanized or Devanagari).
FORBIDDEN: aiyo, ra, undi, cheppu (Telugu words — NEVER). Formal Hindi is also FORBIDDEN.
GOOD → "Arre yaar, kya hua? Bata na." / "Sach mein? Fir kya kiya tune?"`,
            en: `LANGUAGE: Respond in casual spoken English only. No Hindi. No Telugu.
GOOD → "Oh wow, that's rough. What happened?" / "Yeah I get that feeling."`
        }[lang] || `LANGUAGE: Casual English only.`;

        return `You are Blakcide — on a LIVE VOICE CALL with the user's closest friend. NOT an assistant.

${langRule}

LENGTH: 1 sentence max. 2 only for deep emotion. Phone call = short.
FORMAT: Zero markdown, zero asterisks. Pure spoken words.
OPENER: Natural human reaction — NEVER "I understand" / "Certainly" / "That's interesting":
  English → "Oh—" / "Yeah" / "Aw man" / "Really?" / "That's rough"
  Telugu  → "Aiyo" / "Arre ra" / "Sare" / "Nijamga?"
  Hindi   → "Arre yaar" / "Sach mein?" / "Haan haan" / "Oye"
NEVER: Start with "I". Sound like customer service. Say "As an AI".${userCtx}`;
    }

    // ── PCM16 audio playback — schedule each delta back-to-back ──────
    // Uses a GainNode to allow instant mute on server-VAD barge-in.
    // Each delta is a base64-encoded PCM16 chunk at 24 kHz mono.
    function _rtEnqueueAudio(base64PCM) {
        if (!_rtAudioCtx || !_rtActive || !_rtSpeaker) return;
        const ctx = _rtAudioCtx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});

        // Decode base64 → PCM16 Int16 → Float32
        const binary = atob(base64PCM);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const int16   = new Int16Array(bytes.buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

        // Create and schedule buffer
        const buf = ctx.createBuffer(1, float32.length, 24000);
        buf.copyToChannel(float32, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        // Connect through GainNode so _rtStopAudio() can instantly silence it
        src.connect(_rtGain || ctx.destination);

        // Schedule contiguously; add 80ms lead-in for first chunk to absorb jitter
        const now  = ctx.currentTime;
        const when = Math.max(now + 0.08, _rtNextPlayTime);
        src.start(when);
        _rtNextPlayTime  = when + buf.duration;
        _rtAudioPlaying  = true;

        src.onended = () => {
            // Audio done — if nothing more scheduled, mark idle
            if (_rtNextPlayTime <= ctx.currentTime + 0.12) _rtAudioPlaying = false;
        };
    }

    // Instantly silence all scheduled audio (server VAD fired or call ended)
    function _rtStopAudio() {
        if (!_rtAudioCtx) return;
        _rtAudioPlaying = false;
        _rtNextPlayTime = _rtAudioCtx.currentTime;
        // Ramp gain to 0 over 30ms (click-free) then back to 1
        if (_rtGain) {
            const g = _rtGain.gain;
            g.cancelScheduledValues(_rtAudioCtx.currentTime);
            g.setValueAtTime(0, _rtAudioCtx.currentTime);
            g.linearRampToValueAtTime(1, _rtAudioCtx.currentTime + 0.03);
        }
    }

    // ── Mic capture → PCM16@24kHz → WebSocket ────────────────────────
    // ScriptProcessorNode (deprecated but universally supported).
    // Downsamples from the AudioContext rate (44100/48000) to 24000 Hz
    // and converts Float32 to Int16 before sending as base64.
    function _rtStartMicCapture() {
        if (!_rtMicStream || !_rtAudioCtx || !_rtWs) return;
        const ctx        = _rtAudioCtx;
        const sourceRate = ctx.sampleRate;
        const TARGET     = 24000;

        _rtMicSource = ctx.createMediaStreamSource(_rtMicStream);
        // Buffer size 2048 ≈ 46ms at 44.1 kHz — low enough latency
        _rtProcessor = ctx.createScriptProcessor(2048, 1, 1);

        _rtProcessor.onaudioprocess = (e) => {
            if (!_rtActive || _rtMuted || !_rtWs || _rtWs.readyState !== WebSocket.OPEN) return;

            // Duck the mic while the AI is speaking. Drops frames entirely so
            // server VAD can't pick up speaker bleed-through and falsely fire
            // speech_started → cancel-AI-mid-sentence. This is the cause of
            // "AI cuts off mid-sentence" without speakerphone echo cancellation.
            if (_rtAiSpeaking) return;

            const input = e.inputBuffer.getChannelData(0);

            // Linear downsample to 24 kHz
            const ratio   = sourceRate / TARGET;
            const outLen  = Math.floor(input.length / ratio);
            const down    = new Float32Array(outLen);
            for (let i = 0; i < outLen; i++) down[i] = input[Math.round(i * ratio)];

            // Float32 → Int16 PCM
            const pcm16 = new Int16Array(outLen);
            for (let i = 0; i < outLen; i++) {
                pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(down[i] * 32767)));
            }

            // Base64 encode
            const bytes = new Uint8Array(pcm16.buffer);
            let   bin   = '';
            const CHK   = 8192;
            for (let i = 0; i < bytes.length; i += CHK) {
                bin += String.fromCharCode(...bytes.subarray(i, i + CHK));
            }
            _rtWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) }));
        };

        // Must connect to destination even if output is silent
        _rtMicSource.connect(_rtProcessor);
        _rtProcessor.connect(ctx.destination);
    }

    function _rtStopMicCapture() {
        if (_rtProcessor) { try { _rtProcessor.disconnect(); } catch (_) {} _rtProcessor = null; }
        if (_rtMicSource) { try { _rtMicSource.disconnect(); } catch (_) {} _rtMicSource  = null; }
    }

    // ── Send session.update — mirrors the server's canonical config ───────
    // The server (`netlify/functions/realtime-session.js`) returns the FULL
    // canonical config under `_symp_canonical_config` when the ephemeral
    // token is created. We cache it in `_rtCanonicalConfig` and replay it
    // here on every session.update so the client never drifts from server.
    //
    // Fallback: if the server didn't return a canonical block (older deploy,
    // partial outage), we fall back to a minimal block so the call still works.
    let _rtCanonicalConfig = null;        // populated when token is fetched
    let _rtCanonicalTools  = null;        // populated alongside

    const REALTIME_INSTRUCTIONS_FALLBACK = [
        'You are a warm, local digital companion. You MUST output your audio in the EXACT same language the user speaks. ',
        'If the user speaks Telugu, your spoken audio must be entirely in colloquial Telugu. ',
        'If the user speaks Hindi, your spoken audio must be entirely in Hindi. ',
        'Do not use English unless the user speaks pure English. Never mix languages. ',
        'If asked if you are human, be honest but warm: "I live in your phone, but I\'m always here for you." ',
        'Keep responses concise and conversational.'
    ].join('');

    function _rtUpdateSession() {
        if (!_rtWs || _rtWs.readyState !== WebSocket.OPEN) return;
        const cfg = _rtCanonicalConfig;
        const session = {
            modalities:                cfg?.modalities || ['text', 'audio'],
            instructions:              cfg?.instructions || REALTIME_INSTRUCTIONS_FALLBACK,
            voice:                     cfg?.voice || 'alloy',
            input_audio_format:        'pcm16',
            output_audio_format:       'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection:            cfg?.turn_detection || {
                type:                'server_vad',
                threshold:           0.6,
                prefix_padding_ms:   300,
                silence_duration_ms: 1200,
            },
            max_response_output_tokens: 350,
        };
        if (Array.isArray(_rtCanonicalTools) && _rtCanonicalTools.length) {
            session.tools = _rtCanonicalTools;
            session.tool_choice = 'auto';
        }
        _rtWs.send(JSON.stringify({ type: 'session.update', session }));
    }

    // ── Explicit language-switch command detector ─────────────────────
    // Returns 'te' | 'hi' | 'en' | null.  Checks the user's transcript for
    // phrases like "speak in telugu", "mujhe hindi mein baat karna hai", etc.
    function _rtDetectLangCommand(text) {
        const t = text.toLowerCase();
        if (/\b(telugu|telugulo|telugu\s*lo|telugu\s*lo\s*maat|telugu\s*mein|speak.*telugu|talk.*telugu|switch.*telugu|తెలుగు)\b/.test(t)) return 'te';
        if (/\b(hindi|hindi\s*mein|hindi\s*me\b|mujhe\s*hindi|main\s*hindi|hum\s*hindi|हिंदी|हिन्दी)\b/.test(t)) return 'hi';
        if (/\b(english|in\s*english|speak.*english|switch.*english|english\s*mein|english\s*me\b)\b/.test(t)) return 'en';
        return null;
    }

    // ── Ghost-input transcript validator ──────────────────────────────
    // Returns true if the transcript looks like a genuine utterance.
    // Rejects: empty, pure punctuation/noise, single filler syllables.
    function _rtIsValidTranscript(text) {
        if (!text || text.length < 2) return false;
        // Pure whitespace / punctuation
        if (/^[\s.!?,;:…\-–—*]+$/.test(text)) return false;
        // Single filler: "uh", "um", "hmm", "mm", "ah", "eh" with optional trailing chars
        if (/^(uh+|um+|hmm+|hm+|mm+|ah+|eh+|oh+|ew+)\s*[.!?]?\s*$/i.test(text)) return false;
        // Must have at least one actual word character
        if (!/[a-zA-Z\u0900-\u097F\u0C00-\u0C7F]/.test(text)) return false;
        return true;
    }

    // ── WebSocket message router ──────────────────────────────────────
    function _rtHandleMessage(event) {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        switch (msg.type) {

            case 'session.created':
                console.log('[RT] Session created, configuring…');
                _rtUpdateSession();
                _rtTransition('listening');
                break;

            case 'input_audio_buffer.speech_started':
                // Server VAD: user started speaking — record time and stop AI audio (barge-in)
                _rtSpeechStartMs = Date.now();
                console.log('[RT] Speech started');
                _rtAiSpeaking = false; // un-duck — user is genuinely talking
                _rtStopAudio();
                _rtTransition('listening');
                break;

            case 'input_audio_buffer.speech_stopped':
                // Server VAD: user stopped — AI auto-response will follow
                const speechMs = _rtSpeechStartMs ? Date.now() - _rtSpeechStartMs : 9999;
                console.log(`[RT] Speech stopped (${speechMs}ms)`);
                // If the utterance was extremely short (<150ms), it's likely a noise spike.
                // We can't stop the auto-response here (it happens server-side), but we
                // flag it; the transcript validator will cancel the response if needed.
                if (speechMs < 150) {
                    console.warn('[RT] Speech too short — likely noise spike, flagging');
                }
                _rtTransition('thinking');
                break;

            case 'response.created':
                // Track the in-flight response ID so we can cancel ghost responses
                _rtResponseId        = msg.response?.id || null;
                _rtResponseInProgress = true;
                console.log('[RT] Response created:', _rtResponseId);
                break;

            case 'conversation.item.input_audio_transcription.completed': {
                // Whisper transcript of what the user said.
                // This fires AFTER response.created, so we can still cancel a ghost.
                const userText = (msg.transcript || '').trim();
                const speechDurMs = _rtSpeechStartMs ? Date.now() - _rtSpeechStartMs : 9999;

                // ── Ghost-input validation ───────────────────────────────────
                if (!_rtIsValidTranscript(userText)) {
                    console.warn(`[RT] REJECTED ghost input: "${userText}" (speechDuration=${speechDurMs}ms) — cancelling response`);
                    // Cancel the in-flight response
                    if (_rtResponseInProgress && _rtWs?.readyState === WebSocket.OPEN) {
                        _rtWs.send(JSON.stringify({ type: 'response.cancel' }));
                    }
                    _rtTransition('listening');
                    break;
                }

                console.log(`[RT] User (${speechDurMs}ms): "${userText.substring(0, 80)}"`);
                _rtAddMsg('user', userText);
                _rtHistory.push({ role: 'user', content: userText });
                if (_rtHistory.length > 30) _rtHistory = _rtHistory.slice(-30);

                // ── Language detection — three layers ─────────────────────
                // P1: Explicit language command ("speak in telugu") — highest priority,
                //     cancel the current wrong-language response and recreate correctly.
                // P2: Script/keyword detection via detectLangWithFallback.
                // P3: No change — keep previous language.
                const cmdLang  = _rtDetectLangCommand(userText);
                const textLang = window.BlakcideAI?.detectLangWithFallback(userText, _rtDetectedLang)
                               || _rtDetectedLang;
                const newLang  = cmdLang || textLang;

                if (cmdLang) {
                    // Explicit language switch — cancel current response and redo in right lang
                    console.log(`[RT] Explicit language command: "${userText}" → ${cmdLang}`);
                    _rtDetectedLang = cmdLang;
                    _rtUpdateSession();
                    if (_rtResponseInProgress && _rtWs?.readyState === WebSocket.OPEN) {
                        _rtWs.send(JSON.stringify({ type: 'response.cancel' }));
                        // Give session.update 80ms to propagate, then request fresh response
                        setTimeout(() => {
                            if (_rtActive && _rtWs?.readyState === WebSocket.OPEN) {
                                _rtWs.send(JSON.stringify({ type: 'response.create' }));
                            }
                        }, 80);
                    }
                } else if (newLang !== _rtDetectedLang) {
                    // Non-command language switch (user started speaking different language)
                    console.log(`[RT] Language: ${_rtDetectedLang} → ${newLang}`);
                    _rtDetectedLang = newLang;
                    _rtUpdateSession(); // takes effect on next response
                } else {
                    // Same language — still refresh instructions to keep them high-recency
                    _rtUpdateSession();
                }

                _rtLangsUsed.add(_rtDetectedLang);
                break;
            }

            case 'response.audio.delta':
                // Stream PCM16 audio chunks — schedule for seamless playback
                if (msg.delta && _rtSpeaker) {
                    if (_rtState !== 'speaking') {
                        _rtTransition('speaking');
                        _rtCurAIText = '';
                        _rtAddMsg('ai', '');
                    }
                    _rtAiSpeaking = true; // duck mic
                    _rtEnqueueAudio(msg.delta);
                }
                break;

            case 'response.audio_transcript.delta':
                // Live transcript of AI speech — update last message bubble
                if (msg.delta) {
                    _rtCurAIText += msg.delta;
                    const tel = document.getElementById('ai-call-transcript');
                    if (tel) {
                        const msgs   = tel.querySelectorAll('.ai-call-msg');
                        const textEl = msgs[msgs.length - 1]?.querySelector('.ai-call-msg-text-ai');
                        if (textEl) textEl.textContent = _rtCurAIText;
                    }
                }
                break;

            case 'response.audio.done':
                // All audio deltas sent — transition back to listening once drain finishes
                console.log('[RT] Audio done, waiting for playback to drain');
                (function checkDrained() {
                    if (!_rtActive) return;
                    if (!_rtAudioPlaying || _rtNextPlayTime <= (_rtAudioCtx?.currentTime || 0) + 0.15) {
                        _rtAiSpeaking = false; // un-duck mic once playback fully drained
                        _rtTransition('listening');
                    } else {
                        setTimeout(checkDrained, 100);
                    }
                })();
                break;

            case 'response.done': {
                _rtResponseInProgress = false;
                _rtResponseId         = null;
                // Save full AI reply to history
                const items = msg.response?.output || [];
                for (const item of items) {
                    const textContent = item.content?.find(c => c.type === 'audio')?.transcript
                                     || item.content?.find(c => c.type === 'text')?.text || '';
                    if (textContent) {
                        _rtHistory.push({ role: 'assistant', content: textContent.trim() });
                    }
                }
                if (_rtHistory.length > 30) _rtHistory = _rtHistory.slice(-30);
                break;
            }

            case 'response.cancelled':
                _rtResponseInProgress = false;
                _rtResponseId         = null;
                console.log('[RT] Response cancelled');
                break;

            // ── Tool-call handling ───────────────────────────────────────
            // The Realtime API emits tool calls as conversation items of type
            // 'function_call'. Arguments stream via response.function_call_arguments.delta;
            // when .done arrives we execute the tool via /api/blaksyd/symp/*
            // (or an inline handler for UI-only tools), then send a
            // conversation.item.create with role='tool' + the result, then
            // response.create to let the model speak the resolved answer.
            case 'response.function_call_arguments.delta': {
                if (!_rtToolBuf) _rtToolBuf = {};
                const cid = msg.call_id || msg.item_id;
                if (!_rtToolBuf[cid]) _rtToolBuf[cid] = { name: msg.name || '', args: '' };
                if (msg.delta) _rtToolBuf[cid].args += msg.delta;
                if (msg.name)  _rtToolBuf[cid].name  = msg.name;
                break;
            }
            case 'response.function_call_arguments.done': {
                const cid = msg.call_id || msg.item_id;
                const buf = (_rtToolBuf && _rtToolBuf[cid]) || { name: msg.name || '', args: msg.arguments || '' };
                let parsed = {};
                try { parsed = JSON.parse(buf.args || '{}'); } catch (_) { parsed = {}; }
                _rtHandleToolCall({ call_id: cid, name: buf.name || msg.name, args: parsed });
                if (_rtToolBuf) delete _rtToolBuf[cid];
                break;
            }

            case 'error':
                console.error('[RT] API error:', msg.error?.type, msg.error?.message);
                _rtResponseInProgress = false;
                _rtTransition('listening');
                break;
        }
    }

    // ── Tool-call dispatcher (voice) ─────────────────────────────────────
    // UI-side tools render a card immediately and return a confirmation to
    // the model. Server-side tools (search_vault, get_live_context,
    // swap_persona) round-trip through the proxy.
    let _rtToolBuf = null;

    function _rtToolResult(call_id, content) {
        if (!_rtWs || _rtWs.readyState !== WebSocket.OPEN) return;
        _rtWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
                type:    'function_call_output',
                call_id,
                output:  String(content),
            },
        }));
        // Ask the model to continue with the new tool output.
        _rtWs.send(JSON.stringify({ type: 'response.create' }));
    }

    async function _rtHandleToolCall({ call_id, name, args }) {
        console.log(`[RT] tool call: ${name}`, args);
        try {
            // UI-surfacing tools: render a card, return a confirmation immediately.
            if (name === 'escalate_to_human') {
                _rtRenderEscalateCard(args);
                return _rtToolResult(call_id, 'escalation_card_shown');
            }
            if (name === 'suggest_switch_to_text') {
                _rtRenderSwitchToTextCard(args);
                return _rtToolResult(call_id, 'switch_to_text_card_shown');
            }

            // Server-side tools: route through the authenticated proxy.
            const session = window._sbClient && (await window._sbClient.auth.getSession()).data?.session;
            const jwt     = session?.access_token;
            if (!jwt) return _rtToolResult(call_id, `${name}_unavailable: not signed in`);

            // We expose tool execution via a dedicated proxy route that maps
            // 1:1 to /api/symp/v1/tool/<name>. For v1 we only have these
            // server-side tools we need from voice: swap_persona, search_vault,
            // get_live_context, fetch_soft_insight. Everything else is UI-side.
            if (name === 'swap_persona') {
                const r = await fetch('/api/blaksyd/symp/persona/swap', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
                    body:    JSON.stringify({ persona: args.persona, reason: args.reason || '' }),
                });
                const d = await r.json().catch(() => ({}));
                _rtToolResult(call_id, r.ok ? `persona swapped to "${args.persona}". Adopt this voice on your next response.` : `swap failed: ${d?.error?.message || r.status}`);
                // Update the header pill so the user sees their voice request was honoured.
                if (r.ok && typeof window.notifyPersonaSwapped === 'function') {
                    window.notifyPersonaSwapped(args.persona);
                }
                // Also trigger a server-side instructions refresh so the
                // model picks up the new persona card on its next reply.
                _rtUpdateSession();
                return;
            }
            // For the remaining tools we don't have a per-tool proxy route
            // yet. Until they're wired, return a graceful no-op so the model
            // produces a normal text answer.
            _rtToolResult(call_id, `(${name} not yet wired in voice — answer from your own knowledge)`);
        } catch (e) {
            console.warn('[RT] tool dispatch error:', e);
            _rtToolResult(call_id, `tool error: ${e.message || e}`);
        }
    }

    function _rtRenderEscalateCard({ reason, suggested_opener }) {
        const card = document.createElement('div');
        card.className = 'rt-cta-card rt-escalate-card';
        card.innerHTML = `
            <div class="rt-cta-title">Want to talk to a Listener?</div>
            <div class="rt-cta-body">${escapeHtml(suggested_opener || 'I can sit with a Listener and you together.')}</div>
            <div class="rt-cta-actions">
                <button class="rt-cta-yes">Yes, connect</button>
                <button class="rt-cta-no">Not now</button>
            </div>`;
        card.querySelector('.rt-cta-yes').onclick = () => {
            window.dispatchEvent(new CustomEvent('blakcide:escalate-to-human', { detail: { reason } }));
            card.remove();
        };
        card.querySelector('.rt-cta-no').onclick = () => card.remove();
        document.getElementById('ai-call-transcript')?.appendChild(card);
    }

    function _rtRenderSwitchToTextCard({ reason, opener }) {
        const card = document.createElement('div');
        card.className = 'rt-cta-card rt-switch-card';
        card.innerHTML = `
            <div class="rt-cta-title">Tough audio?</div>
            <div class="rt-cta-body">${escapeHtml(opener || 'Want to continue this in chat?')}</div>
            <div class="rt-cta-actions">
                <button class="rt-cta-yes">Switch to chat</button>
                <button class="rt-cta-no">Keep talking</button>
            </div>`;
        card.querySelector('.rt-cta-yes').onclick = () => {
            window.dispatchEvent(new CustomEvent('blakcide:switch-to-text', { detail: { reason } }));
            card.remove();
        };
        card.querySelector('.rt-cta-no').onclick = () => card.remove();
        document.getElementById('ai-call-transcript')?.appendChild(card);
    }

    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // ─────────────────────────────────────────────────────────────────
    // Persona picker — clickable mode menu.
    //
    // Two paths achieve the same outcome:
    //   1. EXPLICIT (this menu): user taps the pill in the chat header,
    //      picks a persona, we POST /persona/swap → the next /chat reply
    //      lands in the new voice. If a voice call is live, we also fire
    //      _rtUpdateSession() so the next utterance switches mid-call.
    //   2. NATURAL ("be my astrologer"): the model itself calls the
    //      `swap_persona` tool from inside chat or voice — same backend
    //      endpoint, same outcome. We just refresh the pill afterwards.
    //
    // The 7 personas mirror the server-side enum in persona-engine.mjs.
    // ─────────────────────────────────────────────────────────────────
    const PERSONA_META = {
        friend:     { emoji: '🤝', label: 'Friend',     one_liner: 'Equal, casual, supportive — daily banter & venting.' },
        father:     { emoji: '🛡️', label: 'Father',     one_liner: 'Protective, logical — financial advice, stability, tough love.' },
        mother:     { emoji: '🌷', label: 'Mother',     one_liner: 'Nurturing, empathetic — feelings, healing, self-care.' },
        astrologer: { emoji: '✨', label: 'Astrologer', one_liner: 'Vedic-style, birth-data aware — purpose, timing, hope.' },
        spiritual:  { emoji: '🕉️', label: 'Spiritual',  one_liner: 'Zen, scripture-aware — peace, mindfulness, the Now.' },
        tech_savvy: { emoji: '💻', label: 'Tech Savvy', one_liner: 'Logical, efficient — productivity, gadgets, problem-solving.' },
        therapist:  { emoji: '🪶', label: 'Therapist',  one_liner: 'Reflective, psychologist-style — listening sessions, reframing.' },
    };
    let _activePersona = 'friend';

    // Render the pill in the header.
    function _renderPersonaPill() {
        const emoji = document.getElementById('persona-picker-emoji');
        const label = document.getElementById('persona-picker-label');
        if (!emoji || !label) return;
        const m = PERSONA_META[_activePersona] || PERSONA_META.friend;
        emoji.textContent = m.emoji;
        label.textContent = m.label;
    }

    // Build the menu list. Re-runs on every open so the active item highlights.
    function _renderPersonaMenu() {
        const list = document.getElementById('persona-picker-list');
        if (!list) return;
        list.innerHTML = Object.entries(PERSONA_META).map(([id, m]) => `
            <div class="persona-picker-item ${id === _activePersona ? 'is-active' : ''}" data-persona="${id}">
                <span class="persona-picker-item-emoji">${m.emoji}</span>
                <div class="persona-picker-item-body">
                    <div class="persona-picker-item-label">${escapeHtml(m.label)}</div>
                    <div class="persona-picker-item-oneliner">${escapeHtml(m.one_liner)}</div>
                </div>
                ${id === _activePersona ? '<ion-icon class="persona-picker-item-check" name="checkmark-outline"></ion-icon>' : ''}
            </div>
        `).join('');
        list.querySelectorAll('.persona-picker-item').forEach(el => {
            el.addEventListener('click', () => {
                const id = el.getAttribute('data-persona');
                if (id) _swapPersona(id);
            });
        });
    }

    window.togglePersonaPicker = function () {
        const menu = document.getElementById('persona-picker-menu');
        if (!menu) return;
        if (menu.hasAttribute('hidden')) {
            _renderPersonaMenu();
            menu.removeAttribute('hidden');
            // Close on outside click — single-shot listener.
            setTimeout(() => {
                document.addEventListener('click', _personaMenuOutside, { once: true });
            }, 0);
        } else {
            menu.setAttribute('hidden', '');
        }
    };
    function _personaMenuOutside(e) {
        const menu = document.getElementById('persona-picker-menu');
        const btn  = document.getElementById('persona-picker-btn');
        if (!menu || menu.hasAttribute('hidden')) return;
        if (menu.contains(e.target) || (btn && btn.contains(e.target))) {
            // Re-arm for the next outside click.
            document.addEventListener('click', _personaMenuOutside, { once: true });
            return;
        }
        menu.setAttribute('hidden', '');
    }

    function _personaToast(msg) {
        const t = document.createElement('div');
        t.className = 'persona-swap-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2400);
    }

    // POST /persona/swap → update local state → close menu → toast.
    // Persona id is also kept in localStorage as a soft fallback so we can
    // recover the user's last choice if the backend persona/state endpoint
    // is briefly unreachable (network blip, cold-start) and so the pill
    // never silently drops back to 'friend' on a slow page load.
    const PERSONA_LS_KEY = 'blaksyd.activePersona';
    function _stashPersonaLocal(id) {
        try { localStorage.setItem(PERSONA_LS_KEY, id); } catch (_) {}
    }
    function _readPersonaLocal() {
        try { return localStorage.getItem(PERSONA_LS_KEY) || null; } catch (_) { return null; }
    }

    async function _swapPersona(personaId) {
        if (!PERSONA_META[personaId]) return;
        if (personaId === _activePersona) {
            // No-op — just close.
            const menu = document.getElementById('persona-picker-menu');
            if (menu) menu.setAttribute('hidden', '');
            return;
        }

        // Optimistic UI — flip first, reconcile on response.
        const prev = _activePersona;
        _activePersona = personaId;
        _renderPersonaPill();
        _stashPersonaLocal(personaId);
        const menu = document.getElementById('persona-picker-menu');
        if (menu) menu.setAttribute('hidden', '');

        // Resolve auth token. We retry briefly because Supabase init is async
        // and on freshly-loaded chat.html the very first tap can land before
        // the SDK has finished hydrating the session.
        async function _waitForToken(attempts = 4) {
            for (let i = 0; i < attempts; i++) {
                const sb = window._sbClient;
                const session = sb && (await sb.auth.getSession()).data?.session;
                if (session?.access_token) return session.access_token;
                await new Promise(r => setTimeout(r, 300 + i * 200));
            }
            return null;
        }

        const token = await _waitForToken();
        if (!token) {
            // No auth — definitely a hard fail. Revert and prompt sign-in.
            _activePersona = prev; _renderPersonaPill();
            _personaToast('Please sign in first');
            return;
        }

        let res;
        try {
            res = await fetch('/api/blaksyd/symp/persona/swap', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body:    JSON.stringify({ persona: personaId, reason: 'user picked from menu' }),
            });
        } catch (netErr) {
            // Network-layer failure: keep the optimistic flip, surface a
            // soft "Saved on this device" toast so the user understands
            // their next message will use the new mode locally even if
            // the server didn't acknowledge yet. No revert — the pill
            // matches what the user wanted.
            console.warn('[persona] swap network error:', netErr?.message || netErr);
            _personaToast(`✓ ${PERSONA_META[personaId].label} mode (offline)`);
            return;
        }

        if (res.ok) {
            try { await _hydrateActivePersona(); } catch (_) {}
            _personaToast(`✓ Now in ${PERSONA_META[personaId].label} mode`);
            if (_rtActive && typeof _rtUpdateSession === 'function') {
                try { _rtUpdateSession(); } catch (_) {}
            }
            return;
        }

        // Non-OK — distinguish "the server rejected the swap" (hard error,
        // revert) from "transient upstream issue" (keep flip, soft toast).
        let errMsg = '';
        let errCode = '';
        try {
            const d = await res.json();
            errMsg  = d?.error?.message || '';
            errCode = d?.error?.code    || '';
        } catch (_) {}
        const hardReject =
            res.status === 400 ||
            res.status === 409 ||
            errCode === 'BAD_REQUEST' ||
            /invalid persona|locked/i.test(errMsg);

        if (hardReject) {
            console.warn(`[persona] swap rejected: ${res.status} ${errCode} ${errMsg}`);
            _activePersona = prev; _renderPersonaPill();
            _stashPersonaLocal(prev);
            _personaToast(errMsg || "That mode isn't available right now");
            return;
        }

        // 401 / 502 / 504 / 500 etc. — keep optimistic flip, schedule a
        // background retry so the server eventually catches up.
        console.warn(`[persona] swap upstream issue: ${res.status} — retrying in background`);
        _personaToast(`✓ ${PERSONA_META[personaId].label} mode (syncing…)`);
        setTimeout(async () => {
            try {
                const t = await _waitForToken(2);
                if (!t) return;
                await fetch('/api/blaksyd/symp/persona/swap', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}` },
                    body:    JSON.stringify({ persona: personaId, reason: 'background retry' }),
                });
            } catch (_) {}
        }, 6000);
    }

    // Read current persona from server on page load. Falls back to 'friend'.
    // Retries up to 6× over ~12s until Supabase auth is ready, since the
    // page's Supabase init is async — the 600ms one-shot used to lose the
    // race and leave the pill stuck on 'friend' even when the user had
    // already switched personas in a previous session.
    async function _hydrateActivePersona({ attempt = 0 } = {}) {
        // 1. Pre-fill from localStorage IMMEDIATELY so the pill never shows
        //    a stale 'friend' default while we round-trip to the server.
        const stashed = _readPersonaLocal();
        if (stashed && PERSONA_META[stashed]) _activePersona = stashed;

        try {
            const sb = window._sbClient;
            const session = sb && (await sb.auth.getSession()).data?.session;
            const token = session?.access_token;
            if (!token) {
                if (attempt < 6) {
                    setTimeout(() => _hydrateActivePersona({ attempt: attempt + 1 }), 1500 + attempt * 400);
                }
                _renderPersonaPill();
                return;
            }
            const res = await fetch('/api/blaksyd/symp/persona/state?user_id=self', {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            if (!res.ok) { _renderPersonaPill(); return; }
            const d = await res.json();
            const id = d?.data?.active_persona;
            if (id && PERSONA_META[id]) {
                _activePersona = id;
                _stashPersonaLocal(id);
            }
        } catch (_) { /* keep stashed value */ }
        _renderPersonaPill();
    }

    // Public hook — the model's `swap_persona` tool path or voice tool
    // executor calls this after a successful swap so the pill updates
    // without a full reload.
    window.notifyPersonaSwapped = function (personaId) {
        if (!PERSONA_META[personaId]) return;
        _activePersona = personaId;
        _stashPersonaLocal(personaId);
        _renderPersonaPill();
        _personaToast(`✓ Now in ${PERSONA_META[personaId].label} mode`);
    };

    // Hydrate on DOM ready (page load is async — auth may not be ready yet).
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(_hydrateActivePersona, 600));
    } else {
        setTimeout(_hydrateActivePersona, 600);
    }

    // ── Start call ─────────────────────────────────────────────────────
    window.startAICall = async function () {
        if (_rtActive) return;
        _rtActive       = true;
        _rtSecs         = 0;
        _rtStartTime    = new Date();
        _rtLangsUsed    = new Set(['en']);
        _rtHistory      = [];
        _rtDetectedLang = 'en';
        _rtMuted        = false;
        _rtSpeaker      = true;
        _rtState        = 'idle';
        _rtAudioPlaying       = false;
        _rtNextPlayTime       = 0;
        _rtCurAIText          = '';
        _rtResponseId         = null;
        _rtResponseInProgress = false;
        _rtSpeechStartMs      = 0;

        // 1. AudioContext — must happen synchronously inside the user gesture
        try {
            if (!_rtAudioCtx || _rtAudioCtx.state === 'closed') {
                _rtAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
            }
            _rtAudioCtx.resume();
            // GainNode for instant barge-in mute
            _rtGain = _rtAudioCtx.createGain();
            _rtGain.gain.value = 1;
            _rtGain.connect(_rtAudioCtx.destination);
        } catch (e) { console.warn('[RT] AudioContext init:', e); }

        // 2. Mic request — also inside the gesture, no await before this
        const micPromise = navigator.mediaDevices
            .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
            .catch(e => { console.error('[RT] Mic denied:', e); return null; });

        // 3. UI setup
        const ov = document.getElementById('ai-call-overlay');
        if (!ov) { _rtActive = false; return; }
        ov.style.display = 'flex';
        const transcriptEl = document.getElementById('ai-call-transcript');
        if (transcriptEl) transcriptEl.innerHTML = '';
        _rtSetStatus('Connecting…');
        document.getElementById('ai-call-timer').innerText = '0:00';
        document.getElementById('ai-call-mute-btn').innerHTML = '<ion-icon name="mic-outline"></ion-icon>';
        document.getElementById('ai-call-mute-btn').classList.remove('btn-muted');
        document.getElementById('ai-call-speaker-btn').innerHTML = '<ion-icon name="volume-high-outline"></ion-icon>';
        document.getElementById('ai-call-speaker-btn').classList.remove('btn-muted');

        _rtTimerInt = setInterval(() => {
            _rtSecs++;
            const m = Math.floor(_rtSecs / 60), s = _rtSecs % 60;
            document.getElementById('ai-call-timer').innerText = `${m}:${String(s).padStart(2, '0')}`;
        }, 1000);

        // 4. Fetch ephemeral token then open Realtime WebSocket
        // Pass user_id so the server can inject this user's Vault context
        // into the Realtime session's `instructions` (polyglot + fluency
        // rules always inject; vault context is user-specific).
        try {
            const tokenRes = await fetch('/api/realtime-session', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ user_id: currentUser?.id || null }),
            });
            if (!tokenRes.ok) throw new Error(`Token ${tokenRes.status}: ${await tokenRes.text()}`);
            const tokenData  = await tokenRes.json();
            const ephKey     = tokenData.client_secret?.value;
            if (!ephKey) throw new Error('No ephemeral key returned');

            // Capture the canonical session config the server built (full
            // CORE IDENTITY + CRITICAL OVERRIDE + persona + vibe + vault
            // stack, plus the voice tools list). _rtUpdateSession() replays
            // this so the client never drifts from server.
            _rtCanonicalConfig = tokenData._symp_canonical_config || null;
            _rtCanonicalTools  = Array.isArray(_rtCanonicalConfig?.tools) ? _rtCanonicalConfig.tools : null;

            if (!_rtActive) return; // call ended during token fetch

            const model = 'gpt-4o-realtime-preview-2024-12-17';
            _rtWs = new WebSocket(
                `wss://api.openai.com/v1/realtime?model=${model}`,
                ['realtime', `openai-insecure-api-key.${ephKey}`, 'openai-beta.realtime-v1']
            );

            let _micStarted = false;
            const _maybeStartCapture = () => {
                if (_micStarted || !_rtMicStream || !_rtWs || _rtWs.readyState !== WebSocket.OPEN) return;
                _micStarted = true;
                _rtStartMicCapture();
            };

            _rtWs.onopen = () => {
                console.log('[RT] WebSocket open');
                _rtSetStatus('Connected…');
                _maybeStartCapture();
            };
            _rtWs.onmessage = _rtHandleMessage;
            _rtWs.onerror   = (e) => { console.error('[RT] WebSocket error', e); };
            _rtWs.onclose   = (e) => {
                console.log('[RT] WebSocket closed:', e.code, e.reason);
                if (_rtActive) { _rtSetStatus('Reconnecting…'); }
            };

            // 5. Wire mic once stream resolves
            micPromise.then(stream => {
                if (!_rtActive) return;
                _rtMicStream = stream;
                if (!stream) { console.warn('[RT] No mic stream'); return; }
                _maybeStartCapture();
            });

        } catch (e) {
            console.error('[RT] Failed to connect:', e);
            if (_rtActive) {
                _rtSetStatus(`Failed: ${e.message}`);
                setTimeout(() => { if (_rtActive) window.endAICall(); }, 3000);
            }
        }
    };

    // ── End call ──────────────────────────────────────────────────────
    window.endAICall = function () {
        _rtActive = false;
        clearInterval(_rtTimerInt);
        _rtTransition('idle');
        _rtStopAudio();
        _rtStopMicCapture();

        if (_rtWs) { try { _rtWs.close(); } catch (_) {} _rtWs = null; }
        if (_rtMicStream) { _rtMicStream.getTracks().forEach(t => t.stop()); _rtMicStream = null; }
        if (_rtAudioCtx) { try { _rtAudioCtx.close(); } catch (_) {} _rtAudioCtx = null; }
        _rtGain = null;

        const ov = document.getElementById('ai-call-overlay');
        if (ov) ov.style.display = 'none';

        if (_rtHistory && _rtHistory.length >= 2 && currentUser) {
            const snap        = [..._rtHistory];
            const userId      = currentUser.id;
            const durationSec = _rtSecs;
            const langsUsed   = [..._rtLangsUsed];
            console.log(`[RT] Saving call: ${snap.length} turns, ${durationSec}s, langs=${langsUsed}`);
            (async () => {
                await saveCallAsThread(snap, userId, durationSec, langsUsed);
                await saveCallAsJournal(snap, userId, durationSec, langsUsed);
            })();
        }
        _rtHistory   = [];
        _rtLangsUsed = new Set();
    };

    window.toggleAICallMute = function () {
        _rtMuted = !_rtMuted;
        const btn = document.getElementById('ai-call-mute-btn');
        if (btn) {
            btn.innerHTML = `<ion-icon name="${_rtMuted ? 'mic-off-outline' : 'mic-outline'}"></ion-icon>`;
            btn.classList.toggle('btn-muted', _rtMuted);
        }
        // Tell OpenAI to discard any buffered audio when muting
        if (_rtMuted && _rtWs && _rtWs.readyState === WebSocket.OPEN) {
            _rtWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
        }
    };

    window.toggleAICallSpeaker = function () {
        _rtSpeaker = !_rtSpeaker;
        const btn = document.getElementById('ai-call-speaker-btn');
        if (btn) {
            btn.innerHTML = `<ion-icon name="${_rtSpeaker ? 'volume-high-outline' : 'volume-mute-outline'}"></ion-icon>`;
            btn.classList.toggle('btn-muted', !_rtSpeaker);
        }
        if (!_rtSpeaker) _rtStopAudio();
    };

    // Save AI call as a chat thread so it appears in sidebar + is continuable
    async function saveCallAsThread(callHistory, userId, durationSec, langsUsed) {
        try {
            const now = new Date();
            const timeStr   = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            const durMin    = Math.floor(durationSec / 60);
            const durSec    = durationSec % 60;
            const durStr    = durMin > 0 ? `${durMin}m ${durSec}s` : `${durSec}s`;
            const langLabel = langsUsed.filter(l => l !== 'en').join('/').toUpperCase();
            const titleSuffix = langLabel ? ` · ${langLabel}` : '';

            // Use upsert-safe insert — omit is_ai_call if column may not exist
            const insertPayload = {
                user_id: userId,
                title:   `📞 AI Call · ${timeStr} (${durStr})${titleSuffix}`
            };

            // Try with is_ai_call first; if it fails (column missing), retry without
            let chatId = null;
            const tryInsert = async (payload) => {
                const { data, error } = await supabase
                    .from('chats')
                    .insert([payload])
                    .select();
                if (error) throw error;
                return data?.[0]?.id;
            };

            try {
                chatId = await tryInsert({ ...insertPayload, is_ai_call: true });
            } catch (e) {
                console.warn('[AI Call] saveCallAsThread: is_ai_call insert failed, retrying without:', e.message);
                chatId = await tryInsert(insertPayload);
            }

            if (!chatId) { console.error('[AI Call] saveCallAsThread: no chatId returned'); return; }

            const msgRows = callHistory.map(m => ({
                chat_id: chatId,
                role:    m.role === 'assistant' ? 'ai' : 'user',
                content: m.content,
            }));
            const { error: msgErr } = await supabase.from('messages').insert(msgRows);
            if (msgErr) console.error('[AI Call] saveCallAsThread messages error:', msgErr.message);

            generateAutoTitle(chatId, callHistory);
            loadSidebar();
            console.log('[AI Call] Thread saved:', chatId);
        } catch (e) {
            console.error('[AI Call] saveCallAsThread failed:', e.message);
        }
    }

    async function saveCallAsJournal(callHistory, userId, durationSec, langsUsed) {
        try {
            // Symp.ai Vault — fire-and-forget ingest into daily AI-companion journal.
            if (window.symp) {
                const endedAt   = new Date();
                const startedAt = new Date(endedAt.getTime() - durationSec * 1000);
                window.symp.ingestSession({
                    session_type: 'ai_call',
                    session_id:   `ai_call_${endedAt.getTime()}`,
                    transcript:   (callHistory || []).map(m => ({
                        role:    m.role === 'assistant' ? 'assistant' : 'user',
                        content: m.content,
                    })),
                    started_at:   startedAt.toISOString(),
                    ended_at:     endedAt.toISOString(),
                }).catch(e => console.warn('[symp.ingest ai_call] failed:', e.message));
            }

            const durMin  = Math.floor(durationSec / 60);
            const durSec  = durationSec % 60;
            const durStr  = durMin > 0 ? `${durMin}m ${durSec}s` : `${durSec}s`;
            const langCtx = langsUsed.length > 1
                ? `\n\nLanguages used: ${langsUsed.map(l => ({ en:'English', hi:'Hindi', te:'Telugu' })[l] || l).join(', ')}`
                : '';

            const res = await fetch('/api/summarize', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ messages: callHistory, type: 'call' })
            });
            if (!res.ok) {
                console.error('[AI Call] saveCallAsJournal: summarize API error', res.status);
                return;
            }
            const { title, content } = await res.json();
            if (!title || !content) {
                console.warn('[AI Call] saveCallAsJournal: empty summary returned');
                return;
            }

            const journalContent = `${content}${langCtx}\n\n_Call duration: ${durStr}_`;

            const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
            const { data: todayEntry, error: findErr } = await supabase
                .from('journals')
                .select('id, content')
                .eq('user_id', userId)
                .eq('ai_source', 'ai_call')
                .gte('created_at', todayStart.toISOString())
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle();

            if (findErr) console.warn('[AI Call] journal lookup error:', findErr.message);

            if (todayEntry) {
                const { error: upErr } = await supabase.from('journals').update({
                    title,
                    content: todayEntry.content + '\n\n---\n\n' + journalContent
                }).eq('id', todayEntry.id);
                if (upErr) console.error('[AI Call] journal update error:', upErr.message);
            } else {
                const { error: insErr } = await supabase.from('journals').insert([{
                    user_id:   userId,
                    title,
                    content:   journalContent,
                    ai_source: 'ai_call'
                }]);
                if (insErr) console.error('[AI Call] journal insert error:', insErr.message);
            }

            showChatToast('📞 Call saved to your journal');
            updateUserMemory(userId, content);
            console.log('[AI Call] Journal entry saved');
        } catch (e) {
            console.error('[AI Call] saveCallAsJournal failed:', e.message);
        }
    }

    // Auto-start call if URL has ?call=1
    (function () {
        const params = new URLSearchParams(window.location.search);
        if (params.get('call') === '1') {
            history.replaceState({}, '', window.location.pathname);
            setTimeout(() => { if (typeof window.startAICall === 'function') window.startAICall(); }, 1800);
        }
    })();

    // Initialize App Session
    enforceSession();
});