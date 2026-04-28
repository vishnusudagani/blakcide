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
            const circle = document.getElementById('uni-avatar-circle');
            if (preview)     { preview.src = profile.avatar_url; preview.style.display = 'block'; }
            if (placeholder) placeholder.style.display = 'none';
            if (circle)      circle.classList.add('has-img');
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
    // ── One-time CSS for the redesigned profile modal ────────────────────
    if (!document.getElementById('blaksyd-profile-css')) {
        const css = document.createElement('style');
        css.id = 'blaksyd-profile-css';
        css.textContent = `
        :root { --p-accent: #00f0c0; --p-accent-2: #b073ff; --p-coral: #ff7da0; }
        #global-profile-reminder.bp-reminder {
            display: none; position: fixed; bottom: 22px; right: 22px;
            width: 290px; padding: 16px 16px 14px; z-index: 9999;
            color: #fff; border-radius: 18px;
            background: linear-gradient(150deg, rgba(20,22,30,0.95), rgba(14,16,22,0.95));
            border: 1px solid rgba(255,255,255,0.08);
            backdrop-filter: blur(22px) saturate(150%);
            -webkit-backdrop-filter: blur(22px) saturate(150%);
            box-shadow: 0 16px 48px rgba(0,0,0,0.45);
        }
        #global-profile-reminder.bp-reminder .bp-rem-row { display:flex; gap:8px; }
        #global-profile-reminder.bp-reminder .bp-rem-go {
            flex:1; padding:10px; background: var(--p-accent); color:#04221c;
            border:none; border-radius:10px; cursor:pointer; font-weight:700; font-size:0.85rem;
        }
        #global-profile-reminder.bp-reminder .bp-rem-skip {
            padding:10px 14px; background:transparent;
            border:1px solid rgba(255,255,255,0.18);
            color:#fff; border-radius:10px; cursor:pointer; font-size:0.85rem;
        }

        /* ── Backdrop ─────────────────────────────────────────────────── */
        #global-profile-modal.bp-modal {
            display: none; position: fixed; inset: 0; z-index: 10000;
            background: rgba(0,0,0,0.62);
            backdrop-filter: blur(14px) saturate(140%);
            -webkit-backdrop-filter: blur(14px) saturate(140%);
            justify-content: center; align-items: center;
            padding: 20px; color: #fff;
            animation: bpFade 0.18s ease-out;
        }
        @keyframes bpFade { from { opacity: 0; } to { opacity: 1; } }

        /* ── Card ─────────────────────────────────────────────────────── */
        .bp-card {
            position: relative;
            width: 100%; max-width: 420px;
            max-height: 92vh; overflow-y: auto;
            border-radius: 24px; padding: 0;
            background:
                linear-gradient(180deg, rgba(22,25,34,0.96), rgba(14,16,22,0.98));
            border: 1px solid rgba(255,255,255,0.07);
            box-shadow:
                0 32px 80px rgba(0,0,0,0.55),
                inset 0 1px 0 rgba(255,255,255,0.05);
            animation: bpRise 0.32s cubic-bezier(0.2, 0.9, 0.3, 1.2);
        }
        @keyframes bpRise {
            from { opacity: 0; transform: translateY(18px) scale(0.96); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        /* Top hero band */
        .bp-hero {
            position: relative;
            padding: 26px 26px 18px;
            border-radius: 24px 24px 0 0;
            background:
                radial-gradient(120% 120% at 0% 0%,
                    rgba(0, 240, 192, 0.18) 0%,
                    rgba(176, 115, 255, 0.10) 35%,
                    transparent 65%),
                radial-gradient(100% 100% at 100% 0%,
                    rgba(255, 125, 160, 0.10) 0%,
                    transparent 60%);
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .bp-hero h2 {
            margin: 0 0 4px;
            font-family: 'Playfair Display', serif;
            font-weight: 500; font-size: 1.45rem; letter-spacing: -0.01em;
        }
        .bp-hero p {
            margin: 0; font-size: 0.82rem; color: rgba(255,255,255,0.55);
        }
        .bp-close {
            position: absolute; top: 14px; right: 14px;
            width: 34px; height: 34px; border-radius: 50%;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.07);
            color: #fff; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            transition: background 0.18s, transform 0.15s;
        }
        .bp-close:hover { background: rgba(255,255,255,0.1); transform: scale(1.05); }
        .bp-close ion-icon { font-size: 1.1rem; }

        /* Body */
        .bp-body { padding: 22px 26px 26px; }

        /* Avatar */
        .bp-avatar-wrap {
            display: flex; flex-direction: column; align-items: center;
            margin: -52px 0 22px;
        }
        .bp-avatar {
            width: 92px; height: 92px; border-radius: 50%;
            position: relative; overflow: hidden; cursor: pointer;
            background: linear-gradient(135deg, #1a1d28, #14171f);
            border: 2px solid rgba(255,255,255,0.08);
            box-shadow:
                0 12px 28px rgba(0,0,0,0.45),
                0 0 0 4px rgba(0, 240, 192, 0.06);
            display: flex; align-items: center; justify-content: center;
            transition: transform 0.22s, box-shadow 0.22s, border-color 0.22s;
        }
        .bp-avatar:hover {
            transform: translateY(-2px) scale(1.02);
            box-shadow:
                0 18px 40px rgba(0,0,0,0.55),
                0 0 0 4px rgba(0, 240, 192, 0.14);
            border-color: rgba(0, 240, 192, 0.35);
        }
        .bp-avatar-placeholder {
            display: flex; flex-direction: column; align-items: center; gap: 4px;
            color: rgba(255,255,255,0.45);
        }
        .bp-avatar-placeholder ion-icon { font-size: 1.7rem; }
        .bp-avatar-placeholder span { font-size: 0.62rem; letter-spacing: 0.5px; text-transform: uppercase; }
        .bp-avatar img {
            position: absolute; inset: 0; width: 100%; height: 100%;
            object-fit: cover;
        }
        .bp-avatar-overlay {
            position: absolute; inset: 0;
            background: rgba(0,0,0,0.55);
            display: none; align-items: center; justify-content: center; flex-direction: column;
            gap: 3px; color: #fff;
        }
        .bp-avatar-overlay ion-icon { font-size: 1.3rem; }
        .bp-avatar-overlay span     { font-size: 0.62rem; letter-spacing: 0.5px; }
        .bp-avatar.has-img:hover .bp-avatar-overlay { display: flex; }
        .bp-avatar-status {
            margin-top: 8px; font-size: 0.74rem; color: var(--p-accent);
            display: none;
        }

        /* Field */
        .bp-field { margin-bottom: 14px; }
        .bp-field-label {
            display: block; font-size: 0.72rem; letter-spacing: 0.4px;
            text-transform: uppercase; color: rgba(255,255,255,0.45);
            margin-bottom: 6px; font-weight: 600;
        }
        .bp-input,
        .bp-select {
            width: 100%; padding: 13px 14px; box-sizing: border-box;
            border-radius: 14px; font-family: inherit; font-size: 0.94rem;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.08);
            color: #fff; outline: none;
            transition: border-color 0.18s, background 0.18s;
        }
        .bp-input:focus,
        .bp-select:focus {
            border-color: rgba(0, 240, 192, 0.55);
            background: rgba(0, 240, 192, 0.04);
        }
        .bp-input::placeholder { color: rgba(255,255,255,0.35); }

        /* Action row */
        .bp-actions { display: flex; gap: 10px; margin-top: 6px; margin-bottom: 16px; }
        .bp-save {
            flex: 1; padding: 13px;
            background: linear-gradient(135deg, var(--p-accent) 0%, #5ab1ff 100%);
            color: #04221c;
            border: none; border-radius: 14px;
            font-weight: 800; font-size: 0.92rem; cursor: pointer;
            font-family: inherit;
            box-shadow: 0 8px 24px rgba(0, 240, 192, 0.3);
            transition: transform 0.15s, box-shadow 0.18s, opacity 0.18s;
            letter-spacing: 0.2px;
        }
        .bp-save:hover  { transform: translateY(-1px); box-shadow: 0 12px 30px rgba(0, 240, 192, 0.4); }
        .bp-save:active { transform: translateY(0); }
        .bp-save:disabled { opacity: 0.65; cursor: wait; }
        .bp-cancel {
            flex: 1; padding: 13px;
            background: transparent;
            border: 1px solid rgba(255,255,255,0.12);
            color: #fff; border-radius: 14px; cursor: pointer;
            font-size: 0.92rem; font-family: inherit; font-weight: 600;
            transition: background 0.18s, border-color 0.18s;
        }
        .bp-cancel:hover { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.22); }

        /* Section divider */
        .bp-section {
            border-top: 1px solid rgba(255,255,255,0.06);
            padding-top: 16px; margin-top: 6px;
        }

        /* Spotify */
        .bp-spotify-connected {
            display: flex; align-items: center; gap: 10px;
            padding: 10px 12px; border-radius: 12px;
            background: rgba(29, 185, 84, 0.08);
            border: 1px solid rgba(29, 185, 84, 0.2);
        }
        .bp-spotify-label { font-size: 0.84rem; flex: 1; opacity: 0.85; }
        .bp-spotify-disconnect {
            background: transparent;
            border: 1px solid rgba(255, 100, 100, 0.3);
            color: #ff8a8a; border-radius: 8px;
            padding: 4px 10px; cursor: pointer; font-size: 0.74rem; font-family: inherit;
        }
        .bp-spotify-connect {
            width: 100%; padding: 12px;
            background: #1DB954; color: #000;
            border: none; border-radius: 14px;
            font-weight: 700; font-size: 0.9rem; cursor: pointer;
            display: flex; align-items: center; justify-content: center; gap: 10px;
            font-family: inherit;
            transition: background 0.18s, transform 0.15s;
        }
        .bp-spotify-connect:hover { background: #1ed760; transform: translateY(-1px); }

        /* Logout */
        .bp-logout {
            width: 100%; padding: 12px;
            background: transparent;
            border: 1px solid rgba(255,80,90,0.25);
            color: #ff8a8a; border-radius: 14px;
            cursor: pointer; font-size: 0.86rem; font-family: inherit; font-weight: 600;
            display: flex; align-items: center; justify-content: center; gap: 8px;
            transition: background 0.18s, border-color 0.18s;
        }
        .bp-logout:hover { background: rgba(255,80,90,0.06); border-color: rgba(255,80,90,0.4); }

        /* ── Credits / wallet ─────────────────────────────────────────── */
        .bp-wallet {
            border-radius: 16px;
            padding: 16px 16px 14px;
            background:
                radial-gradient(120% 120% at 0% 0%, rgba(0,240,192,0.16) 0%, transparent 55%),
                linear-gradient(180deg, rgba(36,40,52,0.7), rgba(20,22,30,0.8));
            border: 1px solid rgba(0,240,192,0.18);
        }
        .bp-wallet-row {
            display:flex; align-items:flex-end; justify-content:space-between; gap:14px;
        }
        .bp-wallet-label {
            font-size: 0.72rem; color: rgba(255,255,255,0.55);
            text-transform: uppercase; letter-spacing: 0.08em;
            margin: 0 0 4px;
        }
        .bp-wallet-bal {
            font-family: 'Playfair Display', serif;
            font-size: 1.85rem; line-height: 1; margin: 0;
            color: var(--p-accent);
            letter-spacing: -0.01em;
        }
        .bp-wallet-bal-suffix {
            font-size: 0.78rem; color: rgba(255,255,255,0.55);
            margin-left: 6px;
        }
        .bp-wallet-add {
            background: var(--p-accent); color: #04221c;
            border: none; border-radius: 12px;
            padding: 9px 14px; font-weight: 700; font-size: 0.82rem;
            cursor: pointer; font-family: inherit;
            transition: transform 0.15s, box-shadow 0.18s;
        }
        .bp-wallet-add:hover { transform: translateY(-1px); box-shadow: 0 10px 24px rgba(0,240,192,0.35); }
        .bp-wallet-meta {
            display:flex; gap:14px; margin-top:10px;
            font-size: 0.72rem; color: rgba(255,255,255,0.5);
        }
        .bp-wallet-meta span b { color: rgba(255,255,255,0.85); font-weight: 600; }
        .bp-wallet-history {
            margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.06);
            padding-top: 10px; max-height: 0; overflow: hidden;
            transition: max-height 0.25s ease;
        }
        .bp-wallet-history.open { max-height: 240px; overflow-y: auto; }
        .bp-wallet-tx {
            display:flex; align-items:center; justify-content:space-between;
            padding: 6px 0; font-size: 0.78rem;
            border-bottom: 1px dashed rgba(255,255,255,0.05);
        }
        .bp-wallet-tx:last-child { border-bottom: none; }
        .bp-wallet-tx-amt-pos { color: var(--p-accent); font-weight: 700; }
        .bp-wallet-tx-amt-neg { color: var(--p-coral); font-weight: 700; }
        .bp-wallet-tx-meta { color: rgba(255,255,255,0.45); font-size: 0.7rem; }
        .bp-wallet-toggle {
            background: none; border: none;
            color: rgba(255,255,255,0.6); font-size: 0.74rem;
            cursor: pointer; padding: 4px 0; margin-top: 2px;
            font-family: inherit;
        }
        .bp-wallet-toggle:hover { color: #fff; }
        .bp-wallet-empty {
            font-size: 0.78rem; color: rgba(255,255,255,0.4);
            padding: 8px 0; text-align: center;
        }

        /* "Add Credits" placeholder modal (Stripe swap point lives here) */
        .bp-pay-modal {
            display:none; position: fixed; inset: 0; z-index: 10001;
            background: rgba(0,0,0,0.7);
            backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
            justify-content:center; align-items:center; padding: 20px;
        }
        .bp-pay-card {
            width: 100%; max-width: 380px; padding: 24px;
            border-radius: 22px;
            background: linear-gradient(180deg, rgba(28,32,42,0.98), rgba(16,18,24,0.99));
            border: 1px solid rgba(255,255,255,0.08);
            color: #fff;
            box-shadow: 0 30px 70px rgba(0,0,0,0.6);
        }
        .bp-pay-card h3 {
            margin: 0 0 6px; font-family: 'Playfair Display', serif;
            font-weight: 500; font-size: 1.3rem; letter-spacing: -0.01em;
        }
        .bp-pay-card p {
            margin: 0 0 14px; font-size: 0.82rem; color: rgba(255,255,255,0.6);
            line-height: 1.5;
        }
        .bp-pay-pack {
            display:flex; align-items:center; justify-content:space-between;
            padding: 12px 14px; margin-bottom: 8px;
            border: 1px solid rgba(255,255,255,0.08); border-radius: 14px;
            background: rgba(255,255,255,0.02);
            cursor: pointer; transition: border-color 0.15s, background 0.15s;
        }
        .bp-pay-pack:hover { border-color: var(--p-accent); background: rgba(0,240,192,0.05); }
        .bp-pay-pack-amt { font-weight: 700; font-size: 1rem; }
        .bp-pay-pack-price { color: rgba(255,255,255,0.7); font-size: 0.85rem; }
        .bp-pay-close {
            margin-top: 12px; width: 100%; padding: 11px;
            background: transparent; color: rgba(255,255,255,0.7);
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 12px; cursor: pointer;
            font-family: inherit; font-size: 0.85rem;
        }
        .bp-pay-note {
            margin-top: 12px; padding: 10px 12px;
            background: rgba(255,191,0,0.06);
            border: 1px solid rgba(255,191,0,0.2);
            color: rgba(255,221,140,0.95);
            border-radius: 10px;
            font-size: 0.76rem; line-height: 1.4;
        }
        `;
        document.head.appendChild(css);
    }

    const uiHTML = `
        <!-- Bottom-right reminder nudge -->
        <div id="global-profile-reminder" class="bp-reminder">
            <p style="margin: 0 0 14px 0; font-size: 0.85rem; opacity: 0.85; line-height: 1.4;">Your profile is incomplete. Add a few details to personalise your sanctuary.</p>
            <div class="bp-rem-row">
                <button class="bp-rem-go"   onclick="document.getElementById('global-profile-modal').style.display='flex'; document.getElementById('global-profile-reminder').style.display='none';">Update</button>
                <button class="bp-rem-skip" onclick="document.getElementById('global-profile-reminder').style.display='none';">Later</button>
            </div>
        </div>

        <!-- Full profile modal -->
        <div id="global-profile-modal" class="bp-modal" onclick="if(event.target===this)this.style.display='none';">
            <div class="bp-card">

                <!-- Hero band -->
                <div class="bp-hero">
                    <button class="bp-close" onclick="document.getElementById('global-profile-modal').style.display='none'" aria-label="Close">
                        <ion-icon name="close-outline"></ion-icon>
                    </button>
                    <h2>Your profile</h2>
                    <p>How Echo learns to greet you, and how listeners see you.</p>
                </div>

                <div class="bp-body">

                    <!-- Avatar upload -->
                    <div class="bp-avatar-wrap">
                        <div id="uni-avatar-circle" class="bp-avatar" onclick="document.getElementById('uni-avatar-input').click()">
                            <div id="uni-avatar-placeholder" class="bp-avatar-placeholder">
                                <ion-icon name="camera-outline"></ion-icon>
                                <span>Add photo</span>
                            </div>
                            <img id="uni-avatar-preview" src="" alt="" style="display:none;">
                            <div id="uni-avatar-overlay" class="bp-avatar-overlay">
                                <ion-icon name="camera-outline"></ion-icon>
                                <span>Change</span>
                            </div>
                        </div>
                        <input type="file" id="uni-avatar-input" accept="image/*" style="display:none;" onchange="window.handleUniversalAvatarPick(event)">
                        <p id="uni-upload-status" class="bp-avatar-status"></p>
                    </div>

                    <!-- Name -->
                    <div class="bp-field">
                        <label class="bp-field-label" for="uni-profile-name">Your name</label>
                        <input type="text" id="uni-profile-name" class="bp-input" placeholder="What should we call you?" autocomplete="name">
                    </div>

                    <!-- Date of Birth -->
                    <div class="bp-field">
                        <label class="bp-field-label" for="uni-profile-dob">Date of birth</label>
                        <input type="date" id="uni-profile-dob" class="bp-input">
                    </div>

                    <!-- Gender -->
                    <div class="bp-field">
                        <label class="bp-field-label" for="uni-profile-gender">Gender</label>
                        <select id="uni-profile-gender" class="bp-select">
                            <option value="" disabled selected>Select…</option>
                            <option value="Male">Male</option>
                            <option value="Female">Female</option>
                            <option value="Non-Binary">Non-binary</option>
                            <option value="Prefer not to say">Prefer not to say</option>
                        </select>
                    </div>

                    <!-- Save / Cancel -->
                    <div class="bp-actions">
                        <button onclick="saveUniversalProfile()" id="uni-save-btn" class="bp-save">Save profile</button>
                        <button onclick="document.getElementById('global-profile-modal').style.display='none'" class="bp-cancel">Cancel</button>
                    </div>

                    <!-- Wallet / Credits -->
                    <div class="bp-section">
                        <div id="bp-wallet" class="bp-wallet">
                            <div class="bp-wallet-row">
                                <div>
                                    <p class="bp-wallet-label">Sanctuary credits</p>
                                    <p class="bp-wallet-bal">
                                        <span id="bp-wallet-balance">—</span><span class="bp-wallet-bal-suffix">credits</span>
                                    </p>
                                </div>
                                <button class="bp-wallet-add" onclick="window.openAddCreditsModal()">+ Add credits</button>
                            </div>
                            <div class="bp-wallet-meta">
                                <span>Lifetime granted: <b id="bp-wallet-lifetime-granted">0</b></span>
                                <span>Used: <b id="bp-wallet-lifetime-spent">0</b></span>
                            </div>
                            <button class="bp-wallet-toggle" onclick="window.toggleWalletHistory()">
                                <span id="bp-wallet-toggle-label">View recent activity ▾</span>
                            </button>
                            <div id="bp-wallet-history" class="bp-wallet-history">
                                <div class="bp-wallet-empty">Loading…</div>
                            </div>
                        </div>
                    </div>

                    <!-- Spotify Connection -->
                    <div id="spotify-status-row" class="bp-section" style="display:none;">
                        <div class="bp-spotify-connected">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="#1DB954"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                            <span id="spotify-connected-label" class="bp-spotify-label"></span>
                            <button onclick="window.disconnectSpotify()" class="bp-spotify-disconnect">Disconnect</button>
                        </div>
                    </div>
                    <div id="spotify-connect-row" class="bp-section">
                        <button onclick="window.initiateSpotifyAuth()" class="bp-spotify-connect">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="black"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                            Connect Spotify
                        </button>
                    </div>

                    <!-- Logout -->
                    <div class="bp-section" style="margin-top:14px;">
                        <button onclick="window.universalLogout()" class="bp-logout">
                            <ion-icon name="log-out-outline"></ion-icon>
                            Log out
                        </button>
                    </div>

                </div><!-- /.bp-body -->
            </div><!-- /.bp-card -->
        </div>

        <!-- Add Credits placeholder modal — Stripe swap point lives here -->
        <div id="bp-pay-modal" class="bp-pay-modal" onclick="if(event.target===this)this.style.display='none';">
            <div class="bp-pay-card">
                <h3>Add credits</h3>
                <p>Credits power your AI Companion conversations and Listener sessions. Pick a pack:</p>
                <div class="bp-pay-pack" onclick="window.requestCheckoutSession(100)">
                    <span class="bp-pay-pack-amt">100 credits</span>
                    <span class="bp-pay-pack-price">$4.99</span>
                </div>
                <div class="bp-pay-pack" onclick="window.requestCheckoutSession(500)">
                    <span class="bp-pay-pack-amt">500 credits</span>
                    <span class="bp-pay-pack-price">$19.99</span>
                </div>
                <div class="bp-pay-pack" onclick="window.requestCheckoutSession(1500)">
                    <span class="bp-pay-pack-amt">1,500 credits</span>
                    <span class="bp-pay-pack-price">$49.99</span>
                </div>
                <div id="bp-pay-note" class="bp-pay-note">
                    Stripe checkout is not enabled yet — credits are admin-granted in this phase. Reach out to your admin if you need a top-up.
                </div>
                <button class="bp-pay-close" onclick="document.getElementById('bp-pay-modal').style.display='none'">Close</button>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', uiHTML);

    // Load wallet snapshot lazily once UI is in DOM
    void window.loadUserWallet();
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
        const circle = document.getElementById('uni-avatar-circle');
        if (preview)     { preview.src = e.target.result; preview.style.display = 'block'; }
        if (placeholder) placeholder.style.display = 'none';
        if (circle)      circle.classList.add('has-img');
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

// ==========================================
// WALLET (Symp.ai credits)
// ==========================================
//
// All reads go through the Blaksyd → Symp.ai proxy at /api/blaksyd/symp/*.
// The proxy injects SYMP_API_KEY server-side and stamps user_id from the
// JWT — so the browser can only ever see its own wallet.
//
// Stripe swap point:
//   `requestCheckoutSession()` currently calls /credits/checkout/start, which
//   returns 501 NOT_IMPLEMENTED. When Stripe is wired up server-side, that
//   endpoint will return a Checkout Session URL — only the body of this
//   function changes (read `checkout_url` and `window.location.href = ...`).

async function _bpAuthHeaders() {
    const { data: { session } } = await _pmClient.auth.getSession();
    if (!session) return null;
    return {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type':  'application/json',
    };
}

window.loadUserWallet = async function () {
    const balEl   = document.getElementById('bp-wallet-balance');
    const grantEl = document.getElementById('bp-wallet-lifetime-granted');
    const spendEl = document.getElementById('bp-wallet-lifetime-spent');
    if (!balEl) return;
    const headers = await _bpAuthHeaders();
    if (!headers) { balEl.textContent = '0'; return; }
    try {
        const res = await fetch('/api/blaksyd/symp/credits/balance?user_id=me', { headers });
        const json = await res.json();
        const w = json?.data?.wallet;
        if (w) {
            balEl.textContent   = (w.current_credits ?? 0).toLocaleString();
            grantEl.textContent = (w.lifetime_granted ?? 0).toLocaleString();
            spendEl.textContent = (w.lifetime_spent   ?? 0).toLocaleString();
        } else {
            balEl.textContent = '0';
        }
    } catch (_) { balEl.textContent = '0'; }
};

let _bpHistoryLoaded = false;
window.toggleWalletHistory = async function () {
    const wrap   = document.getElementById('bp-wallet-history');
    const label  = document.getElementById('bp-wallet-toggle-label');
    if (!wrap) return;
    const open = wrap.classList.toggle('open');
    label.textContent = open ? 'Hide recent activity ▴' : 'View recent activity ▾';
    if (open && !_bpHistoryLoaded) await _bpLoadHistory(wrap);
};

async function _bpLoadHistory(wrap) {
    const headers = await _bpAuthHeaders();
    if (!headers) { wrap.innerHTML = '<div class="bp-wallet-empty">Sign in required</div>'; return; }
    try {
        const res = await fetch('/api/blaksyd/symp/credits/transactions?user_id=me&limit=20', { headers });
        const json = await res.json();
        const rows = json?.data?.transactions || [];
        if (!rows.length) {
            wrap.innerHTML = '<div class="bp-wallet-empty">No activity yet — your credit movements will show here.</div>';
            _bpHistoryLoaded = true;
            return;
        }
        wrap.innerHTML = rows.map(tx => {
            const sign  = tx.amount >= 0 ? '+' : '';
            const cls   = tx.amount >= 0 ? 'bp-wallet-tx-amt-pos' : 'bp-wallet-tx-amt-neg';
            const when  = tx.created_at ? new Date(tx.created_at).toLocaleString(undefined, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            }) : '';
            const label = tx.reason || tx.transaction_type;
            return `
              <div class="bp-wallet-tx">
                  <div>
                      <div>${_bpEscape(label)}</div>
                      <div class="bp-wallet-tx-meta">${_bpEscape(when)} · bal ${tx.balance_after}</div>
                  </div>
                  <div class="${cls}">${sign}${tx.amount}</div>
              </div>`;
        }).join('');
        _bpHistoryLoaded = true;
    } catch (_) {
        wrap.innerHTML = '<div class="bp-wallet-empty">Couldn\'t load activity right now.</div>';
    }
}

function _bpEscape(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
}

window.openAddCreditsModal = function () {
    const m = document.getElementById('bp-pay-modal');
    if (m) m.style.display = 'flex';
};

// ───────────────────────────────────────────────────────────────────────────
// 🟡 STRIPE SWAP POINT — Phase 2 of credits monetization
// ───────────────────────────────────────────────────────────────────────────
// CURRENT (Phase 1, dummy):
//   This calls /api/blaksyd/symp/credits/checkout/start which returns a 501
//   { ok:false, error:{ code:'NOT_IMPLEMENTED', message:'…admin-granted…' } }.
//   The response is rendered in #bp-pay-note inside the "Add Credits" modal.
//
// PHASE 2 (Stripe wired):
//   Server-side: implement netlify/functions/symp-v1-credits.mjs's
//     `POST /credits/checkout/start` to:
//       1. Look up the SKU by `credits` (e.g. 100/500/2500/10000).
//       2. Create a Stripe Checkout Session (mode='payment') with:
//            - line_items: [{ price: SKU.stripe_price_id, quantity: 1 }]
//            - success_url: `https://blakcide.com/profile?credits=success&sid={CHECKOUT_SESSION_ID}`
//            - cancel_url:  `https://blakcide.com/profile?credits=cancel`
//            - client_reference_id: user_id (proxy-stamped)
//            - metadata: { user_id, credits }
//       3. Return { ok:true, data:{ checkout_url: session.url } }.
//   Server-side webhook: add netlify/functions/stripe-webhook.mjs that listens
//     for `checkout.session.completed`, verifies signature, and calls
//     `adjustCredits({ userId, amount: credits, transactionType: 'purchase',
//      reason: 'Stripe checkout', metadata: { stripe_session_id } })`.
//
// CLIENT-SIDE: nothing changes here — the `if (json.data.checkout_url)` branch
// below already redirects to Stripe Checkout. Phase 2 just makes the server
// return that URL instead of the 501.
// ───────────────────────────────────────────────────────────────────────────
window.requestCheckoutSession = async function (creditAmount) {
    const headers = await _bpAuthHeaders();
    if (!headers) { alert('Please sign in to add credits.'); return; }
    try {
        const res = await fetch('/api/blaksyd/symp/credits/checkout/start', {
            method:  'POST',
            headers,
            body:    JSON.stringify({ user_id: 'me', credits: creditAmount }),
        });
        const json = await res.json();
        if (json?.ok && json.data?.checkout_url) {
            // ✅ Phase 2 path — Stripe Checkout is live.
            window.location.href = json.data.checkout_url;
            return;
        }
        // ⏳ Phase 1 path — show the placeholder note in the modal.
        const note = document.getElementById('bp-pay-note');
        if (note) {
            note.textContent = json?.error?.message
                || 'Stripe checkout is not enabled yet — credits are admin-granted in this phase. Reach out to your admin for a top-up.';
        }
    } catch (_) {
        alert('Could not start checkout right now. Please try again.');
    }
};