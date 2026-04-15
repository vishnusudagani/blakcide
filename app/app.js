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
            const table = contextTarget.type === 'folder' ? 'folders' : 'chats';
            await supabase.from(table).update({[contextTarget.type==='folder'?'name':'title']: newName}).eq('id', contextTarget.id);
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
                div.className = `history-item ${chat.id === currentChatId ? 'active' : ''}`;
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
                div.innerHTML = `<span>${chat.title}</span> <button class="item-options-btn"><ion-icon name="ellipsis-horizontal"></ion-icon></button>`;
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

    // ── Auto-save AI chat as journal entry ───────────────
    async function autoSaveChatAsJournal(chatId, userId) {
        if (!chatId || !userId) return;
        try {
            // Skip if already journaled
            const { data: chat } = await supabase.from('chats').select('auto_journaled').eq('id', chatId).maybeSingle();
            if (chat?.auto_journaled) return;

            const { data: msgs } = await supabase.from('messages').select('role, content').eq('chat_id', chatId).order('created_at');
            if (!msgs || msgs.length < 2) return; // Need at least one exchange

            // Collect image descriptions from IMAGE:: messages
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

            await supabase.from('journals').insert([{ user_id: userId, title, content, ai_source: 'ai_chat' }]);
            await supabase.from('chats').update({ auto_journaled: true }).eq('id', chatId);
            showChatToast('💾 Chat saved to your journal');

            // Update rolling user memory so AI has context in future sessions
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
            contentHtml = contentHtml.replace(/\n/g, '<br>');
        }

        feed.innerHTML += `<div class="message ${role==='user'?'user-msg':'ai-msg'}"><div class="msg-content">${contentHtml}</div></div>`;
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

                // Finalise bubble — remove cursor
                const loadingEl = document.getElementById(loadingId);
                if (loadingEl) loadingEl.remove();
                if (currentChatId === thisChatId) {
                    renderMessage(aiResp, 'ai');
                }

                // Push AI reply to in-memory history
                chatMessageHistory.push({ role: 'assistant', content: aiResp });

                // Save AI reply to DB (awaited so it definitely persists)
                await supabase.from('messages').insert({chat_id: thisChatId, role:'ai', content: aiResp});

                // Auto-generate a meaningful title for new chats after the first exchange
                if (isNewChat) generateAutoTitle(thisChatId, text);

            } catch (error) {
                console.error("Chat Error:", error);
                showToast("Connection issue. Please try again.");
                document.querySelectorAll('.msg-content').forEach(el => {
                    if(el.innerText === 'Thinking...') el.parentElement.remove();
                });
            }
        });
    }

    // Generates a 3-5 word AI title for a new chat and updates the DB + sidebar
    async function generateAutoTitle(chatId, firstMessage) {
        try {
            const titlePrompt = [
                { role: 'system', content: 'You are a title generator. Reply with ONLY a 3-5 word title — no punctuation, no quotes, nothing else.' },
                { role: 'user', content: `Title for a conversation starting with: "${firstMessage.substring(0, 200)}"` }
            ];
            const aiTitle = await window.BlakcideAI.getResponse(titlePrompt, null); // no streaming for title
            const cleanTitle = aiTitle.replace(/["']/g, '').replace(/^#+\s*/, '').trim();
            if (cleanTitle && cleanTitle.length > 1 && cleanTitle.length < 60 && !cleanTitle.includes('{')) {
                await supabase.from('chats').update({ title: cleanTitle }).eq('id', chatId);
                if (currentChatId === chatId) getEl('mobile-chat-title').innerText = cleanTitle;
                loadSidebar();
            }
        } catch(e) { /* silently skip — truncated title still shows */ }
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
                document.getElementById(loadingId)?.remove();
                if (currentChatId === thisChatId) renderMessage(aiResp, 'ai');
                chatMessageHistory.push({ role: 'assistant', content: aiResp });
                await supabase.from('messages').insert({ chat_id: thisChatId, role: 'ai', content: aiResp });

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
    // 11. AI VOICE CALL FEATURE
    // ==========================================
    let _callActive   = false;
    let _callMuted    = false;
    let _callSpeaker  = true;
    let _callTimerInt = null;
    let _callSecs     = 0;
    let _callSpeechRec = null;
    let _callSynth    = window.speechSynthesis;
    let _callHistory  = [];

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
                setTimeout(() => av.classList.remove('ai-speaking'), Math.min(text.length * 60, 5000));
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════════════════════
    // AI CALL ENGINE  —  state machine · auto-lang · watchdog TTS
    // Recognition: always en-IN (captures Indian English + Romanized Telugu/Hindi)
    // Language: auto-detected from each transcript → AI replies in detected lang
    // ══════════════════════════════════════════════════════════════════════════
    let _callDetectedLang = 'en';  // updated per turn from transcript
    let _callState        = 'idle';
    let _ttsWatchdog      = null;
    let _speakSeq         = 0;

    function _callTransition(state) {
        _callState = state;
        const labels = { idle:'', listening:'Listening…', thinking:'Thinking…', speaking:'Speaking…' };
        _setCallStatus(labels[state] || '');
        const av = document.getElementById('ai-call-avatar-el');
        if (av) av.classList.toggle('ai-speaking', state === 'speaking');
    }

    // Pick the best available TTS voice for a given locale, with fallback chain
    function _pickVoice(primaryLocale) {
        if (!_callSynth) return null;
        const voices = _callSynth.getVoices();
        if (!voices.length) return null;
        const base = primaryLocale.split('-')[0];
        // Exact locale first, then same language family, then any voice
        return voices.find(v => v.lang === primaryLocale)
            || voices.find(v => v.lang.startsWith(base))
            || voices[0];
    }

    function _stopRecognition() {
        if (_callSpeechRec) {
            try { _callSpeechRec.abort(); } catch(_) {}
            _callSpeechRec = null;
        }
    }

    function _startRecognition() {
        if (!_callActive || _callMuted || _callState !== 'listening') return;
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { _setCallStatus('Voice not supported in this browser'); return; }
        _stopRecognition();
        try {
            const rec = new SR();
            // en-IN is the best single locale for Indian speech:
            // captures Indian-accented English, Romanized Telugu, and Romanized Hindi accurately.
            rec.lang            = 'en-IN';
            rec.continuous      = false;
            rec.interimResults  = false;
            rec.maxAlternatives = 1;

            rec.onresult = (e) => {
                const text = e.results?.[0]?.[0]?.transcript?.trim();
                if (text) _processUserSpeech(text);
            };
            rec.onerror = (e) => {
                if (!_callActive || e.error === 'aborted') return;
                const delay = e.error === 'no-speech' ? 100 : 800;
                setTimeout(() => {
                    if (_callActive && !_callMuted && _callState === 'listening') _startRecognition();
                }, delay);
            };
            rec.onend = () => {
                if (_callActive && !_callMuted && _callState === 'listening') {
                    setTimeout(() => {
                        if (_callActive && !_callMuted && _callState === 'listening') _startRecognition();
                    }, 150);
                }
            };
            rec.start();
            _callSpeechRec = rec;
        } catch(err) {
            console.error('SR start error:', err);
            setTimeout(() => {
                if (_callActive && !_callMuted && _callState === 'listening') _startRecognition();
            }, 1000);
        }
    }

    async function _processUserSpeech(text) {
        if (!_callActive || _callState !== 'listening') return;
        _stopRecognition();
        _callTransition('thinking');
        _addCallMsg('user', text);

        // Auto-detect language from the transcript
        _callDetectedLang = window.BlakcideAI?.detectLang(text) || 'en';

        _callHistory.push({ role: 'user', content: text });
        if (_callHistory.length > 16) _callHistory = _callHistory.slice(-16);

        // Call system prompt — locked to the detected language for this turn
        const langName = { en: 'English', hi: 'Hindi', te: 'Telugu' }[_callDetectedLang] || 'English';
        const callSys  = `You are Blakcide on a voice call with a friend.
RULES (non-negotiable):
1. Reply in ${langName} ONLY — every single word. Absolutely no mixing of other languages.
2. Maximum 1–2 short sentences. This is spoken conversation, not a text chat.
3. No markdown, no symbols, no lists. Plain natural spoken words only.
4. Be warm, real, like a close friend.${_callDetectedLang === 'te' ? '\n5. Use Romanized Telugu matching exactly how the user typed/spoke.' : ''}${_callDetectedLang === 'hi' ? '\n5. Use Romanized Hindi matching exactly how the user typed/spoke.' : ''}`;

        try {
            const reply = await Promise.race([
                window.BlakcideAI.getResponse(
                    [{ role: 'system', content: callSys }, ..._callHistory],
                    null  // no simulate-stream on call — need full text for TTS immediately
                ),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))
            ]);
            if (!_callActive) return;
            _callHistory.push({ role: 'assistant', content: reply });
            _callSpeak(reply);
        } catch(err) {
            console.warn('Call AI error:', err.message);
            if (!_callActive) return;
            const fb = _callDetectedLang === 'hi' ? 'Dobara bolo yaar, kuch gadbad ho gayi.'
                     : _callDetectedLang === 'te' ? 'Okasari repeat cheyyandi, chinna problem vachhindi.'
                     : "Sorry, something slipped. Say that again?";
            _callHistory.push({ role: 'assistant', content: fb });
            _callSpeak(fb);
        }
    }

    // ── TTS — sentence-chunked with watchdog (fixes Chrome onend stall bug) ───
    function _callSpeak(text) {
        if (!_callActive) return;
        _callTransition('speaking');
        _addCallMsg('ai', text);

        _speakSeq++;
        const mySeq = _speakSeq;

        if (!_callSpeaker || !_callSynth) {
            setTimeout(() => {
                if (_callActive && mySeq === _speakSeq) {
                    _callTransition('listening'); _startRecognition();
                }
            }, 500);
            return;
        }

        clearTimeout(_ttsWatchdog);
        _callSynth.cancel();

        // Detect language of the AI reply to set the right TTS locale
        const replyLang   = window.BlakcideAI?.detectLang(text) || 'en';
        const ttsLocale   = replyLang === 'hi' ? 'hi-IN' : replyLang === 'te' ? 'te-IN' : 'en-IN';
        const voice       = _pickVoice(ttsLocale);

        // Split into sentence chunks for natural cadence
        const rawChunks = text
            .replace(/([.!?।]+)\s+/g, '$1\n')
            .split('\n')
            .map(s => s.trim())
            .filter(s => s.length > 0);
        const chunks = rawChunks.length ? rawChunks : [text];
        let idx = 0;

        const next = () => {
            if (!_callActive || mySeq !== _speakSeq) return;
            clearTimeout(_ttsWatchdog);

            if (idx >= chunks.length) {
                _callTransition('listening');
                setTimeout(() => {
                    if (_callActive && !_callMuted && mySeq === _speakSeq) _startRecognition();
                }, 280);
                return;
            }

            const chunk = chunks[idx++];
            const utt   = new SpeechSynthesisUtterance(chunk);
            utt.lang    = ttsLocale;
            utt.rate    = 0.92 + Math.random() * 0.05;
            utt.pitch   = 1.0;
            utt.volume  = 1.0;
            if (voice) utt.voice = voice;

            // Watchdog: force-advance if Chrome never fires onend
            const ms = Math.max(chunk.length * 75, 2000) + 1500;
            _ttsWatchdog = setTimeout(() => {
                if (mySeq !== _speakSeq) return;
                _callSynth.cancel();
                setTimeout(next, 120);
            }, ms);

            utt.onend = () => {
                if (mySeq !== _speakSeq) return;
                clearTimeout(_ttsWatchdog);
                setTimeout(next, /[.!?।]$/.test(chunk) ? 150 : 40);
            };
            utt.onerror = (ev) => {
                if (mySeq !== _speakSeq) return;
                clearTimeout(_ttsWatchdog);
                if (ev.error === 'interrupted' || ev.error === 'cancelled') return;
                setTimeout(next, 80);
            };

            _callSynth.speak(utt);
        };

        setTimeout(next, 110); // brief gap after cancel() — Chrome needs this
    }

    window.startAICall = function () {
        if (_callActive) return;
        _callActive     = true;
        _callSecs       = 0;
        _callHistory    = [];
        _callActiveLang = 'en';
        _callState      = 'idle';
        _callMuted      = false;
        _callSpeaker    = true;
        _speakSeq       = 0;
        clearTimeout(_ttsWatchdog);

        // Highlight EN button by default
        document.querySelectorAll('.call-lang-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.lang === 'en'));

        const ov = document.getElementById('ai-call-overlay');
        if (!ov) return;
        ov.style.display = 'flex';

        const transcriptEl = document.getElementById('ai-call-transcript');
        if (transcriptEl) transcriptEl.innerHTML = '';

        _setCallStatus('Connecting…');
        document.getElementById('ai-call-timer').innerText = '0:00';
        document.getElementById('ai-call-mute-btn').innerHTML = '<ion-icon name="mic-outline"></ion-icon>';
        document.getElementById('ai-call-mute-btn').classList.remove('btn-muted');
        document.getElementById('ai-call-speaker-btn').innerHTML = '<ion-icon name="volume-high-outline"></ion-icon>';
        document.getElementById('ai-call-speaker-btn').classList.remove('btn-muted');

        _callTimerInt = setInterval(() => {
            _callSecs++;
            const m = Math.floor(_callSecs / 60), s = _callSecs % 60;
            document.getElementById('ai-call-timer').innerText = `${m}:${String(s).padStart(2,'0')}`;
        }, 1000);

        setTimeout(() => _callSpeak("Hey yaar, good to hear from you. What's going on?"), 700);
    };

    window.endAICall = function () {
        _callActive = false;
        _callTransition('idle');
        clearInterval(_callTimerInt);
        clearTimeout(_ttsWatchdog);
        if (_callSynth) _callSynth.cancel();
        _stopRecognition();
        const ov = document.getElementById('ai-call-overlay');
        if (ov) ov.style.display = 'none';
        if (_callHistory && _callHistory.length >= 3 && currentUser) {
            saveCallAsJournal([..._callHistory], currentUser.id);
        }
        _callHistory = [];
    };

    async function saveCallAsJournal(callHistory, userId) {
        try {
            const res = await fetch('/api/summarize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: callHistory, type: 'call' })
            });
            if (!res.ok) return;
            const { title, content } = await res.json();
            if (!title || !content) return;
            await supabase.from('journals').insert([{ user_id: userId, title, content, ai_source: 'ai_call' }]);
            showChatToast('📞 Call saved to your journal');
        } catch(_) {}
    }

    window.toggleAICallMute = function () {
        _callMuted = !_callMuted;
        const btn = document.getElementById('ai-call-mute-btn');
        if (btn) {
            btn.innerHTML = `<ion-icon name="${_callMuted ? 'mic-off-outline' : 'mic-outline'}"></ion-icon>`;
            btn.classList.toggle('btn-muted', _callMuted);
        }
        if (_callMuted) {
            _stopRecognition();
        } else {
            // Resume listening only if we're not speaking or thinking
            if (_callState !== 'thinking' && _callState !== 'speaking') {
                _callTransition('listening');
                _startRecognition();
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
        if (!_callSpeaker && _callSynth) _callSynth.cancel();
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