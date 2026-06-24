// Spotify Search Proxy — Client Credentials flow (no user token needed)
// Env vars required: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET

let _spotifyToken = null;
let _tokenExpiry = 0;

async function getClientToken() {
    if (_spotifyToken && Date.now() < _tokenExpiry) return _spotifyToken;

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Missing Spotify credentials');

    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')
        },
        body: 'grant_type=client_credentials'
    });

    if (!res.ok) throw new Error('Token request failed');
    const data = await res.json();
    _spotifyToken = data.access_token;
    _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return _spotifyToken;
}

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    const q = event.queryStringParameters?.q;
    if (!q) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing query parameter "q"' }) };
    }

    try {
        const token = await getClientToken();
        const searchRes = await fetch(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );

        if (!searchRes.ok) throw new Error('Spotify search failed');
        const searchData = await searchRes.json();

        const tracks = (searchData.tracks?.items || []).map(track => ({
            id: track.id,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            album: track.album?.name || '',
            albumArt: track.album.images?.[1]?.url || track.album.images?.[0]?.url || '',
            spotifyUrl: track.external_urls?.spotify || '',
            // 30-sec clip — Spotify nulls this for most apps since late 2024, so the
            // client treats it as optional (falls back to the open-in-Spotify link).
            previewUrl: track.preview_url || ''
        }));

        return { statusCode: 200, headers, body: JSON.stringify({ tracks }) };
    } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Search failed' }) };
    }
};
