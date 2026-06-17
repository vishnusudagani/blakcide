// ==========================================
// SPOTIFY ACCOUNT LINKING (PKCE OAuth)
// Entirely client-side — no secret needed.
// ==========================================
document.addEventListener('DOMContentLoaded', () => {

    // ---- CONFIG ----
    // Replace with your Spotify app's Client ID (public, safe on client)
    const SPOTIFY_CLIENT_ID = 'db9eda9efbe443a2aee5f88c01513c3a';
    const SPOTIFY_REDIRECT_URI = window.location.origin + '/app/journal.html';
    const SPOTIFY_SCOPES = 'user-read-recently-played playlist-read-private';

    // ---- PKCE HELPERS ----
    function generateRandomString(length) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
        const values = crypto.getRandomValues(new Uint8Array(length));
        return Array.from(values, v => chars[v % chars.length]).join('');
    }

    async function generateCodeChallenge(verifier) {
        const encoder = new TextEncoder();
        const data = encoder.encode(verifier);
        const digest = await crypto.subtle.digest('SHA-256', data);
        return btoa(String.fromCharCode(...new Uint8Array(digest)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    // ---- TOKEN MANAGEMENT ----
    function storeSpotifyTokens(accessToken, refreshToken, expiresIn) {
        const expiry = Date.now() + (expiresIn - 60) * 1000;
        localStorage.setItem('spotify_access_token', accessToken);
        if (refreshToken) localStorage.setItem('spotify_refresh_token', refreshToken);
        localStorage.setItem('spotify_token_expiry', expiry.toString());
    }

    window.getSpotifyToken = function() {
        const token = localStorage.getItem('spotify_access_token');
        const expiry = parseInt(localStorage.getItem('spotify_token_expiry') || '0');
        if (!token || Date.now() > expiry) return null;
        return token;
    };

    async function refreshSpotifyToken() {
        const refreshToken = localStorage.getItem('spotify_refresh_token');
        if (!refreshToken) return null;
        try {
            const res = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: SPOTIFY_CLIENT_ID
                })
            });
            const data = await res.json();
            if (data.access_token) {
                storeSpotifyTokens(data.access_token, data.refresh_token || refreshToken, data.expires_in);
                return data.access_token;
            }
        } catch(e) {}
        return null;
    }

    async function getValidToken() {
        let token = window.getSpotifyToken();
        if (!token) token = await refreshSpotifyToken();
        return token;
    }

    // ---- INITIATE OAUTH ----
    window.initiateSpotifyAuth = async function() {
        const verifier = generateRandomString(64);
        sessionStorage.setItem('spotify_pkce_verifier', verifier);
        const challenge = await generateCodeChallenge(verifier);

        const params = new URLSearchParams({
            client_id: SPOTIFY_CLIENT_ID,
            response_type: 'code',
            redirect_uri: SPOTIFY_REDIRECT_URI,
            scope: SPOTIFY_SCOPES,
            code_challenge_method: 'S256',
            code_challenge: challenge
        });

        window.location.href = 'https://accounts.spotify.com/authorize?' + params.toString();
    };

    // ---- HANDLE CALLBACK ----
    async function handleSpotifyCallback() {
        const params = new URLSearchParams(window.location.search);
        const code = params.get('code');
        const error = params.get('error');

        if (error) {
            showToastIfAvailable('Spotify connection denied.');
            cleanUrl();
            return;
        }
        if (!code) return;

        const verifier = sessionStorage.getItem('spotify_pkce_verifier');
        if (!verifier) return;

        try {
            const res = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: SPOTIFY_REDIRECT_URI,
                    client_id: SPOTIFY_CLIENT_ID,
                    code_verifier: verifier
                })
            });
            const data = await res.json();

            if (!data.access_token) {
                showToastIfAvailable('Spotify connection failed.');
                cleanUrl();
                return;
            }

            storeSpotifyTokens(data.access_token, data.refresh_token, data.expires_in);
            sessionStorage.removeItem('spotify_pkce_verifier');
            cleanUrl();

            // Fetch Spotify profile
            const profile = await fetchSpotifyProfile(data.access_token);
            if (profile) {
                localStorage.setItem('spotify_display_name', profile.display_name || 'Spotify User');
                localStorage.setItem('spotify_user_id', profile.id || '');
                await saveSpotifyProfileToSupabase(profile);
            }

            showToastIfAvailable(`Connected as ${profile?.display_name || 'Spotify User'}`);
            updateSpotifyUI();
            checkNowPlaying();
        } catch(e) {
            showToastIfAvailable('Spotify connection error.');
            cleanUrl();
        }
    }

    function cleanUrl() {
        const url = new URL(window.location);
        url.searchParams.delete('code');
        url.searchParams.delete('state');
        url.searchParams.delete('error');
        window.history.replaceState({}, document.title, url.pathname);
    }

    function showToastIfAvailable(msg) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const t = document.createElement('div');
        t.className = 'toast';
        t.innerText = msg;
        container.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    }

    // ---- SPOTIFY PROFILE ----
    async function fetchSpotifyProfile(token) {
        try {
            const res = await fetch('https://api.spotify.com/v1/me', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            return await res.json();
        } catch(e) { return null; }
    }

    async function saveSpotifyProfileToSupabase(profile) {
        // Use the Supabase instance from the global scope if available
        const sb = window._blakcideSupabase || (typeof supabase !== 'undefined' ? supabase : null);
        if (!sb || !profile) return;
        try {
            const { data: { session } } = await sb.auth.getSession();
            if (!session) return;
            await sb.from('profiles').update({
                spotify_user_id: profile.id,
                spotify_display_name: profile.display_name
            }).eq('id', session.user.id);
        } catch(e) {}
    }

    // ---- RECENTLY PLAYED ----
    window.loadRecentlyPlayed = async function() {
        const token = await getValidToken();
        if (!token) return;
        const results = document.getElementById('music-results');
        if (results) results.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Loading...</div>';
        try {
            const res = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=20', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            const tracks = (data.items || []).map(item => ({
                id: item.track.id,
                name: item.track.name,
                artist: item.track.artists.map(a => a.name).join(', '),
                albumArt: item.track.album.images?.[1]?.url || item.track.album.images?.[0]?.url || '',
                spotifyUrl: item.track.external_urls?.spotify || ''
            }));
            if (window.renderMusicResults) window.renderMusicResults(tracks);
        } catch(e) {
            if (results) results.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Could not load recently played</div>';
        }
    };

    // ---- PLAYLISTS ----
    window.loadSpotifyPlaylists = async function() {
        const token = await getValidToken();
        if (!token) return;
        const results = document.getElementById('music-results');
        if (results) results.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Loading...</div>';
        try {
            const res = await fetch('https://api.spotify.com/v1/me/playlists?limit=20', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            const playlists = (data.items || []).map(pl => ({
                id: pl.id,
                name: pl.name || '',
                artist: `${pl.tracks?.total || 0} tracks`,
                albumArt: pl.images?.[0]?.url || '',
                spotifyUrl: pl.external_urls?.spotify || ''
            }));
            if (window.renderMusicResults) window.renderMusicResults(playlists);
            else if (results) results.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">No playlists found</div>';
        } catch(e) {
            if (results) results.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Could not load playlists</div>';
        }
    };

    // ---- NOW PLAYING NUDGE ----
    async function checkNowPlaying() {
        const token = await getValidToken();
        if (!token) return;
        try {
            const res = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=1', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            const track = data.items?.[0]?.track;
            if (!track) return;
            showNowPlayingNudge(track);
        } catch(e) {}
    }

    function showNowPlayingNudge(track) {
        // Only show the nudge on journal.html (the only page with an "Attach" target)
        const page = window.location.pathname.split('/').pop();
        if (page !== 'journal.html') return;
        // Show at most once per browsing session
        if (sessionStorage.getItem('spotify_nudge_shown')) return;
        // Don't show if one already exists on screen
        if (document.getElementById('spotify-nudge')) return;
        sessionStorage.setItem('spotify_nudge_shown', '1');

        const albumArt = track.album.images?.[1]?.url || track.album.images?.[0]?.url || '';
        const artistName = track.artists.map(a => a.name).join(', ');

        const nudge = document.createElement('div');
        nudge.id = 'spotify-nudge';
        nudge.style.cssText = 'position:fixed; bottom:80px; left:50%; transform:translateX(-50%); background:rgba(29,185,84,0.15); backdrop-filter:blur(15px); border:1px solid rgba(29,185,84,0.3); border-radius:14px; padding:12px 16px; z-index:5000; display:flex; align-items:center; gap:12px; max-width:360px; cursor:default; animation:slideUp 0.4s ease;';
        nudge.innerHTML = `
            <img src="${albumArt}" style="width:40px; height:40px; border-radius:6px; object-fit:cover;">
            <div style="flex:1; overflow:hidden;">
                <div style="font-size:0.8rem; opacity:0.7; margin-bottom:2px;">You were listening to</div>
                <div style="font-weight:600; font-size:0.9rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${track.name}</div>
                <div style="font-size:0.75rem; opacity:0.6;">${artistName}</div>
            </div>
            <button id="nudge-attach-btn" style="background:#1DB954; border:none; border-radius:8px; padding:6px 12px; color:white; font-size:0.8rem; cursor:pointer; flex-shrink:0; font-weight:600;">Attach</button>
            <button id="nudge-close-btn" style="background:none; border:none; cursor:pointer; color:var(--text-color); opacity:0.5; font-size:1.2rem; padding:4px;">&times;</button>
        `;

        document.body.appendChild(nudge);

        nudge.querySelector('#nudge-attach-btn').addEventListener('click', () => {
            if (window.selectTrack) {
                window.selectTrack(
                    track.id,
                    track.name,
                    artistName,
                    albumArt,
                    track.external_urls?.spotify || ''
                );
            }
            nudge.remove();
        });

        nudge.querySelector('#nudge-close-btn').addEventListener('click', () => nudge.remove());

        // Auto-dismiss after 12 seconds
        setTimeout(() => { if (nudge.parentNode) nudge.remove(); }, 12000);
    }

    // ---- SPOTIFY UI STATE ----
    function updateSpotifyUI() {
        const name = localStorage.getItem('spotify_display_name');
        const hasToken = !!window.getSpotifyToken();
        const statusRow = document.getElementById('spotify-status-row');
        const connectRow = document.getElementById('spotify-connect-row');
        const label = document.getElementById('spotify-connected-label');

        if (name && hasToken) {
            if (statusRow) statusRow.style.display = 'block';
            if (connectRow) connectRow.style.display = 'none';
            if (label) label.textContent = `Connected as ${name}`;
        } else {
            if (statusRow) statusRow.style.display = 'none';
            if (connectRow) connectRow.style.display = '';
        }
    }

    window.disconnectSpotify = function() {
        if (!confirm('Disconnect Spotify?')) return;
        localStorage.removeItem('spotify_access_token');
        localStorage.removeItem('spotify_refresh_token');
        localStorage.removeItem('spotify_token_expiry');
        localStorage.removeItem('spotify_display_name');
        localStorage.removeItem('spotify_user_id');
        updateSpotifyUI();
        showToastIfAvailable('Spotify disconnected');
    };

    // ---- INIT ----
    // Handle OAuth callback if ?code= is present
    handleSpotifyCallback();

    // Update UI on load
    setTimeout(updateSpotifyUI, 500);

    // Auto-nudge if linked
    if (window.getSpotifyToken()) {
        setTimeout(checkNowPlaying, 2000);
    }

});
