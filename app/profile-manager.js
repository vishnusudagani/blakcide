// ==========================================
// SUPABASE CLIENT (self-contained)
// ==========================================
const _PM_URL = 'https://uoosspumdmffccinszuj.supabase.co';
const _PM_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

// Reuse the page's shared client if it's already been created. Falls back to
// its own instance under the legacy _blakcideSupabase name if profile-manager
// loads before the page-level JS — both paths keep the count to ONE client.
if (!window._sbClient) {
    window._sbClient = window.supabase.createClient(_PM_URL, _PM_KEY);
}
window._blakcideSupabase = window._sbClient; // legacy alias preserved
const _pmClient = window._sbClient;

document.addEventListener('DOMContentLoaded', async () => {
    const { data: { session } } = await _pmClient.auth.getSession();
    if (!session) return;

    injectUniversalProfileUI();

    const { data: profile } = await _pmClient.from('profiles').select('*').eq('id', session.user.id).maybeSingle();

    // Update all avatar images and names on the current page
    document.querySelectorAll('.global-avatar').forEach(img => {
        img.src = profile?.avatar_url || 'https://i.pravatar.cc/150?u=' + session.user.id;
    });
    document.querySelectorAll('.global-name').forEach(el => {
        el.innerText = profile?.full_name || 'Sanctuary Guest';
    });

    // Pre-fill modal fields
    if (profile) {
        const nameEl = document.getElementById('uni-profile-name');
        const dobEl  = document.getElementById('uni-profile-dob');
        const genEl  = document.getElementById('uni-profile-gender');
        if (nameEl) nameEl.value = profile.full_name || '';
        if (dobEl)  dobEl.value  = profile.dob       || '';
        if (genEl)  genEl.value  = profile.gender     || '';

        // Pre-fill avatar preview if one is already saved
        if (profile.avatar_url) {
            const preview = document.getElementById('uni-avatar-preview');
            const placeholder = document.getElementById('uni-avatar-placeholder');
            if (preview)     { preview.src = profile.avatar_url; preview.style.display = 'block'; }
            if (placeholder) placeholder.style.display = 'none';
        }
    }

    // Show the profile reminder if fields are missing
    if (!profile || !profile.full_name || !profile.dob || !profile.gender) {
        if (!sessionStorage.getItem('blakcide_reminder_shown')) {
            const reminder = document.getElementById('global-profile-reminder');
            if (reminder) reminder.style.display = 'flex';
            sessionStorage.setItem('blakcide_reminder_shown', 'true');
        }
    }
});

