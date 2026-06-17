/**
 * BLAKCIDE — Global Bottom Navigation Bar
 * Disabled: replaced by per-page dynamic sidebars (sidebar-common.js)
 */
(function () {
    return; // Bottom nav replaced by sidebars — see sidebar-common.js

    // Don't show on admin, listener console, or onboarding
    const page = window.location.pathname.split('/').pop() || 'index.html';
    const excluded = ['admin.html', 'listener-console.html', 'onboarding.html', 'index.html', ''];
    if (excluded.includes(page)) return;

    // ── Styles ──────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        .bnav {
            position: fixed; bottom: 0; left: 0; right: 0;
            height: var(--nav-h, 62px);
            background: rgba(6, 6, 10, 0.94);
            backdrop-filter: blur(28px) saturate(180%);
            -webkit-backdrop-filter: blur(28px) saturate(180%);
            border-top: 1px solid rgba(255, 255, 255, 0.07);
            display: flex; align-items: stretch; justify-content: space-around;
            z-index: 8000;
            padding-bottom: env(safe-area-inset-bottom, 0);
        }
        .bnav-tab {
            flex: 1; display: flex; flex-direction: column; align-items: center;
            justify-content: center; gap: 3px;
            background: none; border: none; cursor: pointer;
            color: rgba(255, 255, 255, 0.28);
            transition: color 0.18s, transform 0.12s;
            font-family: 'Inter', -apple-system, sans-serif;
            padding: 0; position: relative; outline: none;
            text-decoration: none;
            -webkit-tap-highlight-color: transparent;
        }
        .bnav-tab ion-icon {
            font-size: 1.45rem;
            transition: color 0.18s, transform 0.15s, filter 0.18s;
        }
        .bnav-label {
            font-size: 0.6rem; font-weight: 500; letter-spacing: 0.2px;
            transition: color 0.18s;
        }
        .bnav-tab:active { transform: scale(0.88); }
        .bnav-tab:hover { color: rgba(255,255,255,0.7); }
        .bnav-tab.active { color: #fff; }
        .bnav-tab.active ion-icon {
            color: var(--accent, #00d4aa);
            filter: drop-shadow(0 0 9px var(--accent-glow, rgba(0,212,170,0.65)));
        }
        .bnav-tab.active .bnav-label { color: var(--accent, #00d4aa); }
        .bnav-tab.active::after {
            content: '';
            position: absolute; top: 0; left: 50%; transform: translateX(-50%);
            width: 28px; height: 2px; border-radius: 0 0 3px 3px;
            background: var(--accent, #00d4aa);
            box-shadow: 0 0 8px var(--accent-glow, rgba(0,212,170,0.5));
        }

        /* AI Call tab — special pill */
        .bnav-call-tab {
            max-width: 72px;
        }
        .bnav-call-tab ion-icon {
            color: var(--accent, #00d4aa);
            filter: drop-shadow(0 0 6px var(--accent-glow, rgba(0,212,170,0.45)));
        }
        .bnav-call-inner {
            width: 44px; height: 44px;
            border-radius: 50%;
            background: var(--accent-dim, rgba(0,212,170,0.10));
            border: 1.5px solid var(--accent-mid, rgba(0,212,170,0.28));
            display: flex; align-items: center; justify-content: center;
            transition: background 0.2s, box-shadow 0.2s;
        }
        .bnav-call-tab:active .bnav-call-inner {
            background: var(--accent-mid, rgba(0,212,170,0.22));
            box-shadow: 0 0 16px var(--accent-glow, rgba(0,212,170,0.35));
        }
        .bnav-call-tab .bnav-label { color: var(--accent, #00d4aa); opacity: 0.75; font-size: 0.58rem; }

        /* Body padding so content isn't hidden behind nav */
        body { padding-bottom: calc(var(--nav-h, 62px) + env(safe-area-inset-bottom, 0px)) !important; }
    `;
    document.head.appendChild(style);

    // ── Tab definitions ──────────────────────────────────────────
    const tabs = [
        { icon: 'home-outline',     label: 'Home',    href: 'dashboard.html', match: 'dashboard.html' },
        { icon: 'sparkles-outline', label: 'AI Chat', href: 'chat.html',      match: 'chat.html' },
        { icon: 'book-outline',     label: 'Journal', href: 'journal.html',   match: 'journal.html' },
        { icon: 'people-outline',   label: 'Connect', href: 'connect.html',   match: 'connect.html' },
        { icon: 'call-outline',     label: 'AI Call', href: null,             match: '__call__', special: true },
    ];

    // ── Build nav ────────────────────────────────────────────────
    const nav = document.createElement('nav');
    nav.className = 'bnav';
    nav.setAttribute('aria-label', 'Main navigation');

    tabs.forEach(tab => {
        const btn = document.createElement('button');
        btn.className = 'bnav-tab' + (tab.special ? ' bnav-call-tab' : '');
        btn.setAttribute('aria-label', tab.label);

        // Active state
        if (!tab.special && page === tab.match) btn.classList.add('active');

        if (tab.special) {
            btn.innerHTML = `
                <div class="bnav-call-inner">
                    <ion-icon name="${tab.icon}"></ion-icon>
                </div>
                <span class="bnav-label">${tab.label}</span>
            `;
        } else {
            btn.innerHTML = `
                <ion-icon name="${tab.icon}"></ion-icon>
                <span class="bnav-label">${tab.label}</span>
            `;
        }

        btn.addEventListener('click', () => {
            if (tab.special) {
                // AI Call button
                if (page === 'chat.html') {
                    if (typeof window.startAICall === 'function') {
                        window.startAICall();
                    }
                } else {
                    window.location.href = 'chat.html?call=1';
                }
            } else {
                if (page !== tab.match) {
                    window.location.href = tab.href;
                }
            }
        });

        nav.appendChild(btn);
    });

    // ── Inject into page ─────────────────────────────────────────
    function inject() {
        // Remove any existing nav to avoid duplicates
        const existing = document.querySelector('.bnav');
        if (existing) existing.remove();
        document.body.appendChild(nav);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else {
        inject();
    }
})();
