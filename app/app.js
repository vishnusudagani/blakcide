document.addEventListener('DOMContentLoaded', () => {

    // ==========================================
    // 1. SUPABASE & 3D CANVAS INITIALIZATION
    // ==========================================
    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    let supabase;
    if (typeof window.supabase !== 'undefined') {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    } else {
        console.error("Supabase failed to load.");
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
    }

    // ── Load user profile + recent journals into AI context ──────────────────
    async function loadUserContext() {
        try {
            const [profileRes, journalsRes] = await Promise.all([
                supabase.from('profiles').select('full_name, bio, user_memory').eq('id', currentUser.id).maybeSingle(),
                supabase.from('journals').select('title, emotion, content').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(5)
            ]);

            const profile  = profileRes.data;
            const journals = journalsRes.data || [];

            let ctx = '';
            if (profile?.full_name) ctx += `User's name: ${profile.full_name}. `;
            if (profile?.bio)       ctx += `About them: ${profile.bio}. `;
            if (profile?.user_memory) ctx += `Notes from past sessions: ${profile.user_memory} `;
            if (journals.length) {
                const recent = journals.map(j =>
                    `"${j.title}"${j.emotion ? ` (felt ${j.emotion})` : ''}${j.content ? ': ' + j.content.substring(0, 80) : ''}`
                ).join(' | ');
                ctx += `Recent journal entries: ${recent}.`;
            }

            window.blakcideUserContext = ctx.trim() || null;
        } catch(e) {
            window.blakcideUserContext = null;
        }
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
    }

    // ── Auto-save AI chat as journal entry (one entry per day — updates throughout day) ──
    async function autoSaveChatAsJournal(chatId, userId) {
        if (!chatId || !userId) return;
        try {
            // Skip if already journaled
            const { data: chat } = await supabase.from('chats').select('auto_journaled').eq('id', chatId).maybeSingle();
            if (chat?.auto_journaled) return;

            const { data: msgs } = await supabase.from('messages').select('role, content').eq('chat_id', chatId).order('created_at');
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
            ? `<div class="connect-cue"><a href="connect.html" class="connect-cue-btn"><ion-icon name="people-outline"></ion-icon> Talk to a Real Person</a></div>`
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
                    const vRes = await fetch('/api/vision', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ imageUrl: publicUrl })
                    });
                    const vData = await vRes.json();
                    imageDesc = vData.description || imageDesc;
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
    // 11. AI VOICE CALL ENGINE
    // Robust design: single mic stream per call, per-utterance generation
    // counter prevents stale onstop callbacks, watchdog auto-recovers
    // stuck states, continuous language switching via Whisper.
    // ==========================================
    let _callActive        = false;
    let _callMuted         = false;
    let _callSpeaker       = true;
    let _callTimerInt      = null;
    let _callSecs          = 0;
    let _callStartTime     = null;   // Date when call started — for duration logging
    let _callLangsUsed     = new Set(); // languages detected during the call
    let _callHistory       = [];
    let _callSynth         = window.speechSynthesis;

    // Mic acquired ONCE per call — never re-requested mid-call
    let _callMicStream     = null;

    // Per-utterance recorder — recreated each turn
    let _callRecGen        = 0;       // generation counter: stale onstop/transcribe closures self-cancel
    let _callMediaRecorder = null;

    // VAD nodes (reuse AudioContext from output)
    let _callVADSource     = null;
    let _callVADAnalyser   = null;
    let _callVADFrame      = null;

    // Watchdog — if stuck in thinking/speaking > 18s, auto-recover
    let _callWatchdog      = null;

    // Barge-in — lightweight VAD that runs during AI speech
    let _bargeInAnalyser   = null;
    let _bargeInSource     = null;
    let _bargeInFrame      = null;
    let _bargeInCnt        = 0;    // consecutive energetic frames

    // ─────────────────────────────────────────────────────────────────
    // State machine + remaining vars
    // ─────────────────────────────────────────────────────────────────
    // ── Language state ───────────────────────────────────────────────────────
    // _callDetectedLang : authoritative language for THIS TURN, drives LLM enforcement
    // _callWhisperLang  : raw Whisper result (after remap), stored separately so
    //                     text-scoring can override it before committing
    // _callLangStreak   : consecutive turns in same non-English language → triggers
    //                     native-script hint to Whisper after 2 turns
    let _callDetectedLang  = 'en';
    let _callWhisperLang   = 'en';
    let _callLangStreak    = 0;
    let _callLangStreakVal  = 'en';
    let _callState         = 'idle'; // idle | listening | thinking | speaking
    let _speakSeq          = 0;
    let _callAudioCtx      = null;   // Web AudioContext (unlocked once on user gesture)
    let _callAudioSrc      = null;   // current BufferSourceNode

    function _setCallStatus(txt) {
        const el = document.getElementById('ai-call-status');
        if (el) el.innerText = txt;
    }

    function _addCallMsg(speaker, text) {
        const el = document.getElementById('ai-call-transcript');
        if (!el) return;
        const wrap = document.createElement('div');
        wrap.className = 'ai-call-msg';
        wrap.innerHTML = `<span class="ai-call-msg-label">${speaker === 'user' ? 'You' : 'AI'}</span><span class="ai-call-msg-text-${speaker}">${text}</span>`;
        el.appendChild(wrap);
        el.scrollTop = el.scrollHeight;
        if (speaker === 'ai') {
            const av = document.getElementById('ai-call-avatar-el');
            if (av) {
                av.classList.add('ai-speaking');
                setTimeout(() => av.classList.remove('ai-speaking'), Math.min(text.length * 55, 6000));
            }
        }
    }

    // ── State transition + watchdog reset + barge-in lifecycle ──────
    function _callTransition(state) {
        const prev = _callState;
        _callState = state;
        const labels = { idle: '', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };
        _setCallStatus(labels[state] || '');
        const av = document.getElementById('ai-call-avatar-el');
        if (av) av.classList.toggle('ai-speaking', state === 'speaking');

        // Barge-in only active while AI is speaking
        if (state === 'speaking' && prev !== 'speaking') {
            _startBargeIn();
        } else if (state !== 'speaking') {
            _stopBargeIn();
        }

        _resetWatchdog();
    }

    // ── Barge-in: lightweight VAD running during AI speech ────────────
    // If the user starts speaking while AI is talking, interrupt immediately.
    // Uses a separate AnalyserNode on the existing mic stream — does NOT
    // start a new MediaRecorder (that happens after transition to listening).
    // echoCancellation in getUserMedia suppresses speaker echo so the AI's
    // own voice doesn't trigger a false positive.
    //
    // Thresholds tuned conservatively: requires 5 consecutive hot frames
    // (~165ms at 30fps) and energy > 28 to avoid triggering on breaths/noise.
    // We also skip the first 500ms of AI speech so the initial burst of audio
    // routing doesn't create echo before WebRTC EC settles.

    function _startBargeIn() {
        if (!_callMicStream || !_callAudioCtx || _callAudioCtx.state === 'closed') return;
        if (_bargeInAnalyser) return; // already running
        try {
            _bargeInSource   = _callAudioCtx.createMediaStreamSource(_callMicStream);
            _bargeInAnalyser = _callAudioCtx.createAnalyser();
            _bargeInAnalyser.fftSize = 256;
            _bargeInSource.connect(_bargeInAnalyser);
        } catch (e) { return; }

        const buf = new Uint8Array(_bargeInAnalyser.frequencyBinCount);
        _bargeInCnt = 0;

        const ENERGY_THRESHOLD = 28;   // 0–255
        const FRAMES_REQUIRED  = 5;    // ~165ms at 30fps
        let   framesTotal      = 0;

        const loop = () => {
            if (!_callActive || _callState !== 'speaking') { _stopBargeIn(); return; }
            framesTotal++;

            // Skip first 15 frames (~500ms) — EC needs time to suppress echo
            if (framesTotal < 15) { _bargeInFrame = requestAnimationFrame(loop); return; }

            _bargeInAnalyser.getByteFrequencyData(buf);
            const energy = buf.reduce((s, v) => s + v, 0) / buf.length;

            if (energy > ENERGY_THRESHOLD) {
                _bargeInCnt++;
                if (_bargeInCnt >= FRAMES_REQUIRED) {
                    _handleBargeIn(); // interrupt AI
                    return;
                }
            } else {
                _bargeInCnt = 0; // reset on silence
            }
            _bargeInFrame = requestAnimationFrame(loop);
        };
        _bargeInFrame = requestAnimationFrame(loop);
    }

    function _stopBargeIn() {
        if (_bargeInFrame)    { cancelAnimationFrame(_bargeInFrame); _bargeInFrame = null; }
        if (_bargeInSource)   { try { _bargeInSource.disconnect();   } catch (_) {} _bargeInSource   = null; }
        if (_bargeInAnalyser) { try { _bargeInAnalyser.disconnect(); } catch (_) {} _bargeInAnalyser = null; }
        _bargeInCnt = 0;
    }

    function _handleBargeIn() {
        _stopBargeIn();
        _stopTTSAudio();      // kills current audio + resets TTS queue
        _stopRecorder();      // cleans up any stale recorder
        _callTransition('listening');
        // Small delay so the AudioContext settles before we attach new VAD nodes
        setTimeout(() => {
            if (_callActive && !_callMuted) _startListening();
        }, 120);
    }

    // ── Watchdog: if stuck in thinking/speaking >18s, force-recover ──
    function _resetWatchdog() {
        clearTimeout(_callWatchdog);
        if (!_callActive || _callState === 'idle' || _callState === 'listening') return;
        _callWatchdog = setTimeout(() => {
            if (!_callActive || _callState === 'idle' || _callState === 'listening') return;
            console.warn('[AI Call] Watchdog fired — recovering to listening');
            _stopTTSAudio();
            _stopRecorder();
            _callTransition('listening');
            _startListening();
        }, 18000);
    }

    // ── Audio output ──────────────────────────────────────────────────
    function _stopTTSAudio() {
        // CRITICAL: increment _speakSeq here so any in-flight _callSpeakSimple
        // fetch (greeting, error) sees mySeq !== _speakSeq and bails out.
        // Without this, barge-in / watchdog interrupts leave a stale TTS fetch
        // that resolves later and starts a second audio source simultaneously —
        // the primary cause of audio cutting immediately.
        _speakSeq++;
        _ttsQueueReset();  // drain queue and invalidate in-flight queue fetches
        if (_callAudioSrc) {
            try { _callAudioSrc.onended = null; _callAudioSrc.stop(); } catch (_) {}
            _callAudioSrc = null;
        }
        if (_callSynth) _callSynth.cancel();
    }

    // ── Stop recorder only — mic stream stays alive ───────────────────
    // CRITICAL: increment _callRecGen FIRST so any in-flight async
    // callbacks (onstop, transcribe) see the new generation and bail out.
    function _stopRecorder() {
        _callRecGen++;  // invalidate all in-flight closures immediately
        if (_callVADFrame) { cancelAnimationFrame(_callVADFrame); _callVADFrame = null; }
        if (_callVADSource)   { try { _callVADSource.disconnect();   } catch (_) {} _callVADSource   = null; }
        if (_callVADAnalyser) { try { _callVADAnalyser.disconnect(); } catch (_) {} _callVADAnalyser = null; }
        if (_callMediaRecorder && _callMediaRecorder.state !== 'inactive') {
            try { _callMediaRecorder.stop(); } catch (_) {}
        }
        _callMediaRecorder = null;
    }

    // ── Full teardown — releases mic at call end ──────────────────────
    function _releaseMic() {
        _stopBargeIn();
        _stopRecorder();
        if (_callMicStream) {
            _callMicStream.getTracks().forEach(t => t.stop());
            _callMicStream = null;
        }
    }

    // ── Whisper transcription ─────────────────────────────────────────
    async function _transcribeWhisper(chunks, mimeType, myGen) {
        try {
            const blob     = new Blob(chunks, { type: mimeType });
            const arrayBuf = await blob.arrayBuffer();
            // Fast base64 encoding via chunk-splitting avoids O(n²) string concat.
            // String.fromCharCode.apply works on ≤65535-byte chunks; larger blobs
            // must be chunked to avoid "Maximum call stack size exceeded".
            const uint8  = new Uint8Array(arrayBuf);
            let binary = '';
            const CHUNK = 8192;
            for (let i = 0; i < uint8.length; i += CHUNK) {
                binary += String.fromCharCode(...uint8.subarray(i, i + CHUNK));
            }
            const base64 = btoa(binary);

            const body = { audioBase64: base64, mimeType };
            // Only hint Whisper's language after 2+ consecutive turns in the same
            // non-English language. This gets native script (తెలుగు / हिंदी) while
            // not permanently locking Whisper when the user switches to English.
            if (_callLangStreak >= 2 && _callLangStreakVal !== 'en') {
                body.langHint = _callLangStreakVal;
            }

            const res = await fetch('/api/transcribe', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body)
            });
            // Check generation after each await — bail if stale
            if (myGen !== _callRecGen || !_callActive) return null;
            if (!res.ok) return null;
            const data = await res.json();
            if (myGen !== _callRecGen || !_callActive) return null;

            // ── Whisper language remapping ─────────────────────────────────
            // Whisper misclassifies Telugu as Tamil ('ta') / Kannada ('kn') /
            // Malayalam ('ml') — South Indian scripts look similar to its model.
            // Urdu ('ur') → Hindi ('hi'): same spoken register, different script.
            const LANG_REMAP = { ta: 'te', kn: 'te', ml: 'te', ur: 'hi' };
            let whisperLang = data.language || null;
            if (whisperLang && LANG_REMAP[whisperLang]) {
                console.log(`[AI Call] Whisper remap: ${whisperLang} → ${LANG_REMAP[whisperLang]}`);
                whisperLang = LANG_REMAP[whisperLang];
            }

            // Store Whisper's result for reference in _processUserSpeech.
            // CRITICAL: Only write non-English results to _callDetectedLang here.
            // If Whisper says 'en', DO NOT override — Whisper frequently returns
            // 'en' for short/quiet Telugu/Hindi phrases (especially on first turns
            // before langHint kicks in). Text-scoring in _processUserSpeech will
            // be the tiebreaker. Applying 'en' from Whisper prematurely would make
            // detectLangWithFallback() use 'en' as its fallback and confirm the
            // wrong language.
            _callWhisperLang = whisperLang || 'en';
            if (whisperLang && whisperLang !== 'en') {
                _callDetectedLang = whisperLang;  // positive non-English signal → apply immediately
            }
            console.log(`[AI Call] STT whisper=${_callWhisperLang} detected=${_callDetectedLang} text="${(data.text||'').substring(0,60)}"`);
            return (data.text || '').trim();
        } catch (e) {
            console.error('[AI Call] Transcribe error:', e);
            return null;
        }
    }

    // ── Start listening for user speech ───────────────────────────────
    function _startListening() {
        if (!_callActive || _callMuted || _callState !== 'listening') return;

        // Mic not yet ready — retry shortly (mic request is async)
        if (!_callMicStream) {
            setTimeout(() => {
                if (_callActive && !_callMuted && _callState === 'listening') _startListening();
            }, 250);
            return;
        }

        _stopRecorder();  // increments _callRecGen, kills any previous session

        const ctx = _callAudioCtx;
        if (!ctx || ctx.state === 'closed') return;

        // ── VAD setup ───────────────────────────────────────────────────
        try {
            _callVADSource   = ctx.createMediaStreamSource(_callMicStream);
            _callVADAnalyser = ctx.createAnalyser();
            _callVADAnalyser.fftSize = 512;
            _callVADSource.connect(_callVADAnalyser);
        } catch (e) {
            console.error('[AI Call] VAD setup error:', e);
            setTimeout(() => { if (_callActive && !_callMuted && _callState === 'listening') _startListening(); }, 500);
            return;
        }
        const vadBuf = new Uint8Array(_callVADAnalyser.frequencyBinCount);

        // ── MediaRecorder ───────────────────────────────────────────────
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';

        // Capture generation and chunk array in closure — immune to _stopRecorder resets
        const myGen    = _callRecGen;
        const myChunks = [];
        let   speechSeen = false;
        let   silenceCnt = 0;
        let   frameCnt   = 0;

        let recorder;
        try {
            recorder = new MediaRecorder(_callMicStream, { mimeType });
        } catch (e) {
            console.error('[AI Call] MediaRecorder create error:', e);
            setTimeout(() => { if (_callActive && !_callMuted && _callState === 'listening') _startListening(); }, 500);
            return;
        }
        _callMediaRecorder = recorder;

        recorder.ondataavailable = e => { if (e.data && e.data.size > 0) myChunks.push(e.data); };

        recorder.onstop = async () => {
            // Self-cancel if a newer session started or call ended
            if (myGen !== _callRecGen || !_callActive) return;

            if (!speechSeen || myChunks.length === 0) {
                // Silence window with no speech — restart immediately, no dead time
                if (_callActive && !_callMuted && _callState === 'listening') _startListening();
                return;
            }

            // Send to Whisper
            const text = await _transcribeWhisper(myChunks, mimeType, myGen);

            // Check generation again after async Whisper call
            if (myGen !== _callRecGen || !_callActive) return;

            if (text) {
                _processUserSpeech(text);
            } else {
                // Empty/failed transcription — restart without breaking the call
                if (_callActive && !_callMuted && _callState === 'listening') _startListening();
            }
        };

        try {
            recorder.start(200); // 200ms timeslices for low-latency data delivery
        } catch (e) {
            console.error('[AI Call] recorder.start error:', e);
            setTimeout(() => { if (_callActive && !_callMuted && _callState === 'listening') _startListening(); }, 500);
            return;
        }

        // ── VAD rAF loop ─────────────────────────────────────────────────
        const SPEECH_THRESHOLD = 15;  // 0–255 energy level
        const SILENCE_FRAMES   = 18;  // ~0.60s at 30fps — was 25 (833ms), reduced for faster cutoff
        const MAX_RECORD_SEC   = 900; // 30s safety cap (frameCnt at ~30fps)

        const vadLoop = () => {
            // Bail instantly if session is stale or state left 'listening'
            if (myGen !== _callRecGen || !_callActive || _callState !== 'listening') return;

            frameCnt++;
            _callVADAnalyser.getByteFrequencyData(vadBuf);
            const energy = vadBuf.reduce((s, v) => s + v, 0) / vadBuf.length;

            if (energy > SPEECH_THRESHOLD) {
                speechSeen = true;
                silenceCnt = 0;
            } else if (speechSeen) {
                silenceCnt++;
                if (silenceCnt >= SILENCE_FRAMES) {
                    _callVADFrame = null;
                    if (recorder.state === 'recording') recorder.stop();
                    return; // onstop will handle restart
                }
            } else if (frameCnt >= MAX_RECORD_SEC) {
                // Long silence with no speech — restart fresh
                _callVADFrame = null;
                if (recorder.state === 'recording') recorder.stop();
                return;
            }
            _callVADFrame = requestAnimationFrame(vadLoop);
        };
        _callVADFrame = requestAnimationFrame(vadLoop);
    }

    // ── TTS audio queue — pre-fetches next sentence while current plays ──
    // Each entry: { audioBuffer: AudioBuffer | null, text: string }
    // The queue drains automatically; if next buffer arrives before current
    // finishes, there is zero gap between sentences.
    let _ttsQueue       = [];
    let _ttsQueueSeq    = 0;   // invalidates queue on interruption
    let _ttsPlaying     = false;
    // Set true the moment getResponseStreaming resolves — tells onended
    // that no more sentences are coming so it can safely transition back
    // to listening even if slot.isLast was never set (race condition fix).
    let _callStreamDone = false;

    function _ttsQueueReset() {
        _ttsQueueSeq++;
        _ttsQueue        = [];
        _ttsPlaying      = false;
        _callStreamDone  = false;
    }

    // Pre-fetch TTS audio for a sentence, language-aware (voice + speed).
    async function _ttsFetch(sentence, myQueueSeq) {
        try {
            const res = await fetch('/api/tts', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    text:     sentence.substring(0, 500),
                    language: _callDetectedLang   // ← voice/speed selected per language
                })
            });
            if (myQueueSeq !== _ttsQueueSeq || !_callActive) return;
            if (!res.ok) throw new Error(`TTS ${res.status}`);
            const arrayBuf = await res.arrayBuffer();
            if (myQueueSeq !== _ttsQueueSeq || !_callActive) return;
            const ctx = _callAudioCtx;
            if (!ctx || ctx.state === 'closed') return;
            await ctx.resume();
            const audioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
            if (myQueueSeq !== _ttsQueueSeq || !_callActive) return;
            // Find the slot in the queue for this sentence and fill it
            const slot = _ttsQueue.find(s => s.text === sentence && s.audioBuffer === null);
            if (slot) { slot.audioBuffer = audioBuffer; slot.ready = true; }
            // Kick off playback if nothing is currently playing
            _ttsDrainQueue(myQueueSeq);
        } catch (e) {
            if (myQueueSeq !== _ttsQueueSeq) return;
            console.warn('[AI Call] TTS fetch error:', e.message);
            // Mark slot as errored so we skip it and continue queue
            const slot = _ttsQueue.find(s => s.text === sentence && s.audioBuffer === null);
            if (slot) { slot.error = true; }
            _ttsDrainQueue(myQueueSeq);
        }
    }

    // Drain: play the next ready buffer in order. Called after each sentence
    // finishes and when a new buffer arrives.
    function _ttsDrainQueue(myQueueSeq) {
        if (myQueueSeq !== _ttsQueueSeq || !_callActive || _ttsPlaying) return;
        if (_ttsQueue.length === 0) return;

        const slot = _ttsQueue[0];
        if (!slot.ready && !slot.error) return; // still fetching

        _ttsQueue.shift();

        if (slot.error || !slot.audioBuffer) {
            // Skip errored slot, try next
            _ttsDrainQueue(myQueueSeq);
            return;
        }

        _ttsPlaying = true;
        const ctx = _callAudioCtx;

        // Safety: resume context if browser suspended it (tab switch, etc.)
        // Do NOT await here — we're in a sync drain function. Fire-and-forget
        // resume is fine; AudioContext buffers internally.
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});

        const src = ctx.createBufferSource();
        src.buffer = slot.audioBuffer;
        src.connect(ctx.destination);
        _callAudioSrc = src;
        console.log(`[AI Call] TTS playing sentence (${Math.round(slot.audioBuffer.duration*10)/10}s): "${slot.text.substring(0,40)}…"`);

        src.onended = () => {
            if (_callAudioSrc === src) _callAudioSrc = null;
            _ttsPlaying = false;
            if (myQueueSeq !== _ttsQueueSeq || !_callActive) return;

            if (_ttsQueue.length > 0) {
                // Natural inter-sentence pause: 120ms feels human, 0ms feels robotic
                setTimeout(() => _ttsDrainQueue(myQueueSeq), 120);
            } else if (slot.isLast || _callStreamDone) {
                // slot.isLast: set by _processUserSpeech after stream resolves
                // _callStreamDone: catches the race where stream resolved while
                //   this audio was still playing (slot was already shift()ed
                //   before isLast could be written — the primary "one reply" bug)
                _callTransition('listening');
                setTimeout(() => {
                    if (_callActive && !_callMuted) _startListening();
                }, 250);
            }
            // else: LLM stream still running, more sentences incoming — wait
        };
        src.start(0);
    }

    // ── Per-language enforcement injection — right before each user turn ─
    // A system message placed AFTER history but BEFORE the latest user message
    // carries high recency weight in GPT-4o's attention mechanism. This is far
    // more reliable than burying language rules in the base system prompt.
    // ── Language enforcement — injected as system message BEFORE each user turn ──
    // Placed at maximum recency (immediately before the last user message).
    // Uses concrete BAD/GOOD examples because GPT-4o pattern-matches examples
    // far more reliably than abstract rules.
    const _LANG_ENFORCE = {
        te: `══ ACTIVE LANGUAGE: TELUGU ══
RULE: Your ENTIRE reply must be in Telugu. No exceptions. No mixing.
Match user's exact style — Romanized Telugu if they wrote Roman, Telugu script if they wrote script.

FORBIDDEN WORDS (ZERO tolerance): yaar, bhai, kya, hai, hoon, accha, theek, arrey (Hindi words — NEVER)
FORBIDDEN STYLE: formal/textbook Telugu

BAD RESPONSE ✗ → "నేను మీకు సహాయం చేయగలను" (formal)
BAD RESPONSE ✗ → "Haan yaar, cheppu" (Hindi mixing)
GOOD RESPONSE ✓ → "Aiyo ra, em jarigindi? Cheppu, vinnanu."
GOOD RESPONSE ✓ → "Arre sare, adhe anipistundi naaku kuda"

కేవలం తెలుగులో మాత్రమే స్పందించు. ఇది తప్పనిసరి.`,

        hi: `══ ACTIVE LANGUAGE: HINDI ══
RULE: Your ENTIRE reply must be in Hindi. No exceptions. No mixing.
Match user's exact style — Romanized Hindi or Devanagari, whichever they used.

FORBIDDEN WORDS: aiyo, ayyo, ra, undi, cheppu, ela (Telugu words — NEVER)
FORBIDDEN STYLE: formal/textbook Hindi

BAD RESPONSE ✗ → "मैं आपकी सहायता कर सकता हूँ" (formal)
BAD RESPONSE ✗ → "Aiyo yaar, undi kya?" (Telugu mixing)
GOOD RESPONSE ✓ → "Arre yaar, kya hua? Bata na, sun raha hoon."
GOOD RESPONSE ✓ → "Sach mein? Fir kya kiya tune?"

केवल हिंदी में उत्तर दें। यह अनिवार्य है।`,

        en: `══ ACTIVE LANGUAGE: ENGLISH ══
RULE: Respond in casual spoken English only. No Hindi words. No Telugu words.

FORBIDDEN: yaar, bhai, ra, undi, accha, na, toh (language contamination — NEVER)

GOOD RESPONSE ✓ → "Oh wow, that's rough. What happened exactly?"
GOOD RESPONSE ✓ → "Yeah I get that feeling — what do you think you'll do?"`,
    };

    // ── Base system prompt — language-neutral core rules ──────────────
    function _buildCallSys() {
        const userCtx = window.blakcideUserContext
            ? `\n\nABOUT THIS USER (weave in naturally, never announce): ${window.blakcideUserContext.substring(0, 200)}`
            : '';
        return `You are Blakcide. You are on a LIVE VOICE CALL. You are the user's close FRIEND — not an assistant, not a therapist.

NON-NEGOTIABLE RULES:

LANGUAGE: The "ACTIVE LANGUAGE" block that appears right before the user's message is your ONLY language instruction. Follow it exactly. It overrides everything else including this prompt.

LENGTH: 1 sentence maximum. 2 sentences only when emotional depth requires it. Phone call = short. Long replies = broken experience.

FORMAT: Zero markdown. Zero asterisks. Zero bullet points. Zero headers. Pure spoken words only.

OPENER: Always start with a natural human reaction — NEVER "I understand" / "I see" / "Certainly" / "That's interesting":
  English → "Oh—" / "Wait—" / "Yeah" / "Aw man" / "Really?" / "That's rough"
  Telugu  → "Aiyo" / "Arre ra" / "Sare" / "Nijamga?" / "Oh nice ra" / "Ayyo paapam"
  Hindi   → "Arre yaar" / "Sach mein?" / "Haan haan" / "Oye" / "Kya hua bata"

NEVER: Start with "I". Say "As an AI". Sound like a customer service bot.

MEMORY: Remember everything said in this conversation. Do NOT lose context when language switches.

GOOD vs BAD:
  BAD  "I understand that you are feeling stressed about your exam situation."
  GOOD "Exam stress ra? Cheppu — em jarigindi exactly?"

  BAD  "मैं आपकी भावनाओं को समझता हूँ और आपकी सहायता करना चाहता हूँ।"
  GOOD "Arre yaar tough hai — kya hua bata?"

  BAD  "That sounds like a challenging situation for you to navigate."
  GOOD "That's rough. What happened?"${userCtx}`;
    }

    // ── Handle transcribed text → AI response (streaming pipeline) ───
    async function _processUserSpeech(text) {
        if (!_callActive) return;
        // Hard guard: if we're already thinking or speaking, a second invocation
        // means a stale onstop fired — discard it. Two parallel LLM streams
        // would race and corrupt _callHistory.
        if (_callState === 'thinking' || _callState === 'speaking') {
            console.warn('[AI Call] _processUserSpeech called in wrong state:', _callState, '— discarding');
            return;
        }
        _stopRecorder();
        _callTransition('thinking');
        console.log(`[AI Call] Processing speech: lang=${_callDetectedLang} text="${text.substring(0,80)}"`);

        _addCallMsg('user', text);

        // ── STRICT PRIORITY LANGUAGE DETECTION (per-turn) ──────────────────
        //
        // Priority order (hard rules, no exceptions):
        //   P1. Unicode script in text  → ABSOLUTE (Telugu ≠ Tamil, Hindi ≠ Urdu)
        //   P2. Keyword match in text   → HIGH CONFIDENCE
        //   P3. Whisper non-English     → MEDIUM (already remapped ta→te, ur→hi)
        //   P4. Whisper English         → LOW (only trusted with 4+ English words)
        //   P5. Previous language       → FALLBACK (never reset on ambiguous input)
        //
        // The fallback fix in detectLang ensures ambiguous short text returns
        // the previous language rather than defaulting to 'en'.

        const textLang  = window.BlakcideAI?.detectLangWithFallback(text, _callDetectedLang) || 'en';
        const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

        if (textLang !== 'en') {
            // P1/P2: Unicode script or keyword match — ALWAYS trust this
            _callDetectedLang = textLang;
            console.log(`[AI Call] Lang from text scoring: ${textLang}`);

        } else if (_callWhisperLang !== 'en') {
            // P3: Text has no keywords/script but Whisper says non-English
            // (e.g. native-script input that keyword scoring didn't recognise)
            _callDetectedLang = _callWhisperLang;
            console.log(`[AI Call] Lang from Whisper (non-English): ${_callWhisperLang}`);

        } else if (_callWhisperLang === 'en' && wordCount >= 4) {
            // P4: Both text and Whisper say English AND text is long enough
            // (4+ words) to be a genuine English switch, not just "ha okay"
            _callDetectedLang = 'en';
            console.log(`[AI Call] Lang switched to English (${wordCount} words, Whisper confirmed)`);

        } else {
            // P5: Ambiguous — keep previous language
            // Covers: short phrases, "ha", "sare", "okay", single syllables
            console.log(`[AI Call] Lang unchanged (ambiguous): keeping ${_callDetectedLang} (text="${text.substring(0,30)}")`);
        }

        // Track all languages used this call (for journal metadata)
        _callLangsUsed.add(_callDetectedLang);

        // Update streak for native-script hint logic in _transcribeWhisper
        if (_callDetectedLang === _callLangStreakVal) {
            _callLangStreak++;
        } else {
            _callLangStreak    = 1;
            _callLangStreakVal  = _callDetectedLang;
        }

        _callHistory.push({ role: 'user', content: text });
        if (_callHistory.length > 20) _callHistory = _callHistory.slice(-20);

        const lang    = _callDetectedLang;
        const callSys = _buildCallSys();
        const enforce = _LANG_ENFORCE[lang] || _LANG_ENFORCE.en;

        // ── Inject language enforcement as system message before user turn ─
        // Layout: [callSys] + [prior history] + [enforcement] + [last user msg]
        const lastMsg  = _callHistory[_callHistory.length - 1];
        const priorHist = _callHistory.slice(0, -1);
        const messages = [
            { role: 'system', content: callSys },
            ...priorHist,
            { role: 'system', content: enforce }, // ← high-recency enforcement
            lastMsg,
        ];

        // ── Streaming pipeline ─────────────────────────────────────────
        _ttsQueueReset();      // also resets _callStreamDone = false
        const myQueueSeq = _ttsQueueSeq;
        let   fullReply  = '';
        let   firstSent  = false;

        const onSentence = (sentence, fullSoFar) => {
            if (myQueueSeq !== _ttsQueueSeq || !_callActive) return;
            const clean = sentence.replace('[SUGGEST_HUMAN_CONNECT]', '').trim();
            if (!clean) return;

            if (!firstSent) {
                firstSent = true;
                console.log(`[AI Call] LLM first sentence → TTS queue starts. lang=${_callDetectedLang}`);
                _callTransition('speaking');
                _addCallMsg('ai', ''); // placeholder, updated live below
            }
            fullReply = fullSoFar.replace('[SUGGEST_HUMAN_CONNECT]', '').trim();

            // Live-update transcript text as sentences arrive
            const tel = document.getElementById('ai-call-transcript');
            if (tel) {
                const last   = tel.querySelectorAll('.ai-call-msg');
                const textEl = last[last.length - 1]?.querySelector('.ai-call-msg-text-ai');
                if (textEl) textEl.textContent = fullReply;
            }

            if (_callSpeaker) {
                const slot = { text: clean, audioBuffer: null, ready: false, error: false, isLast: false };
                _ttsQueue.push(slot);
                _ttsFetch(clean, myQueueSeq);  // pre-fetch audio immediately
            }
        };

        try {
            const reply = await Promise.race([
                window.BlakcideAI.getResponseStreaming(messages, { onSentence }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))
            ]);

            if (!_callActive) return;

            const clean = (reply || '').replace('[SUGGEST_HUMAN_CONNECT]', '').trim();
            _callHistory.push({ role: 'assistant', content: clean });

            // Signal that the LLM stream is fully done — onended now knows it
            // can transition to listening when the last audio finishes.
            // Must be set BEFORE the queue-length check so onended sees it.
            _callStreamDone = true;

            if (_ttsQueue.length > 0) {
                // Audio for these slots hasn't played yet — mark last for transition
                _ttsQueue[_ttsQueue.length - 1].isLast = true;
            } else if (_callSpeaker && !_ttsPlaying && _callState === 'speaking') {
                // All audio already finished before stream resolved (fastest path)
                _callTransition('listening');
                setTimeout(() => { if (_callActive && !_callMuted) _startListening(); }, 250);
            } else if (!_callSpeaker) {
                // Speaker off — never enters TTS path at all, go directly to listening
                _callTransition('listening');
                setTimeout(() => { if (_callActive && !_callMuted) _startListening(); }, 300);
            }
            // else: last audio still playing — onended will fire with _callStreamDone=true

            if (!firstSent) {
                const fb = lang === 'hi' ? 'एक बार फिर से बोलो यार।'
                         : lang === 'te' ? 'ఒక్కసారి మళ్ళీ చెప్పు రా.'
                         : "Say that again?";
                _callHistory.push({ role: 'assistant', content: fb });
                _callSpeakSimple(fb);
            }

        } catch (err) {
            if (!_callActive) return;
            console.warn('[AI Call] AI error:', err.message);
            const fb = lang === 'hi' ? 'एक बार फिर से बोलो यार, कुछ गड़बड़ हो गई।'
                     : lang === 'te' ? 'ఒక్కసారి మళ్ళీ చెప్పు రా, చిన్న సమస్య వచ్చింది.'
                     : "Sorry, say that again?";
            _callHistory.push({ role: 'assistant', content: fb });
            _callSpeakSimple(fb);
        }
    }

    // ── Simple single-shot TTS (for greetings and error messages) ────
    async function _callSpeakSimple(text) {
        if (!_callActive) return;
        _callTransition('speaking');
        _addCallMsg('ai', text);

        // _stopTTSAudio() increments _speakSeq internally (to invalidate any
        // previous in-flight fetch), so capture mySeq AFTER calling it.
        _stopTTSAudio();           // kills current audio + increments _speakSeq
        const mySeq = _speakSeq;  // capture the NEW value as our ownership token

        if (!_callSpeaker) {
            setTimeout(() => {
                if (_callActive && mySeq === _speakSeq) { _callTransition('listening'); _startListening(); }
            }, 300);
            return;
        }

        const onFinished = () => {
            if (!_callActive || mySeq !== _speakSeq) return;
            _callTransition('listening');
            setTimeout(() => {
                if (_callActive && !_callMuted && mySeq === _speakSeq) _startListening();
            }, 250);
        };

        try {
            const res = await fetch('/api/tts', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ text: text.substring(0, 500), voice: 'nova' })
            });
            if (!_callActive || mySeq !== _speakSeq) return;
            if (!res.ok) throw new Error(`TTS ${res.status}`);

            const arrayBuffer = await res.arrayBuffer();
            if (!_callActive || mySeq !== _speakSeq) return;

            const ctx = _callAudioCtx;
            if (!ctx || ctx.state === 'closed') throw new Error('No AudioContext');

            await ctx.resume();
            if (!_callActive || mySeq !== _speakSeq) return;

            const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
            if (!_callActive || mySeq !== _speakSeq) return;

            const src = ctx.createBufferSource();
            src.buffer = audioBuffer;
            src.connect(ctx.destination);
            _callAudioSrc = src;
            src.onended = () => { if (_callAudioSrc === src) _callAudioSrc = null; onFinished(); };
            src.start(0);
            return;

        } catch (e) {
            if (!_callActive || mySeq !== _speakSeq) return;
            console.warn('[AI Call] TTS failed, falling back:', e.message);
        }
        _fallbackBrowserTTS(text, mySeq, onFinished);
    }

    function _fallbackBrowserTTS(text, mySeq, onFinished) {
        if (!_callSynth || !_callActive || mySeq !== _speakSeq) { onFinished(); return; }
        const voices = _callSynth.getVoices();
        const voice  = voices.find(v => v.lang === 'en-IN' && v.name.toLowerCase().includes('google'))
                    || voices.find(v => v.lang === 'en-IN')
                    || voices.find(v => v.lang.startsWith('en'))
                    || voices[0];
        const utt = new SpeechSynthesisUtterance(text);
        utt.lang  = 'en-IN'; utt.rate = 0.94;
        if (voice) utt.voice = voice;
        const wd = setTimeout(() => { _callSynth.cancel(); onFinished(); }, Math.max(text.length * 80, 3500));
        utt.onend   = () => { clearTimeout(wd); onFinished(); };
        utt.onerror = ev => { clearTimeout(wd); if (ev.error !== 'interrupted' && ev.error !== 'cancelled') onFinished(); };
        _callSynth.speak(utt);
    }

    // ── Start call ────────────────────────────────────────────────────
    window.startAICall = function () {
        if (_callActive) return;
        _callActive        = true;
        _callSecs          = 0;
        _callStartTime     = new Date();
        _callLangsUsed     = new Set(['en']);
        _callHistory       = [];
        _callDetectedLang  = 'en';
        _callWhisperLang   = 'en';
        _callLangStreak    = 0;
        _callLangStreakVal  = 'en';
        _callState         = 'idle';
        _callMuted        = false;
        _callSpeaker      = true;
        _speakSeq         = 0;
        _callRecGen       = 0;
        _ttsQueue         = [];
        _ttsQueueSeq      = 0;
        _ttsPlaying       = false;
        clearTimeout(_callWatchdog);
        _stopTTSAudio();

        // 1. Unlock AudioContext SYNCHRONOUSLY inside the gesture handler.
        //    Must happen before any await — iOS/Chrome require user gesture.
        try {
            if (!_callAudioCtx || _callAudioCtx.state === 'closed') {
                _callAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            _callAudioCtx.resume();
        } catch (e) { console.warn('[AI Call] AudioContext init:', e); }

        // 2. Request mic ALSO inside the gesture handler (no await before this).
        //    Store the Promise — we handle its result asynchronously below.
        const micPromise = navigator.mediaDevices
            .getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
                video: false
            })
            .catch(e => { console.error('[AI Call] Mic denied:', e); return null; });

        // 3. Setup UI
        const ov = document.getElementById('ai-call-overlay');
        if (!ov) { _callActive = false; return; }
        ov.style.display = 'flex';
        const transcriptEl = document.getElementById('ai-call-transcript');
        if (transcriptEl) transcriptEl.innerHTML = '';
        _setCallStatus('Connecting…');
        document.getElementById('ai-call-timer').innerText = '0:00';
        document.getElementById('ai-call-mute-btn').innerHTML  = '<ion-icon name="mic-outline"></ion-icon>';
        document.getElementById('ai-call-mute-btn').classList.remove('btn-muted');
        document.getElementById('ai-call-speaker-btn').innerHTML = '<ion-icon name="volume-high-outline"></ion-icon>';
        document.getElementById('ai-call-speaker-btn').classList.remove('btn-muted');

        _callTimerInt = setInterval(() => {
            _callSecs++;
            const m = Math.floor(_callSecs / 60), s = _callSecs % 60;
            document.getElementById('ai-call-timer').innerText = `${m}:${String(s).padStart(2, '0')}`;
        }, 1000);

        // 4. Store mic stream when ready (runs in parallel with greeting)
        micPromise.then(stream => {
            _callMicStream = stream;
            if (!stream) console.warn('[AI Call] No mic stream — TTS-only mode');
            // If greeting already finished and we're waiting for listening to start, kick it off now
            if (_callActive && _callState === 'listening' && stream) _startListening();
        });

        // 5. Greeting — plays immediately; mic loads in parallel
        const name = window.blakcideUserContext?.match(/User's name:\s*([^.]+)/)?.[1]?.trim();
        const greeting = name
            ? `Hey ${name}! Good to hear from you. What's going on?`
            : "Hey! Good to hear from you. What's on your mind?";
        setTimeout(() => _callSpeakSimple(greeting), 400);
    };

    // ── End call ──────────────────────────────────────────────────────
    window.endAICall = function () {
        _callActive = false;
        clearTimeout(_callWatchdog);
        _callTransition('idle');
        clearInterval(_callTimerInt);
        _stopTTSAudio();
        _releaseMic();
        if (_callAudioCtx) {
            try { _callAudioCtx.close(); } catch (_) {}
            _callAudioCtx = null;
        }
        const ov = document.getElementById('ai-call-overlay');
        if (ov) ov.style.display = 'none';
        if (_callHistory && _callHistory.length >= 2 && currentUser) {
            const snap        = [..._callHistory];
            const userId      = currentUser.id;
            const durationSec = _callSecs;
            const langsUsed   = [..._callLangsUsed];
            console.log(`[AI Call] Saving call: ${snap.length} messages, ${durationSec}s, langs=${langsUsed}`);
            (async () => {
                await saveCallAsThread(snap, userId, durationSec, langsUsed);
                await saveCallAsJournal(snap, userId, durationSec, langsUsed);
            })();
        }
        _callHistory   = [];
        _callLangsUsed = new Set();
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

    window.toggleAICallMute = function () {
        _callMuted = !_callMuted;
        const btn = document.getElementById('ai-call-mute-btn');
        if (btn) {
            btn.innerHTML = `<ion-icon name="${_callMuted ? 'mic-off-outline' : 'mic-outline'}"></ion-icon>`;
            btn.classList.toggle('btn-muted', _callMuted);
        }
        if (_callMuted) {
            _stopRecorder();
        } else {
            // Resume listening only if we're not speaking or thinking
            if (_callState !== 'thinking' && _callState !== 'speaking') {
                _callTransition('listening');
                _startListening();
            }
        }
    };

    window.toggleAICallSpeaker = function () {
        _callSpeaker = !_callSpeaker;
        const btn = document.getElementById('ai-call-speaker-btn');
        if (btn) {
            btn.innerHTML = `<ion-icon name="${_callSpeaker ? 'volume-high-outline' : 'volume-mute-outline'}"></ion-icon>`;
            btn.classList.toggle('btn-muted', !_callSpeaker);
        }
        if (!_callSpeaker) _stopTTSAudio();
    };

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