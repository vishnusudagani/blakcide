// "The Pulse" — Blaksyd's gentle, contextual feedback collector.
//
// Usage on any page:
//     <link rel="stylesheet" href="blaksyd-pulse.css?v=20260428b">
//     <script src="blaksyd-pulse.js?v=20260428b"></script>
//     <script>
//         document.addEventListener('DOMContentLoaded', () => {
//             // After a soft delay, ask the user how the space feels.
//             window.BlaksydPulse?.trigger('ai_echo', { delayMs: 12000 });
//         });
//     </script>
//
// You can also pass `delayMs: 0` and call `trigger()` from inside an action
// handler (e.g. right after a journal save) — the pulse appears immediately.
//
// Design rules:
//   - Master switch: reads global_settings.pulse_active before mounting. If
//     pulse_active is false, the component never renders.
//   - One-per-page-per-session: localStorage marks a page as "pulsed" so the
//     user isn't asked twice in the same browser session.
//   - Anonymous-friendly: works without a session. If the user is signed in,
//     user_id is stamped server-side via the supabase client.
//   - Self-contained: depends only on a Supabase client at window._sbClient
//     OR window.supabase.createClient. No global app context required.

(function () {
    'use strict';

    if (window.BlaksydPulse) return; // idempotent

    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    // Vibe options the user can pick. Keep the list short — three is friction
    // we can ask for, four feels like a survey.
    const VIBES = [
        { id: 'calm',            emoji: '🌿', label: 'Calm' },
        { id: 'glitchy',         emoji: '⚡', label: 'Glitchy' },
        { id: 'needs_something', emoji: '💡', label: 'Needs something' },
    ];

    function getClient() {
        if (window._sbClient) return window._sbClient;
        if (typeof window.supabase !== 'undefined') {
            window._sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
            return window._sbClient;
        }
        return null;
    }

    // Cached master-switch result so each page-nav only checks once.
    let cachedMasterSwitch = null;
    async function isPulseActive() {
        if (cachedMasterSwitch !== null) return cachedMasterSwitch;
        const sb = getClient();
        if (!sb) return false;
        try {
            const { data, error } = await sb
                .from('global_settings')
                .select('value')
                .eq('key', 'pulse_active')
                .maybeSingle();
            if (error) { console.warn('[pulse] settings read failed', error); return false; }
            const enabled = !!(data?.value?.enabled);
            cachedMasterSwitch = enabled;
            return enabled;
        } catch (e) {
            console.warn('[pulse] settings read threw', e);
            return false;
        }
    }

    // Idempotency: don't pulse the same context twice in the same session.
    function alreadyPulsed(pageContext) {
        try {
            const k = `blaksyd-pulse-shown:${pageContext}`;
            const ts = sessionStorage.getItem(k);
            return !!ts;
        } catch (_) { return false; }
    }
    function markPulsed(pageContext) {
        try { sessionStorage.setItem(`blaksyd-pulse-shown:${pageContext}`, String(Date.now())); } catch (_) {}
    }

    // Build DOM once and re-use it across triggers within the same page load.
    function buildShell() {
        const root = document.createElement('div');
        root.className = 'blaksyd-pulse';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-label', 'Quick feedback');
        root.setAttribute('aria-live', 'polite');

        root.innerHTML = `
            <button class="bp-dismiss" type="button" aria-label="Dismiss feedback">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                    <path d="M6 6l12 12M18 6L6 18"/>
                </svg>
            </button>

            <div class="bp-stage" data-stage="ask">
                <div class="bp-eyebrow">A quiet check-in</div>
                <div class="bp-prompt">How is this space feeling for you?</div>
                <div class="bp-vibes">
                    ${VIBES.map(v => `
                        <button class="bp-vibe" type="button" data-vibe="${v.id}">
                            <span class="bp-vibe-emoji" aria-hidden="true">${v.emoji}</span>
                            <span class="bp-vibe-label">${v.label}</span>
                        </button>
                    `).join('')}
                </div>
            </div>

            <div class="bp-stage" data-stage="text" hidden>
                <div class="bp-eyebrow"><span class="bp-vibe-pill"></span></div>
                <div class="bp-prompt">Any quick thoughts you want to leave behind?</div>
                <textarea class="bp-textarea" rows="3" maxlength="500" placeholder="Optional — this stays anonymous unless you're signed in."></textarea>
                <div class="bp-actions">
                    <button class="bp-skip" type="button">Skip</button>
                    <button class="bp-submit" type="button">Send</button>
                </div>
            </div>

            <div class="bp-stage" data-stage="thanks" hidden>
                <div class="bp-thanks">
                    <div class="bp-thanks-glyph" aria-hidden="true">·</div>
                    <div class="bp-prompt">Thank you. We hear you.</div>
                </div>
            </div>
        `;
        return root;
    }

    async function submit(sb, payload) {
        try {
            const { error } = await sb.from('blaksyd_pulse_logs').insert(payload);
            if (error) { console.warn('[pulse] insert failed', error); return false; }
            return true;
        } catch (e) { console.warn('[pulse] insert threw', e); return false; }
    }

    async function show(pageContext) {
        if (!pageContext) return;
        if (alreadyPulsed(pageContext)) return;
        const active = await isPulseActive();
        if (!active) return;

        const sb = getClient();
        if (!sb) return;

        // Pull current user (best-effort — anonymous is fine).
        let userId = null;
        try {
            const { data } = await sb.auth.getSession();
            userId = data?.session?.user?.id || null;
        } catch (_) {}

        markPulsed(pageContext);
        const root = buildShell();
        document.body.appendChild(root);
        // Trigger CSS slide-in next frame so transitions fire.
        requestAnimationFrame(() => root.classList.add('bp-visible'));

        const stages = root.querySelectorAll('.bp-stage');
        const goTo = (name) => {
            stages.forEach(s => { s.hidden = s.dataset.stage !== name; });
        };
        const dismiss = () => {
            root.classList.remove('bp-visible');
            setTimeout(() => root.remove(), 350);
        };

        // Auto-dismiss after 22s if the user never engages — silence is also
        // valid feedback; we don't pester.
        let autoDismiss = setTimeout(() => { if (root.isConnected) dismiss(); }, 22000);
        const cancelAuto = () => { clearTimeout(autoDismiss); autoDismiss = null; };

        root.querySelector('.bp-dismiss').addEventListener('click', dismiss);

        let chosenVibe = null;
        root.querySelectorAll('.bp-vibe').forEach(btn => {
            btn.addEventListener('click', () => {
                cancelAuto();
                chosenVibe = btn.dataset.vibe;
                const meta = VIBES.find(v => v.id === chosenVibe);
                root.querySelector('.bp-vibe-pill').innerHTML =
                    `<span aria-hidden="true">${meta.emoji}</span> ${meta.label}`;
                goTo('text');
                setTimeout(() => root.querySelector('.bp-textarea')?.focus(), 220);
            });
        });

        root.querySelector('.bp-skip').addEventListener('click', async () => {
            // User picked a vibe but skipped the text — still useful signal.
            await submit(sb, {
                user_id:       userId,
                page_context:  pageContext,
                vibe_rating:   chosenVibe || 'calm',
                feedback_text: null,
                user_agent:    navigator.userAgent.slice(0, 240),
            });
            goTo('thanks');
            setTimeout(dismiss, 1400);
        });

        root.querySelector('.bp-submit').addEventListener('click', async () => {
            const text = (root.querySelector('.bp-textarea').value || '').trim().slice(0, 500);
            const submitBtn = root.querySelector('.bp-submit');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Sending…';
            const ok = await submit(sb, {
                user_id:       userId,
                page_context:  pageContext,
                vibe_rating:   chosenVibe || 'calm',
                feedback_text: text || null,
                user_agent:    navigator.userAgent.slice(0, 240),
            });
            if (!ok) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Send';
                return;
            }
            goTo('thanks');
            setTimeout(dismiss, 1600);
        });
    }

    // Public API
    window.BlaksydPulse = {
        // pageContext — one of: 'journal' | 'ai_echo' | 'human_connect' | 'community' | 'dashboard' | 'other'
        // opts.delayMs — time to wait before showing (default 10s). Pass 0 for immediate.
        trigger(pageContext, opts) {
            const delay = (opts && typeof opts.delayMs === 'number') ? opts.delayMs : 10000;
            if (delay <= 0) {
                show(pageContext);
            } else {
                setTimeout(() => show(pageContext), delay);
            }
        },
        // Force-show for testing / preview without waiting on the global flag.
        _forceShow(pageContext) {
            cachedMasterSwitch = true;
            sessionStorage.removeItem(`blaksyd-pulse-shown:${pageContext}`);
            show(pageContext);
        },
    };
})();
