document.addEventListener('DOMContentLoaded', () => {
    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    let supabase;
    if (typeof window.supabase !== 'undefined') {
        supabase = window._sbClient || (window._sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY));
    } else { return console.error("Supabase failed to load."); }

    if (typeof window.SympClient === 'function' && supabase && !window.symp) {
        try {
            window.symp = new window.SympClient({
                getAuthToken: async () => {
                    const { data } = await supabase.auth.getSession();
                    return data?.session?.access_token || '';
                },
            });
        } catch (e) { console.warn('[symp] init failed:', e.message); }
    }

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

    // Voice-optimized Opus SDP params — mirror of connect-user.js.
    function tuneOpusSdp(sdp) {
        if (!sdp) return sdp;
        const lines = sdp.split('\r\n');
        const opusRtpmapIdx = lines.findIndex(l => /a=rtpmap:\d+\s+opus\/48000/i.test(l));
        if (opusRtpmapIdx < 0) return sdp;
        const pt = lines[opusRtpmapIdx].match(/a=rtpmap:(\d+)/)[1];
        const fmtpIdx = lines.findIndex(l => l.startsWith(`a=fmtp:${pt}`));
        const fmtp = `a=fmtp:${pt} minptime=10;useinbandfec=1;stereo=0;usedtx=1;maxaveragebitrate=40000`;
        if (fmtpIdx >= 0) lines[fmtpIdx] = fmtp;
        else lines.splice(opusRtpmapIdx + 1, 0, fmtp);
        return lines.join('\r\n');
    }

    // Feature 5: split-duration tracking (call vs chat)
    let callStartTime = null;
    let callTimerInterval = null;
    let chatStartTime = null;

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

    window.openProfile = async function(forceLock = false) {
        if (!currentListenerProfile) return;
        // Refresh row so rating/minutes reflect latest trigger + end-of-session writes
        const { data: fresh } = await supabase.from('listeners').select('*').eq('id', currentListenerProfile.id).maybeSingle();
        if (fresh) currentListenerProfile = fresh;
        renderProfileStats();
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

    function renderProfileStats() {
        const host = document.getElementById('listener-stats-block');
        if (!host || !currentListenerProfile) return;
        const rating = currentListenerProfile.rating;
        const count = currentListenerProfile.review_count || 0;
        const callMin = Math.round(Number(currentListenerProfile.total_call_minutes) || Number(currentListenerProfile.total_minutes_spoken) || 0);
        const chatMin = Math.round(Number(currentListenerProfile.total_chat_minutes) || 0);
        const ratingStr = rating != null
            ? `★ ${Number(rating).toFixed(2)} <span style="opacity:0.6;font-weight:400;">(${count} review${count === 1 ? '' : 's'})</span>`
            : `<span style="opacity:0.6;font-weight:400;">No reviews yet</span>`;
        host.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:8px;padding:14px;background:var(--glass-inner,rgba(255,255,255,0.04));border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:12px;margin-bottom:14px;">
                <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.2px;opacity:0.6;">Rating</div>
                <div style="font-size:1.05rem;font-weight:700;color:#FFC857;">${ratingStr}</div>
                <div style="display:flex;gap:18px;margin-top:4px;">
                    <div><div style="font-size:0.7rem;opacity:0.6;">Call minutes</div><div style="font-size:1rem;font-weight:700;">${callMin}</div></div>
                    <div><div style="font-size:0.7rem;opacity:0.6;">Chat minutes</div><div style="font-size:1rem;font-weight:700;">${chatMin}</div></div>
                    <div><div style="font-size:0.7rem;opacity:0.6;">Total</div><div style="font-size:1rem;font-weight:700;">${callMin + chatMin}</div></div>
                </div>
            </div>
        `;
    }

    window.viewListenerReviews = async function() {
        if (!currentListenerProfile) return;
        const { data: reviews } = await supabase.from('listener_reviews')
            .select('rating, review_text, created_at').eq('listener_id', currentListenerProfile.id)
            .order('created_at', { ascending: false }).limit(20);
        const list = (reviews && reviews.length)
            ? reviews.map(r => `<div style="padding:10px;border-bottom:1px solid var(--glass-border,rgba(255,255,255,0.08));"><div style="color:#FFC857;">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>${r.review_text ? `<div style="font-size:0.85rem;margin-top:4px;">${r.review_text.replace(/</g,'&lt;')}</div>` : ''}<div style="font-size:0.7rem;opacity:0.5;margin-top:4px;">${new Date(r.created_at).toLocaleDateString()}</div></div>`).join('')
            : '<div style="opacity:0.6;text-align:center;padding:20px;">No reviews yet.</div>';
        const modal = document.createElement('div');
        modal.className = 'auth-overlay active';
        modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);';
        modal.innerHTML = `<div class="glass-pane" style="width:90%;max-width:420px;max-height:70vh;overflow:auto;padding:20px;background:var(--bg-color);"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><h3 style="margin:0;">Reviews</h3><button onclick="this.closest('.auth-overlay').remove()" style="background:none;border:none;color:var(--text-color);font-size:1.8rem;cursor:pointer;">&times;</button></div>${list}</div>`;
        document.body.appendChild(modal);
    };

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
        if (!chatStartTime) chatStartTime = Date.now();

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

        // Drop any optimistic temp bubbles from this listener once the real DB row arrives.
        // Without this, the listener sees their own message twice (once optimistic, once from realtime).
        const isReal = typeof msg.id === 'string' && !msg.id.startsWith('temp-');
        if (isReal && msg.sender_id === currentUser?.id) {
            feed.querySelectorAll('[id^="msg-temp-"]').forEach(el => el.remove());
        }

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
    // Voice mask — pitch-shift the listener's mic before it enters WebRTC.
    //
    // CRITICAL FIX: the previous implementation used ScriptProcessorNode inside an
    // AudioContext that was never resumed. Browsers ship AudioContext in the
    // "suspended" state until a user gesture calls resume(), so onaudioprocess
    // never fired and the MediaStreamDestination output pure silence — meaning
    // the USER heard NOTHING from the listener. This is the #1 reason callers
    // reported "voice not working".
    //
    // New strategy:
    //   1. Try to resume the AudioContext. If it stays suspended, bail out.
    //   2. Verify the destination stream actually has an audio track before
    //      handing it to WebRTC. If the track is missing/silent, fall back to
    //      the raw mic stream so the call is never dead-air.
    //   3. Any failure → return raw stream (audible call beats silent mask).
    async function applyVoiceMask(rawStream) {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            // MUST resume — without this, suspended contexts produce silence.
            if (audioContext.state === 'suspended') {
                try { await audioContext.resume(); } catch {}
            }
            if (audioContext.state !== 'running') {
                console.warn('[VoiceMask] AudioContext could not resume, using raw mic');
                return rawStream;
            }

            const source = audioContext.createMediaStreamSource(rawStream);
            const bufferSize = 4096;
            const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
            const pitchFactor = 0.82;   // ≈ −3 semitones

            processor.onaudioprocess = (e) => {
                const input  = e.inputBuffer.getChannelData(0);
                const output = e.outputBuffer.getChannelData(0);
                for (let i = 0; i < bufferSize; i++) {
                    const srcIdx = Math.floor(i * pitchFactor);
                    output[i] = srcIdx < input.length ? input[srcIdx] : 0;
                }
            };

            const dest = audioContext.createMediaStreamDestination();
            source.connect(processor);
            processor.connect(dest);

            // Verify the mask actually produced an audio track.
            const maskedTracks = dest.stream.getAudioTracks();
            if (!maskedTracks.length || !maskedTracks[0].enabled) {
                console.warn('[VoiceMask] Mask produced no audio track, using raw mic');
                return rawStream;
            }

            pitchShiftedStream = dest.stream;
            console.log('[VoiceMask] Active — pitch factor', pitchFactor);
            return dest.stream;
        } catch (e) {
            console.warn('[VoiceMask] Exception, falling back to raw mic:', e.message);
            return rawStream;
        }
    }

    async function initWebRTC(isOfferer) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl:  true,
                },
            });
        } catch (err) {
            document.getElementById('call-status').innerText = "Microphone error.";
            alert("Microphone required for voice call.");
            return;
        }

        // NOTE: voice mask is DISABLED for reliability. The ScriptProcessor-based
        // pitch shifter was a prime suspect in the "neither side can hear each
        // other" bug — even with resume() it can produce silence under the
        // browser's main-thread audio policy. Ship raw audio for now; replace
        // with an AudioWorklet implementation before re-enabling.
        const streamToSend = localStream;
        // const streamToSend = await applyVoiceMask(localStream);

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

        // ── WebRTC diagnostics (mirrors connect-user.js) ─────────────────────
        peerConnection.oniceconnectionstatechange = () => {
            console.log('[WebRTC] iceConnectionState:', peerConnection.iceConnectionState);
        };
        peerConnection.onicegatheringstatechange = () => {
            console.log('[WebRTC] iceGatheringState:', peerConnection.iceGatheringState);
        };
        peerConnection.onsignalingstatechange = () => {
            console.log('[WebRTC] signalingState:', peerConnection.signalingState);
        };
        peerConnection.onicecandidateerror = (e) => {
            console.warn('[WebRTC] iceCandidateError:', e.errorCode, e.errorText, e.url);
        };
        const statsInterval = setInterval(async () => {
            if (!peerConnection || peerConnection.connectionState === 'closed') {
                clearInterval(statsInterval);
                return;
            }
            try {
                const stats = await peerConnection.getStats();
                let inbound = 0, outbound = 0;
                stats.forEach(r => {
                    if (r.type === 'inbound-rtp'  && r.kind === 'audio') inbound  = r.bytesReceived || 0;
                    if (r.type === 'outbound-rtp' && r.kind === 'audio') outbound = r.bytesSent     || 0;
                });
                console.log(`[WebRTC] audio bytes — in:${inbound} out:${outbound}`);
            } catch {}
        }, 3000);

        let iceBuffer = [];

        peerConnection.ontrack = (event) => {
            console.log('[WebRTC] ontrack', event.track.kind, 'streams:', event.streams.length, 'muted:', event.track.muted);
            const remoteAudio = document.getElementById('remote-audio');
            if (!remoteAudio || event.track.kind !== 'audio') return;

            // Some Chromium/Android builds emit the track without a grouped stream.
            // Construct one so the <audio> element has a valid srcObject either way.
            let stream = event.streams && event.streams[0];
            if (!stream) {
                stream = new MediaStream();
                stream.addTrack(event.track);
            }
            remoteAudio.srcObject = stream;
            remoteAudio.muted  = false;
            remoteAudio.volume = 1.0;

            const tryPlay = () => remoteAudio.play()
                .then(() => {
                    document.getElementById('call-status').innerText = "Connected • Secure Voice Channel";
                    startCallTimer();
                })
                .catch(err => {
                    console.warn('[WebRTC] remote audio autoplay blocked:', err.message);
                    const statusEl = document.getElementById('call-status');
                    if (statusEl) {
                        statusEl.innerHTML = '<button onclick="document.getElementById(\'remote-audio\').play()" style="background:#4CAF50;color:#fff;border:none;padding:8px 16px;border-radius:20px;cursor:pointer;">🔊 Tap to enable audio</button>';
                    }
                });

            // First RTP packet arrival unmutes the track. Retrying play() here
            // handles the Android/Chromium case where the element is attached to
            // a still-silent track and never produces audio.
            event.track.onunmute = () => {
                console.log('[WebRTC] remote track unmuted');
                tryPlay();
            };
            tryPlay();
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
                // Opus munging removed — see note in connect-user.js
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

    async function stopTimersAndSave() {
        if (!currentListenerProfile) return;
        const patch = {};
        if (callStartTime) {
            clearInterval(callTimerInterval);
            const mins = (Date.now() - callStartTime) / 60000;
            callStartTime = null; callTimerInterval = null;
            const curCall = Number(currentListenerProfile.total_call_minutes) || 0;
            patch.total_call_minutes = Math.round((curCall + mins) * 100) / 100;
            // Keep legacy total_minutes_spoken in sync for any consumer still reading it
            const curLegacy = Number(currentListenerProfile.total_minutes_spoken) || 0;
            patch.total_minutes_spoken = Math.round((curLegacy + mins) * 100) / 100;
        }
        if (chatStartTime) {
            const mins = (Date.now() - chatStartTime) / 60000;
            chatStartTime = null;
            const curChat = Number(currentListenerProfile.total_chat_minutes) || 0;
            patch.total_chat_minutes = Math.round((curChat + mins) * 100) / 100;
        }
        if (Object.keys(patch).length === 0) return;
        await supabase.from('listeners').update(patch).eq('id', currentListenerProfile.id);
        Object.assign(currentListenerProfile, patch);
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
        // Feature 5: save accumulated call + chat minutes before unloading
        await stopTimersAndSave();
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
        let seekerId = null;
        try {
            if (activeSessionId) {
                const { data: sess } = await supabase.from('connect_sessions')
                    .select('user_id').eq('id', activeSessionId).maybeSingle();
                if (sess && sess.user_id) {
                    seekerId = sess.user_id;
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

            // Prefer Symp.ai Co-Pilot — grounded in the seeker's Vault analysis.
            // Falls back to legacy /api/listener-copilot if SDK unavailable or errors.
            if (window.symp && seekerId) {
                try {
                    const r = await window.symp.getCopilotHint({
                        target_user_id:    seekerId,
                        session_id:        activeSessionId,
                        recent_messages:   recentMessages,
                        listener_question: question,
                    });
                    if (r && r.ok && r.data && r.data.hint) {
                        const risk = r.data.risk_level;
                        const tag  = (risk && risk !== 'low')
                            ? `<div style="font-size:0.68rem;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:${risk === 'high' ? '#ff6a6a' : '#ffb547'};margin-bottom:4px;">⚠ ${risk} risk</div>`
                            : '';
                        if (replyEl) replyEl.innerHTML = tag + r.data.hint.replace(/</g,'&lt;');
                        feed.scrollTop = feed.scrollHeight;
                        return;
                    }
                    console.warn('[copilot] Symp.ai returned no hint, falling back', r);
                } catch (e) {
                    console.warn('[copilot] Symp.ai hint failed, falling back:', e.message);
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