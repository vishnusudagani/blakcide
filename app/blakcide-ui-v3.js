/* ═════════════════════════════════════════════════════════════════════
   BLAKCIDE UI v3 — runtime (mobile bottom-nav, haptics, micro-interactions)
   Loads AFTER blakcide-ui-v3.css. Self-contained, no dependencies.
   Safe on every page — no-ops where it doesn't apply.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── Page detection ──────────────────────────────────────────────────
    const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    // Bottom-nav lives ONLY on dashboard. Every other authenticated page
    // already has clear in-page navigation (back-button + sidebar trigger),
    // so a second persistent bar just steals tap-target real-estate and —
    // worse — overlaps the chat composer / journal toolbar / connect filters.
    const BNAV_ONLY = new Set(['dashboard.html']);
    const showBnav = BNAV_ONLY.has(page);
    const NO_BNAV = new Set();  // legacy — no longer used for the gate
    // (showBnav is set above by the BNAV_ONLY allow-list)

    // Mark body for CSS hooks
    if (document.body) {
        document.body.classList.add('v3-breath');
        // Bright/colorful theme on by default — neuro-addictive overlay
        document.body.classList.add('v3-bright');
    }
    if (!showBnav) document.body && document.body.setAttribute('data-v3-no-bnav', 'true');

    // ── Haptic helper (Android only — iOS Safari ignores; harmless) ────
    const reduceMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function haptic(ms) {
        if (reduceMotion) return;
        try { navigator.vibrate && navigator.vibrate(ms || 8); } catch (_) {}
    }
    window.blakcideHaptic = haptic;

    // ── Toast queue ─────────────────────────────────────────────────────
    const toastQueue = [];
    let toastBusy = false;
    function flushToast() {
        if (toastBusy || !toastQueue.length) return;
        toastBusy = true;
        const { msg, tone, ms } = toastQueue.shift();
        const t = document.createElement('div');
        t.className = 'v3-toast tone-' + (tone || 'mint');
        const pip = document.createElement('span');
        pip.className = 'v3-toast-pip';
        if (tone === 'iris')   pip.style.background = 'var(--pulse-3)';
        if (tone === 'azure')  pip.style.background = 'var(--pulse-2)';
        if (tone === 'coral')  pip.style.background = 'var(--pulse-4)';
        if (tone === 'amber')  pip.style.background = 'var(--pulse-5)';
        t.appendChild(pip);
        const span = document.createElement('span');
        span.textContent = msg;
        t.appendChild(span);
        document.body.appendChild(t);
        // next frame → trigger transition
        requestAnimationFrame(() => t.classList.add('show'));
        setTimeout(() => {
            t.classList.remove('show');
            setTimeout(() => {
                t.remove();
                toastBusy = false;
                flushToast();
            }, 260);
        }, ms || 2400);
    }
    function toast(msg, opts) {
        toastQueue.push({ msg: String(msg || ''), tone: (opts && opts.tone) || 'mint', ms: opts && opts.ms });
        flushToast();
    }
    window.blakcideToast = toast;

    // ── Bottom navigation ───────────────────────────────────────────────
    function buildBottomNav() {
        if (!showBnav) return;
        if (document.querySelector('.v3-bnav')) return;

        const tabs = [
            { icon: 'home',                label: 'Home',    href: 'dashboard.html' },
            { icon: 'sparkles',            label: 'AI',      href: 'chat.html' },
            { icon: 'add',                 label: 'Talk',    fab: true,
              action: () => {
                  haptic(12);
                  // smart center action: AI call if on chat, else jump to chat with call autostart
                  if (page === 'chat.html' && typeof window.startAICall === 'function') {
                      window.startAICall();
                  } else {
                      location.href = 'chat.html?call=1';
                  }
              }
            },
            { icon: 'book',                label: 'Journal', href: 'journal.html' },
            { icon: 'people',              label: 'Connect', href: 'connect.html' },
        ];

        const nav = document.createElement('nav');
        nav.className = 'v3-bnav';
        nav.setAttribute('aria-label', 'Primary');
        const inner = document.createElement('div');
        inner.className = 'v3-bnav-inner';
        nav.appendChild(inner);

        for (const tab of tabs) {
            const btn = document.createElement(tab.href ? 'a' : 'button');
            btn.className = 'v3-bnav-tab' + (tab.fab ? ' v3-bnav-fab' : '');
            btn.setAttribute('aria-label', tab.label);
            if (tab.href) {
                btn.href = tab.href;
                if (tab.href === page) btn.classList.add('is-active');
            }

            if (tab.fab) {
                btn.innerHTML =
                    '<span class="v3-bnav-fab-inner"><ion-icon name="' + tab.icon + '"></ion-icon></span>' +
                    '<span class="v3-bnav-label">' + tab.label + '</span>';
            } else {
                btn.innerHTML =
                    '<ion-icon name="' + tab.icon + '"></ion-icon>' +
                    '<span class="v3-bnav-label">' + tab.label + '</span>';
            }

            btn.addEventListener('click', (e) => {
                if (tab.action) {
                    e.preventDefault();
                    tab.action();
                    return;
                }
                haptic(6);
                if (tab.href === page) {
                    e.preventDefault();        // already here, don't reload
                    return;
                }
            }, { passive: false });

            inner.appendChild(btn);
        }

        document.body.appendChild(nav);
        document.body.classList.add('v3-has-bnav');
    }

    // ── Streak ring helper ─────────────────────────────────────────────
    // Animates --p from 0 to target on intersection / mount.
    function animateRings(scope) {
        const rings = (scope || document).querySelectorAll('.v3-ring[data-target]');
        rings.forEach(r => {
            const target = Number(r.getAttribute('data-target')) || 0;
            const tier = target >= 80 ? 'hot' : target >= 60 ? 'warmer' : target >= 40 ? 'warm' : 'cool';
            r.setAttribute('data-tier', tier);
            const start = performance.now();
            const dur = 900;
            function tick(t) {
                const elapsed = t - start;
                const k = Math.min(1, elapsed / dur);
                // ease-out-cubic
                const eased = 1 - Math.pow(1 - k, 3);
                r.style.setProperty('--p', String(Math.round(target * eased)));
                if (k < 1) requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
        });
    }
    window.blakcideAnimateRings = animateRings;

    // ── Reveal-on-scroll ────────────────────────────────────────────────
    function wireReveal() {
        if (!('IntersectionObserver' in window)) return;
        const els = document.querySelectorAll('[data-v3-reveal]');
        if (!els.length) return;
        const io = new IntersectionObserver((entries) => {
            entries.forEach(en => {
                if (en.isIntersecting) {
                    en.target.classList.add('v3-rise');
                    io.unobserve(en.target);
                }
            });
        }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });
        els.forEach(el => io.observe(el));
    }

    // ── Micro-haptic on interactive surfaces ────────────────────────────
    function wireHaptics() {
        // Capture-phase so we always fire even if handler stops propagation
        document.addEventListener('click', (e) => {
            const t = e.target.closest('.feature-card, .v3-quick-item, .v3-focus, .mood-btn, .snav-item, .v3-press');
            if (t) haptic(6);
        }, true);
    }

    // ── Time-based greeting helper ─────────────────────────────────────
    function applyGreeting() {
        const h = new Date().getHours();
        const tone =
            h < 5  ? 'late tonight' :
            h < 12 ? 'good morning' :
            h < 17 ? 'good afternoon' :
            h < 21 ? 'good evening' : 'good night';
        document.querySelectorAll('[data-v3-greeting]').forEach(el => {
            el.textContent = tone.charAt(0).toUpperCase() + tone.slice(1);
        });
    }

    // ── Hero invitation rotator (variable-reward microcopy) ────────────
    const INVITATIONS = [
        { eyebrow: 'Today\'s invitation', title: 'Take one slow breath together.', sub: 'A 30-second pause. Just you and Blak.', cta: 'Begin', href: 'chat.html?call=1', tone: 'mint' },
        { eyebrow: 'A small ritual', title: 'Write one line about today.', sub: 'No structure. No grade. Just a sentence.', cta: 'Open journal', href: 'journal.html', tone: 'iris' },
        { eyebrow: 'Try this', title: 'Tell Blak what you\'re carrying.', sub: 'It listens in your language. Always.', cta: 'Start chat', href: 'chat.html', tone: 'mint' },
        { eyebrow: 'Connect', title: 'A real listener is online.', sub: 'A 10-minute call can change a day.', cta: 'Find someone', href: 'connect.html', tone: 'coral' },
        { eyebrow: 'Reset', title: 'Five quiet minutes.', sub: 'Step away. The screen will wait.', cta: 'Got it', href: '#', tone: 'azure' },
    ];
    function rotateInvitation() {
        const target = document.querySelector('[data-v3-invite]');
        if (!target) return;
        // deterministic per day — feels like a fresh invitation, not random
        const dayKey = new Date().toISOString().slice(0, 10);
        let h = 0; for (const c of dayKey) h = (h * 31 + c.charCodeAt(0)) | 0;
        const inv = INVITATIONS[Math.abs(h) % INVITATIONS.length];
        target.querySelector('.v3-focus-eyebrow').textContent = inv.eyebrow;
        target.querySelector('.v3-focus-title').textContent  = inv.title;
        target.querySelector('.v3-focus-sub').textContent    = inv.sub;
        target.setAttribute('href', inv.href);
        target.style.setProperty('--pulse-1', `var(--pulse-${{mint:1,azure:2,iris:3,coral:4,amber:5}[inv.tone] || 1})`);
    }

    // ── Init ───────────────────────────────────────────────────────────
    function init() {
        buildBottomNav();
        animateRings();
        wireReveal();
        wireHaptics();
        applyGreeting();
        rotateInvitation();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