// ==========================================
// UNIVERSAL UI INJECTOR
// ==========================================
function injectUniversalProfileUI() {
    const uiHTML = `
        <!-- Bottom-right reminder nudge -->
        <div id="global-profile-reminder" style="display: none; position: fixed; bottom: 24px; right: 24px; background: rgba(15,15,20,0.92); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); padding: 18px; border-radius: 16px; z-index: 9999; width: 280px; color: white; box-shadow: 0 12px 40px rgba(0,0,0,0.4);">
            <p style="margin: 0 0 14px 0; font-size: 0.85rem; opacity: 0.85; line-height: 1.4;">Your profile is incomplete. Update it to personalize your sanctuary.</p>
            <div style="display: flex; gap: 8px;">
                <button onclick="document.getElementById('global-profile-modal').style.display='flex'; document.getElementById('global-profile-reminder').style.display='none';" style="flex: 1; padding: 9px; background: white; color: black; border: none; border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 0.85rem;">Update</button>
                <button onclick="document.getElementById('global-profile-reminder').style.display='none';" style="padding: 9px 14px; background: transparent; border: 1px solid rgba(255,255,255,0.2); color: white; border-radius: 10px; cursor: pointer; font-size: 0.85rem;">Later</button>
            </div>
        </div>

        <!-- Full profile modal -->
        <div id="global-profile-modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: 10000; justify-content: center; align-items: center; color: white; padding: 20px;">
            <div style="background: #141418; padding: 28px; border-radius: 22px; width: 90%; max-width: 400px; border: 1px solid rgba(255,255,255,0.06); max-height: 90vh; overflow-y: auto; box-shadow: 0 24px 64px rgba(0,0,0,0.5);">

                <h2 style="margin: 0 0 22px 0; font-family: 'Playfair Display', serif; font-weight: 500; font-size: 1.5rem;">Your Identity</h2>

                <!-- Avatar upload -->
                <div style="display: flex; flex-direction: column; align-items: center; margin-bottom: 22px;">
                    <div
                        id="uni-avatar-circle"
                        onclick="document.getElementById('uni-avatar-input').click()"
                        style="width: 80px; height: 80px; border-radius: 50%; border: 2px dashed rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; cursor: pointer; position: relative; overflow: hidden; background: rgba(255,255,255,0.04); transition: 0.2s;"
                        onmouseover="this.style.borderColor='rgba(255,255,255,0.4)'; document.getElementById('uni-avatar-overlay').style.display=(document.getElementById('uni-avatar-preview').style.display!=='none'?'flex':'none')"
                        onmouseout="this.style.borderColor='rgba(255,255,255,0.2)'; document.getElementById('uni-avatar-overlay').style.display='none'"
                    >
                        <div id="uni-avatar-placeholder" style="display:flex; flex-direction:column; align-items:center; gap:3px; opacity:0.4; pointer-events:none;">
                            <ion-icon name="camera-outline" style="font-size:1.6rem;"></ion-icon>
                            <span style="font-size:0.65rem;">Photo</span>
                        </div>
                        <img id="uni-avatar-preview" src="" style="display:none; position:absolute; inset:0; width:100%; height:100%; object-fit:cover;">
                        <div id="uni-avatar-overlay" style="display:none; position:absolute; inset:0; background:rgba(0,0,0,0.5); align-items:center; justify-content:center; flex-direction:column; gap:3px;">
                            <ion-icon name="camera-outline" style="font-size:1.3rem; color:white;"></ion-icon>
                            <span style="font-size:0.6rem; color:white;">Change</span>
                        </div>
                    </div>
                    <input type="file" id="uni-avatar-input" accept="image/*" style="display:none;" onchange="window.handleUniversalAvatarPick(event)">
                    <p id="uni-upload-status" style="margin:6px 0 0 0; font-size:0.75rem; color:#00b894; display:none;"></p>
                </div>

                <!-- Name -->
                <input type="text" id="uni-profile-name" placeholder="Full Name"
                    style="width:100%; padding:11px 14px; margin-bottom:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.04); color:white; box-sizing:border-box; font-size:0.92rem; font-family:inherit; outline:none; transition:0.2s;"
                    onfocus="this.style.borderColor='rgba(108,92,231,0.5)'" onblur="this.style.borderColor='rgba(255,255,255,0.1)'">

                <!-- Date of Birth -->
                <div style="font-size:0.75rem; opacity:0.5; margin-bottom:4px; font-weight:500;">Date of Birth</div>
                <input type="date" id="uni-profile-dob"
                    style="width:100%; padding:11px 14px; margin-bottom:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.04); color:white; box-sizing:border-box; font-family:inherit; outline:none;">

                <!-- Gender -->
                <select id="uni-profile-gender"
                    style="width:100%; padding:11px 14px; margin-bottom:18px; border-radius:12px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.04); color:white; box-sizing:border-box; font-family:inherit; outline:none;">
                    <option value="" disabled selected>Select Gender</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Non-Binary">Non-Binary</option>
                    <option value="Prefer not to say">Prefer not to say</option>
                </select>

                <!-- Save / Cancel -->
                <div style="display:flex; gap:8px; margin-bottom:14px;">
                    <button onclick="saveUniversalProfile()" id="uni-save-btn"
                        style="flex:1; padding:12px; background:white; color:black; border:none; border-radius:12px; cursor:pointer; font-weight:700; font-size:0.9rem; transition:0.2s; font-family:inherit;">
                        Save Profile
                    </button>
                    <button onclick="document.getElementById('global-profile-modal').style.display='none'"
                        style="flex:1; padding:12px; background:transparent; border:1px solid rgba(255,255,255,0.15); color:white; border-radius:12px; cursor:pointer; font-size:0.9rem; font-family:inherit;">
                        Cancel
                    </button>
                </div>

                <!-- Spotify Connection -->
                <div id="spotify-status-row" style="display:none; border-top:1px solid rgba(255,255,255,0.06); padding-top:14px; margin-bottom:14px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="#1DB954"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                        <span id="spotify-connected-label" style="font-size:0.85rem; opacity:0.8; flex:1;"></span>
                        <button onclick="window.disconnectSpotify()" style="background:transparent; border:1px solid rgba(255,100,100,0.3); color:#ff6b6b; border-radius:8px; padding:4px 10px; cursor:pointer; font-size:0.75rem; font-family:inherit;">Disconnect</button>
                    </div>
                </div>
                <div id="spotify-connect-row" style="border-top:1px solid rgba(255,255,255,0.06); padding-top:14px; margin-bottom:14px;">
                    <button onclick="window.initiateSpotifyAuth()"
                        style="width:100%; padding:11px; background:#1DB954; color:black; border:none; border-radius:12px; cursor:pointer; font-weight:700; font-size:0.9rem; display:flex; align-items:center; justify-content:center; gap:8px; font-family:inherit; transition:0.2s;">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="black"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                        Connect Spotify
                    </button>
                </div>

                <!-- Logout -->
                <div style="border-top:1px solid rgba(255,255,255,0.06); padding-top:14px; text-align:center;">
                    <button onclick="window.universalLogout()"
                        style="width:100%; padding:11px; background:transparent; border:1px solid rgba(231,76,60,0.3); color:#ff6b6b; border-radius:12px; cursor:pointer; font-size:0.85rem; display:flex; align-items:center; justify-content:center; gap:8px; font-family:inherit; transition:0.2s;">
                        <ion-icon name="log-out-outline"></ion-icon>
                        Log Out
                    </button>
                </div>

            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', uiHTML);
}

// ==========================================
// FIX 2: Universal logout
// Signs out from Supabase and redirects to
// the landing page from any page in the app.
// ==========================================
window.universalLogout = async function() {
    const confirmed = confirm("Are you sure you want to log out?");
    if (!confirmed) return;
    await _pmClient.auth.signOut();
    // Works from both /app/ pages and root-level pages
    const isInAppFolder = window.location.pathname.includes('/app/');
    window.location.href = isInAppFolder ? '../index.html' : 'index.html';
};

// ==========================================
// Avatar pick — shows instant local preview
// ==========================================
window.handleUniversalAvatarPick = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const preview = document.getElementById('uni-avatar-preview');
        const placeholder = document.getElementById('uni-avatar-placeholder');
        if (preview)     { preview.src = e.target.result; preview.style.display = 'block'; }
        if (placeholder) placeholder.style.display = 'none';
    };
    reader.readAsDataURL(file);
};

// ==========================================
// Save — uploads avatar first if new one
// was picked, then saves all fields at once
// ==========================================
window.saveUniversalProfile = async function() {
    const { data: { session } } = await _pmClient.auth.getSession();
    if (!session) return;

    const name    = document.getElementById('uni-profile-name').value.trim();
    const dob     = document.getElementById('uni-profile-dob').value   || null;
    const gender  = document.getElementById('uni-profile-gender').value || null;
    const saveBtn = document.getElementById('uni-save-btn');
    const statusEl = document.getElementById('uni-upload-status');

    if (!name) return alert("Name is required.");

    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerText = 'Saving...'; }

    let avatarUrl = null;

    const fileInput = document.getElementById('uni-avatar-input');
    const file = fileInput && fileInput.files.length > 0 ? fileInput.files[0] : null;

    if (file) {
        if (statusEl) { statusEl.innerText = 'Uploading photo...'; statusEl.style.display = 'block'; }
        const ext = file.name.split('.').pop();
        const fileName = `${session.user.id}-${Date.now()}.${ext}`;

        const { error: uploadError } = await _pmClient.storage
            .from('avatars')
            .upload(fileName, file, { upsert: true });

        if (uploadError) {
            alert("Photo upload failed: " + uploadError.message);
            if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = 'Save Profile'; }
            if (statusEl) statusEl.style.display = 'none';
            return;
        }

        const { data: urlData } = _pmClient.storage.from('avatars').getPublicUrl(fileName);
        avatarUrl = urlData.publicUrl;
        if (statusEl) statusEl.innerText = 'Photo uploaded!';
    }

    const payload = { id: session.user.id, full_name: name, dob, gender };
    if (avatarUrl) payload.avatar_url = avatarUrl;

    const { error } = await _pmClient.from('profiles').upsert(payload);

    if (error) {
        alert("Error saving profile: " + error.message);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = 'Save Profile'; }
        return;
    }

    // Update every avatar and name visible on the current page
    if (avatarUrl) document.querySelectorAll('.global-avatar').forEach(img => { img.src = avatarUrl; });
    document.querySelectorAll('.global-name').forEach(el => { el.innerText = name; });

    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = 'Save Profile'; }
    if (statusEl) statusEl.style.display = 'none';
    document.getElementById('global-profile-modal').style.display = 'none';
    if (fileInput) fileInput.value = '';
};