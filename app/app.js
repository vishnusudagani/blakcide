document.addEventListener('DOMContentLoaded', () => {

    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    let supabase;
    if (typeof window.supabase !== 'undefined') {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
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

    let currentUser = null;
    let currentChatId = null;
    let openFolders = new Set();
    let isSidebarLoading = false;
    let currentView = 'main';

    const getPinKey = () => 'blakcide_pin_' + currentUser.id;
    const getVaultKey = () => 'blakcide_vault_' + currentUser.id;
    const getArchiveKey = () => 'blakcide_archive_' + currentUser.id;

    const getVaultData = () => JSON.parse(localStorage.getItem(getVaultKey()) || '{"chats":[],"folders":[]}');
    const getArchiveData = () => JSON.parse(localStorage.getItem(getArchiveKey()) || '{"chats":[],"folders":[]}');
    const setVaultData = (d) => localStorage.setItem(getVaultKey(), JSON.stringify(d));
    const setArchiveData = (d) => localStorage.setItem(getArchiveKey(), JSON.stringify(d));

    const getEl = (id) => document.getElementById(id);
    const click = (id, fn) => { const el = getEl(id); if(el) el.addEventListener('click', fn); };
    function showToast(msg) {
        const t = document.createElement('div'); t.className='toast'; t.innerText=msg;
        getEl('toast-container').appendChild(t); setTimeout(()=>t.remove(), 3000);
    }

    async function enforceSession() {
        if(!supabase) return;
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) { window.location.href = '../index.html'; } 
        else { currentUser = session.user; initializeApp(); }
    }

    function initializeApp() {
        fetchProfile();
        startNewChat(null, false); 
        loadSidebar();
    }

    click('home-btn', () => { window.location.href = '../index.html?noredirect=true'; });
    click('logout-btn', async (e) => { e.stopPropagation(); await supabase.auth.signOut(); window.location.href = '../index.html'; });
    click('toggle-sidebar-btn', () => getEl('main-sidebar').classList.toggle('collapsed'));
    click('mobile-menu-btn', () => getEl('main-sidebar').classList.add('open'));
    click('mobile-overlay', () => getEl('main-sidebar').classList.remove('open'));

    let contextTarget = null;
    const ctxMenu = getEl('context-menu');

    function openContextMenu(e, id, type) {
        e.preventDefault(); e.stopPropagation();
        contextTarget = { id, type };
        ctxMenu.style.left = `${e.pageX}px`;
        ctxMenu.style.top = `${e.pageY}px`;
        ctxMenu.classList.add('active');
        
        getEl('cm-vault').innerHTML = currentView === 'vault' ? '<ion-icon name="lock-open"></ion-icon> Remove from Vault' : '<ion-icon name="lock-closed"></ion-icon> Send to Vault';
        getEl('cm-archive').innerHTML = currentView === 'archive' ? '<ion-icon name="arrow-undo"></ion-icon> Unarchive' : '<ion-icon name="archive"></ion-icon> Archive';
    }

    window.addEventListener('click', () => { ctxMenu.classList.remove('active'); });

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
        updateViewUI(); loadSidebar(); getEl('main-sidebar').classList.remove('open');
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
            getEl('pin-modal').classList.add('active');
            getEl('pin-input').focus();
        }
    });

    click('pin-cancel', () => getEl('pin-modal').classList.remove('active'));
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
        getEl('pin-modal').classList.remove('active');
        currentView = 'vault'; 
        document.body.classList.add('dark-mode'); 
        startNewChat(null, false); 
        updateViewUI(); loadSidebar();
        getEl('main-sidebar').classList.remove('open');
    }

    function updateViewUI() {
        getEl('archive-view-btn').classList.toggle('active', currentView === 'archive');
        getEl('vault-btn').classList.toggle('active', currentView === 'vault');
        
        const vaultIcon = getEl('vault-btn').querySelector('ion-icon');
        vaultIcon.setAttribute('name', currentView === 'vault' ? 'lock-open-outline' : 'lock-closed-outline');

        const titleEl = getEl('view-title');
        if(currentView === 'main') titleEl.style.display = 'none';
        else {
            titleEl.style.display = 'block';
            titleEl.innerText = currentView === 'vault' ? "The Vault" : "Archives";
        }
    }

    click('open-change-pin-btn', () => {
        getEl('profile-modal').classList.remove('active');
        getEl('old-pin-input').value = '';
        getEl('new-pin-input').value = '';
        getEl('change-pin-modal').classList.add('active');
    });
    click('change-pin-cancel', () => {
        getEl('change-pin-modal').classList.remove('active');
        getEl('profile-modal').classList.add('active');
    });
    click('change-pin-confirm', () => {
        const oldPin = getEl('old-pin-input').value;
        const newPin = getEl('new-pin-input').value;
        const currentPin = localStorage.getItem(getPinKey());
        if (currentPin && oldPin !== currentPin) return showToast("Old PIN is incorrect");
        if (newPin.length !== 4) return showToast("New PIN must be 4 digits");
        localStorage.setItem(getPinKey(), newPin);
        showToast("Vault Passcode Updated!");
        getEl('change-pin-modal').classList.remove('active');
    });

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

    async function loadSidebar() {
        if (isSidebarLoading) return;
        isSidebarLoading = true;

        const list = getEl('history-list'); list.innerHTML = '';
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

        isSidebarLoading = false;
    }

    async function loadThread(id, title) {
        currentChatId = id; 
        getEl('chat-feed').innerHTML = ''; 
        getEl('mobile-chat-title').innerText = title || "Chat"; 
        loadSidebar(); 
        getEl('main-sidebar').classList.remove('open'); 
        
        const { data } = await supabase.from('messages').select('*').eq('chat_id', id).order('created_at');
        if(data) data.forEach(m => renderMessage(m.content, m.role));
    }
    
    function startNewChat(fid = null, triggerSidebar = true) {
        currentChatId = null; 
        getEl('chat-feed').innerHTML = ''; 
        getEl('mobile-chat-title').innerText = "New Chat";
        
        if(fid) openFolders.add(fid); 
        if(triggerSidebar) loadSidebar();
        getEl('chat-form').dataset.pendingFolder = fid || '';
        getEl('main-sidebar').classList.remove('open');
    }

    function renderMessage(text, role) {
        const feed = getEl('chat-feed');
        let contentHtml = text;

        if (text.startsWith('AUDIO::')) {
            const url = text.split('AUDIO::')[1];
            contentHtml = `<audio controls src="${url}" class="chat-audio-player"></audio>`;
        } else {
            contentHtml = contentHtml.replace(/\n/g, '<br>');
        }

        feed.innerHTML += `<div class="message ${role==='user'?'user-msg':'ai-msg'}"><div class="msg-content">${contentHtml}</div></div>`;
        feed.scrollTop = feed.scrollHeight;
    }

    getEl('chat-form').addEventListener('submit', async (e) => {
        e.preventDefault(); 
        const inp = getEl('chat-input'); const text = inp.value; if(!text) return;
        inp.value = ''; 
        renderMessage(text, 'user');
        
        if(!currentChatId) {
            const fid = getEl('chat-form').dataset.pendingFolder;
            const payload = {user_id: currentUser.id, title: text.slice(0,20) + "..."};
            if(fid) payload.folder_id = fid;
            const { data } = await supabase.from('chats').insert([payload]).select().single();
            currentChatId = data.id; 
            if(currentView === 'vault') { let v = getVaultData(); v.chats.push(data.id); setVaultData(v); }
            if(currentView === 'archive') { let a = getArchiveData(); a.chats.push(data.id); setArchiveData(a); }
            getEl('mobile-chat-title').innerText = payload.title; 
            loadSidebar();
        }
        await supabase.from('messages').insert({chat_id: currentChatId, role:'user', content:text});
        
        const loadingId = "loading-" + Date.now();
        const feed = getEl('chat-feed');
        feed.innerHTML += `<div id="${loadingId}" class="message ai-msg"><div class="msg-content">Thinking...</div></div>`;
        feed.scrollTop = feed.scrollHeight;

        const { data: history } = await supabase.from('messages')
            .select('role, content')
            .eq('chat_id', currentChatId)
            .order('created_at', { ascending: true });

        const chatHistory = history.map(msg => ({
            role: msg.role === 'ai' ? 'assistant' : 'user',
            content: msg.content.startsWith('AUDIO::') ? '[User sent a voice note]' : msg.content
        }));

        const aiResp = await window.BlakcideAI.getResponse(chatHistory);
        
        document.getElementById(loadingId).remove();
        renderMessage(aiResp, 'ai');
        await supabase.from('messages').insert({chat_id: currentChatId, role:'ai', content: aiResp});
    });

    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;
    const voiceBtn = getEl('voice-btn');
    const chatInput = getEl('chat-input');

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

                    document.getElementById(tempId).remove();

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

    async function sendAudioMessageAndProcessAI(url, transcribedText) {
        if(!currentChatId) {
            const fid = getEl('chat-form').dataset.pendingFolder;
            const payload = {user_id: currentUser.id, title: "Voice Note..."};
            if(fid) payload.folder_id = fid;
            const { data } = await supabase.from('chats').insert([payload]).select().single();
            currentChatId = data.id; 
            
            if(currentView === 'vault') { let v = getVaultData(); v.chats.push(data.id); setVaultData(v); }
            if(currentView === 'archive') { let a = getArchiveData(); a.chats.push(data.id); setArchiveData(a); }
            
            getEl('mobile-chat-title').innerText = payload.title; 
            loadSidebar();
        }

        const audioMarker = `AUDIO::${url}`;
        renderMessage(audioMarker, 'user');
        await supabase.from('messages').insert({chat_id: currentChatId, role:'user', content: audioMarker});
        
        const loadingId = "loading-" + Date.now();
        const feed = getEl('chat-feed');
        feed.innerHTML += `<div id="${loadingId}" class="message ai-msg"><div class="msg-content">Thinking...</div></div>`;
        feed.scrollTop = feed.scrollHeight;

        const { data: history } = await supabase.from('messages')
            .select('role, content')
            .eq('chat_id', currentChatId)
            .order('created_at', { ascending: true });

        const chatHistory = history.map(msg => ({
            role: msg.role === 'ai' ? 'assistant' : 'user',
            content: msg.content.startsWith('AUDIO::') ? '[User sent a voice note]' : msg.content
        }));

        chatHistory[chatHistory.length - 1].content = `[Voice Note Transcribed]: "${transcribedText}"`;

        const aiResp = await window.BlakcideAI.getResponse(chatHistory);

        document.getElementById(loadingId).remove();
        renderMessage(aiResp, 'ai');
        await supabase.from('messages').insert({chat_id: currentChatId, role:'ai', content:aiResp});
    }

    const modal = getEl('input-modal'); const mInp = getEl('modal-input'); let mCb = null;
    function openModal(t, v, cb) { getEl('modal-title').innerText=t; mInp.value=v; modal.classList.add('active'); mInp.focus(); mCb=cb; }
    click('modal-confirm', ()=>{ if(mCb)mCb(mInp.value); modal.classList.remove('active'); });
    click('modal-cancel', ()=>{ modal.classList.remove('active'); });

    click('new-folder-btn', ()=>openModal('New Folder', '', async(n)=>{
        if(n){
            const { data } = await supabase.from('folders').insert([{user_id:currentUser.id, name:n}]).select().single();
            if(currentView === 'vault') { let v = getVaultData(); v.folders.push(data.id); setVaultData(v); }
            if(currentView === 'archive') { let a = getArchiveData(); a.folders.push(data.id); setArchiveData(a); }
            loadSidebar(); getEl('main-sidebar').classList.remove('open');
        }
    }));
    
    click('new-chat-btn', ()=>startNewChat(null, true));
    
    click('open-profile-btn', ()=>{
        getEl('profile-modal').classList.add('active');
        getEl('main-sidebar').classList.remove('open');
    });
    click('close-profile-btn', ()=>getEl('profile-modal').classList.remove('active'));

    getEl('avatar-upload').addEventListener('change', async (e) => {
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

    async function fetchProfile() {
        if(!currentUser) return;
        const { data } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
        if(data) {
            if(data.avatar_url) { 
                getEl('sidebar-avatar').src=data.avatar_url; 
                getEl('sidebar-avatar').style.display='flex'; 
                getEl('sidebar-avatar-placeholder').style.display='none'; 
                getEl('profile-preview').src=data.avatar_url; 
                getEl('profile-preview').style.display='block'; 
                getEl('profile-placeholder').style.display='none';
            }
            if(data.full_name) getEl('user-name-display').innerText=data.full_name;
            getEl('profile-name').value = data.full_name || '';
            getEl('profile-bio').value = data.bio || '';
        }
    }
    
    getEl('profile-form').addEventListener('submit', async(e)=>{
        e.preventDefault();
        const updates = { id: currentUser.id, full_name: getEl('profile-name').value, bio: getEl('profile-bio').value };
        await supabase.from('profiles').upsert(updates); 
        showToast("Profile Saved!"); 
        fetchProfile(); 
        getEl('profile-modal').classList.remove('active');
    });

    enforceSession();
});