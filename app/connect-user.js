document.addEventListener('DOMContentLoaded', () => {
    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    let supabase;
    if (typeof window.supabase !== 'undefined') {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    } else { return console.error("Supabase failed to load."); }

    let currentUser = null;
    window.selectedListenerId = null;
    let activeListenerId = null; // Feature 6: persisted for post-session review
    let activeSessionId = null;
    let isEnding = false;
    let currentUIState = 'dashboard';

    let globalChannel = null;
    let sessionChannel = null;
    let chatChannel = null;
    let rtcChannel = null;
    let gridPollInterval = null;
    let sessionPollInterval = null;
    let messagePollInterval = null;

    let renderedMessageIds = new Set();
    let peerConnection = null;
    let localStream = null;
    let lastListenerIds = '';

    // Tune the Opus codec parameters in SDP for voice-optimized calling.
    // stereo=0 (mono), useinbandfec=1 (forward error correction for packet loss),
    // usedtx=1 (discontinuous transmission — don't send silence), maxaveragebitrate=40000.
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

    async function init() {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error || !session) return window.location.replace('../index.html');
        currentUser = session.user;

        const { data: existingSessions } = await supabase.from('connect_sessions')
            .select('*').eq('user_id', currentUser.id).in('status', ['pending', 'active'])
            .order('created_at', { ascending: false }).limit(1);

        const existingSession = existingSessions && existingSessions.length > 0 ? existingSessions[0] : null;

        if (existingSession) {
            activeSessionId = existingSession.id;
            activeListenerId = existingSession.listener_id;
            setupSessionWatcher(existingSession.id);
            if (existingSession.status === 'active') {
                existingSession.session_type === 'call' ? startVoiceCallInterface() : startLiveChatInterface();
            } else {
                showRingingUI(existingSession.session_type);
            }
        } else {
            loadListeners();
            loadHistory();

            if (globalChannel) supabase.removeChannel(globalChannel);
            globalChannel = supabase.channel('public:listeners')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'listeners' }, () => {
                    if (!activeSessionId) loadListeners();
                }).subscribe();

            if (gridPollInterval) clearInterval(gridPollInterval);
            gridPollInterval = setInterval(() => { if (!activeSessionId) loadListeners(); }, 5000);
        }
    }

    async function loadHistory() {
        const { data: history } = await supabase.from('connect_sessions')
            .select('*, listeners(display_name)').eq('user_id', currentUser.id).eq('status', 'completed')
            .order('created_at', { ascending: false }).limit(5);
        if (!history || history.length === 0) return;

        let historyHTML = `<div style="margin-top:28px;padding:0 16px 0;"><p class="quick-section-label" style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-3);margin-bottom:10px;">Recent Connections</p><div style="display:flex;flex-direction:column;gap:8px;">`;
        history.forEach(s => {
            const date = new Date(s.created_at).toLocaleDateString();
            const name = s.listeners ? s.listeners.display_name : 'Unknown Listener';
            const safeName = name.replace(/'/g, "\\'");
            const icon = s.session_type === 'call' ? 'call-outline' : 'chatbubbles-outline';
            historyHTML += `<div onclick="window.viewPastSession('${s.id}', '${safeName}')" style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--surface-1);border:1px solid var(--border);border-radius:14px;cursor:pointer;transition:background 0.2s;" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='var(--surface-1)'">
                <ion-icon name="${icon}" style="font-size:1.1rem;color:var(--text-3);flex-shrink:0;"></ion-icon>
                <div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:0.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div><div style="font-size:0.72rem;color:var(--text-3);margin-top:2px;">${s.session_type} · ${date}</div></div>
                <ion-icon name="chevron-forward-outline" style="font-size:0.85rem;color:var(--text-3);opacity:0.5;flex-shrink:0;"></ion-icon>
            </div>`;
        });
        historyHTML += `</div></div>`;
        const grid = document.getElementById('listener-grid');
        if (grid) grid.insertAdjacentHTML('afterend', historyHTML);
    }

    async function loadListeners() {
        const grid = document.getElementById('listener-grid');
        if (!grid) return;

        const { data: listeners, error } = await supabase.from('listeners').select('*').eq('is_online', true);

        if (error) {
            console.error('loadListeners error:', error.message);
            return;
        }

        if (!listeners || listeners.length === 0) {
            if (lastListenerIds !== 'empty') {
                lastListenerIds = 'empty';
                grid.innerHTML = '<div class="connect-empty"><ion-icon name="moon-outline"></ion-icon><p>No listeners online right now.<br>Check back soon.</p></div>';
            }
            return;
        }

        const newIds = listeners.map(l => l.id + ':' + l.is_online).join(',');
        if (newIds === lastListenerIds) return;
        lastListenerIds = newIds;

        let newHTML = '';
        listeners.forEach(listener => {
            const name = listener.display_name || 'Anonymous Listener';
            const safeName = name.replace(/'/g, "\\'");
            const pic = listener.profile_pic || ('https://i.pravatar.cc/150?u=' + listener.id);
            const safePic = pic.replace(/'/g, "\\'");
            const chatPrice = listener.chat_price_per_min || 10;
            const callPrice = listener.call_price_per_min || 25;
            const tagline = listener.bio || 'Here to listen without judgment';
            const lang = listener.language || 'English';
            const callMin = Math.round(Number(listener.total_call_minutes) || Number(listener.total_minutes_spoken) || 0);
            const chatMin = Math.round(Number(listener.total_chat_minutes) || 0);
            const totalMin = callMin + chatMin;
            const ratingStr = listener.rating != null
                ? `★ ${Number(listener.rating).toFixed(1)} (${listener.review_count || 0})`
                : 'New listener';
            const experienceStr = totalMin > 0 ? `${totalMin} min listened` : null;

            newHTML += `
                <div class="listener-card" onclick="openConnectModal('${listener.id}', '${safeName}', '${safePic}', ${chatPrice}, ${callPrice}, ${callMin}, ${chatMin}, ${listener.rating != null ? Number(listener.rating) : 'null'}, ${listener.review_count || 0})">
                    <div class="listener-avatar-wrap">
                        <img src="${pic}" onerror="this.src='https://i.pravatar.cc/150?u=${listener.id}'" alt="${name}">
                        <div class="online-dot"></div>
                    </div>
                    <div class="listener-info">
                        <div class="listener-name">${name}</div>
                        <div class="listener-tagline">${tagline}</div>
                        <div class="listener-meta">
                            <span class="listener-price-tag">₹${chatPrice}/min chat · ₹${callPrice}/min call</span>
                            <span class="listener-lang-tag">${lang}</span>
                        </div>
                        <div class="listener-meta" style="margin-top:4px;">
                            <span class="listener-lang-tag" style="color:#FFC857;">${ratingStr}</span>
                            ${experienceStr ? `<span class="listener-lang-tag">${experienceStr}</span>` : ''}
                        </div>
                    </div>
                    <div class="listener-card-action">
                        <button class="connect-btn-small">
                            <ion-icon name="arrow-forward-outline"></ion-icon>
                        </button>
                    </div>
                </div>
            `;
        });
        grid.innerHTML = newHTML;
    }

    window.openConnectModal = function(id, name, pic, chatPrice, callPrice, callMin, chatMin, rating, reviewCount) {
        window.selectedListenerId = id;
        document.getElementById('modal-listener-name').innerText = `Connect with ${name}`;
        document.getElementById('modal-listener-pic').src = pic;
        document.getElementById('modal-chat-price').innerText = `₹${chatPrice} / min`;
        document.getElementById('modal-call-price').innerText = `₹${callPrice} / min`;
        const stats = document.getElementById('modal-listener-stats');
        if (stats) {
            const ratingLbl = (rating != null && !isNaN(rating))
                ? `<span style="color:#FFC857;">★ ${Number(rating).toFixed(1)}</span> · ${reviewCount || 0} review${reviewCount === 1 ? '' : 's'}`
                : 'New listener';
            const total = (Number(callMin) || 0) + (Number(chatMin) || 0);
            const minsLbl = total > 0 ? ` · ${total} min listened (${callMin || 0} call, ${chatMin || 0} chat)` : '';
            stats.innerHTML = ratingLbl + minsLbl;
        }
        document.getElementById('connection-modal').classList.add('active');
    };

    const closeBtn = document.getElementById('close-modal-btn');
    if (closeBtn) closeBtn.onclick = () => document.getElementById('connection-modal').classList.remove('active');

    function showRingingUI(type) {
        currentUIState = 'ringing';
        const grid = document.getElementById('listener-grid');
        grid.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:70vh;padding:32px 24px;gap:0;';

        const icon = type === 'call' ? 'call-outline' : 'chatbubbles-outline';
        const label = type === 'call' ? 'Calling your listener…' : 'Connecting to listener…';
        const sub   = type === 'call' ? 'Ringing. They\'ll answer shortly.' : 'Starting your private chat session.';

        grid.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;gap:18px;width:100%;max-width:300px;text-align:center;">
                <!-- Pulsing ring avatar -->
                <div style="position:relative;width:100px;height:100px;display:flex;align-items:center;justify-content:center;">
                    <div style="position:absolute;inset:-16px;border-radius:50%;border:2px solid rgba(0,212,170,0.15);animation:callPulse 1.8s ease-out infinite 0s;"></div>
                    <div style="position:absolute;inset:-8px;border-radius:50%;border:2px solid rgba(0,212,170,0.25);animation:callPulse 1.8s ease-out infinite 0.4s;"></div>
                    <div style="width:100px;height:100px;border-radius:50%;background:var(--accent-dim);border:2px solid var(--accent-mid);display:flex;align-items:center;justify-content:center;font-size:2.4rem;color:var(--accent);">
                        <ion-icon name="${icon}"></ion-icon>
                    </div>
                </div>
                <div>
                    <div style="font-size:1.05rem;font-weight:700;margin-bottom:5px;">${label}</div>
                    <div style="font-size:0.8rem;color:var(--text-3);">${sub}</div>
                </div>
                <button onclick="window.cancelPendingRequest()"
                    style="padding:12px 28px;background:rgba(255,77,106,0.1);border:1px solid rgba(255,77,106,0.25);color:var(--red);border-radius:24px;font-size:0.88rem;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:6px;margin-top:8px;">
                    <ion-icon name="close-circle-outline"></ion-icon> Cancel
                </button>
            </div>
            <style>
                @keyframes callPulse{0%{opacity:0.6;transform:scale(0.92);}100%{opacity:0;transform:scale(1.4);}}
            </style>
        `;

        const historySec = grid.nextElementSibling;
        if (historySec && historySec.innerHTML.includes('Recent Connections')) historySec.style.display = 'none';
    }

    window.cancelPendingRequest = async function() {
        if (!activeSessionId) return;
        if (sessionPollInterval) clearInterval(sessionPollInterval);
        if (sessionChannel) supabase.removeChannel(sessionChannel);
        await supabase.from('connect_sessions').update({ status: 'cancelled' }).eq('id', activeSessionId);
        activeSessionId = null;
        isEnding = true;
        window.location.reload();
    };

    async function syncSessionStatus() {
        if (!activeSessionId || isEnding) return;
        const { data: sess } = await supabase.from('connect_sessions').select('*').eq('id', activeSessionId).maybeSingle();
        if (!sess) return;

        if (sess.status === 'completed') return handleSessionEnd();
        if (sess.status === 'cancelled') return;
        if (sess.status === 'rejected') {
            alert("The listener is currently busy or declined.");
            window.location.reload();
        }

        if (sess.status === 'active') {
            if (sess.session_type === 'call' && currentUIState !== 'call') {
                startVoiceCallInterface();
            } else if (sess.session_type === 'chat' && currentUIState !== 'chat') {
                stopWebRTC();
                startLiveChatInterface();
            }
        }
    }

    window.setupSessionWatcher = function(sessionId) {
        if (sessionChannel) supabase.removeChannel(sessionChannel);
        sessionChannel = supabase.channel('session_' + sessionId)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'connect_sessions', filter: `id=eq.${sessionId}` }, () => {
                // Realtime fires instantly — no polling delay
                syncSessionStatus();
            }).subscribe();
        // Backup poll at 800ms (down from 1500ms) for mobile network gaps
        if (sessionPollInterval) clearInterval(sessionPollInterval);
        sessionPollInterval = setInterval(syncSessionStatus, 800);
    };

    window.startSession = async function(type) {
        const isAnonymous = document.getElementById('anonymous-toggle').checked;
        if (!window.selectedListenerId) return alert("Please select a listener first.");

        // Optimistic: close modal + show ringing UI immediately before DB round-trip
        document.getElementById('connection-modal').classList.remove('active');
        showRingingUI(type);

        const { data, error } = await supabase.from('connect_sessions').insert([{
            user_id: currentUser.id, listener_id: window.selectedListenerId, session_type: type,
            is_anonymous: isAnonymous, status: 'pending'
        }]).select().single();

        if (error) {
            // Revert on failure
            window.location.reload();
            return;
        }
        activeSessionId = data.id;
        activeListenerId = window.selectedListenerId;
        setupSessionWatcher(data.id);
    };

    let _callRequestInFlight = false;
    window.requestCallUpgrade = async function() {
        if (!activeSessionId || _callRequestInFlight) return;
        _callRequestInFlight = true;
        // Disable button to prevent double-taps that created duplicate CALL_REQUEST rows
        const btns = document.querySelectorAll('button[onclick*="requestCallUpgrade"]');
        btns.forEach(b => { b.disabled = true; b.style.opacity = '0.5'; b.style.pointerEvents = 'none'; });
        try {
            // Guard: if a pending call_request from this user already exists, don't insert another
            const { data: recent } = await supabase.from('messages')
                .select('id, sender_id, content').eq('session_id', activeSessionId)
                .order('created_at', { ascending: false }).limit(1);
            const last = recent && recent[0];
            if (!(last && last.sender_id === currentUser.id && last.content === '###CALL_REQUEST###')) {
                await supabase.from('messages').insert([{ session_id: activeSessionId, sender_id: currentUser.id, content: '###CALL_REQUEST###' }]);
            }
        } finally {
            // Leave disabled — listener will respond or user ends session
            setTimeout(() => { _callRequestInFlight = false; }, 4000);
        }
    };

    window.acceptMidChatCall = async function() {
        if (!activeSessionId) return;
        await supabase.from('connect_sessions').update({ session_type: 'call' }).eq('id', activeSessionId);
        syncSessionStatus();
    };

    window.revertToChat = async function() {
        if (!activeSessionId) return;
        await supabase.from('connect_sessions').update({ session_type: 'chat' }).eq('id', activeSessionId);
        syncSessionStatus();
    };

    async function startLiveChatInterface() {
        currentUIState = 'chat';
        if (rtcChannel) supabase.removeChannel(rtcChannel);

        const page = document.querySelector('.connect-page');
        if (page) page.style.paddingBottom = 'calc(var(--nav-h, 62px) + env(safe-area-inset-bottom,0px) + 72px)';

        const grid = document.getElementById('listener-grid');
        // Replace entire grid with a proper chat shell
        grid.style.cssText = 'display:flex;flex-direction:column;flex:1;padding:0;gap:0;';

        grid.innerHTML = `
            <!-- Chat header bar -->
            <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--surface-1);border-bottom:1px solid var(--border);flex-shrink:0;">
                <div style="width:36px;height:36px;border-radius:50%;background:var(--surface-3);border:1.5px solid var(--border-md);display:flex;align-items:center;justify-content:center;font-size:1rem;color:var(--text-3);flex-shrink:0;">
                    <ion-icon name="headset-outline"></ion-icon>
                </div>
                <div style="flex:1;">
                    <div style="font-weight:700;font-size:0.92rem;">Your Listener</div>
                    <div style="font-size:0.72rem;color:var(--accent);display:flex;align-items:center;gap:4px;">
                        <span style="width:6px;height:6px;border-radius:50%;background:var(--accent);display:inline-block;"></span> Secure connection active
                    </div>
                </div>
                <button onclick="window.requestCallUpgrade()"
                    style="padding:7px 13px;border-radius:20px;background:var(--accent-dim);border:1px solid var(--accent-mid);color:var(--accent);font-size:0.75rem;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px;">
                    <ion-icon name="call-outline"></ion-icon> Call
                </button>
                <button onclick="window.endUserSession()"
                    style="width:36px;height:36px;border-radius:50%;background:rgba(255,77,106,0.1);border:1px solid rgba(255,77,106,0.2);color:var(--red);font-size:1rem;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;">
                    <ion-icon name="close-outline"></ion-icon>
                </button>
            </div>

            <!-- Messages -->
            <div id="user-chat-feed" style="flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:6px;-webkit-overflow-scrolling:touch;">
                <div style="text-align:center;font-size:0.72rem;color:var(--text-3);padding:8px 0 4px;">
                    <ion-icon name="lock-closed-outline" style="vertical-align:middle;margin-right:3px;"></ion-icon> End-to-end private session started
                </div>
            </div>

            <!-- Input row (position:relative so the attach menu can anchor to it) -->
            <div style="position:relative;display:flex;align-items:center;gap:8px;padding:10px 12px;padding-bottom:calc(10px + env(safe-area-inset-bottom,0px));background:var(--surface-1);border-top:1px solid var(--border);flex-shrink:0;">

                <!-- Attach popup menu — inside position:relative parent so bottom/left work correctly -->
                <div id="connect-attach-menu" style="display:none;position:absolute;bottom:calc(100% + 8px);left:0;background:var(--surface-1);border:1px solid var(--border);border-radius:16px;padding:8px;box-shadow:0 8px 32px rgba(0,0,0,0.4);z-index:200;flex-direction:column;gap:2px;min-width:170px;">
                    <button id="connect-menu-image" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:none;background:none;color:var(--text);font-size:0.88rem;font-family:inherit;cursor:pointer;border-radius:10px;width:100%;text-align:left;">
                        <ion-icon name="image-outline" style="font-size:1.2rem;color:var(--accent);flex-shrink:0;"></ion-icon> Photo / Image
                    </button>
                    <button id="connect-menu-voice" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:none;background:none;color:var(--text);font-size:0.88rem;font-family:inherit;cursor:pointer;border-radius:10px;width:100%;text-align:left;">
                        <ion-icon name="mic-outline" style="font-size:1.2rem;color:var(--accent);flex-shrink:0;"></ion-icon> <span id="connect-voice-label">Voice Note</span>
                    </button>
                </div>
                <button id="connect-attach-btn" title="Attach"
                    style="width:40px;height:40px;border-radius:50%;background:var(--surface-2);border:1px solid var(--border);color:var(--text-3);font-size:1.1rem;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:all 0.15s;">
                    <ion-icon name="add-outline"></ion-icon>
                </button>
                <input type="file" id="connect-image-input" accept="image/*" hidden>
                <input type="text" id="user-chat-input"
                    placeholder="Message your listener…"
                    style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:22px;padding:10px 16px;color:var(--text);font-size:16px;font-family:inherit;outline:none;transition:border-color 0.2s;"
                    onfocus="this.style.borderColor='var(--accent-mid)'" onblur="this.style.borderColor='var(--border)'"
                    onkeypress="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window.sendUserMessage();}">
                <button onclick="window.sendUserMessage()"
                    style="width:44px;height:44px;border-radius:50%;background:var(--accent-dim);border:1px solid var(--accent-mid);color:var(--accent);font-size:1.15rem;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:background 0.2s;">
                    <ion-icon name="arrow-up-outline"></ion-icon>
                </button>
            </div>
        `;

        // Wire up attach menu, image upload, and voice recording
        setTimeout(() => {
            const attachBtn  = document.getElementById('connect-attach-btn');
            const attachMenu = document.getElementById('connect-attach-menu');
            const imageInput = document.getElementById('connect-image-input');
            const menuImage  = document.getElementById('connect-menu-image');
            const menuVoice  = document.getElementById('connect-menu-voice');

            // Toggle attach menu
            const closeMenu = () => {
                attachMenu.style.display = 'none';
                attachBtn.style.background = 'var(--surface-2)';
                attachBtn.style.color      = 'var(--text-3)';
            };
            attachBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = attachMenu.style.display === 'flex';
                if (isOpen) { closeMenu(); return; }
                attachMenu.style.display = 'flex';
                attachBtn.style.background = 'var(--accent-dim)';
                attachBtn.style.color      = 'var(--accent)';
            });
            // Close when clicking anywhere outside the menu or button
            document.addEventListener('click', (e) => {
                if (!attachMenu.contains(e.target) && e.target !== attachBtn && !attachBtn.contains(e.target)) {
                    closeMenu();
                }
            });

            // Image
            menuImage.addEventListener('click', (e) => {
                e.stopPropagation();
                closeMenu();
                imageInput.click();
            });
            imageInput.addEventListener('change', (e) => handleConnectImageUpload(e));

            // Voice note
            menuVoice.addEventListener('click', (e) => {
                e.stopPropagation();
                closeMenu();
                toggleConnectVoiceRecording();
            });
        }, 100);

        // Load existing messages instantly
        const { data: msgs } = await supabase.from('messages').select('*').eq('session_id', activeSessionId).order('created_at', { ascending: true });
        if (msgs) msgs.forEach(msg => renderUserMessage(msg));

        // Realtime-first: new messages land immediately
        if (chatChannel) supabase.removeChannel(chatChannel);
        chatChannel = supabase.channel('chat_user_' + activeSessionId)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `session_id=eq.${activeSessionId}` }, (payload) => {
                renderUserMessage(payload.new);
            }).subscribe();

        // Backup poll at 1500ms (Realtime handles the fast path)
        if (messagePollInterval) clearInterval(messagePollInterval);
        messagePollInterval = setInterval(syncMessages, 1500);
    }

    let lastSyncedAt = null;
    async function syncMessages() {
        if (!activeSessionId) return;   // keep polling even if UI state differs — dedup Set guards render
        let q = supabase.from('messages').select('*').eq('session_id', activeSessionId).order('created_at', { ascending: true });
        if (lastSyncedAt) q = q.gt('created_at', lastSyncedAt);
        const { data: msgs } = await q;
        if (msgs && msgs.length) {
            msgs.forEach(msg => renderUserMessage(msg));
            lastSyncedAt = msgs[msgs.length - 1].created_at;
        }
    }

    window.sendUserMessage = async function() {
        const input = document.getElementById('user-chat-input');
        const text = input.value.trim();
        if (!text || !activeSessionId) return;
        // Optimistic render before DB confirm
        const tempId = 'temp-' + Date.now();
        const feed = document.getElementById('user-chat-feed');
        if (feed) {
            feed.insertAdjacentHTML('beforeend', buildMessageBubble(tempId, text, true));
            feed.scrollTop = feed.scrollHeight;
        }
        input.value = '';
        await supabase.from('messages').insert([{ session_id: activeSessionId, sender_id: currentUser.id, content: text }]);
    };

    function buildMessageBubble(id, content, isMe) {
        const bubbleStyle = isMe
            ? 'background:var(--text);color:var(--bg);border-radius:18px 18px 4px 18px;'
            : 'background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:18px 18px 18px 4px;';

        let innerHtml = content;
        if (content && content.startsWith('IMAGE::')) {
            const parts = content.replace('IMAGE::', '').split('||DESC::');
            const imgUrl = parts[0];
            const desc   = parts[1] || '';
            innerHtml = `<div style="max-width:220px;">
                <img src="${imgUrl}" style="width:100%;border-radius:10px;cursor:pointer;display:block;"
                     onclick="window.open('${imgUrl}','_blank')" title="${desc}">
                ${desc ? `<div style="font-size:0.72rem;opacity:0.65;margin-top:5px;line-height:1.35;">${desc}</div>` : ''}
            </div>`;
        } else if (content && content.startsWith('AUDIO::')) {
            const audioUrl = content.replace('AUDIO::', '');
            innerHtml = `<div style="min-width:200px;">
                <div style="font-size:0.72rem;opacity:0.55;margin-bottom:6px;display:flex;align-items:center;gap:4px;">
                    <ion-icon name="mic-outline" style="font-size:0.85rem;"></ion-icon> Voice note
                </div>
                <audio src="${audioUrl}" controls preload="metadata"
                    style="width:100%;height:32px;outline:none;border-radius:8px;"></audio>
            </div>`;
        }

        return `<div id="msg-${id}" style="display:flex;justify-content:${isMe?'flex-end':'flex-start'};width:100%;animation:msgIn 0.2s ease both;">
            <div style="${bubbleStyle}padding:10px 14px;max-width:78%;word-wrap:break-word;font-size:0.92rem;line-height:1.5;">${innerHtml}</div>
        </div>`;
    }

    // ── Connect image upload ─────────────────────────────
    async function handleConnectImageUpload(e) {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file || !activeSessionId || !currentUser) return;
        if (!file.type.startsWith('image/')) return;
        if (file.size > 8 * 1024 * 1024) { alert('Image must be under 8 MB'); return; }

        const feed = document.getElementById('user-chat-feed');
        const tempId = 'img-' + Date.now();
        if (feed) {
            feed.insertAdjacentHTML('beforeend', `<div id="${tempId}" style="display:flex;justify-content:flex-end;width:100%;opacity:0.5;font-size:0.82rem;padding:4px 0;">📷 Uploading…</div>`);
            feed.scrollTop = feed.scrollHeight;
        }

        try {
            // Upload to Supabase storage
            const ext  = file.name.split('.').pop() || 'jpg';
            const path = `connect/${currentUser.id}/${Date.now()}.${ext}`;
            const sb   = window._blakcideSupabase || supabase;
            const { error: upErr } = await sb.storage.from('chat_images').upload(path, file, { contentType: file.type });
            if (upErr) { document.getElementById(tempId)?.remove(); alert('Upload failed'); return; }

            const { data: urlData } = sb.storage.from('chat_images').getPublicUrl(path);
            const publicUrl = urlData.publicUrl;

            // Vision analysis
            let imageDesc = '';
            try {
                const vRes = await fetch('/api/vision', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ imageUrl: publicUrl })
                });
                const vData = await vRes.json();
                imageDesc = vData.description || '';
            } catch(_) {}

            document.getElementById(tempId)?.remove();

            const msgContent = `IMAGE::${publicUrl}${imageDesc ? '||DESC::' + imageDesc : ''}`;
            // Optimistic render
            if (feed) {
                feed.insertAdjacentHTML('beforeend', buildMessageBubble('temp-' + Date.now(), msgContent, true));
                feed.scrollTop = feed.scrollHeight;
            }

            await sb.from('messages').insert([{
                session_id: activeSessionId,
                sender_id: currentUser.id,
                content: msgContent,
                media_url: publicUrl,
                media_type: 'image',
                media_description: imageDesc || null
            }]);
        } catch(err) {
            document.getElementById(tempId)?.remove();
            console.error('Connect image upload error:', err);
        }
    }

    // ── Voice note recording ──────────────────────────────────────────────────
    let _voiceRecorder   = null;
    let _voiceChunks     = [];
    let _voiceRecording  = false;
    let _voiceTimerInt   = null;
    let _voiceSeconds    = 0;

    async function toggleConnectVoiceRecording() {
        if (_voiceRecording) {
            // Stop and send
            _voiceRecorder.stop();
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            _voiceChunks    = [];
            _voiceRecording = true;
            _voiceSeconds   = 0;

            // Update voice button label to show recording state
            const lbl = document.getElementById('connect-voice-label');
            if (lbl) lbl.textContent = 'Stop Recording';
            const menuVoice = document.getElementById('connect-menu-voice');
            if (menuVoice) menuVoice.style.color = 'var(--red)';

            // Live timer in attach button
            const attachBtn = document.getElementById('connect-attach-btn');
            if (attachBtn) {
                attachBtn.style.background = 'rgba(255,77,106,0.12)';
                attachBtn.style.color      = 'var(--red)';
                attachBtn.style.borderColor= 'rgba(255,77,106,0.3)';
                attachBtn.innerHTML        = '<ion-icon name="radio-button-on-outline"></ion-icon>';
            }
            _voiceTimerInt = setInterval(() => {
                _voiceSeconds++;
                const m = String(Math.floor(_voiceSeconds / 60)).padStart(2,'0');
                const s = String(_voiceSeconds % 60).padStart(2,'0');
                if (attachBtn) attachBtn.title = `Recording ${m}:${s} — tap menu to stop`;
            }, 1000);

            _voiceRecorder = new MediaRecorder(stream);
            _voiceRecorder.ondataavailable = e => { if (e.data.size) _voiceChunks.push(e.data); };
            _voiceRecorder.onstop = async () => {
                clearInterval(_voiceTimerInt);
                stream.getTracks().forEach(t => t.stop());
                _voiceRecording = false;
                // Reset button
                const ab = document.getElementById('connect-attach-btn');
                if (ab) { ab.style.cssText = 'width:40px;height:40px;border-radius:50%;background:var(--surface-2);border:1px solid var(--border);color:var(--text-3);font-size:1.1rem;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:all 0.15s;'; ab.innerHTML = '<ion-icon name="add-outline"></ion-icon>'; ab.title = 'Attach'; }
                const vl = document.getElementById('connect-voice-label');
                if (vl) vl.textContent = 'Voice Note';
                const mv = document.getElementById('connect-menu-voice');
                if (mv) mv.style.color = '';

                if (!_voiceChunks.length || !activeSessionId || !currentUser) return;
                await uploadConnectVoiceNote();
            };
            _voiceRecorder.start();
        } catch(e) {
            _voiceRecording = false;
            clearInterval(_voiceTimerInt);
            alert('Microphone access denied');
        }
    }

    async function uploadConnectVoiceNote() {
        const mimeType = _voiceRecorder?.mimeType || 'audio/webm';
        const ext      = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
        const blob     = new Blob(_voiceChunks, { type: mimeType });

        const feed   = document.getElementById('user-chat-feed');
        const tempId = 'voice-' + Date.now();
        if (feed) {
            feed.insertAdjacentHTML('beforeend', `<div id="${tempId}" style="display:flex;justify-content:flex-end;width:100%;opacity:0.5;font-size:0.82rem;padding:4px 0;">🎤 Uploading…</div>`);
            feed.scrollTop = feed.scrollHeight;
        }

        try {
            const path = `connect-voice/${currentUser.id}/${Date.now()}.${ext}`;
            const { error: upErr } = await supabase.storage.from('voice_notes').upload(path, blob, { contentType: mimeType });
            if (upErr) { document.getElementById(tempId)?.remove(); alert('Voice upload failed'); return; }

            const { data: urlData } = supabase.storage.from('voice_notes').getPublicUrl(path);
            const publicUrl = urlData.publicUrl;

            document.getElementById(tempId)?.remove();
            const msgContent = `AUDIO::${publicUrl}`;
            if (feed) {
                feed.insertAdjacentHTML('beforeend', buildMessageBubble('temp-' + Date.now(), msgContent, true));
                feed.scrollTop = feed.scrollHeight;
            }
            await supabase.from('messages').insert([{
                session_id: activeSessionId,
                sender_id:  currentUser.id,
                content:    msgContent,
                media_url:  publicUrl,
                media_type: 'audio',
            }]);
        } catch(err) {
            document.getElementById(tempId)?.remove();
            console.error('Connect voice upload error:', err);
        }
    }

    function renderUserMessage(msg) {
        if (renderedMessageIds.has(msg.id)) return;
        renderedMessageIds.add(msg.id);

        const feed = document.getElementById('user-chat-feed');
        if (!feed) return;
        const isMe = msg.sender_id === currentUser.id;
        let html = '';

        if (msg.content === '###CALL_REQUEST###') {
            html = isMe
                ? `<div id="msg-${msg.id}" style="text-align:center;padding:10px 0;font-size:0.75rem;color:var(--text-3);"><ion-icon name="call-outline" style="vertical-align:middle;margin-right:4px;"></ion-icon>Voice call requested — waiting for listener</div>`
                : `<div id="msg-${msg.id}" style="text-align:center;padding:10px 0;"><button onclick="window.acceptMidChatCall()" style="padding:10px 20px;background:var(--accent-dim);border:1px solid var(--accent-mid);color:var(--accent);border-radius:20px;cursor:pointer;font-size:0.85rem;font-weight:700;font-family:inherit;display:inline-flex;align-items:center;gap:6px;"><ion-icon name="call-outline"></ion-icon> Accept Voice Call</button></div>`;
        } else {
            html = buildMessageBubble(msg.id, msg.content, isMe);
        }
        // Remove optimistic temp bubbles (dedupe against the confirmed DB message)
        if (isMe) feed.querySelectorAll('[id^="msg-temp-"]').forEach(el => el.remove());
        feed.insertAdjacentHTML('beforeend', html);
        feed.scrollTop = feed.scrollHeight;
    }

    let _callMuted = false;
    let _speakerOff = false;

    async function startVoiceCallInterface() {
        currentUIState = 'call';
        _callMuted = false;
        _speakerOff = false;
        if (messagePollInterval) clearInterval(messagePollInterval);
        if (chatChannel) supabase.removeChannel(chatChannel);

        const grid = document.getElementById('listener-grid');
        grid.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:70vh;padding:24px;gap:0;';

        grid.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;gap:20px;width:100%;max-width:340px;">

                <!-- Animated avatar -->
                <div id="call-avatar-ring" style="width:110px;height:110px;border-radius:50%;background:radial-gradient(circle at 35% 35%,rgba(0,212,170,0.18),rgba(0,0,0,0.5));border:2px solid rgba(0,212,170,0.35);box-shadow:0 0 0 0 rgba(0,212,170,0.3);display:flex;align-items:center;justify-content:center;animation:callPulse 2s infinite;">
                    <ion-icon name="people-outline" style="font-size:2.8rem;color:var(--accent);"></ion-icon>
                </div>

                <div style="text-align:center;">
                    <div style="font-size:1.15rem;font-weight:700;margin-bottom:4px;">Voice Call Active</div>
                    <div id="call-status" style="font-size:0.82rem;color:var(--text-3);">Connecting audio…</div>
                </div>

                <audio id="remote-audio" autoplay playsinline></audio>

                <!-- Call controls -->
                <div style="display:flex;align-items:center;gap:16px;margin-top:8px;">

                    <!-- Mute -->
                    <button id="call-mute-btn" onclick="window.toggleConnectMute()"
                        style="width:54px;height:54px;border-radius:50%;background:var(--surface-2);border:1px solid var(--border);color:var(--text-2);font-size:1.4rem;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all 0.2s;-webkit-tap-highlight-color:transparent;">
                        <ion-icon name="mic-outline"></ion-icon>
                    </button>

                    <!-- End call (centre, large red) -->
                    <button onclick="window.endUserSession()"
                        style="width:68px;height:68px;border-radius:50%;background:var(--red);border:none;color:white;font-size:1.7rem;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 20px rgba(255,77,106,0.4);transition:opacity 0.2s;-webkit-tap-highlight-color:transparent;">
                        <ion-icon name="call-outline" style="transform:rotate(135deg);"></ion-icon>
                    </button>

                    <!-- Speaker -->
                    <button id="call-speaker-btn" onclick="window.toggleConnectSpeaker()"
                        style="width:54px;height:54px;border-radius:50%;background:var(--surface-2);border:1px solid var(--border);color:var(--text-2);font-size:1.4rem;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all 0.2s;-webkit-tap-highlight-color:transparent;">
                        <ion-icon name="volume-high-outline"></ion-icon>
                    </button>

                </div>

                <!-- Back to chat link -->
                <button onclick="window.revertToChat()"
                    style="background:none;border:none;color:var(--text-3);font-size:0.8rem;cursor:pointer;font-family:inherit;padding:8px;text-decoration:underline;text-underline-offset:3px;">
                    Switch to text chat
                </button>

            </div>

            <style>
                @keyframes callPulse {
                    0%,100% { box-shadow: 0 0 0 0 rgba(0,212,170,0.3); }
                    50%      { box-shadow: 0 0 0 18px rgba(0,212,170,0); }
                }
            </style>
        `;
        // Clean up any stale WebRTC state from a previous call before re-initiating
        stopWebRTC();
        // USER is always the OFFERER in the unified handshake protocol
        initWebRTC(true);
    }

    // ============================================================
    // WEBRTC FIX: Unified handshake protocol
    //
    // ROOT CAUSE: The old connect-user.js used a "ready" ping/pong
    // protocol. The old listener-console.js used a completely
    // different "request-offer" protocol. The two sides never
    // understood each other, so the offer was never sent and the
    // call was stuck at "Connecting audio..." forever.
    //
    // FIX: Both files now use ONE shared protocol:
    //   - User  (isOfferer=true):  subscribes → immediately sends offer
    //   - Listener (isOfferer=false): subscribes → waits for offer → sends answer
    //
    // The offerer also retries every 4s if no answer arrives (race
    // condition guard for when one side subscribes before the other).
    // ============================================================
    async function initWebRTC(isOfferer) {
        try {
            // WhatsApp-quality mic: enable browser DSP (echo cancel, noise
            // suppression, auto gain) and prefer 48 kHz mono for Opus.
            // Drop explicit channelCount/sampleRate — Android Chrome rejects or
            // returns silent tracks on some devices when these are pinned.
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl:  true,
                },
            });
        } catch (err) {
            document.getElementById('call-status').innerText = "Microphone access denied.";
            alert("Microphone required for voice call. Reverting to secure chat.");
            return window.revertToChat();
        }

        // Feature 1: fetch fresh TURN credentials from backend for reliable NAT traversal
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
        // Explicit transceiver with sendrecv direction — defends against buggy
        // SDP where addTrack alone produces a sendonly direction on some browsers.
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

        // ── WebRTC diagnostics ────────────────────────────────────────────────
        // Log every state transition and surface ICE errors. Without this, a
        // failed call is a silent black box. Also run getStats every 3s to prove
        // whether RTP is actually flowing.
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
                })
                .catch(err => {
                    console.warn('[WebRTC] remote audio autoplay blocked:', err.message);
                    const statusEl = document.getElementById('call-status');
                    if (statusEl) {
                        statusEl.innerHTML = '<button onclick="document.getElementById(\'remote-audio\').play()" style="background:#4CAF50;color:#fff;border:none;padding:8px 16px;border-radius:20px;cursor:pointer;">🔊 Tap to enable audio</button>';
                    }
                });

            // Retry on first RTP arrival — handles Android/Chromium where the
            // track is muted until the first packet lands.
            event.track.onunmute = () => {
                console.log('[WebRTC] remote track unmuted');
                tryPlay();
            };
            tryPlay();
        };

        peerConnection.onconnectionstatechange = async () => {
            const state = peerConnection.connectionState;
            const statusEl = document.getElementById('call-status');
            if (!statusEl) return;
            if (state === 'connected') statusEl.innerText = "Connected • Secure Voice Channel";
            if (state === 'disconnected') statusEl.innerText = "Reconnecting…";
            // Auto ICE-restart on failure (offerer side only — answerer follows)
            if (state === 'failed' && isOfferer) {
                statusEl.innerText = "Reconnecting…";
                try {
                    const offer = await peerConnection.createOffer({ iceRestart: true });
                    // Opus SDP munging removed — it broke audio on Android/Windows Chromium
            // (usedtx=1 suppressed silent frames that Chromium was expecting; the
            // answerer-side rewrite also violated the spec's "answer mirrors offer"
            // rule, leaving connected-but-silent calls).
                    await peerConnection.setLocalDescription(offer);
                    rtcChannel?.send({ type: 'broadcast', event: 'offer', payload: { offer } });
                } catch (e) { statusEl.innerText = "Connection lost. End and restart."; }
            }
        };

        if (rtcChannel) supabase.removeChannel(rtcChannel);
        rtcChannel = supabase.channel('rtc_' + activeSessionId);

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                rtcChannel.send({ type: 'broadcast', event: 'ice-candidate', payload: { candidate: event.candidate } });
            }
        };

        // Shared offer/answer/ice handlers — same on both sides
        rtcChannel
            .on('broadcast', { event: 'offer' }, async (payload) => {
                // Only the answerer handles incoming offers
                if (isOfferer) return;
                if (peerConnection.signalingState !== 'stable') return;
                await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.payload.offer));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                rtcChannel.send({ type: 'broadcast', event: 'answer', payload: { answer } });
                // Flush buffered ICE candidates
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

                if (isOfferer) {
                    const offer = await peerConnection.createOffer();
                    // Tune Opus for voice: stereo off, DTX on, max bitrate 40 kbps.
                    // Mirrors WhatsApp/Zoom defaults — drastically improves
                    // intelligibility and reduces jitter on mobile networks.
                    // Opus SDP munging removed — it broke audio on Android/Windows Chromium
            // (usedtx=1 suppressed silent frames that Chromium was expecting; the
            // answerer-side rewrite also violated the spec's "answer mirrors offer"
            // rule, leaving connected-but-silent calls).
                    await peerConnection.setLocalDescription(offer);
                    rtcChannel.send({ type: 'broadcast', event: 'offer', payload: { offer } });

                    // Retry every 3 s for 27 s while we wait for the answer.
                    let offerRetries = 0;
                    const offerRetryTimer = setInterval(() => {
                        if (!peerConnection || peerConnection.signalingState !== 'have-local-offer' || offerRetries >= 9) {
                            clearInterval(offerRetryTimer);
                            return;
                        }
                        rtcChannel.send({ type: 'broadcast', event: 'offer', payload: { offer } });
                        offerRetries++;
                    }, 3000);

                    // Connection-timeout watchdog: if we're not connected in 25 s
                    // the call is effectively dead. Show a "Call failed — retry"
                    // state instead of leaving the user staring at "Connecting…"
                    // forever.
                    setTimeout(() => {
                        if (!peerConnection) return;
                        const st = peerConnection.connectionState;
                        if (st === 'connected' || st === 'closed') return;
                        const statusEl = document.getElementById('call-status');
                        if (statusEl) {
                            statusEl.innerHTML = 'Call failed to connect. <button onclick="window.location.reload()" style="background:#4CAF50;color:#fff;border:none;padding:6px 14px;border-radius:16px;cursor:pointer;margin-left:8px;">Retry</button>';
                        }
                    }, 25000);
                }
                // Answerer (listener) just waits — no action needed here
            });
    }

    window.toggleConnectMute = function() {
        if (!localStream) return;
        _callMuted = !_callMuted;
        localStream.getAudioTracks().forEach(t => { t.enabled = !_callMuted; });
        const btn = document.getElementById('call-mute-btn');
        if (btn) {
            btn.style.background = _callMuted ? 'rgba(255,77,106,0.15)' : 'var(--surface-2)';
            btn.style.borderColor = _callMuted ? 'rgba(255,77,106,0.4)' : 'var(--border)';
            btn.style.color = _callMuted ? 'var(--red)' : 'var(--text-2)';
            btn.querySelector('ion-icon').setAttribute('name', _callMuted ? 'mic-off-outline' : 'mic-outline');
        }
    };

    window.toggleConnectSpeaker = function() {
        _speakerOff = !_speakerOff;
        const audio = document.getElementById('remote-audio');
        if (audio) audio.muted = _speakerOff;
        const btn = document.getElementById('call-speaker-btn');
        if (btn) {
            btn.style.background = _speakerOff ? 'rgba(255,77,106,0.15)' : 'var(--surface-2)';
            btn.style.borderColor = _speakerOff ? 'rgba(255,77,106,0.4)' : 'var(--border)';
            btn.style.color = _speakerOff ? 'var(--red)' : 'var(--text-2)';
            btn.querySelector('ion-icon').setAttribute('name', _speakerOff ? 'volume-mute-outline' : 'volume-high-outline');
        }
    };

    function stopWebRTC() {
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        if (peerConnection) peerConnection.close();
        if (rtcChannel) supabase.removeChannel(rtcChannel);
    }

    let _finalized = false;
    window.handleSessionEnd = function() {
        if (_finalized) return;
        _finalized = true;
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

    window.endUserSession = async function() {
        if (!activeSessionId) return;
        const sessId = activeSessionId;
        const listenerId = activeListenerId;
        // Freeze watchers BEFORE flipping status — otherwise the realtime UPDATE
        // or the 800ms poll fires syncSessionStatus → handleSessionEnd, which
        // replaces document.body and wipes the rating modal before the user sees it.
        isEnding = true;
        if (sessionPollInterval) clearInterval(sessionPollInterval);
        if (messagePollInterval) clearInterval(messagePollInterval);
        if (sessionChannel) supabase.removeChannel(sessionChannel);
        if (chatChannel) supabase.removeChannel(chatChannel);
        stopWebRTC();
        await supabase.from('connect_sessions').update({ status: 'completed' }).eq('id', sessId);
        await autoJournalConnectSession(sessId);
        showRatingModal(sessId, listenerId);
    };

    // Feature 6: rating modal
    function showRatingModal(sessionId, listenerId) {
        let selectedStars = 0;
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px;';
        overlay.innerHTML = `
            <div style="background:var(--surface-1);border:1px solid var(--border);border-radius:24px;padding:28px 24px;max-width:340px;width:100%;text-align:center;">
                <div style="font-size:2rem;margin-bottom:8px;">✨</div>
                <h3 style="margin:0 0 6px;font-size:1.05rem;">How was your session?</h3>
                <p style="font-size:0.82rem;color:var(--text-3);margin:0 0 18px;">Your feedback helps listeners improve.</p>
                <div id="star-row" style="display:flex;justify-content:center;gap:10px;margin-bottom:16px;font-size:2rem;cursor:pointer;">
                    ${[1,2,3,4,5].map(n => `<span data-star="${n}" style="opacity:0.3;transition:opacity 0.15s;">★</span>`).join('')}
                </div>
                <textarea id="review-text" placeholder="Optional — share your thoughts…"
                    style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:10px 12px;color:var(--text);font-size:0.83rem;font-family:inherit;resize:none;outline:none;line-height:1.5;height:72px;margin-bottom:14px;"></textarea>
                <div style="display:flex;gap:10px;">
                    <button id="skip-review-btn"
                        style="flex:1;padding:11px;background:var(--surface-2);border:1px solid var(--border);border-radius:12px;color:var(--text-3);font-size:0.85rem;cursor:pointer;font-family:inherit;">
                        Skip
                    </button>
                    <button id="submit-review-btn"
                        style="flex:2;padding:11px;background:var(--accent);border:none;border-radius:12px;color:white;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit;opacity:0.4;pointer-events:none;">
                        Submit
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // Star interaction
        const stars = overlay.querySelectorAll('[data-star]');
        stars.forEach(star => {
            star.addEventListener('click', () => {
                selectedStars = Number(star.dataset.star);
                stars.forEach(s => { s.style.opacity = Number(s.dataset.star) <= selectedStars ? '1' : '0.3'; });
                const btn = overlay.querySelector('#submit-review-btn');
                btn.style.opacity = '1'; btn.style.pointerEvents = 'auto';
            });
        });

        overlay.querySelector('#skip-review-btn').addEventListener('click', () => {
            overlay.remove(); handleSessionEnd();
        });

        overlay.querySelector('#submit-review-btn').addEventListener('click', async () => {
            if (!selectedStars) return;
            const reviewText = overlay.querySelector('#review-text').value.trim() || null;
            overlay.remove();
            try {
                await supabase.from('listener_reviews').insert([{
                    session_id: sessionId,
                    listener_id: listenerId,
                    user_id: currentUser.id,
                    rating: selectedStars,
                    review_text: reviewText,
                }]);
            } catch (e) { /* non-blocking */ }
            handleSessionEnd();
        });
    }

    // ── Auto-journal a completed Human Connect session ─────────────────────────
    async function autoJournalConnectSession(sessionId) {
        try {
            const { data: sess } = await supabase.from('connect_sessions')
                .select('session_type, user_id').eq('id', sessionId).maybeSingle();
            if (!sess || !currentUser) return;

            const { data: msgs } = await supabase.from('messages')
                .select('sender_id, content').eq('session_id', sessionId).order('created_at');
            if (!msgs || msgs.length < 2) return;

            // Build transcript (filter system messages)
            const transcript = msgs
                .filter(m => m.content && !m.content.startsWith('###'))
                .map(m => ({
                    role: m.sender_id === currentUser.id ? 'user' : 'assistant',
                    content: m.content
                }));
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

            // One-per-day: check for existing today's entry of same source
            const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
            const { data: todayEntry } = await supabase
                .from('journals')
                .select('id, content')
                .eq('user_id', currentUser.id)
                .eq('ai_source', aiSource)
                .gte('created_at', todayStart.toISOString())
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle();

            if (todayEntry) {
                await supabase.from('journals').update({
                    title,
                    content: todayEntry.content + '\n\n---\n\n' + content
                }).eq('id', todayEntry.id);
            } else {
                await supabase.from('journals').insert([{
                    user_id: currentUser.id, title, content, ai_source: aiSource
                }]);
            }
        } catch(e) { /* non-blocking */ }
    }

    window.viewPastSession = async function(sessionId, name) {
        const { data: msgs } = await supabase.from('messages').select('*').eq('session_id', sessionId).order('created_at', { ascending: true });

        let msgHtml = msgs && msgs.length > 0 ? msgs.map(m => {
            const isMe = m.sender_id === currentUser.id;
            const content = m.content === '###CALL_REQUEST###' ? '📞 Voice Call Requested' : m.content;
            return `<div style="display: flex; justify-content: ${isMe ? 'flex-end' : 'flex-start'}; width: 100%;">
                        <div style="background: ${isMe ? 'var(--text-color)' : 'var(--glass-inner)'}; color: ${isMe ? 'var(--bg-color)' : 'var(--text-color)'}; padding: 10px 15px; border-radius: 12px; max-width: 75%; word-wrap: break-word;">
                            ${content}
                        </div>
                    </div>`;
        }).join('') : '<div style="text-align:center; opacity:0.5; width: 100%;">No messages in this session.</div>';

        const modalHTML = `
            <div id="history-modal" class="auth-overlay active" style="display:flex; z-index:9999; justify-content:center; align-items:center;">
                <div class="glass-pane" style="width: 90%; max-width: 500px; height: 70vh; display: flex; flex-direction: column; padding: 20px; background: var(--bg-color);">
                    <div style="display: flex; justify-content: space-between; align-items:center; border-bottom: 1px solid var(--glass-border); padding-bottom: 15px; margin-bottom: 15px;">
                        <h3 style="margin:0;"><ion-icon name="time-outline"></ion-icon> Transcript: ${name}</h3>
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