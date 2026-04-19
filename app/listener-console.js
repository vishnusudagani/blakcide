document.addEventListener('DOMContentLoaded', () => {
    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    let supabase;
    if (typeof window.supabase !== 'undefined') {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    } else { return console.error("Supabase failed to load."); }

    let currentUser = null;
    let currentListenerProfile = null;
    let activeSessionId = null;
    let isEnding = false; 
    let currentUIState = 'dashboard';

    let queueChannel = null;
    let sessionChannel = null;
    let chatChannel = null;
    let rtcChannel = null;
    let queuePollInterval = null;
    let sessionPollInterval = null;
    let messagePollInterval = null;

    let renderedMessageIds = new Set();
    let peerConnection = null;
    let localStream = null;

    // Feature 5: call-duration tracking
    let callStartTime = null;
    let callTimerInterval = null;

    // Feature 2: voice-masking audio context
    let audioContext = null;
    let pitchShiftedStream = null;

    const statusToggleBtn = document.getElementById('status-toggle-btn');
    const statusBtnText = document.getElementById('status-btn-text');
    const statusText = document.getElementById('status-indicator-text');
    const profileModal = document.getElementById('profile-modal');

    async function init() {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error || !session) return window.location.replace('../index.html');
        currentUser = session.user;

        const { data: listenerData } = await supabase.from('listeners').select('*').eq('user_id', currentUser.id).maybeSingle();
        if (!listenerData) {
            document.body.innerHTML = '<h2 style="text-align:center; padding: 50px;">Access Denied.</h2>';
            return;
        }
        currentListenerProfile = listenerData;

        const { data: existingSessions } = await supabase.from('connect_sessions')
            .select('*').eq('listener_id', currentListenerProfile.id).in('status', ['active'])
            .order('created_at', { ascending: false }).limit(1);

        const existingSession = existingSessions && existingSessions.length > 0 ? existingSessions[0] : null;

        if (existingSession) {
            activeSessionId = existingSession.id;
            updateStatusUI(); 
            setupSessionWatcher(existingSession.id);
            existingSession.session_type === 'call' ? startVoiceCallInterface() : startLiveChatInterface();
            window.showCopilot();
        } else {
            if (!currentListenerProfile.display_name || currentListenerProfile.display_name.trim() === '') {
                await supabase.from('listeners').update({ is_online: false }).eq('id', currentListenerProfile.id);
                currentListenerProfile.is_online = false;
                window.openProfile(true); 
            } 
            updateStatusUI();
            loadHistory();
        }
    }

    async function loadHistory() {
        const { data: history } = await supabase.from('connect_sessions')
            .select('*').eq('listener_id', currentListenerProfile.id).eq('status', 'completed').order('created_at', { ascending: false }).limit(5);
        
        if (!history || history.length === 0) return;
        
        let hHTML = `<h3 style="font-size: 0.9rem; margin: 20px 0 10px 0; border-top: 1px solid var(--glass-border); padding-top: 15px;">Recent Sessions</h3><div style="display:flex; flex-direction:column; gap:8px;">`;
        history.forEach(s => {
            const date = new Date(s.created_at).toLocaleDateString();
            hHTML += `<div onclick="window.viewPastSession('${s.id}')" style="font-size:0.75rem; background:var(--glass-inner); padding:8px; border-radius:8px; cursor: pointer; transition: 0.2s;">Session (${s.session_type})<br><span style="opacity:0.6">${date}</span></div>`;
        });
        hHTML += `</div>`;
        
        const nav = document.querySelector('nav');
        if(nav) nav.insertAdjacentHTML('beforeend', hHTML);
    }

    function updateStatusUI() {
        if (!currentListenerProfile) return;

        if (currentListenerProfile.is_online) {
            statusToggleBtn.style.background = '#4CAF50'; 
            statusBtnText.innerText = 'Go Offline';
            statusText.innerText = "Live on Marketplace";
            statusText.style.color = "#4CAF50";
            
            startListeningForCalls();
            if (queuePollInterval) clearInterval(queuePollInterval);
            queuePollInterval = setInterval(pollForRequests, 3000);

        } else {
            statusToggleBtn.style.background = '#555'; 
            statusBtnText.innerText = 'Go Online';
            statusText.innerText = "Currently Offline";
            statusText.style.color = "var(--accent-red)";
            
            if (queueChannel) supabase.removeChannel(queueChannel);
            if (queuePollInterval) clearInterval(queuePollInterval);

            document.getElementById('call-queue').innerHTML = '<div class="queue-empty"><ion-icon name="call-outline"></ion-icon><p>Go online to receive call requests</p></div>';
            document.getElementById('chat-queue').innerHTML = '<div class="queue-empty"><ion-icon name="chatbubbles-outline"></ion-icon><p>Go online to receive chat requests</p></div>';
        }
    }

    window.toggleStatus = async function() {
        if (!currentListenerProfile) return;
        if (!currentListenerProfile.display_name || currentListenerProfile.display_name.trim() === '') {
            window.openProfile(true);
            return;
        }
        const isNowOnline = !currentListenerProfile.is_online; 
        statusToggleBtn.disabled = true; statusToggleBtn.style.opacity = '0.5';
        await supabase.from('listeners').update({ is_online: isNowOnline }).eq('id', currentListenerProfile.id);
        currentListenerProfile.is_online = isNowOnline;
        updateStatusUI();
        statusToggleBtn.disabled = false; statusToggleBtn.style.opacity = '1';
    };

    window.previewImage = function(event) {
        const file = event.target.files[0];
        if (file) document.getElementById('prof-pic-preview').src = URL.createObjectURL(file);
    };

    window.openProfile = function(forceLock = false) { 
        if (!currentListenerProfile) return;
        document.getElementById('prof-pic-preview').src = currentListenerProfile.profile_pic || 'https://i.pravatar.cc/150';
        document.getElementById('prof-name').value = currentListenerProfile.display_name || '';
        document.getElementById('prof-bio').value = currentListenerProfile.bio || '';
        document.getElementById('prof-lang').value = currentListenerProfile.languages ? currentListenerProfile.languages.join(', ') : '';
        document.getElementById('prof-chat-price').value = currentListenerProfile.chat_price_per_min || 10;
        document.getElementById('prof-call-price').value = currentListenerProfile.call_price_per_min || 25;
        
        if (forceLock || !currentListenerProfile.display_name) {
            document.getElementById('profile-modal-title').innerText = "Action Required: Complete Profile";
            document.getElementById('cancel-profile-btn').style.display = 'none';
        } else {
            document.getElementById('profile-modal-title').innerText = "Edit Profile";
            document.getElementById('cancel-profile-btn').style.display = 'block';
        }
        profileModal.style.display = 'flex';
    };

    window.closeProfile = () => profileModal.style.display = 'none';

    window.saveProfile = async function() { 
        const name = document.getElementById('prof-name').value.trim();
        const bio = document.getElementById('prof-bio').value.trim();
        const langsRaw = document.getElementById('prof-lang').value.trim();
        if (!name || !langsRaw) return alert("Display Name and Languages are required.");
        
        const btn = document.getElementById('save-profile-btn');
        let finalPicUrl = currentListenerProfile.profile_pic || '';
        btn.disabled = true; btn.innerText = "Saving...";

        const picInput = document.getElementById('prof-pic-upload');
        if (picInput && picInput.files.length > 0) {
            const file = picInput.files[0];
            const fileExt = file.name.split('.').pop();
            const fileName = `${currentListenerProfile.id}-${Date.now()}.${fileExt}`;
            const { error: uploadError } = await supabase.storage.from('avatars').upload(fileName, file);
            if (!uploadError) {
                const { data } = supabase.storage.from('avatars').getPublicUrl(fileName);
                finalPicUrl = data.publicUrl;
            }
        }

        const payload = {
            display_name: name, bio: bio,
            languages: langsRaw.split(',').map(s => s.trim()),
            chat_price_per_min: document.getElementById('prof-chat-price').value || 10,
            call_price_per_min: document.getElementById('prof-call-price').value || 25,
            profile_pic: finalPicUrl, is_online: true 
        };

        await supabase.from('listeners').update(payload).eq('id', currentListenerProfile.id);
        currentListenerProfile = { ...currentListenerProfile, ...payload };
        profileModal.style.display = 'none';
        btn.innerText = "Save Profile"; btn.disabled = false;
        updateStatusUI(); 
    };

    window.logoutUser = async function() {
        if (currentListenerProfile) await supabase.from('listeners').update({ is_online: false }).eq('id', currentListenerProfile.id);
        await supabase.auth.signOut();
        window.location.replace('../index.html');
    };

    function startListeningForCalls() {
        if (queueChannel) supabase.removeChannel(queueChannel); 
        queueChannel = supabase.channel('listener_queue').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'connect_sessions' }, 
            (payload) => {
                if (payload.new.listener_id === currentListenerProfile.id && payload.new.status === 'pending') renderIncomingRequest(payload.new);
            }).subscribe();
    }

    async function pollForRequests() {
        if (!currentListenerProfile || !currentListenerProfile.is_online) return;
        const { data: pendingReqs } = await supabase.from('connect_sessions').select('*').eq('listener_id', currentListenerProfile.id).eq('status', 'pending');
        if (pendingReqs && pendingReqs.length > 0) {
            pendingReqs.forEach(req => { if (!document.getElementById(`req-${req.id}`)) renderIncomingRequest(req); });
        }
    }

    async function renderIncomingRequest(req) {
        if (document.getElementById(`req-${req.id}`)) return; 
        const isCall = req.session_type === 'call';
        const targetQueue = document.getElementById(isCall ? 'call-queue' : 'chat-queue');
        if(targetQueue.innerHTML.includes('No active') || targetQueue.innerHTML.includes('Offline') || targetQueue.innerHTML.includes('Waiting')) targetQueue.innerHTML = ''; 

        let callerName = "Anonymous User";
        if (!req.is_anonymous) {
            const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', req.user_id).maybeSingle();
            if (profile) callerName = profile.full_name || "Unknown User";
        }

        const safeName = callerName.replace(/'/g, "\\'");
        targetQueue.innerHTML += `
            <div id="req-${req.id}" class="req-card" style="animation:msgIn 0.3s ease both;">
                <div class="req-card-top">
                    <div class="req-avatar"><ion-icon name="person-outline"></ion-icon></div>
                    <div class="req-info">
                        <div class="req-name">${callerName}</div>
                    </div>
                    <span class="req-type-chip ${isCall ? 'call' : 'chat'}">${isCall ? '📞 Call' : '💬 Chat'}</span>
                </div>
                <div class="req-card-actions">
                    <button class="req-accept-btn" onclick="window.acceptRequest('${req.id}', '${safeName}', '${req.session_type}')">
                        <ion-icon name="checkmark-outline"></ion-icon> Accept
                    </button>
                    <button class="req-decline-btn" onclick="window.rejectRequest('${req.id}')" title="Decline">
                        <ion-icon name="close-outline"></ion-icon>
                    </button>
                </div>
            </div>
        `;
    }

    async function syncSessionStatus() {
        if (!activeSessionId || isEnding) return;
        const { data: sess } = await supabase.from('connect_sessions').select('*').eq('id', activeSessionId).maybeSingle();
        if (!sess) return;

        if (sess.status === 'completed') return handleSessionEnd();
        if (sess.status === 'rejected') {
            alert("Connection cancelled.");
            window.location.reload();
        }

        if (sess.status === 'active') {
            if (sess.session_type === 'call' && currentUIState !== 'call') {
                document.getElementById('caller-demographics').innerText = 'Voice Call Active';
                startVoiceCallInterface();
            } else if (sess.session_type === 'chat' && currentUIState !== 'chat') {
                document.getElementById('caller-demographics').innerText = 'Secure Chat Active';
                stopWebRTC();
                startLiveChatInterface();
            }
        }
    }

    window.setupSessionWatcher = function(sessionId) {
        if (sessionChannel) supabase.removeChannel(sessionChannel);
        
        sessionChannel = supabase.channel('session_watch_' + sessionId)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'connect_sessions', filter: `id=eq.${sessionId}` }, (payload) => {
                syncSessionStatus();
            }).subscribe();

        if (sessionPollInterval) clearInterval(sessionPollInterval);
        sessionPollInterval = setInterval(syncSessionStatus, 1500); 
    }

    window.acceptRequest = async function(sessionId, callerName, type) {
        const { error } = await supabase.from('connect_sessions').update({ status: 'active' }).eq('id', sessionId);
        if (error) return alert("Error accepting connection: " + error.message);

        activeSessionId = sessionId;
        const reqEl = document.getElementById(`req-${sessionId}`);
        if(reqEl) reqEl.remove(); 
        
        document.getElementById('caller-name').innerText = callerName;
        document.getElementById('caller-demographics').innerText = type === 'call' ? 'Voice Call Active' : 'Secure Chat Active';
        
        type === 'call' ? startVoiceCallInterface() : startLiveChatInterface();
        setupSessionWatcher(sessionId);
        window.showCopilot(); // Feature 4: show AI copilot FAB once session is live
    };

    window.acceptMidChatCall = async function() {
        if(!activeSessionId) return;
        await supabase.from('connect_sessions').update({ session_type: 'call' }).eq('id', activeSessionId);
        syncSessionStatus();
    };

    function cleanCentralPanel() {
        let centralPanel = document.getElementById('live-chat-feed')?.parentElement;
        if (!centralPanel) {
            const noSessionEl = Array.from(document.querySelectorAll('*')).find(el => el.textContent.includes('No Active Session'));
            if (noSessionEl) centralPanel = noSessionEl.closest('.glass-pane') || noSessionEl.parentElement;
        }
        return centralPanel;
    }

    async function startLiveChatInterface() {
        currentUIState = 'chat';
        if (rtcChannel) supabase.removeChannel(rtcChannel); 

        const feedContainer = cleanCentralPanel();
        if (!feedContainer) return;

        feedContainer.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--glass-border); padding-bottom: 15px; margin-bottom: 15px;">
                <h3 style="margin:0;"><ion-icon name="chatbubbles"></ion-icon> Chat Session</h3>
                <div style="display: flex; gap: 5px;">
                    <button onclick="window.endSession('${activeSessionId}')" class="btn-solid" style="background: var(--accent-red); padding: 5px 15px; font-size: 0.8rem;">End Session</button>
                </div>
            </div>
            <div id="live-chat-feed" style="flex: 1; padding: 20px 5px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; height: 50vh;">
                <div style="text-align:center; opacity:0.5; width:100%; margin-bottom:15px;">Connection established. You can now chat.</div>
            </div>
            <div style="padding-top: 15px; border-top: 1px solid var(--glass-border); display: flex; gap: 10px;">
                <input type="text" id="chat-reply-input" class="minimal-input" placeholder="Type your reply..." style="flex: 1; border-radius: 20px; padding: 10px 15px; background: var(--glass-inner);" onkeypress="if(event.key === 'Enter') window.sendReply()">
                <button onclick="window.sendReply()" id="send-reply-btn" class="brand-small-btn" style="border-radius: 50%; width: 45px; height: 45px; cursor: pointer; display:flex; justify-content:center; align-items:center;"><ion-icon name="send"></ion-icon></button>
            </div>
        `;

        const { data: pastMessages } = await supabase.from('messages').select('*').eq('session_id', activeSessionId).order('created_at', { ascending: true });
        if (pastMessages) pastMessages.forEach(msg => renderChatMessage(msg));

        if (chatChannel) supabase.removeChannel(chatChannel);
        chatChannel = supabase.channel('chat_' + activeSessionId)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `session_id=eq.${activeSessionId}` }, (payload) => {
                renderChatMessage(payload.new);
            }).subscribe();
            
        if (messagePollInterval) clearInterval(messagePollInterval);
        // Match the user side (1.5s) so listener doesn't lag on inbound messages.
        messagePollInterval = setInterval(syncMessages, 1500);
    }

    let lastSyncedAt = null;
    async function syncMessages() {
        if (!activeSessionId) return;   // poll even in call view so chat stays fresh
        let q = supabase.from('messages').select('*').eq('session_id', activeSessionId).order('created_at', { ascending: true });
        if (lastSyncedAt) q = q.gt('created_at', lastSyncedAt);
        const { data: msgs } = await q;
        if (msgs && msgs.length) {
            msgs.forEach(msg => renderChatMessage(msg));
            lastSyncedAt = msgs[msgs.length - 1].created_at;
        }
    }

    window.sendReply = async function() {
        if (!activeSessionId) return;
        const input = document.getElementById('chat-reply-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        // Optimistic echo so listener sees own message immediately (dedup handles the DB echo)
        const tempId = 'temp-' + Date.now();
        renderChatMessage({ id: tempId, sender_id: currentUser.id, content: text, created_at: new Date().toISOString() });
        await supabase.from('messages').insert([{ session_id: activeSessionId, sender_id: currentUser.id, content: text }]);
    };

    function renderChatMessage(msg) {
        if (renderedMessageIds.has(msg.id)) return; 
        renderedMessageIds.add(msg.id);

        const feed = document.getElementById('live-chat-feed');
        if(!feed) return; 

        const isMe = msg.sender_id === currentUser.id;
        let html = '';

        if (msg.content === '###CALL_REQUEST###') {
            if (!isMe) {
                html = `<div id="msg-${msg.id}" style="text-align:center; margin: 15px 0; width: 100%;"><button onclick="window.acceptMidChatCall()" class="btn-solid" style="background:#4CAF50; padding: 10px 20px; border-radius: 20px; cursor:pointer;"><ion-icon name="call" style="margin-right:5px;"></ion-icon> Accept Voice Call Request</button></div>`;
            } else {
                html = `<div id="msg-${msg.id}" style="text-align:center; margin: 15px 0; width: 100%; opacity: 0.6; font-size: 0.85rem;">Ringing... Waiting for user to accept.</div>`;
            }
        } else {
            // Render media or plain text
            let innerHtml = '';
            if (msg.content && msg.content.startsWith('IMAGE::')) {
                const parts = msg.content.replace('IMAGE::', '').split('||DESC::');
                const imgUrl = parts[0];
                const desc   = parts[1] || '';
                innerHtml = `<div style="max-width:220px;">
                    <img src="${imgUrl}" style="width:100%;border-radius:10px;cursor:pointer;display:block;"
                         onclick="window.open('${imgUrl}','_blank')" title="${desc}">
                    ${desc ? `<div style="font-size:0.72rem;opacity:0.65;margin-top:5px;line-height:1.35;">${desc}</div>` : ''}
                </div>`;
            } else if (msg.content && msg.content.startsWith('AUDIO::')) {
                const audioUrl = msg.content.replace('AUDIO::', '');
                innerHtml = `<div style="min-width:200px;">
                    <div style="font-size:0.72rem;opacity:0.55;margin-bottom:6px;display:flex;align-items:center;gap:4px;">
                        <ion-icon name="mic-outline" style="font-size:0.85rem;"></ion-icon> Voice note
                    </div>
                    <audio src="${audioUrl}" controls preload="metadata"
                        style="width:100%;height:32px;outline:none;border-radius:8px;"></audio>
                </div>`;
            } else {
                innerHtml = msg.content || '';
            }

            html = `
                <div id="msg-${msg.id}" style="display:flex;justify-content:${isMe ? 'flex-end' : 'flex-start'};width:100%;margin-bottom:10px;">
                    <div style="background:${isMe ? 'var(--accent-red)' : 'var(--glass-inner)'};color:${isMe ? 'white' : 'var(--text-color)'};padding:10px 15px;border-radius:12px;max-width:75%;word-wrap:break-word;">
                        ${innerHtml}
                    </div>
                </div>
            `;
        }
        feed.insertAdjacentHTML('beforeend', html);
        feed.scrollTop = feed.scrollHeight; 
    }

    function startVoiceCallInterface() {
        currentUIState = 'call';
        if (messagePollInterval) clearInterval(messagePollInterval);
        if (chatChannel) supabase.removeChannel(chatChannel);

        const feedContainer = cleanCentralPanel();
        if (!feedContainer) return;

        feedContainer.innerHTML = `
            <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100%; gap: 15px; padding: 50px 0;">
                <ion-icon name="mic-circle" style="font-size: 7rem; color: #4CAF50; animation: pulse 2s infinite;"></ion-icon>
                <h2 style="margin: 0;">Voice Call Active</h2>
                <p style="opacity: 0.6; font-size: 0.9rem;" id="call-status">Connecting audio...</p>
                <audio id="remote-audio" autoplay playsinline></audio>
                <div style="display: flex; gap: 15px; margin-top: 20px;">
                    <button onclick="window.endSession('${activeSessionId}')" class="btn-solid" style="background: var(--accent-red); padding: 10px 25px; border-radius: 30px; font-weight: bold;">
                        <ion-icon name="close-circle" style="margin-right: 5px;"></ion-icon> End Session
                    </button>
                </div>
            </div>
        `;
        // Clean up any stale WebRTC state before re-initiating
        stopWebRTC();
        // LISTENER is always the ANSWERER in the unified handshake protocol
        initWebRTC(false);
    }

    // ============================================================
    // WEBRTC FIX: Unified handshake — LISTENER is the ANSWERER
    //
    // The old code used two different signalling protocols between
    // the user and listener files, so offers/answers never matched.
    //
    // Fixed protocol (same in connect-user.js and here):
    //   - User  (isOfferer=true):  subscribes → sends offer immediately
    //   - Listener (isOfferer=false): subscribes → waits for offer → answers
    // ============================================================
    // Feature 2: pitch-shift the listener's mic before it enters WebRTC.
    // We lower pitch by ~3 semitones using a scriptProcessor to obscure the
    // listener's real voice without requiring a server-side audio pipeline.
    async function applyVoiceMask(rawStream) {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioContext.createMediaStreamSource(rawStream);

            // ScriptProcessorNode: simple pitch approximation via playback rate
            // For a production app replace with a proper AudioWorklet pitch shifter
            // (e.g. github.com/cwilso/Audio-Input-Effects).
            const bufferSize = 4096;
            const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

            // Shift pitch by playing back at 0.82x rate (≈ −3 semitones)
            const pitchFactor = 0.82;
            let inputBuffer = new Float32Array(0);

            processor.onaudioprocess = (e) => {
                const input = e.inputBuffer.getChannelData(0);
                const output = e.outputBuffer.getChannelData(0);
                // Simple resampling pitch shift
                for (let i = 0; i < bufferSize; i++) {
                    const srcIdx = Math.floor(i * pitchFactor);
                    output[i] = srcIdx < input.length ? input[srcIdx] : 0;
                }
            };

            const dest = audioContext.createMediaStreamDestination();
            source.connect(processor);
            processor.connect(dest);
            pitchShiftedStream = dest.stream;
            return dest.stream;
        } catch (e) {
            console.warn('[VoiceMask] Web Audio API unavailable, using raw stream:', e.message);
            return rawStream;
        }
    }

    async function initWebRTC(isOfferer) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            document.getElementById('call-status').innerText = "Microphone error.";
            alert("Microphone required for voice call.");
            return;
        }

        // Feature 2: apply voice mask before tracks enter the peer connection
        const streamToSend = await applyVoiceMask(localStream);

        // Feature 1: fetch TURN credentials from backend (avoids rate-limited hardcoded keys)
        let iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ];
        try {
            const iceRes = await fetch('/api/ice-servers');
            if (iceRes.ok) {
                const iceData = await iceRes.json();
                if (Array.isArray(iceData.iceServers)) iceServers = iceData.iceServers;
            }
        } catch (e) {
            console.warn('[WebRTC] Could not fetch ICE servers, using defaults:', e.message);
        }

        const servers = { iceServers };
        peerConnection = new RTCPeerConnection(servers);
        streamToSend.getTracks().forEach(track => peerConnection.addTrack(track, streamToSend));

        let iceBuffer = [];

        peerConnection.ontrack = (event) => {
            const remoteAudio = document.getElementById('remote-audio');
            if (remoteAudio && remoteAudio.srcObject !== event.streams[0]) {
                remoteAudio.srcObject = event.streams[0];
                remoteAudio.play().catch(() => {});
                document.getElementById('call-status').innerText = "Connected • Secure Voice Channel";
                // Feature 5: start call timer on first audio track
                startCallTimer();
            }
        };

        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection.connectionState;
            const statusEl = document.getElementById('call-status');
            if (!statusEl) return;
            if (state === 'connected') { statusEl.innerText = "Connected • Secure Voice Channel"; startCallTimer(); }
            if (state === 'disconnected') statusEl.innerText = "Reconnecting…";
            if (state === 'failed') statusEl.innerText = "Reconnecting…"; // answerer waits for user's ICE-restart offer
        };

        if (rtcChannel) supabase.removeChannel(rtcChannel);
        rtcChannel = supabase.channel('rtc_' + activeSessionId);

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                rtcChannel.send({ type: 'broadcast', event: 'ice-candidate', payload: { candidate: event.candidate } });
            }
        };

        rtcChannel
            .on('broadcast', { event: 'offer' }, async (payload) => {
                // Only the answerer handles incoming offers
                if (isOfferer) return;
                if (peerConnection.signalingState !== 'stable') return;
                await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.payload.offer));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                rtcChannel.send({ type: 'broadcast', event: 'answer', payload: { answer } });
                iceBuffer.forEach(c => { try { peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {} });
                iceBuffer = [];
            })
            .on('broadcast', { event: 'answer' }, async (payload) => {
                if (!isOfferer) return;
                if (peerConnection.signalingState !== 'have-local-offer') return;
                await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.payload.answer));
                iceBuffer.forEach(c => { try { peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {} });
                iceBuffer = [];
            })
            .on('broadcast', { event: 'ice-candidate' }, async (payload) => {
                if (peerConnection.remoteDescription) {
                    try { await peerConnection.addIceCandidate(new RTCIceCandidate(payload.payload.candidate)); } catch(e) {}
                } else {
                    iceBuffer.push(payload.payload.candidate);
                }
            })
            .subscribe(async (status) => {
                if (status !== 'SUBSCRIBED') return;
                // Listener just waits for the user's offer — nothing to send here
            });
    }

    function stopWebRTC() {
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        if (pitchShiftedStream) pitchShiftedStream.getTracks().forEach(t => t.stop());
        if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
        if (peerConnection) peerConnection.close();
        if (rtcChannel) supabase.removeChannel(rtcChannel);
    }

    // Feature 5: call timer
    function startCallTimer() {
        if (callStartTime) return; // already running
        callStartTime = Date.now();
        const statusEl = document.getElementById('call-status');
        callTimerInterval = setInterval(() => {
            const secs = Math.floor((Date.now() - callStartTime) / 1000);
            const m = String(Math.floor(secs / 60)).padStart(2, '0');
            const s = String(secs % 60).padStart(2, '0');
            if (statusEl) statusEl.innerText = `Connected • ${m}:${s}`;
        }, 1000);
    }

    async function stopCallTimerAndSave() {
        if (!callStartTime) return;
        clearInterval(callTimerInterval);
        const minutesSpoken = (Date.now() - callStartTime) / 60000;
        callStartTime = null;
        callTimerInterval = null;
        if (!currentListenerProfile) return;
        // Increment total_minutes_spoken on the listener row
        const current = Number(currentListenerProfile.total_minutes_spoken) || 0;
        const updated = Math.round((current + minutesSpoken) * 100) / 100;
        await supabase.from('listeners').update({ total_minutes_spoken: updated }).eq('id', currentListenerProfile.id);
        currentListenerProfile.total_minutes_spoken = updated;
    }

    window.handleSessionEnd = function() {
        if (isEnding) return;
        isEnding = true;
        window.hideCopilot();
        stopWebRTC();
        document.body.innerHTML = `
            <div style="display:flex; justify-content:center; align-items:center; height:100vh; flex-direction:column; background: var(--bg-color); color: var(--text-color);">
                <ion-icon name="checkmark-circle" style="font-size:5rem; color:#4CAF50; margin-bottom: 20px;"></ion-icon>
                <h2>Session Ended</h2>
                <p style="opacity: 0.6;">Returning to dashboard...</p>
            </div>
        `;
        setTimeout(() => window.location.reload(), 2000);
    };

    window.endSession = async function(sessionId) {
        if (!sessionId) return;
        await supabase.from('connect_sessions').update({ status: 'completed' }).eq('id', sessionId);
        // Feature 5: save accumulated minutes before unloading
        await stopCallTimerAndSave();
        // Feature 3: auto-journal session (mirrors logic in connect-user.js)
        await autoJournalSession(sessionId);
        handleSessionEnd();
    };

    // Feature 3: one-per-day journal upsert from the listener's side
    async function autoJournalSession(sessionId) {
        try {
            const { data: sess } = await supabase.from('connect_sessions')
                .select('session_type, user_id').eq('id', sessionId).maybeSingle();
            if (!sess) return;
            const userId = sess.user_id;
            if (!userId) return;

            const { data: msgs } = await supabase.from('messages')
                .select('sender_id, content').eq('session_id', sessionId).order('created_at');
            if (!msgs || msgs.length < 2) return;

            const transcript = msgs
                .filter(m => m.content && !m.content.startsWith('###'))
                .map(m => ({ role: m.sender_id === userId ? 'user' : 'assistant', content: m.content }));
            if (transcript.length < 2) return;

            const res = await fetch('/api/summarize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: transcript, type: sess.session_type || 'chat', imageDescriptions: [] })
            });
            if (!res.ok) return;
            const { title, content } = await res.json();
            if (!title || !content) return;

            const aiSource = sess.session_type === 'call' ? 'ai_call' : 'ai_chat';
            const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
            const { data: existing } = await supabase.from('journals')
                .select('id, content').eq('user_id', userId).eq('ai_source', aiSource)
                .gte('created_at', todayStart.toISOString())
                .order('created_at', { ascending: true }).limit(1).maybeSingle();

            if (existing) {
                await supabase.from('journals').update({
                    title, content: existing.content + '\n\n---\n\n' + content
                }).eq('id', existing.id);
            } else {
                await supabase.from('journals').insert([{ user_id: userId, title, content, ai_source: aiSource }]);
            }
        } catch (e) { /* non-blocking */ }
    }

    window.rejectRequest = async function(sessionId) {
        await supabase.from('connect_sessions').update({ status: 'rejected' }).eq('id', sessionId);
        const reqEl = document.getElementById(`req-${sessionId}`);
        if(reqEl) reqEl.remove();
    };

    window.saveNotes = async function() {
        const notes = document.getElementById('listener-notes').value.trim();
        if (activeSessionId && notes) {
            await supabase.from('connect_sessions').update({ listener_notes: notes }).eq('id', activeSessionId);
            alert("Notes saved.");
        }
    };

    window.viewPastSession = async function(sessionId) {
        const { data: msgs } = await supabase.from('messages').select('*').eq('session_id', sessionId).order('created_at', { ascending: true });
        
        let msgHtml = msgs && msgs.length > 0 ? msgs.map(m => {
            const isMe = m.sender_id === currentUser.id;
            const content = m.content === '###CALL_REQUEST###' ? '📞 Voice Call Requested' : m.content;
            return `<div style="display: flex; justify-content: ${isMe ? 'flex-end' : 'flex-start'}; width: 100%;">
                        <div style="background: ${isMe ? 'var(--accent-red)' : 'var(--glass-inner)'}; color: ${isMe ? 'white' : 'var(--text-color)'}; padding: 10px 15px; border-radius: 12px; max-width: 75%; word-wrap: break-word;">
                            ${content}
                        </div>
                    </div>`;
        }).join('') : '<div style="text-align:center; opacity:0.5; width: 100%;">No messages in this session.</div>';

        const modalHTML = `
            <div id="history-modal" class="auth-overlay active" style="display:flex; z-index:9999; justify-content:center; align-items:center;">
                <div class="glass-pane" style="width: 90%; max-width: 500px; height: 70vh; display: flex; flex-direction: column; padding: 20px; background: var(--bg-color);">
                    <div style="display: flex; justify-content: space-between; align-items:center; border-bottom: 1px solid var(--glass-border); padding-bottom: 15px; margin-bottom: 15px;">
                        <h3 style="margin:0;"><ion-icon name="time-outline"></ion-icon> Transcript</h3>
                        <button onclick="document.getElementById('history-modal').remove()" style="background:none; border:none; color:var(--text-color); font-size:2rem; cursor:pointer; line-height: 1;">&times;</button>
                    </div>
                    <div style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;">
                        ${msgHtml}
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    };

    // ── Feature 4: AI Copilot ─────────────────────────────────────────────────
    // Inject copilot panel into the DOM and wire up streaming responses.
    function injectCopilotPanel() {
        if (document.getElementById('copilot-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'copilot-panel';
        panel.style.cssText = `
            position:fixed; bottom:80px; right:18px; width:320px; max-height:480px;
            background:var(--surface-1); border:1px solid var(--border);
            border-radius:20px; display:none; flex-direction:column;
            box-shadow:0 8px 40px rgba(0,0,0,0.4); z-index:600; overflow:hidden;
        `;
        panel.innerHTML = `
            <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--surface-2);">
                <span style="font-size:0.78rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-2);">
                    <ion-icon name="sparkles-outline" style="vertical-align:-2px;margin-right:5px;color:var(--accent);"></ion-icon>AI Copilot
                </span>
                <button onclick="document.getElementById('copilot-panel').style.display='none'"
                    style="background:none;border:none;color:var(--text-3);font-size:1.2rem;cursor:pointer;padding:0 2px;line-height:1;">&times;</button>
            </div>
            <div id="copilot-messages" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;min-height:160px;"></div>
            <div style="padding:10px 12px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end;">
                <textarea id="copilot-input" placeholder="Ask for a suggestion…"
                    style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:10px 12px;color:var(--text);font-size:0.83rem;font-family:inherit;resize:none;outline:none;line-height:1.5;max-height:80px;"
                    rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window.sendCopilotMessage();}"></textarea>
                <button onclick="window.sendCopilotMessage()"
                    style="width:38px;height:38px;border-radius:50%;background:var(--accent);border:none;color:white;font-size:1rem;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;">
                    <ion-icon name="arrow-up-outline"></ion-icon>
                </button>
            </div>
        `;
        document.body.appendChild(panel);

        // FAB to toggle the panel (shown only during active session)
        const fab = document.createElement('button');
        fab.id = 'copilot-fab';
        fab.title = 'AI Copilot';
        fab.style.cssText = `
            position:fixed; bottom:18px; right:18px; width:52px; height:52px;
            border-radius:50%; background:var(--accent); border:none; color:white;
            font-size:1.4rem; display:none; align-items:center; justify-content:center;
            cursor:pointer; box-shadow:0 4px 20px rgba(0,212,170,0.35); z-index:601;
        `;
        fab.innerHTML = '<ion-icon name="sparkles-outline"></ion-icon>';
        fab.onclick = () => {
            const p = document.getElementById('copilot-panel');
            p.style.display = p.style.display === 'flex' ? 'none' : 'flex';
        };
        document.body.appendChild(fab);
    }

    window.showCopilot = function() {
        injectCopilotPanel();
        const fab = document.getElementById('copilot-fab');
        if (fab) fab.style.display = 'flex';
    };

    window.hideCopilot = function() {
        const fab = document.getElementById('copilot-fab');
        const panel = document.getElementById('copilot-panel');
        if (fab) fab.style.display = 'none';
        if (panel) panel.style.display = 'none';
    };

    window.sendCopilotMessage = async function() {
        const input = document.getElementById('copilot-input');
        const question = input ? input.value.trim() : '';
        if (!question) return;
        input.value = '';
        input.style.height = 'auto';

        const feed = document.getElementById('copilot-messages');
        if (!feed) return;

        // User bubble
        feed.insertAdjacentHTML('beforeend', `
            <div style="align-self:flex-end;background:var(--surface-2);border:1px solid var(--border);border-radius:12px 12px 4px 12px;padding:8px 12px;font-size:0.82rem;max-width:90%;word-wrap:break-word;">
                ${question.replace(/</g,'&lt;')}
            </div>
        `);
        feed.scrollTop = feed.scrollHeight;

        // AI response bubble (streaming)
        const replyId = 'cop-reply-' + Date.now();
        feed.insertAdjacentHTML('beforeend', `
            <div id="${replyId}" style="align-self:flex-start;background:rgba(0,212,170,0.07);border:1px solid rgba(0,212,170,0.2);border-radius:12px 12px 12px 4px;padding:8px 12px;font-size:0.82rem;max-width:90%;word-wrap:break-word;white-space:pre-wrap;color:var(--text);">
                <span style="opacity:0.4;">Thinking…</span>
            </div>
        `);
        feed.scrollTop = feed.scrollHeight;

        const replyEl = document.getElementById(replyId);

        // Gather connected-user profile context
        let userProfile = {};
        let recentMessages = [];
        try {
            if (activeSessionId) {
                const { data: sess } = await supabase.from('connect_sessions')
                    .select('user_id').eq('id', activeSessionId).maybeSingle();
                if (sess && sess.user_id) {
                    const { data: prof } = await supabase.from('profiles')
                        .select('full_name, bio, user_memory').eq('id', sess.user_id).maybeSingle();
                    if (prof) userProfile = prof;

                    const { data: journals } = await supabase.from('journals')
                        .select('title, content').eq('user_id', sess.user_id)
                        .order('created_at', { ascending: false }).limit(3);
                    if (journals) userProfile.recent_journals = journals;

                    const { data: msgs } = await supabase.from('messages')
                        .select('sender_id, content').eq('session_id', activeSessionId)
                        .order('created_at', { ascending: false }).limit(20);
                    if (msgs) recentMessages = msgs.reverse().map(m => ({
                        role: m.sender_id === sess.user_id ? 'user' : 'assistant',
                        content: m.content
                    }));
                }
            }

            const res = await fetch('/api/listener-copilot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ listenerQuestion: question, userProfile, recentMessages })
            });
            const data = await res.json();
            if (!res.ok || data.error) {
                if (replyEl) replyEl.textContent = 'Error: ' + (data.error || res.status);
                return;
            }
            if (replyEl) replyEl.textContent = data.reply || '(no reply)';
        } catch (e) {
            if (replyEl) replyEl.textContent = 'Error: ' + e.message;
        }
        feed.scrollTop = feed.scrollHeight;
    };

    init();
});