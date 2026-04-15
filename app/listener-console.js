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
        messagePollInterval = setInterval(syncMessages, 2500);
    }

    async function syncMessages() {
        if (!activeSessionId || currentUIState !== 'chat') return;
        const { data: msgs } = await supabase.from('messages').select('*').eq('session_id', activeSessionId).order('created_at', { ascending: true });
        if (msgs) msgs.forEach(msg => renderChatMessage(msg));
    }

    window.sendReply = async function() {
        if (!activeSessionId) return;
        const input = document.getElementById('chat-reply-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = ''; 
        
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
            html = `
                <div id="msg-${msg.id}" style="display: flex; justify-content: ${isMe ? 'flex-end' : 'flex-start'}; width: 100%; margin-bottom: 10px;">
                    <div style="background: ${isMe ? 'var(--accent-red)' : 'var(--glass-inner)'}; color: ${isMe ? 'white' : 'var(--text-color)'}; padding: 10px 15px; border-radius: 12px; max-width: 70%; word-wrap: break-word;">
                        ${msg.content}
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
    async function initWebRTC(isOfferer) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            document.getElementById('call-status').innerText = "Microphone error.";
            alert("Microphone required for voice call.");
            return;
        }

        const servers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
                { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
                { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
            ]
        };
        peerConnection = new RTCPeerConnection(servers);
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        let iceBuffer = [];

        peerConnection.ontrack = (event) => {
            const remoteAudio = document.getElementById('remote-audio');
            if (remoteAudio && remoteAudio.srcObject !== event.streams[0]) {
                remoteAudio.srcObject = event.streams[0];
                remoteAudio.play().catch(() => {});
                document.getElementById('call-status').innerText = "Connected • Secure Voice Channel";
            }
        };

        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection.connectionState;
            const statusEl = document.getElementById('call-status');
            if (!statusEl) return;
            if (state === 'connected') statusEl.innerText = "Connected • Secure Voice Channel";
            if (state === 'disconnected' || state === 'failed') statusEl.innerText = "Connection lost.";
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
        if(localStream) localStream.getTracks().forEach(t => t.stop());
        if(peerConnection) peerConnection.close();
        if(rtcChannel) supabase.removeChannel(rtcChannel); 
    }

    window.handleSessionEnd = function() {
        if (isEnding) return; 
        isEnding = true;
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
        if(!sessionId) return;
        await supabase.from('connect_sessions').update({ status: 'completed' }).eq('id', sessionId);
        handleSessionEnd();
    };

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

    init();
});