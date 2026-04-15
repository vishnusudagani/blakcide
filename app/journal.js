document.addEventListener('DOMContentLoaded', () => {

    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    let supabase;
    if (typeof window.supabase !== 'undefined') {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    } else { return console.error("Supabase failed to load."); }

    let currentUser = null;
    let currentEntryId = null;
    let currentView = 'main';

    // Silently grab rough GPS on load for location search bias.
    // Also reverse-geocode to get country code + city for better Nominatim results.
    let userLat = null;
    let userLon = null;
    let userCountryCode = null;
    let userCity = null;
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                userLat = pos.coords.latitude;
                userLon = pos.coords.longitude;
                try {
                    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${userLat}&lon=${userLon}&zoom=10`, {
                        headers: { 'Accept-Language': 'en', 'User-Agent': 'BlakcideApp/1.0' }
                    });
                    const data = await res.json();
                    userCountryCode = data.address?.country_code || null;
                    userCity = data.address?.city || data.address?.town || data.address?.state || null;
                } catch(e) {}
            },
            () => {}
        );
    }

    // FIX: Also add mediaUrls declaration here so it exists before any
    // button handler tries to use it (previously was missing, crashing new entry)
    let mediaUrls = { image: null, video: null, audio: null, spotify: null };

    const getEl = (id) => document.getElementById(id);
    const click = (id, fn) => { const el = getEl(id); if(el) el.addEventListener('click', fn); };
    
    function showToast(msg) {
        const t = document.createElement('div'); t.className='toast'; t.innerText=msg;
        getEl('toast-container').appendChild(t); setTimeout(()=>t.remove(), 3000);
    }

    // --- LIGHTBOX ---
    if (!getEl('media-lightbox')) {
        document.body.insertAdjacentHTML('beforeend', `
        <div id="media-lightbox" class="overlay-glass" style="z-index: 10000; align-items: center; justify-content: center; cursor: pointer;" onclick="this.classList.remove('active')">
            <div style="position: relative; max-width: 95%; max-height: 95%; display: flex; align-items: center; justify-content: center;" onclick="event.stopPropagation()">
                <button class="brand-small-btn" style="position: absolute; top: -45px; right: 0; color: white; background: rgba(0,0,0,0.4);" onclick="document.getElementById('media-lightbox').classList.remove('active')"><ion-icon name="close" style="font-size: 1.8rem;"></ion-icon></button>
                <img id="lightbox-img" src="" style="max-width: 100%; max-height: 85vh; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.8);">
            </div>
        </div>`);
    }
    window.openLightbox = function(src) { getEl('lightbox-img').src = src; getEl('media-lightbox').classList.add('active'); }

    async function enforceSession() {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error || !session) window.location.href = '../index.html'; 
        else { currentUser = session.user; loadSidebar(); }
    }

    // --- NAVIGATION ---
    click('nav-dashboard-btn', () => { window.location.href = 'dashboard.html'; });
    click('toggle-sidebar-btn', () => { window.innerWidth <= 768 ? getEl('main-sidebar').classList.remove('open') : getEl('main-sidebar').classList.toggle('collapsed'); });
    click('mobile-menu-btn', () => { getEl('main-sidebar').classList.add('open'); getEl('mobile-overlay')?.classList.add('active'); });
    // Overlay click closes sidebar
    getEl('mobile-overlay')?.addEventListener('click', () => { getEl('main-sidebar').classList.remove('open'); getEl('mobile-overlay').classList.remove('active'); });

    click('new-entry-btn', () => {
        currentEntryId = null;
        mediaUrls = { image: null, video: null, audio: null, spotify: null, spotifyMeta: null };
        renderMediaPreviews();
        
        getEl('entry-title').value = '';
        getEl('entry-content').value = '';
        
        if(getEl('emotion-select')) getEl('emotion-select').value = '';
        
        const locInp = getEl('location-input');
        if(locInp) { locInp.value = ''; locInp.dataset.lat = ''; locInp.dataset.lon = ''; locInp.classList.remove('loc-input-focused'); }
        const clrBtn = getEl('loc-clear-btn');
        if(clrBtn) clrBtn.style.display = 'none';

        if(getEl('reflect-ai-btn')) getEl('reflect-ai-btn').style.display = 'none';

        getEl('delete-entry-btn').style.display = 'none';
        getEl('mobile-journal-title').innerText = "New Entry";
        getEl('main-sidebar').classList.remove('open');
        
        const statusIndicator = getEl('save-entry-btn');
        if(statusIndicator) statusIndicator.innerText = "Saved";
    });

    // ==========================================
    // ENHANCED LOCATION PICKER (Google Maps-style)
    // ==========================================
    let locTimeout;
    let locKeyIndex = -1;
    const locInput = getEl('location-input');
    const locSuggs = getEl('location-suggestions');
    const locClearBtn = getEl('loc-clear-btn');

    // Category icon map for Nominatim place types
    const LOC_ICONS = {
        restaurant: '🍽️', cafe: '☕', bar: '🍸', fast_food: '🍔', food: '🍽️',
        hotel: '🏨', hostel: '🛏️', tourism: '🏛️', museum: '🎨', attraction: '🎡',
        park: '🌳', nature: '🌿', garden: '🌻', water: '🌊',
        hospital: '🏥', pharmacy: '💊', clinic: '🏥', doctors: '🏥',
        bus_stop: '🚌', subway: '🚇', train_station: '🚂', station: '🚂', airport: '✈️', aerodrome: '✈️',
        fuel: '⛽', parking: '🅿️', supermarket: '🛒', shop: '🛍️', mall: '🛍️', marketplace: '🛍️',
        school: '🏫', university: '🎓', college: '🎓', library: '📚',
        bank: '🏦', atm: '🏧', cinema: '🎬', theatre: '🎭',
        place_of_worship: '🛕', church: '⛪', mosque: '🕌', temple: '🛕',
        sports: '⚽', stadium: '🏟️', gym: '🏋️', swimming: '🏊',
        office: '🏢', government: '🏛️', police: '🚔', fire_station: '🚒',
        residential: '🏘️', city: '🏙️', town: '🏘️', village: '🏡', suburb: '🏘️',
        boundary: '🗺️', administrative: '🗺️'
    };

    function getLocIcon(place) {
        const cat = ((place.category || '') + ' ' + (place.type || '')).toLowerCase();
        for (const key of Object.keys(LOC_ICONS)) {
            if (cat.includes(key)) return LOC_ICONS[key];
        }
        return '📍';
    }

    // Recent locations stored in localStorage
    function getRecentLocations() {
        try { return JSON.parse(localStorage.getItem('blakcide_recent_locations') || '[]'); } catch { return []; }
    }
    function saveRecentLocation(name, lat, lon) {
        let recents = getRecentLocations().filter(r => r.name !== name);
        recents.unshift({ name, lat, lon });
        if (recents.length > 5) recents = recents.slice(0, 5);
        localStorage.setItem('blakcide_recent_locations', JSON.stringify(recents));
    }

    function buildSuggestionRow(icon, name, address, lat, lon) {
        const safeName = name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        return `<button type="button" class="loc-result-row" tabindex="-1"
            onclick="window.selectLocation('${safeName}', '${lat}', '${lon}')">
            <span class="loc-result-icon">${icon}</span>
            <span class="loc-result-text">
                <span class="loc-result-name">${name}</span>
                ${address ? `<span class="loc-result-addr">${address}</span>` : ''}
            </span>
        </button>`;
    }

    function showLocSuggestions() { locSuggs.classList.add('open'); locKeyIndex = -1; }
    function hideLocSuggestions() { locSuggs.classList.remove('open'); locKeyIndex = -1; }

    function updateClearBtn() {
        if (locClearBtn) locClearBtn.style.display = locInput.value ? 'flex' : 'none';
    }

    function renderRecentLocations() {
        const recents = getRecentLocations();
        let html = '';
        // GPS option always first
        html += `<button type="button" class="loc-result-row" tabindex="-1" onclick="window.useGPSLocation()">
            <span class="loc-result-icon" style="color: var(--accent-red);">📌</span>
            <span class="loc-result-text"><span class="loc-result-name">Use Current GPS</span></span>
        </button>`;
        if (recents.length > 0) {
            html += `<div class="loc-divider"></div>`;
            html += `<div class="loc-recent-header">Recent</div>`;
            recents.forEach(r => { html += buildSuggestionRow('🕐', r.name, '', r.lat, r.lon); });
        }
        locSuggs.innerHTML = html;
        showLocSuggestions();
    }

    if (locInput && locSuggs) {
        locInput.addEventListener('focus', () => {
            locInput.classList.add('loc-input-focused');
            // Show recent locations on focus if input is empty
            if (!locInput.value.trim()) renderRecentLocations();
        });

        locInput.addEventListener('blur', () => {
            if (!locInput.value) locInput.classList.remove('loc-input-focused');
            setTimeout(() => hideLocSuggestions(), 250);
        });

        locInput.addEventListener('input', (e) => {
            clearTimeout(locTimeout);
            const query = e.target.value.trim();
            updateClearBtn();

            // Clear exact coordinates when user types new text
            locInput.dataset.lat = '';
            locInput.dataset.lon = '';
            triggerAutoSave();

            if (query.length < 2) {
                if (query.length === 0) renderRecentLocations();
                else hideLocSuggestions();
                return;
            }

            locSuggs.innerHTML = `<div style="text-align:center; padding:12px; opacity:0.5; font-size:0.85rem;">Searching...</div>`;
            showLocSuggestions();

            locTimeout = setTimeout(async () => {
                try {
                    // GPS option always first
                    let html = `<button type="button" class="loc-result-row" tabindex="-1" onclick="window.useGPSLocation()">
                        <span class="loc-result-icon" style="color: var(--accent-red);">📌</span>
                        <span class="loc-result-text"><span class="loc-result-name">Use Current GPS</span></span>
                    </button>`;

                    // Build search query — append city for short/generic terms
                    let searchQuery = query;
                    if (userCity && query.length <= 12 && !query.includes(',')) {
                        searchQuery = `${query} near ${userCity}`;
                    }

                    let nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&addressdetails=1&limit=8`;
                    // Country code bias for much better regional results
                    if (userCountryCode) {
                        nominatimUrl += `&countrycodes=${userCountryCode}`;
                    }
                    // Tight GPS viewbox with bounded=1 to strongly prefer nearby
                    if (userLat && userLon) {
                        const delta = 1.5; // ~170km box
                        const minLon = (userLon - delta).toFixed(4);
                        const minLat = (userLat - delta).toFixed(4);
                        const maxLon = (userLon + delta).toFixed(4);
                        const maxLat = (userLat + delta).toFixed(4);
                        nominatimUrl += `&viewbox=${minLon},${maxLat},${maxLon},${minLat}&bounded=0`;
                    }

                    const res = await fetch(nominatimUrl, {
                        headers: { 'Accept-Language': 'en', 'User-Agent': 'BlakcideApp/1.0' }
                    });
                    let data = await res.json();

                    // If location-biased search returns few results, fallback without city suffix
                    if (data.length < 2 && searchQuery !== query) {
                        let fallbackUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=6`;
                        if (userCountryCode) fallbackUrl += `&countrycodes=${userCountryCode}`;
                        const fb = await fetch(fallbackUrl, { headers: { 'Accept-Language': 'en', 'User-Agent': 'BlakcideApp/1.0' } });
                        const fbData = await fb.json();
                        if (fbData.length > data.length) data = fbData;
                    }

                    data.forEach(place => {
                        const parts = place.display_name.split(',');
                        const name = (place.name || parts[0] || '').trim();
                        const address = parts.slice(1, 4).join(',').trim();
                        const icon = getLocIcon(place);
                        html += buildSuggestionRow(icon, name, address, place.lat, place.lon);
                    });

                    locSuggs.innerHTML = html;
                    showLocSuggestions();
                } catch (err) {
                    locSuggs.innerHTML = `<div style="text-align:center; padding:12px; opacity:0.5; font-size:0.85rem;">Search unavailable</div>`;
                }
            }, 250);
        });

        // Keyboard navigation
        locInput.addEventListener('keydown', (e) => {
            const rows = locSuggs.querySelectorAll('.loc-result-row');
            if (!rows.length || !locSuggs.classList.contains('open')) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                locKeyIndex = Math.min(locKeyIndex + 1, rows.length - 1);
                rows[locKeyIndex].focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                locKeyIndex = Math.max(locKeyIndex - 1, 0);
                rows[locKeyIndex].focus();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (locKeyIndex >= 0 && rows[locKeyIndex]) rows[locKeyIndex].click();
            } else if (e.key === 'Escape') {
                hideLocSuggestions();
            }
        });

        // Allow arrow keys within dropdown
        locSuggs.addEventListener('keydown', (e) => {
            const rows = locSuggs.querySelectorAll('.loc-result-row');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                locKeyIndex = Math.min(locKeyIndex + 1, rows.length - 1);
                rows[locKeyIndex].focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                locKeyIndex--;
                if (locKeyIndex < 0) { locInput.focus(); locKeyIndex = -1; }
                else rows[locKeyIndex].focus();
            } else if (e.key === 'Escape') {
                hideLocSuggestions();
                locInput.focus();
            }
        });
    }

    // Clear button
    if (locClearBtn) {
        locClearBtn.addEventListener('click', () => {
            locInput.value = '';
            locInput.dataset.lat = '';
            locInput.dataset.lon = '';
            updateClearBtn();
            hideLocSuggestions();
            locInput.focus();
            triggerAutoSave();
        });
    }

    // Global helper to select a location from dropdown
    window.selectLocation = function(name, lat, lon) {
        locInput.value = name;
        locInput.dataset.lat = lat;
        locInput.dataset.lon = lon;
        hideLocSuggestions();
        updateClearBtn();
        saveRecentLocation(name, lat, lon);
        triggerAutoSave();
    };

    // Global helper for GPS fetching
    window.useGPSLocation = function() {
        if (!navigator.geolocation) return showToast("GPS not supported.");
        locInput.value = "Locating...";
        hideLocSuggestions();

        navigator.geolocation.getCurrentPosition(async (pos) => {
            const lat = pos.coords.latitude;
            const lon = pos.coords.longitude;
            try {
                const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
                const data = await res.json();
                const name = data.address.city || data.address.town || data.address.suburb || "Current Location";
                locInput.value = name;
                saveRecentLocation(name, lat, lon);
            } catch(e) {
                locInput.value = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
            }
            locInput.dataset.lat = lat;
            locInput.dataset.lon = lon;
            updateClearBtn();

            // Pin-drop animation
            const pinIcon = document.querySelector('.loc-pin-icon');
            if (pinIcon) {
                pinIcon.classList.add('pin-drop-anim');
                setTimeout(() => pinIcon.classList.remove('pin-drop-anim'), 600);
            }

            triggerAutoSave();
        }, () => { locInput.value = "Access denied"; updateClearBtn(); });
    };


    // ==========================================
    // AUTO-SAVE & AUTO-TITLE ENGINE
    // ==========================================
    let autoSaveTimer = null;
    let isGeneratingTitle = false;
    
    const statusIndicator = getEl('save-entry-btn');
    if (statusIndicator) {
        statusIndicator.style.pointerEvents = 'none';
        statusIndicator.style.background = 'transparent';
        statusIndicator.style.border = '1px solid var(--glass-border)';
        statusIndicator.style.color = 'var(--text-color)';
        statusIndicator.style.opacity = '0.6';
        statusIndicator.innerText = "Saved";
    }

    function triggerAutoSave() {
        if(statusIndicator) statusIndicator.innerText = "Saving...";
        clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(async () => { await performSave(); }, 1200); 
    }

    getEl('entry-title').addEventListener('input', triggerAutoSave);
    getEl('entry-content').addEventListener('input', triggerAutoSave);
    if(getEl('emotion-select')) getEl('emotion-select').addEventListener('change', triggerAutoSave);

    async function performSave() {
        let title = getEl('entry-title').value.trim();
        const content = getEl('entry-content').value.trim();
        const emotionSelect = getEl('emotion-select');
        const emotion = emotionSelect ? emotionSelect.value : null;

        // Process location link generation
        let finalLocation = null;
        const locVal = locInput ? locInput.value.trim() : '';
        if (locVal && locVal !== 'Locating...') {
            const lat = locInput.dataset.lat;
            const lon = locInput.dataset.lon;
            let mapLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(locVal)}`; // Text search fallback
            if (lat && lon) mapLink = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`; // Exact coordinate pinpoint
            finalLocation = `<a href="${mapLink}" target="_blank" style="color:inherit; text-decoration:underline;">${locVal}</a>`;
        }
        
        if (!content && !mediaUrls.image && !mediaUrls.video && !mediaUrls.audio && !mediaUrls.spotify) {
            if(statusIndicator) statusIndicator.innerText = "Saved";
            return;
        }

        if (!title && content.length > 20 && !isGeneratingTitle) {
            isGeneratingTitle = true;
            try {
                const prompt = [{ role: 'user', content: `Create a very simple 3 to 5 word title for this journal entry. Reply ONLY with the title. Entry: "${content.substring(0, 300)}"` }];
                const aiTitle = await window.BlakcideAI.getResponse(prompt);
                title = aiTitle.replace(/["']/g, "").trim();
                getEl('entry-title').value = title;
            } catch(e) { title = 'Untitled'; }
            isGeneratingTitle = false;
        } else if (!title) { title = 'Untitled'; }

        const payload = {
            user_id: currentUser.id, title: title, content: content, emotion: emotion, location: finalLocation,
            image_url: mediaUrls.image, video_url: mediaUrls.video, audio_url: mediaUrls.audio,
            spotify_url: mediaUrls.spotify || null,
            ...(mediaUrls.imageDescription ? { image_description: mediaUrls.imageDescription } : {})
        };
        
        try {
            if (currentEntryId) {
                const { error } = await supabase.from('journals').update(payload).eq('id', currentEntryId);
                if (error) throw error;
            } else {
                const { data, error } = await supabase.from('journals').insert([payload]).select().single();
                if (error) throw error;
                if (data && data.id) {
                    currentEntryId = data.id;
                    getEl('delete-entry-btn').style.display = 'block';
                }
            }
            if(statusIndicator) statusIndicator.innerText = "Saved";
            if(getEl('reflect-ai-btn')) getEl('reflect-ai-btn').style.display = 'flex';
            loadSidebar();
        } catch (error) {
            console.error("Journal save failed:", error);
            if(statusIndicator) statusIndicator.innerText = "Error Saving";
            showToast("Save failed: " + (error.message || "Unknown error"));
        }
    }


    // ==========================================
    // IN-ENTRY AI REFLECTION CHAT
    // ==========================================
    let entryChatHistory = [];
    
    click('reflect-ai-btn', () => {
        const title = getEl('entry-title').value || 'Untitled';
        const content = getEl('entry-content').value;
        const emotion = getEl('emotion-select') ? getEl('emotion-select').value : '';

        if(!content) return showToast("Write something first so I have context.");

        const feed = getEl('entry-chat-feed');
        if(feed) feed.innerHTML = `<div class="message ai-msg" style="margin-top:auto;"><div class="msg-content">I've read your entry "${title}". I'm here to listen. Tell me more about what's on your mind.</div></div>`;

        // Include any attached image context in the system prompt
        const imageContext = mediaUrls.image
            ? ` They also attached a photo to this entry${mediaUrls.imageDescription ? ': "' + mediaUrls.imageDescription + '"' : ''}.`
            : '';

        entryChatHistory = [{
            role: 'system',
            content: `You are the Sanctuary AI, an empathetic journaling companion. The user is reflecting on an entry they wrote titled "${title}". Content: "${content}". They noted feeling ${emotion || 'neutral'}.${imageContext} Act as a supportive friend helping them explore these specific thoughts. Keep answers concise, warm, and therapeutic.`
        }];

        // If there's an attached image, send it as a vision message so the AI can actually see it
        if (mediaUrls.image) {
            entryChatHistory.push({
                role: 'user',
                content: [
                    { type: 'text', text: 'Here is the photo I attached to this journal entry.' },
                    { type: 'image_url', image_url: { url: mediaUrls.image, detail: 'auto' } }
                ]
            });
        }

        getEl('entry-chat-modal')?.classList.add('active');
    });

    const chatForm = getEl('entry-chat-form');
    if (chatForm) {
        chatForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const inp = getEl('entry-chat-input');
            const text = inp.value.trim();
            if(!text) return;
            inp.value = '';
            
            const feed = getEl('entry-chat-feed');
            feed.innerHTML += `<div class="message user-msg"><div class="msg-content">${text}</div></div>`;
            feed.scrollTop = feed.scrollHeight;
            entryChatHistory.push({ role: 'user', content: text });
            
            const loadId = 'loading-' + Date.now();
            feed.innerHTML += `<div id="${loadId}" class="message ai-msg"><div class="msg-content">Thinking...</div></div>`;
            feed.scrollTop = feed.scrollHeight;
            
            try {
                const reply = await window.BlakcideAI.getResponse(entryChatHistory);
                const loadEl = document.getElementById(loadId);
                if(loadEl) loadEl.remove();
                feed.innerHTML += `<div class="message ai-msg"><div class="msg-content">${reply}</div></div>`;
                entryChatHistory.push({ role: 'assistant', content: reply });
                feed.scrollTop = feed.scrollHeight;
            } catch(e) {
                const loadEl = document.getElementById(loadId);
                if(loadEl) loadEl.remove();
                showToast("Connection issue.");
            }
        });
    }

    // ==========================================
    // LOADING & SIDEBAR LOGIC
    // ==========================================
    async function loadSidebar() {
        const list = getEl('journal-list');
        if(!list) return;

        try {
            const { data: entries, error } = await supabase.from('journals').select('*').eq('user_id', currentUser.id).order('created_at', {ascending: false});
            if (error) throw error;
            
            list.innerHTML = '';
            const vaultData = JSON.parse(localStorage.getItem('blakcide_vault_' + currentUser.id) || '{"journals":[]}');
            if (!vaultData.journals) vaultData.journals = [];

            let filteredEntries = [];
            if (currentView === 'archive') filteredEntries = entries.filter(e => e.is_archived === true && !vaultData.journals.includes(e.id));
            else if (currentView === 'vault') filteredEntries = entries.filter(e => vaultData.journals.includes(e.id));
            else filteredEntries = entries.filter(e => e.is_archived !== true && !vaultData.journals.includes(e.id));

            if (filteredEntries.length === 0) return list.innerHTML = '<div style="padding: 15px; opacity: 0.6; text-align: center;">No entries found.</div>';

            const today = new Date(); const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
            let currentGroupName = "";

            filteredEntries.forEach(entry => {
                const d = new Date(entry.created_at);
                let groupName = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
                if (d.toDateString() === today.toDateString()) groupName = "Today";
                else if (d.toDateString() === yesterday.toDateString()) groupName = "Yesterday";

                if (groupName !== currentGroupName) {
                    const header = document.createElement('div');
                    header.style.cssText = "font-size: 0.75rem; color: var(--text-color); opacity: 0.5; padding: 15px 15px 5px 15px; text-transform: uppercase; letter-spacing: 1px; font-weight: bold;";
                    header.innerText = groupName;
                    list.appendChild(header);
                    currentGroupName = groupName;
                }

                const div = document.createElement('div');
                div.className = `history-item ${entry.id === currentEntryId ? 'active' : ''}`;
                div.dataset.id = entry.id; 
                
                const timeStr = d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                const emoIcon = entry.emotion ? '✨' : ''; 
                
                const aiBadge = entry.ai_source === 'ai_call'
                    ? `<span class="ai-journal-badge ai-badge-call">📞 AI Call</span>`
                    : entry.ai_source === 'ai_chat'
                    ? `<span class="ai-journal-badge ai-badge-chat">✨ AI Chat</span>`
                    : '';

                div.innerHTML = `
                    <div style="display:flex; flex-direction:column; overflow: hidden; flex: 1;">
                        <div style="display:flex;align-items:center;gap:5px;overflow:hidden;">
                            <span style="font-weight:600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex:1;">${entry.title} ${emoIcon}</span>
                            ${aiBadge}
                        </div>
                        <span style="font-size:0.7rem; opacity:0.6;">${timeStr}</span>
                    </div>
                    <button class="item-options-btn"><ion-icon name="ellipsis-horizontal"></ion-icon></button>
                `;
                
                div.onclick = (e) => {
                    if(e.target.closest('.item-options-btn')) { openContextMenu(e, entry); return; }
                    loadEntry(entry);
                };
                list.appendChild(div);
            });
        } catch (error) { console.error("Load Error:", error); }
    }

    window.loadEntry = function(entry) {
        currentEntryId = entry.id;
        getEl('entry-title').value = entry.title || '';
        getEl('entry-content').value = entry.content || '';
        if(getEl('emotion-select')) getEl('emotion-select').value = entry.emotion || '';
        
        // Extract raw text from saved HTML location link
        if(locInput) {
            if (entry.location) {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = entry.location;
                locInput.value = tempDiv.textContent || tempDiv.innerText || '';
                locInput.classList.add('loc-input-focused');
            } else {
                locInput.value = '';
                locInput.classList.remove('loc-input-focused');
            }
            locInput.dataset.lat = ''; locInput.dataset.lon = '';
            const clrBtnE = getEl('loc-clear-btn');
            if(clrBtnE) clrBtnE.style.display = locInput.value ? 'flex' : 'none';
        }
        
        if(getEl('reflect-ai-btn')) getEl('reflect-ai-btn').style.display = 'flex'; 
        getEl('mobile-journal-title').innerText = "Reading Entry";
        getEl('delete-entry-btn').style.display = 'block';
        getEl('main-sidebar').classList.remove('open');
        getEl('day-entries-modal')?.classList.remove('active'); 
        getEl('entry-chat-modal')?.classList.remove('active');
        
        mediaUrls = { image: entry.image_url || null, video: entry.video_url || null, audio: entry.audio_url || null, spotify: entry.spotify_url || null, spotifyMeta: null };
        renderMediaPreviews();
        
        document.querySelectorAll('#journal-list .history-item').forEach(el => el.classList.remove('active'));
        const activeItem = document.querySelector(`#journal-list .history-item[data-id="${entry.id}"]`);
        if (activeItem) activeItem.classList.add('active');
        if(statusIndicator) statusIndicator.innerText = "Saved";
    }

    // --- CONTEXT MENUS & UI ACTIONS ---
    let contextTarget = null;
    const ctxMenu = getEl('context-menu');

    function openContextMenu(e, entry) {
        e.preventDefault(); e.stopPropagation();
        contextTarget = entry;
        ctxMenu.style.left = `${e.pageX}px`; ctxMenu.style.top = `${e.pageY}px`;
        ctxMenu.classList.add('active');
        getEl('cm-archive').innerHTML = entry.is_archived ? '<ion-icon name="arrow-undo"></ion-icon> Unarchive' : '<ion-icon name="archive"></ion-icon> Archive';
        let vaultData = JSON.parse(localStorage.getItem('blakcide_vault_' + currentUser.id) || '{"journals":[]}');
        if (!vaultData.journals) vaultData.journals = [];
        getEl('cm-vault').innerHTML = vaultData.journals.includes(entry.id) ? '<ion-icon name="lock-open"></ion-icon> Unlock' : '<ion-icon name="lock-closed"></ion-icon> Lock';
    }

    window.addEventListener('click', () => { if(ctxMenu) ctxMenu.classList.remove('active'); });

    click('cm-delete', async () => {
        await supabase.from('journals').delete().eq('id', contextTarget.id);
        if(contextTarget.id === currentEntryId) getEl('new-entry-btn').click();
        loadSidebar(); showToast("Entry Deleted");
    });
    click('delete-entry-btn', async () => {
        if(confirm("Permanently delete this entry?")) {
            await supabase.from('journals').delete().eq('id', currentEntryId);
            getEl('new-entry-btn').click(); loadSidebar(); showToast("Entry Deleted");
        }
    });

    click('cm-archive', async () => {
        const newStatus = !contextTarget.is_archived;
        await supabase.from('journals').update({is_archived: newStatus}).eq('id', contextTarget.id);
        if(contextTarget.id === currentEntryId && newStatus === true) getEl('new-entry-btn').click();
        loadSidebar(); showToast(newStatus ? "Archived" : "Restored from Archive");
    });

    click('cm-vault', () => {
        let vaultData = JSON.parse(localStorage.getItem('blakcide_vault_' + currentUser.id) || '{"chats":[],"folders":[],"journals":[]}');
        if (!vaultData.journals) vaultData.journals = [];
        if (vaultData.journals.includes(contextTarget.id)) vaultData.journals = vaultData.journals.filter(id => id !== contextTarget.id);
        else vaultData.journals.push(contextTarget.id);
        localStorage.setItem('blakcide_vault_' + currentUser.id, JSON.stringify(vaultData));
        if(contextTarget.id === currentEntryId) getEl('new-entry-btn').click();
        loadSidebar();
    });

    click('archive-view-btn', () => { currentView = currentView === 'archive' ? 'main' : 'archive'; updateViewUI(); loadSidebar(); getEl('new-entry-btn').click(); });
    click('vault-btn', () => {
        if(currentView === 'vault') { currentView = 'main'; updateViewUI(); loadSidebar(); getEl('new-entry-btn').click(); } 
        else { getEl('pin-input').value = ''; getEl('pin-modal').classList.add('active'); getEl('pin-input').focus(); }
    });

    click('pin-cancel', () => getEl('pin-modal')?.classList.remove('active'));
    click('pin-confirm', () => {
        const input = getEl('pin-input').value;
        const existingPin = localStorage.getItem('blakcide_pin_' + currentUser.id);
        if (input === existingPin) {
            getEl('pin-modal').classList.remove('active');
            currentView = 'vault'; updateViewUI(); loadSidebar(); getEl('new-entry-btn').click();
        } else { showToast("Incorrect PIN"); }
    });

    function updateViewUI() {
        getEl('archive-view-btn')?.classList.toggle('active', currentView === 'archive');
        getEl('vault-btn')?.classList.toggle('active', currentView === 'vault');
        getEl('calendar-view-btn')?.classList.toggle('active', currentView === 'calendar');
        const titleEl = getEl('view-title');
        if(titleEl) {
            if(currentView === 'main') titleEl.style.display = 'none';
            else {
                titleEl.style.display = 'block';
                if(currentView === 'vault') titleEl.innerText = "The Vault";
                if(currentView === 'archive') titleEl.innerText = "Archives";
                if(currentView === 'calendar') titleEl.innerText = "Story Archive";
            }
        }
    }

    // ==========================================
    // MULTIMEDIA UPLOAD ENGINE
    // ==========================================
    const imgUploadInp = getEl('upload-image-input');
    const imgCaptureInp = getEl('capture-image-input');
    const vidUploadInp = getEl('upload-video-input');
    const previewContainer = getEl('media-preview-container');

    click('btn-upload-img', () => imgUploadInp?.click());
    click('btn-capture-img', () => imgCaptureInp?.click());
    click('btn-video', () => vidUploadInp?.click());

    async function handleFileSelection(e, type) {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 500 * 1024 * 1024) return showToast("File is too large! Max 500MB.");
        const url = await uploadMediaFile(file, type);
        if (!url) return;
        mediaUrls[type] = url;
        renderMediaPreviews();
        triggerAutoSave();

        // Vision analysis for images — run in background, update entry when done
        if (type === 'image') {
            analyzeAndStoreImageDescription(url);
        }
    }

    async function analyzeAndStoreImageDescription(imageUrl) {
        try {
            const res = await fetch('/api/vision', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageUrl })
            });
            if (!res.ok) return;
            const { description } = await res.json();
            if (!description) return;

            // Store on the current entry if it exists
            if (currentEntryId) {
                await supabase.from('journals').update({ image_description: description }).eq('id', currentEntryId);
            }
            // Also stash for use in the AI reflection / calendar context
            mediaUrls.imageDescription = description;
        } catch(e) { /* non-blocking */ }
    }

    if(imgUploadInp) imgUploadInp.addEventListener('change', (e) => handleFileSelection(e, 'image'));
    if(imgCaptureInp) imgCaptureInp.addEventListener('change', (e) => handleFileSelection(e, 'image'));
    if(vidUploadInp) vidUploadInp.addEventListener('change', (e) => handleFileSelection(e, 'video'));

    let jMediaRecorder;
    let jAudioChunks = [];
    let jIsRecording = false;

    click('btn-record-audio', async () => {
        const micBtn = getEl('btn-record-audio');
        if (!jIsRecording) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                let options = { mimeType: 'audio/webm' };
                if (MediaRecorder.isTypeSupported('audio/mp4')) options = { mimeType: 'audio/mp4' };
                jMediaRecorder = new MediaRecorder(stream, options);
                jMediaRecorder.start();
                jIsRecording = true;
                micBtn.style.color = "var(--accent-red)";
                micBtn.innerHTML = '<ion-icon name="square" style="font-size: 1.5rem;"></ion-icon>';
                showToast("Recording...");

                jMediaRecorder.ondataavailable = e => { jAudioChunks.push(e.data); };
                jMediaRecorder.onstop = async () => {
                    const finalType = jMediaRecorder.mimeType || 'audio/webm';
                    const audioBlob = new Blob(jAudioChunks, { type: finalType });
                    if (finalType.includes('mp4')) audioBlob.ext = 'm4a';
                    else if (finalType.includes('ogg')) audioBlob.ext = 'ogg';
                    else audioBlob.ext = 'webm';
                    jAudioChunks = [];
                    const url = await uploadMediaFile(audioBlob, 'audio');
                    if (url) { mediaUrls.audio = url; renderMediaPreviews(); triggerAutoSave(); }
                };
            } catch (err) { showToast("Microphone access needed."); }
        } else {
            jMediaRecorder.stop();
            jIsRecording = false;
            micBtn.style.color = "";
            micBtn.innerHTML = '<ion-icon name="mic-outline" style="font-size: 1.5rem;"></ion-icon>';
            jMediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
    });

    window.removeMedia = function(type) {
        mediaUrls[type] = null;
        if (type === 'spotify') mediaUrls.spotifyMeta = null;
        renderMediaPreviews(); triggerAutoSave(); showToast("Media removed.");
    };

    // ==========================================
    // SPOTIFY INTEGRATION (Instagram Stories-style picker)
    // ==========================================
    window.attachSpotify = function() {
        getEl('music-picker-modal')?.classList.add('active');
        const searchInput = getEl('music-search-input');
        if (searchInput) { searchInput.value = ''; setTimeout(() => searchInput.focus(), 300); }
        // Show linked-account tabs if Spotify is connected
        const token = window.getSpotifyToken ? window.getSpotifyToken() : null;
        const recentTab = getEl('music-tab-recent');
        const playlistTab = getEl('music-tab-playlists');
        const nudge = getEl('music-connect-nudge');
        if (token) {
            if (recentTab) recentTab.style.display = '';
            if (playlistTab) playlistTab.style.display = '';
            if (nudge) nudge.style.display = 'none';
        } else {
            if (recentTab) recentTab.style.display = 'none';
            if (playlistTab) playlistTab.style.display = 'none';
            if (nudge) nudge.style.display = 'block';
        }
        // Reset to search tab
        window.switchMusicTab('search');
        // Show placeholder
        getEl('music-results').innerHTML = `<div style="text-align: center; padding: 40px 20px; opacity: 0.5;">
            <ion-icon name="musical-notes-outline" style="font-size: 2rem; display: block; margin-bottom: 10px;"></ion-icon>
            Search for a song to attach
        </div>`;
    };

    // Tab switching
    window.switchMusicTab = function(tab) {
        document.querySelectorAll('.music-tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`.music-tab[data-tab="${tab}"]`)?.classList.add('active');
        const searchBar = getEl('music-search-bar');
        if (tab === 'search') {
            if (searchBar) searchBar.style.display = 'block';
        } else {
            if (searchBar) searchBar.style.display = 'none';
            if (tab === 'recent' && window.loadRecentlyPlayed) window.loadRecentlyPlayed();
            if (tab === 'playlists' && window.loadSpotifyPlaylists) window.loadSpotifyPlaylists();
        }
    };

    // Select a track from the picker
    window.selectTrack = function(trackId, trackName, artistName, albumArt, spotifyUrl) {
        mediaUrls.spotify = spotifyUrl;
        mediaUrls.spotifyMeta = { trackId, trackName, artistName, albumArt };
        renderMediaPreviews();
        triggerAutoSave();
        getEl('music-picker-modal')?.classList.remove('active');
        showToast(`"${trackName}" attached`);
    };

    // Search input handler
    let musicSearchTimeout;
    const musicSearchInput = getEl('music-search-input');
    if (musicSearchInput) {
        musicSearchInput.addEventListener('input', (e) => {
            clearTimeout(musicSearchTimeout);
            const q = e.target.value.trim();
            if (!q) {
                getEl('music-results').innerHTML = `<div style="text-align: center; padding: 40px 20px; opacity: 0.5;">
                    <ion-icon name="musical-notes-outline" style="font-size: 2rem; display: block; margin-bottom: 10px;"></ion-icon>
                    Search for a song to attach
                </div>`;
                return;
            }
            getEl('music-results').innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Searching...</div>';
            musicSearchTimeout = setTimeout(() => searchSpotifyTracks(q), 350);
        });
    }

    async function searchSpotifyTracks(q) {
        try {
            const res = await fetch(`/api/spotify-search?q=${encodeURIComponent(q)}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            window.renderMusicResults(data.tracks || []);
        } catch(e) {
            getEl('music-results').innerHTML = `<div style="text-align:center; padding:20px; opacity:0.5;">Search unavailable</div>`;
        }
    }

    // Render track results (exposed for spotify-auth.js to reuse)
    // Store track data by index to avoid inline string escaping issues
    window._musicTrackCache = [];
    window.renderMusicResults = function(tracks) {
        const container = getEl('music-results');
        if (!container) return;
        if (tracks.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">No results found</div>';
            return;
        }
        window._musicTrackCache = tracks;
        let html = '';
        tracks.forEach((t, i) => {
            html += `<button type="button" class="music-result-row" data-idx="${i}">
                <img class="music-album-art" src="${t.albumArt || ''}" alt="" onerror="this.style.display='none'">
                <div class="music-track-info">
                    <span class="music-track-name">${t.name || ''}</span>
                    <span class="music-track-artist">${t.artist || ''}</span>
                </div>
            </button>`;
        });
        container.innerHTML = html;
        // Bind clicks via delegation (no inline onclick, no escaping issues)
        container.querySelectorAll('.music-result-row[data-idx]').forEach(btn => {
            btn.addEventListener('click', () => {
                const track = window._musicTrackCache[parseInt(btn.dataset.idx)];
                if (track) window.selectTrack(track.id, track.name, track.artist, track.albumArt, track.spotifyUrl);
            });
        });
    };

    function renderMediaPreviews() {
        if(!previewContainer) return;
        previewContainer.innerHTML = '';
        const buildWrapper = (type, innerHtml) => `
            <div style="position: relative; display: inline-block; margin-bottom: 15px; width: 100%;">
                ${innerHtml}
                <button type="button" class="remove-media-btn" onclick="removeMedia('${type}')" style="position: absolute; top: -10px; right: -10px; background: var(--accent-red); color: white; border: none; border-radius: 50%; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 10;"><ion-icon name="trash"></ion-icon></button>
            </div>
        `;
        if (mediaUrls.image) previewContainer.innerHTML += buildWrapper('image', `<img src="${mediaUrls.image}" onclick="window.openLightbox(this.src)" style="max-width: 100%; max-height: 250px; border-radius: 12px; object-fit: cover; border: 1px solid var(--glass-border); cursor: pointer;" title="Tap to expand">`);
        if (mediaUrls.video) previewContainer.innerHTML += buildWrapper('video', `<video src="${mediaUrls.video}" controls playsinline style="max-width: 100%; max-height: 250px; border-radius: 12px; border: 1px solid var(--glass-border);"></video>`);
        if (mediaUrls.audio) previewContainer.innerHTML += buildWrapper('audio', `<div style="background: var(--glass-inner); padding: 15px; border-radius: 12px; border: 1px solid var(--glass-border);"><audio src="${mediaUrls.audio}" controls playsinline preload="auto" style="width: 100%; outline: none;"></audio></div>`);
        if (mediaUrls.spotify) {
            const meta = mediaUrls.spotifyMeta;
            const spotifyMatch = mediaUrls.spotify.match(/spotify\.com\/(track|album|playlist|episode)\/([a-zA-Z0-9]+)/);
            const embedUrl = spotifyMatch ? `https://open.spotify.com/embed/${spotifyMatch[1]}/${spotifyMatch[2]}?utm_source=generator&theme=0` : '';

            if (meta && meta.albumArt) {
                // Rich card with album art
                const cardClick = embedUrl
                    ? `document.getElementById('spotify-embed-frame').src='${embedUrl}'; document.getElementById('spotify-embed-modal').classList.add('active');`
                    : `window.open('${mediaUrls.spotify}', '_blank');`;
                previewContainer.innerHTML += buildWrapper('spotify', `
                    <div class="music-rich-card" onclick="${cardClick}">
                        <img src="${meta.albumArt}" alt="Album art" onerror="this.style.display='none'">
                        <div class="track-info">
                            <div class="track-title">${meta.trackName || ''}</div>
                            <div class="track-artist">${meta.artistName || ''}</div>
                            <div class="spotify-badge">
                                <svg width="12" height="12" fill="#1DB954" viewBox="0 0 24 24"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                                Tap to play
                            </div>
                        </div>
                    </div>
                `);
            } else if (spotifyMatch) {
                // Fallback: iframe embed for old entries without rich metadata
                previewContainer.innerHTML += buildWrapper('spotify', `<iframe src="${embedUrl}" width="100%" height="152" frameBorder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy" style="border-radius: 12px;"></iframe>`);
            }
        }
    }

    async function uploadMediaFile(file, type) {
        if (!file) return null;
        const ext = file.ext ? file.ext : (file.name ? file.name.split('.').pop() : (file.type.includes('mp4') ? 'mp4' : 'webm'));
        const fileName = `${currentUser.id}-${Date.now()}-${type}.${ext}`;
        showToast(`Uploading ${type}...`);
        const { error } = await supabase.storage.from('journal_media').upload(fileName, file, { contentType: file.type });
        if (error) { alert(`Failed to upload ${type}: ` + error.message); return null; }
        const { data } = supabase.storage.from('journal_media').getPublicUrl(fileName);
        return data.publicUrl;
    }

    // ==========================================
    // HOLISTIC AI CALENDAR SUMMARY ENGINE
    // ==========================================
    let currentMonthOffset = 0;
    click('calendar-view-btn', () => {
        if (currentView === 'calendar') { currentView = 'main'; updateViewUI(); loadSidebar(); getEl('new-entry-btn').click(); } 
        else { currentView = 'calendar'; updateViewUI(); currentMonthOffset = 0; renderCalendar(); }
    });

    window.tempCalendarMemories = [];
    async function renderCalendar() {
        const list = getEl('journal-list');
        if(!list) return;
        list.innerHTML = '<div style="text-align:center; padding: 20px; opacity:0.6;">Dusting off the archives...</div>';

        try {
            const { data: entries, error } = await supabase.from('journals').select('*').eq('user_id', currentUser.id);
            if (error) throw error;

            const date = new Date(); date.setMonth(date.getMonth() + currentMonthOffset);
            const year = date.getFullYear(); const month = date.getMonth(); 
            const firstDay = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

            let html = `
                <div class="calendar-wrapper">
                    <div class="cal-header">
                        <button class="brand-small-btn" id="prev-month-btn"><ion-icon name="chevron-back"></ion-icon></button>
                        <span>${monthNames[month]} ${year}</span>
                        <button class="brand-small-btn" id="next-month-btn"><ion-icon name="chevron-forward"></ion-icon></button>
                    </div>
                    <div class="cal-weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
                    <div class="calendar-grid">
            `;

            for (let i = 0; i < firstDay; i++) { html += `<div class="cal-day empty"></div>`; }
            for (let day = 1; day <= daysInMonth; day++) {
                const dayEntries = entries.filter(e => {
                    const eDate = new Date(e.created_at);
                    return eDate.getFullYear() === year && eDate.getMonth() === month && eDate.getDate() === day;
                });
                if (dayEntries.length > 0) {
                    const safeJson = JSON.stringify(dayEntries).replace(/'/g, "&#39;");
                    html += `<div class="cal-day has-entry" data-entries='${safeJson}'>${day}</div>`;
                } else { html += `<div class="cal-day no-entry">${day}</div>`; }
            }
            html += `</div></div>`;
            list.innerHTML = html;

            if(getEl('prev-month-btn')) getEl('prev-month-btn').onclick = () => { currentMonthOffset--; renderCalendar(); };
            if(getEl('next-month-btn')) getEl('next-month-btn').onclick = () => { currentMonthOffset++; renderCalendar(); };

            document.querySelectorAll('.cal-day.has-entry').forEach(el => {
                el.onclick = async () => {
                    const memories = JSON.parse(el.getAttribute('data-entries').replace(/&#39;/g, "'"));
                    window.tempCalendarMemories = memories;
                    const memDate = new Date(memories[0].created_at);
                    getEl('modal-date-header').innerText = memDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

                    let listHtml = ''; let combinedTextForAI = '';
                    memories.forEach((mem, index) => {
                        const time = new Date(mem.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                        const entryTitle = mem.title || `Entry ${index + 1}`;
                        
                        // Extract RAW info for AI analysis
                        const rawEmotion = mem.emotion || "Not specified";
                        let rawLoc = "Not specified";
                        if (mem.location) { const t = document.createElement('div'); t.innerHTML = mem.location; rawLoc = t.textContent || t.innerText; }
                        
                        let mediaArr = [];
                        if (mem.image_url) mediaArr.push(mem.image_description ? `a Photo (${mem.image_description})` : 'a Photo');
                        if (mem.video_url) mediaArr.push("a Video");
                        if (mem.audio_url) mediaArr.push("a Voice Note");
                        const mediaStr = mediaArr.length > 0 ? mediaArr.join(", ") : "No media attached";

                        listHtml += `<button class="btn-glass luxury-btn" style="text-align: left; padding: 12px; margin-bottom: 8px; justify-content: flex-start; width: 100%; border-radius: 8px;" onclick="window.openMemoryFromModal('${mem.id}')">
                                        <strong>${entryTitle}</strong> <span style="font-size:0.8rem; opacity:0.6; margin-left: auto;">${time}</span>
                                     </button>`;
                        
                        // The comprehensive package fed to the AI
                        combinedTextForAI += `\n--- Entry ${index + 1} ---\nTime: ${time}\nTitle: ${entryTitle}\nState of Mind: ${rawEmotion}\nLocation: ${rawLoc}\nAttached Media: ${mediaStr}\nContent: ${mem.content}\n`;
                    });
                    
                    getEl('day-entries-list').innerHTML = listHtml;
                    getEl('day-summary-box').innerHTML = '<span style="opacity: 0.6;"><ion-icon name="sparkles"></ion-icon> Reading your holistic memories...</span>';
                    getEl('day-entries-modal').classList.add('active');

                    try {
                        // Include actual images so the AI can visually see them, not just read descriptions
                        const imageParts = memories
                            .filter(m => m.image_url)
                            .map(m => ({ type: 'image_url', image_url: { url: m.image_url, detail: 'low' } }));

                        const textContent = `You are a close, observant friend. Read these journal entries from a single day and write a short, simple 2-3 sentence summary of how the user spent their day. Speak directly to them like a friend (e.g., "You went to the cafe..."). Naturally mention their state of mind, the locations they visited, and any media (photos, voice notes) they attached. Use simple, everyday vocabulary. Entries: ${combinedTextForAI}`;

                        const prompt = [{
                            role: 'user',
                            content: imageParts.length > 0
                                ? [{ type: 'text', text: textContent }, ...imageParts]
                                : textContent
                        }];
                        const summary = await window.BlakcideAI.getResponse(prompt);
                        getEl('day-summary-box').innerHTML = `<strong>Day's Reflection:</strong><br>${summary}`;
                    } catch(e) { getEl('day-summary-box').innerHTML = `<em>A collection of ${memories.length} memories from this day.</em>`; }
                };
            });
        } catch (err) { console.error("Calendar Error:", err); }
    }
    window.openMemoryFromModal = function(id) { const mem = window.tempCalendarMemories.find(m => m.id === id); if(mem) window.loadEntry(mem); }

    enforceSession();
});