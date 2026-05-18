/* ════════════════════════════════════════════════════════════════════
   blaksyd — landing  ·  interaction layer
   ──────────────────────────────────────────────────────────────────────
   - theme toggle with bloom sweep
   - vibe slider that re-tints the Symp Core
   - four micro-trials (Journal · Nexus · Echo · Listeners)
   - Echo trial uses the real /api/chat endpoint (one-shot)
   - auth modal hand-off
   ════════════════════════════════════════════════════════════════════ */

(() => {
    'use strict';

    /* ─── tiny utils ─────────────────────────────────────────────── */
    const $  = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    /* ═══════════════════════════════════════════════════════════════
       1. THEME — saved preference, system fallback, bloom transition
       ═══════════════════════════════════════════════════════════════ */
    const THEME_KEY = 'blaksyd:theme';
    function initTheme() {
        const saved = localStorage.getItem(THEME_KEY);
        const sys   = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        const theme = saved || sys;
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeMeta(theme);
    }
    function updateThemeMeta(theme) {
        const meta = $('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', theme === 'light' ? '#F8F4ED' : '#0F172A');
    }
    function setTheme(theme, originEl) {
        const html = document.documentElement;
        const bloom = $('#theme-bloom');

        // 1. freeze heavy transitions/animations briefly
        html.classList.add('theme-switching');

        // 2. flip the variables — paint the new theme behind the bloom
        html.setAttribute('data-theme', theme);
        localStorage.setItem(THEME_KEY, theme);
        updateThemeMeta(theme);

        // 3. trigger a quick GPU-only crossfade (no clip-path, no layout work)
        if (bloom) {
            bloom.classList.remove('bloom-active');
            void bloom.offsetWidth;
            bloom.classList.add('bloom-active');
        }

        // 4. release transitions after the short fade (~420ms)
        clearTimeout(setTheme._t);
        setTheme._t = setTimeout(() => html.classList.remove('theme-switching'), 460);
    }
    function bindTheme() {
        const btn = $('#theme-toggle');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            setTheme(next, btn);
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       2. NAV scroll state + button magnetic shimmer
       ═══════════════════════════════════════════════════════════════ */
    function bindNav() {
        const nav = $('.top-nav');
        const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 8);
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();

        $$('.nav-tell-us, .hook-cta').forEach(b => {
            b.addEventListener('mousemove', (e) => {
                const r = b.getBoundingClientRect();
                b.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
                b.style.setProperty('--my', `${((e.clientY - r.top)  / r.height) * 100}%`);
            });
        });

        $('#nav-tell-us')?.addEventListener('click', () => openAuth());
    }

    /* ═══════════════════════════════════════════════════════════════
       3. HERO input → Echo trial
       ═══════════════════════════════════════════════════════════════ */
    function bindHero() {
        const form = $('#hero-input-form');
        const input = $('#hero-input');
        if (!form) return;
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) { input.focus(); return; }
            openTrial('echo', { seed: text });
            input.value = '';
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       4. VIBE PAD  —  drag a dot in 2-D space
       maps emotional state, re-tints the Symp Core in real time
       ═══════════════════════════════════════════════════════════════ */
    const vibePresets = [
        // [xMin, xMax, yMin, yMax, word, line, orbA, orbB, orbC, rgb]
        // x = heavy (0) → light (1)  ·  y = still (0) → activated (1)
        // rgb = the cell-tint color when this region is "active"
        { x:[0,.33], y:[.66,1],   w:'on edge',          l:"a lot is moving inside. let's slow it down together.",
          a:'rgba(167,139,250,.55)', b:'rgba(245,107,107,.4)', c:'rgba(94,234,212,.3)',  rgb:[167,139,250] },
        { x:[.33,.66], y:[.66,1], w:'wired',            l:'energy without a home. we have a place for it.',
          a:'rgba(245,185,98,.55)',  b:'rgba(167,139,250,.4)', c:'rgba(94,234,212,.4)',  rgb:[245,185,98] },
        { x:[.66,1], y:[.66,1],   w:'lit up',           l:'this is a good kind of awake. enjoy it.',
          a:'rgba(94,234,212,.55)',  b:'rgba(245,185,98,.45)', c:'rgba(167,243,208,.4)', rgb:[94,234,212] },
        { x:[0,.33], y:[.33,.66], w:'heavy',            l:"the weight is real. you don't have to lift it alone.",
          a:'rgba(167,139,250,.5)',  b:'rgba(80,100,160,.4)',  c:'rgba(94,234,212,.25)', rgb:[129,118,196] },
        { x:[.33,.66], y:[.33,.66], w:'somewhere in the middle', l:"that's a fine place to sit. take a breath.",
          a:'rgba(245,185,98,.45)',  b:'rgba(94,234,212,.35)', c:'rgba(167,139,250,.3)', rgb:[214,164,118] },
        { x:[.66,1], y:[.33,.66], w:'open',             l:'a soft kind of okay. nice to meet you here.',
          a:'rgba(94,234,212,.5)',   b:'rgba(167,243,208,.4)', c:'rgba(245,185,98,.3)',  rgb:[120,210,180] },
        { x:[0,.33], y:[0,.33],   w:'flat',             l:"low and quiet. we'll just sit with you.",
          a:'rgba(80,100,160,.5)',   b:'rgba(167,139,250,.35)',c:'rgba(94,234,212,.2)',  rgb:[100,118,170] },
        { x:[.33,.66], y:[0,.33], w:'still',            l:'the rest you needed. let it stay a while.',
          a:'rgba(94,234,212,.4)',   b:'rgba(167,139,250,.3)', c:'rgba(245,185,98,.3)',  rgb:[140,200,200] },
        { x:[.66,1], y:[0,.33],   w:'at peace',         l:"hold this one. it's the rare one.",
          a:'rgba(167,243,208,.55)', b:'rgba(94,234,212,.4)',  c:'rgba(245,185,98,.3)',  rgb:[167,222,180] },
    ];

    function vibeReadout(nx, ny) {
        for (const p of vibePresets) {
            if (nx >= p.x[0] && nx <= p.x[1] && ny >= p.y[0] && ny <= p.y[1]) return p;
        }
        return vibePresets[4];
    }

    function bindVibe() {
        const pad   = $('#vibe-pad');
        const dot   = $('#vibe-dot');
        const glow  = $('#vibe-glow');
        const word  = $('#vibe-word');
        const line  = $('#vibe-line');
        const core  = $('#symp-core');
        const grid  = $('.vibe-grid');
        if (!pad) return;

        // ─── build the 12 × 10 grid of 120 cells once ───
        const COLS = 12, ROWS = 10, CELLS = COLS * ROWS;
        const cells = [];
        if (grid && !grid.children.length) {
            const frag = document.createDocumentFragment();
            for (let i = 0; i < CELLS; i++) {
                const c = document.createElement('div');
                c.className = 'vibe-cell idle';
                c.style.setProperty('--breath-delay', `${(Math.random() * 6).toFixed(2)}s`);
                frag.appendChild(c);
                cells.push(c);
            }
            grid.appendChild(frag);
        } else if (grid) {
            cells.push(...grid.children);
        }

        // start centered
        let x = .5, y = .5;
        let dragging = false;

        function paint(nx, ny) {
            const padRect = pad.getBoundingClientRect();
            const px = nx * padRect.width;
            const py = (1 - ny) * padRect.height;  // y inverted: top = 1
            dot.style.left  = `${px}px`;
            dot.style.top   = `${py}px`;
            glow.style.left = `${px}px`;
            glow.style.top  = `${py}px`;

            const r = vibeReadout(nx, ny);
            if (word.textContent !== r.w) {
                word.style.opacity = 0;
                setTimeout(() => { word.textContent = r.w; word.style.opacity = 1; }, 180);
            }
            line.textContent = r.l;

            // Re-tint the Symp Core orb gradients
            core?.style.setProperty('--orb-a', r.a);
            core?.style.setProperty('--orb-b', r.b);
            core?.style.setProperty('--orb-c', r.c);

            // ─── light up the 120-cell grid based on the dot position ───
            // dot lives in pad's coord-space; cells fill the whole vibe-stage.
            // map pad's normalized (nx, ny) into the larger grid coordinate space.
            const stage = grid?.parentElement;
            if (cells.length && stage) {
                const padOffsetX = pad.offsetLeft;
                const padOffsetY = pad.offsetTop;
                const stageW = stage.clientWidth || 1;
                const stageH = stage.clientHeight || 1;

                const dotStageX = padOffsetX + nx * pad.clientWidth;
                const dotStageY = padOffsetY + (1 - ny) * pad.clientHeight;
                const dotCellX = (dotStageX / stageW) * COLS - .5;
                const dotCellY = (dotStageY / stageH) * ROWS - .5;

                const [R, G, B] = r.rgb;
                // wide warm pool — most of the 120 cells touch the active color
                const radius = 5.5 + ny * 2.5;        // 5.5 .. 8.0 cells (vs ~12 wide grid)
                const baseI  = .85;

                for (let i = 0; i < CELLS; i++) {
                    const cx = i % COLS;
                    const cy = Math.floor(i / COLS);
                    const dx = cx - dotCellX;
                    const dy = cy - dotCellY;
                    const d  = Math.sqrt(dx*dx + dy*dy);
                    const cell = cells[i];

                    cell.style.setProperty('--cell-r', R);
                    cell.style.setProperty('--cell-g', G);
                    cell.style.setProperty('--cell-b', B);

                    if (d <= radius) {
                        const t = 1 - (d / radius);     // 0..1, 1 at the dot
                        // brighter near dot, lingering glow at the edge
                        const intensity = clamp(baseI * Math.pow(t, 1.4) + .12, 0, .95);
                        cell.style.setProperty('--cell-i', intensity.toFixed(3));
                        cell.classList.remove('idle');
                        if (d < 1.1) cell.classList.add('is-anchor');
                        else         cell.classList.remove('is-anchor');
                    } else {
                        // far-from-dot cells: still a soft tint so the whole grid feels alive
                        const ambient = clamp(.16 - (d - radius) * .015, .07, .16);
                        cell.style.setProperty('--cell-i', ambient.toFixed(3));
                        cell.classList.add('idle');
                        cell.classList.remove('is-anchor');
                    }
                }
            }

            // aria
            pad.setAttribute('aria-valuenow', Math.round((nx + ny) * 50));
        }

        function pointerXY(ev) {
            const rect = pad.getBoundingClientRect();
            const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
            const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
            return {
                nx: clamp(cx / rect.width, 0, 1),
                ny: clamp(1 - cy / rect.height, 0, 1),  // invert
            };
        }

        function start(ev) {
            dragging = true;
            dot.classList.add('dragging');
            const { nx, ny } = pointerXY(ev);
            x = nx; y = ny; paint(x, y);
            ev.preventDefault?.();
        }
        function move(ev) {
            if (!dragging) return;
            const { nx, ny } = pointerXY(ev);
            x = nx; y = ny; paint(x, y);
            ev.preventDefault?.();
        }
        function end() {
            dragging = false;
            dot.classList.remove('dragging');
        }

        pad.addEventListener('mousedown', start);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', end);
        pad.addEventListener('touchstart', start, { passive: false });
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', end);

        // Keyboard support
        pad.addEventListener('keydown', (e) => {
            const step = .06;
            if (e.key === 'ArrowLeft')  x = clamp(x - step, 0, 1);
            else if (e.key === 'ArrowRight') x = clamp(x + step, 0, 1);
            else if (e.key === 'ArrowUp')    y = clamp(y + step, 0, 1);
            else if (e.key === 'ArrowDown')  y = clamp(y - step, 0, 1);
            else return;
            paint(x, y); e.preventDefault();
        });

        // initial paint after layout
        requestAnimationFrame(() => paint(x, y));
        window.addEventListener('resize', () => paint(x, y));
    }

    /* ═══════════════════════════════════════════════════════════════
       5. TRIAL OVERLAY  —  expanded glass-pane experience
       ═══════════════════════════════════════════════════════════════ */
    const overlay  = () => $('#trial-overlay');
    const card     = () => $('#trial-card');
    const titleEl  = () => $('#trial-title');
    const tagEl    = () => $('#trial-tag');
    const bodyEl   = () => $('#trial-body');
    const hookEl   = () => $('#trial-hook');
    const progress = () => $('.trial-progress-bar');

    function showHook(delay = 600) {
        const h = hookEl();
        if (!h) return;
        setTimeout(() => {
            h.hidden = false;
            h.style.opacity = 0;
            h.style.transform = 'translateY(10px)';
            h.style.transition = 'opacity .8s ease, transform .8s ease';
            requestAnimationFrame(() => {
                h.style.opacity = 1;
                h.style.transform = 'translateY(0)';
            });
            progress() && (progress().style.width = '100%');
        }, delay);
    }

    function setProgress(pct) {
        const p = progress(); if (p) p.style.width = `${pct}%`;
    }

    function openTrial(kind, opts = {}) {
        const o = overlay(); if (!o) return;
        const ttl = $('#trial-tag');
        const sub = $('#trial-title');

        const meta = TRIALS[kind];
        if (!meta) return;
        ttl.textContent = meta.tag;
        sub.textContent = meta.title;

        // reset hook + progress
        const h = hookEl(); if (h) { h.hidden = true; h.removeAttribute('style'); }
        setProgress(8);

        // populate body
        bodyEl().innerHTML = '';
        bodyEl().appendChild(meta.render(opts));

        o.classList.add('is-open');
        o.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';

        // run after-mount hook
        meta.afterMount?.(opts);
    }

    function closeTrial() {
        const o = overlay(); if (!o) return;
        o.classList.remove('is-open');
        o.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
    }

    function bindOverlay() {
        // legacy 4-tile grid (kept for back-compat — hidden in CSS)
        $$('.pane').forEach(p => {
            const kind = p.dataset.trial;
            p.addEventListener('click', () => openTrial(kind));
            p.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTrial(kind); }
            });
        });
        // new split-layout: clicking a preview card (but NOT an inner control) opens the modal
        $$('.feature-preview').forEach(card => {
            const kind = card.dataset.trial;
            card.addEventListener('click', (e) => {
                if (e.target.closest('input, textarea, button, .preview-input-row, .preview-nexus-input-row, .preview-journal-foot, .listener-rows, .nexus-matches, .preview-stream')) return;
                openTrial(kind);
            });
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    if (e.target !== card) return;
                    e.preventDefault();
                    openTrial(kind);
                }
            });
        });
        // header CTA on each feature row also opens the modal
        $$('.feature-row .feature-cta-text').forEach(cta => {
            const row = cta.closest('.feature-row');
            const kind = row?.dataset.trial;
            if (!kind) return;
            cta.style.cursor = 'pointer';
            cta.addEventListener('click', () => openTrial(kind));
        });

        $$('[data-close]').forEach(el => el.addEventListener('click', closeTrial));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay()?.classList.contains('is-open')) closeTrial();
        });

        $('#hook-cta')?.addEventListener('click', () => {
            closeTrial();
            setTimeout(() => openAuth(), 250);
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       5B. LIVE PREVIEWS — inline, on-page interactive cards
       ═══════════════════════════════════════════════════════════════ */
    function bindFeaturePreviews() {
        bindJournalPreview();
        bindEchoPreview();
        bindListenerPreview();
        bindNexusPreview();
        bindFeatureReveal();
    }

    /* — 01 · Journal preview — */
    function bindJournalPreview() {
        const ta   = $('#jp-text');
        const cnt  = $('#jp-count');
        const btn  = $('#jp-release');
        const dust = $('#jp-dust');
        const val  = $('#jp-validation');
        if (!ta) return;

        const MAX = 200;
        ta.addEventListener('input', () => {
            const len = ta.value.length;
            if (len > MAX) ta.value = ta.value.slice(0, MAX);
            cnt.textContent = `${ta.value.length} / ${MAX}`;
            cnt.classList.toggle('over', ta.value.length >= MAX);
            btn.disabled = ta.value.trim().length === 0;
        });
        btn.disabled = true;

        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && ta.value.trim()) {
                e.preventDefault(); release();
            }
        });
        btn.addEventListener('click', release);

        async function release() {
            const txt = ta.value.trim();
            if (!txt) { ta.focus(); return; }
            btn.disabled = true;

            const taRect = ta.getBoundingClientRect();
            const dustRect = dust.getBoundingClientRect();
            const baseLeft = taRect.left - dustRect.left;
            const baseTop  = taRect.top  - dustRect.top + 4;

            const PIECES = clamp(Math.floor(txt.length * 1.4), 18, 50);
            for (let i = 0; i < PIECES; i++) {
                const d = document.createElement('span');
                d.className = 'dust-particle';
                const rx = Math.random() * (taRect.width - 20);
                const ry = Math.random() * Math.min(taRect.height - 12, 80);
                d.style.left = `${baseLeft + rx}px`;
                d.style.top  = `${baseTop + ry}px`;
                const angle = (Math.random() - .5) * Math.PI;
                const dist  = 50 + Math.random() * 130;
                d.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
                d.style.setProperty('--dy', `${-30 - Math.random() * dist}px`);
                d.style.transitionDelay = `${Math.random() * .2}s`;
                d.style.background = ['#E8A85B', '#C97B5A', '#D4A373', '#B8896C'][i % 4];
                dust.appendChild(d);
            }
            requestAnimationFrame(() => {
                $$('.dust-particle', dust).forEach(p => { p.classList.add('born'); requestAnimationFrame(() => p.classList.add('go')); });
            });

            ta.style.transition = 'opacity .55s ease';
            ta.style.opacity = 0;

            await sleep(900);
            ta.value = '';
            ta.style.opacity = 1;
            cnt.textContent = `0 / ${MAX}`;
            dust.innerHTML = '';

            val.textContent = "released. that thought no longer lives anywhere — not on this page, not in our servers.";
            val.hidden = false;
            val.style.animation = 'none';
            void val.offsetWidth;
            val.style.animation = '';
            btn.disabled = true;

            // auto-hide after a moment so the card is reusable
            clearTimeout(release._t);
            release._t = setTimeout(() => { val.hidden = true; ta.focus(); }, 6000);
        }
    }

    /* — 02 · Echo preview — */
    function bindEchoPreview() {
        const stream = $('#ep-stream');
        const inp    = $('#ep-input');
        const btn    = $('#ep-send');
        if (!stream || !inp || !btn) return;

        let busy = false;
        btn.addEventListener('click', send);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

        async function send() {
            if (busy) return;
            const txt = inp.value.trim();
            if (!txt) { inp.focus(); return; }
            busy = true; btn.disabled = true;

            const me = document.createElement('div');
            me.className = 'preview-bubble preview-bubble-you';
            me.textContent = txt;
            stream.appendChild(me);
            stream.scrollTop = stream.scrollHeight;

            inp.value = '';
            const bot = document.createElement('div');
            bot.className = 'preview-bubble preview-bubble-bot typing';
            bot.textContent = '';
            stream.appendChild(bot);
            stream.scrollTop = stream.scrollHeight;

            let reply = '';
            try {
                const r = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        stream: false,
                        messages: [
                            { role: 'system', content:
                                'You are Echo, a quietly empathetic companion on the blaksyd landing page. ' +
                                'Reply in under 40 words. Warm, present, no advice, no clinical language, no piling on questions. ' +
                                'Match their language. Lowercase or sentence case is fine. No emojis. Sound like a friend who reads slowly.' },
                            { role: 'user', content: txt },
                        ],
                    }),
                });
                if (r.ok) {
                    const data = await r.json();
                    reply = (data.reply || data.message || '').toString().trim();
                }
            } catch (_) { /* fall through */ }

            if (!reply) reply = canonicalEchoReply(txt);

            bot.classList.remove('typing');
            await typeOut(bot, reply, stream);

            // CTA bubble after the reply
            const cta = document.createElement('button');
            cta.className = 'preview-bubble preview-bubble-bot';
            cta.style.cursor = 'pointer';
            cta.style.borderStyle = 'dashed';
            cta.textContent = '↗ open Echo full conversation';
            cta.addEventListener('click', () => openTrial('echo', { seed: txt }));
            stream.appendChild(cta);
            stream.scrollTop = stream.scrollHeight;

            btn.disabled = false;
            busy = false;
        }

        function canonicalEchoReply(txt) {
            const t = txt.toLowerCase();
            if (/(tired|exhaust|drain)/.test(t))   return "i hear you. the kind of tired that sleep doesn't fix, right? i'm right here. take a breath, there's no rush.";
            if (/(anxious|anxiety|panic|nerv)/.test(t)) return "your body is doing a lot right now, even if no one can see it. that's real. you can sit here as long as you need.";
            if (/(sad|down|low|empty|numb)/.test(t)) return "you don't have to call it anything. it's heavy and that's enough of a reason. i'm here.";
            if (/(lonely|alone|isolat)/.test(t))   return "being unseen is its own kind of loud. you are seen here. not by an algorithm — by us.";
            if (/(angry|mad|furious|rage)/.test(t)) return "anger usually means something underneath it got hurt. you don't have to explain. i'm not going anywhere.";
            if (/(work|boss|job|career)/.test(t)) return "work bleeds into the rest of you in ways people underestimate. tell me what's loudest right now.";
            return "thank you for trusting me with that. it's safe here. you don't have to perform anything.";
        }

        async function typeOut(node, text, scrollHost) {
            let out = '';
            for (let i = 0; i < text.length; i++) {
                out += text[i];
                node.textContent = out;
                if (scrollHost) scrollHost.scrollTop = scrollHost.scrollHeight;
                let d = 22;
                const ch = text[i];
                if (ch === ' ') d = 14;
                if (/[.,!?;:]/.test(ch)) d = 200;
                await sleep(d);
            }
        }
    }

    /* — 03 · Listener preview — */
    function bindListenerPreview() {
        const rows = $$('.preview-listener-card .listener-row');
        if (!rows.length) return;
        rows.forEach(row => {
            const btn = row.querySelector('.listener-connect');
            if (!btn) return;
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (row.classList.contains('is-connecting')) return;
                rows.forEach(r => r.classList.remove('is-connecting'));
                row.classList.add('is-connecting');
                btn.textContent = 'Calling…';
                await sleep(900);
                btn.textContent = '✓ Connected';
                await sleep(700);
                openTrial('listener');
                setTimeout(() => {
                    btn.textContent = 'Connect';
                    row.classList.remove('is-connecting');
                }, 600);
            });
        });
    }

    /* — 04 · Nexus preview — */
    function bindNexusPreview() {
        const inp     = $('#np-input');
        const share   = $('#np-share');
        const matches = $('#np-matches');
        if (!inp || !share || !matches) return;

        // a small bank of believable anonymous voices keyed loosely by intent
        const voices = [
            { q: '"I say I\'m fine so many times I\'ve started to believe it myself."',     pct: 94, ago: '2 min ago',  tags: ['fine','okay','tired','mask'] },
            { q: '"The loneliness isn\'t about being alone. It\'s about not being understood."', pct: 88, ago: '8 min ago',  tags: ['lonely','alone','isolated','understood'] },
            { q: '"I check on everyone. Nobody checks on me."',                              pct: 81, ago: '14 min ago', tags: ['caretaker','overgive','tired','seen'] },
            { q: '"I\'m doing everything right and I still feel behind."',                   pct: 92, ago: '4 min ago',  tags: ['behind','stuck','career','doing'] },
            { q: '"I keep saying I\'ll talk to someone. Then I don\'t."',                    pct: 86, ago: '11 min ago', tags: ['avoid','therapy','help','later'] },
            { q: '"It\'s 3am again. I can\'t turn my brain off."',                           pct: 90, ago: '6 min ago',  tags: ['anxious','sleep','3am','spiral','anxiety'] },
            { q: '"I love them and I\'m still drained."',                                    pct: 83, ago: '17 min ago', tags: ['relationship','drained','love','tired'] },
            { q: '"Everyone says I\'ve grown. I just feel hollow."',                         pct: 89, ago: '9 min ago',  tags: ['empty','numb','hollow','grow','sad'] },
        ];

        share.addEventListener('click', (e) => { e.stopPropagation(); doMatch(); });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doMatch(); });

        function doMatch() {
            const txt = inp.value.trim();
            if (!txt) { inp.focus(); return; }
            const t = txt.toLowerCase();

            // pick the voices most relevant to the user's input via simple tag overlap, fall back to defaults
            const ranked = voices
                .map(v => ({ v, score: v.tags.reduce((s, tag) => s + (t.includes(tag) ? 1 : 0), 0) + Math.random() * 0.3 }))
                .sort((a, b) => b.score - a.score)
                .slice(0, 3);

            // animate input → "shared" state
            share.textContent = '✓ shared';
            share.disabled = true;

            // wipe & re-build the match list with fresh entries
            matches.innerHTML = '';
            const tints = ['nexus-match-1', 'nexus-match-2', 'nexus-match-3'];
            ranked.forEach((r, i) => {
                const card = document.createElement('div');
                card.className = `nexus-match ${tints[i]} fresh`;
                card.innerHTML = `
                    <div class="match-pct">${r.v.pct}% MATCH</div>
                    <p class="match-quote">${r.v.q}</p>
                    <p class="match-meta">Anonymous · ${r.v.ago}</p>
                `;
                card.style.animationDelay = `${i * .12}s`;
                matches.appendChild(card);
            });

            setTimeout(() => {
                share.textContent = 'Share →';
                share.disabled = false;
                inp.value = '';
            }, 1800);
        }
    }

    /* — scroll-reveal: fade rows in as they enter the viewport — */
    function bindFeatureReveal() {
        const rows = $$('.feature-row');
        if (!rows.length) return;
        if (!('IntersectionObserver' in window)) {
            rows.forEach(r => r.classList.add('is-visible'));
            return;
        }
        const io = new IntersectionObserver((entries) => {
            entries.forEach(en => {
                if (en.isIntersecting) {
                    en.target.classList.add('is-visible');
                    io.unobserve(en.target);
                }
            });
        }, { threshold: .12, rootMargin: '0px 0px -8% 0px' });
        rows.forEach(r => io.observe(r));

        // pointer-following 3D tilt on the preview cards (desktop, fine pointer only)
        const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
        if (!fine) return;
        $$('.feature-preview').forEach(host => {
            const card = host.querySelector('.preview-card');
            if (!card) return;
            let raf = 0;
            host.addEventListener('mousemove', (e) => {
                const r = host.getBoundingClientRect();
                const px = (e.clientX - r.left) / r.width;
                const py = (e.clientY - r.top)  / r.height;
                cancelAnimationFrame(raf);
                raf = requestAnimationFrame(() => {
                    const rx = (py - .5) * -4;
                    const ry = (px - .5) *  5;
                    card.style.transform = `perspective(1100px) translateY(-4px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
                    host.style.setProperty('--mx', `${px * 100}%`);
                    host.style.setProperty('--my', `${py * 100}%`);
                });
            });
            host.addEventListener('mouseleave', () => {
                cancelAnimationFrame(raf);
                card.style.transform = '';
            });
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       6. THE FOUR TRIALS
       ═══════════════════════════════════════════════════════════════ */

    const TRIALS = {

        /* ─────────── JOURNAL ─────────── */
        journal: {
            tag: 'a place to leave it',
            title: 'Journal',
            render() {
                const el = document.createElement('div');
                el.innerHTML = `
                    <p class="journal-prompt">type one sentence you couldn't say out loud today. press enter to leave it behind.</p>
                    <div class="journal-paper" id="j-paper">
                        <textarea
                            id="j-text"
                            class="journal-textarea"
                            placeholder="i feel like…"
                            spellcheck="false"
                            autocomplete="off"
                            rows="3"></textarea>
                        <div class="journal-meta">
                            <span id="j-count">0 / 220</span>
                            <button type="button" id="j-release">release ↵</button>
                        </div>
                        <div class="dust-layer" id="j-dust"></div>
                    </div>
                    <div class="journal-validation" id="j-val" aria-live="polite">
                        <strong>Echo</strong>
                        <span id="j-val-text"></span>
                    </div>
                `;
                return el;
            },
            afterMount() {
                const ta   = $('#j-text');
                const cnt  = $('#j-count');
                const btn  = $('#j-release');
                const dust = $('#j-dust');
                const val  = $('#j-val');
                const valT = $('#j-val-text');

                setTimeout(() => ta?.focus(), 250);
                setProgress(28);

                ta.addEventListener('input', () => {
                    cnt.textContent = `${ta.value.length} / 220`;
                    if (ta.value.length > 220) ta.value = ta.value.slice(0, 220);
                });

                ta.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); release(); }
                });
                btn.addEventListener('click', release);

                async function release() {
                    const txt = ta.value.trim();
                    if (!txt) { ta.focus(); return; }

                    setProgress(60);

                    // capture text bounds
                    const paperRect = $('#j-paper').getBoundingClientRect();
                    const taRect    = ta.getBoundingClientRect();
                    const baseLeft  = taRect.left - paperRect.left + 16;
                    const baseTop   = taRect.top  - paperRect.top  + 16;

                    // build dust particles
                    const PIECES = Math.min(60, Math.max(20, txt.length * 1.5));
                    for (let i = 0; i < PIECES; i++) {
                        const d = document.createElement('span');
                        d.className = 'dust-particle';
                        const rx = Math.random() * (taRect.width - 30);
                        const ry = Math.random() * Math.min(taRect.height, 60);
                        d.style.left = `${baseLeft + rx}px`;
                        d.style.top  = `${baseTop + ry}px`;
                        const angle = (Math.random() - .5) * Math.PI;
                        const dist  = 60 + Math.random() * 140;
                        d.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
                        d.style.setProperty('--dy', `${-40 - Math.random() * dist}px`);
                        d.style.animationDelay = `${Math.random() * .2}s`;
                        dust.appendChild(d);
                    }
                    requestAnimationFrame(() => $$('.dust-particle', dust).forEach(p => p.classList.add('go')));

                    // fade out the text
                    ta.style.transition = 'opacity .55s ease';
                    ta.style.opacity = 0;

                    await sleep(900);
                    ta.value = '';
                    ta.style.opacity = 1;
                    cnt.textContent = '0 / 220';
                    dust.innerHTML = '';

                    valT.textContent = "that sounds incredibly heavy to carry alone. your thought is safe here. we can unpack it whenever you are ready.";
                    val.classList.add('is-shown');
                    showHook(900);
                }
            },
        },

        /* ─────────── NEXUS ─────────── */
        nexus: {
            tag: 'you are not the only one',
            title: 'Nexus',
            render() {
                const el = document.createElement('div');
                el.innerHTML = `
                    <p class="nexus-prompt">what is weighing on you right now? two words is enough.</p>
                    <input id="nx-input" class="nexus-input" placeholder="e.g. anxiety about the future" autocomplete="off" />
                    <div class="nexus-feed" id="nx-feed">
                        <div class="nexus-card">
                            <div class="nexus-card-head">
                                <span class="nexus-handle">QuietNorth_22</span>
                                <span class="nexus-match">— %</span>
                            </div>
                            <p class="nexus-body">i scroll past everyone's highlight reel and feel further behind every time</p>
                        </div>
                        <div class="nexus-card">
                            <div class="nexus-card-head">
                                <span class="nexus-handle">NeonSky_42</span>
                                <span class="nexus-match">— %</span>
                            </div>
                            <p class="nexus-body">lying awake at 3am wondering if i'm on the right path. it feels overwhelming today.</p>
                        </div>
                        <div class="nexus-card">
                            <div class="nexus-card-head">
                                <span class="nexus-handle">SoftLamp_7</span>
                                <span class="nexus-match">— %</span>
                            </div>
                            <p class="nexus-body">i smile at work all day, then sit in my car and just exhale</p>
                        </div>
                    </div>
                    <p class="nexus-status" id="nx-status">type a feeling — we'll find your match.</p>
                `;
                return el;
            },
            afterMount() {
                const inp    = $('#nx-input');
                const feed   = $('#nx-feed');
                const status = $('#nx-status');
                setTimeout(() => inp?.focus(), 250);
                setProgress(28);

                let armed = false;
                inp.addEventListener('input', () => {
                    if (inp.value.trim().length >= 3 && !armed) {
                        armed = true;
                        runMatch();
                    }
                });
                inp.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !armed) { armed = true; runMatch(); }
                });

                async function runMatch() {
                    setProgress(55);
                    status.innerHTML = `<span class="nx-spinner"></span> reading the room…`;
                    await sleep(700);
                    status.innerHTML = `<span class="nx-spinner"></span> finding people who feel exactly like this…`;
                    await sleep(900);

                    // reveal the matched card with the strongest pull
                    const cards = $$('.nexus-card', feed);
                    cards[1].classList.add('revealed');
                    cards[1].querySelector('.nexus-match').textContent = '🔥 94% vibe match';

                    await sleep(600);
                    cards[0].classList.add('revealed');
                    cards[0].querySelector('.nexus-match').textContent = '82% vibe match';
                    await sleep(500);
                    cards[2].classList.add('revealed');
                    cards[2].querySelector('.nexus-match').textContent = '78% vibe match';

                    status.textContent = "you are not the only one feeling this. you never were.";
                    showHook(700);
                }
            },
        },

        /* ─────────── ECHO ─────────── */
        echo: {
            tag: 'a voice in the quiet',
            title: 'Echo',
            render() {
                const el = document.createElement('div');
                el.innerHTML = `
                    <div class="echo-stream" id="e-stream">
                        <div class="echo-msg echo-msg-echo">echo is awake. say hello, or drop a thought.</div>
                    </div>
                    <div class="echo-input-row">
                        <input id="e-input" placeholder="i'm just tired…" autocomplete="off" />
                        <button id="e-send" class="echo-send">send</button>
                    </div>
                    <p style="margin-top:14px;font-size:11.5px;color:var(--ink-mute);text-align:center;letter-spacing:.04em">
                        a one-message taste · the full conversation lives inside your vault
                    </p>
                `;
                return el;
            },
            afterMount(opts = {}) {
                const stream = $('#e-stream');
                const inp    = $('#e-input');
                const btn    = $('#e-send');
                let used     = false;

                setTimeout(() => inp?.focus(), 250);
                setProgress(28);

                if (opts.seed) {
                    inp.value = opts.seed;
                    setTimeout(send, 320);
                }

                btn.addEventListener('click', send);
                inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

                async function send() {
                    if (used) return;
                    const txt = inp.value.trim();
                    if (!txt) { inp.focus(); return; }
                    used = true;
                    btn.disabled = true;
                    inp.disabled = true;

                    // user message
                    const me = document.createElement('div');
                    me.className = 'echo-msg echo-msg-you';
                    me.textContent = txt;
                    stream.appendChild(me);
                    stream.scrollTop = stream.scrollHeight;

                    // typing bubble
                    const bot = document.createElement('div');
                    bot.className = 'echo-msg echo-msg-echo typing';
                    bot.textContent = '';
                    stream.appendChild(bot);

                    setProgress(60);

                    let reply = '';
                    try {
                        const r = await fetch('/api/chat', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                stream: false,
                                messages: [
                                    {
                                        role: 'system',
                                        content:
                                            'You are Echo, a quietly empathetic companion on the blaksyd landing page. ' +
                                            'You are giving the user a single, deeply present response — under 50 words, ' +
                                            'warm, no advice, no clinical language, no questions piled on. ' +
                                            'Match their language. Acknowledge what they said specifically, gently. ' +
                                            'Reflect back the feeling in plain words. Lowercase or normal sentence case is fine. ' +
                                            'No emojis. No "I\'m sorry to hear". Sound like a friend who reads slowly.',
                                    },
                                    { role: 'user', content: txt },
                                ],
                            }),
                        });
                        if (r.ok) {
                            const data = await r.json();
                            reply = (data.reply || data.message || '').toString().trim();
                        }
                    } catch (_) { /* fall through */ }

                    if (!reply) reply = canonicalEchoReply(txt);

                    await typeOut(bot, reply);
                    bot.classList.remove('typing');
                    showHook(800);
                }

                function canonicalEchoReply(txt) {
                    const t = txt.toLowerCase();
                    if (/(tired|exhaust|drain)/.test(t))
                        return "i hear you. the kind of tired that sleep doesn't fix, right? i'm right here. take a breath, there's no rush.";
                    if (/(anxious|anxiety|panic|nerv)/.test(t))
                        return "your body is doing a lot right now, even if no one can see it. that's real. you can sit here as long as you need.";
                    if (/(sad|down|low|empty|numb)/.test(t))
                        return "you don't have to call it anything. it's heavy and that's enough of a reason. i'm here.";
                    if (/(lonely|alone|isolat)/.test(t))
                        return "being unseen is its own kind of loud. you are seen here. not by an algorithm — by us.";
                    if (/(angry|mad|furious|rage)/.test(t))
                        return "anger usually means something underneath it got hurt. you don't have to explain. i'm not going anywhere.";
                    return "thank you for trusting me with that. it's safe here. you don't have to perform anything.";
                }

                async function typeOut(node, text) {
                    // cascade at a calm reading pace — ~32 chars/sec
                    const total = text.length;
                    let out = '';
                    for (let i = 0; i < total; i++) {
                        out += text[i];
                        node.textContent = out;
                        stream.scrollTop = stream.scrollHeight;
                        const ch = text[i];
                        let d = 28;
                        if (ch === ' ') d = 18;
                        if (/[.,!?;:]/.test(ch)) d = 220;
                        if (ch === '\n') d = 320;
                        await sleep(d);
                    }
                }
            },
        },

        /* ─────────── LISTENERS ─────────── */
        listener: {
            tag: 'someone is ready to listen',
            title: 'Listeners',
            render() {
                const el = document.createElement('div');
                el.innerHTML = `
                    <div class="listener-status">
                        <span class="live-dot"></span>
                        <b id="l-online">12 listeners online</b> · trained · anonymous
                    </div>
                    <p class="listener-prompt">sometimes you just need a real human. what do you want to talk about?</p>
                    <div class="listener-tags" id="l-tags">
                        <button class="listener-tag" data-mood="Heartbreak">Heartbreak</button>
                        <button class="listener-tag" data-mood="Work Stress">Work Stress</button>
                        <button class="listener-tag" data-mood="Family">Family</button>
                        <button class="listener-tag" data-mood="Loneliness">Loneliness</button>
                        <button class="listener-tag" data-mood="Burnout">Burnout</button>
                        <button class="listener-tag" data-mood="Just need to vent">Just need to vent</button>
                    </div>
                    <div class="listener-match" id="l-match" aria-live="polite">
                        <p class="listener-match-line">pick a tag above — we'll find someone who's been there.</p>
                    </div>
                `;
                return el;
            },
            afterMount() {
                const tagBox = $('#l-tags');
                const match  = $('#l-match');
                setProgress(28);

                const profiles = {
                    'Heartbreak':  { name: 'Maya',  bio: "navigated a long breakup last year. soft listener, gives you the floor." },
                    'Work Stress': { name: 'Sarah', bio: "navigated burnout before. patient, won't try to fix you." },
                    'Family':      { name: 'Arjun', bio: "knows messy family lines. holds space without taking sides." },
                    'Loneliness':  { name: 'Iris',  bio: "spent a year mostly alone. understands the quiet kind of heavy." },
                    'Burnout':     { name: 'Sarah', bio: "navigated burnout before. patient, won't try to fix you." },
                    'Just need to vent': { name: 'Theo', bio: "the kind of person who actually waits for you to finish." },
                };

                tagBox.addEventListener('click', async (e) => {
                    const btn = e.target.closest('.listener-tag');
                    if (!btn) return;
                    $$('.listener-tag', tagBox).forEach(t => t.classList.remove('is-active'));
                    btn.classList.add('is-active');
                    const mood = btn.dataset.mood;

                    setProgress(55);

                    match.classList.remove('found');
                    match.innerHTML = `
                        <p class="listener-match-line"><span class="nx-spinner"></span> finding a listener who understands "<b>${mood}</b>"…</p>
                    `;
                    await sleep(900);

                    match.innerHTML = `
                        <p class="listener-match-line"><span class="nx-spinner"></span> three matches found. picking the closest one…</p>
                    `;
                    await sleep(800);

                    const p = profiles[mood] || profiles['Just need to vent'];
                    match.classList.add('found');
                    match.innerHTML = `
                        <p class="listener-match-line lead">found ${p.name}. she's online right now.</p>
                        <div class="listener-profile">
                            <div class="listener-avatar">${p.name[0]}</div>
                            <div>
                                <div class="listener-name">${p.name} · trained listener</div>
                                <div class="listener-bio">${p.bio}</div>
                            </div>
                        </div>
                        <p class="listener-match-line" style="margin-top:14px">she'll be there when you're ready. nothing happens until you say so.</p>
                    `;
                    showHook(700);
                });
            },
        },

    };

    /* ═══════════════════════════════════════════════════════════════
       7. AUTH OVERLAY
       ═══════════════════════════════════════════════════════════════ */
    function openAuth() {
        const o = $('#auth-overlay'); if (!o) return;
        o.classList.add('is-open');
        o.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        setTimeout(() => $('#email')?.focus(), 320);
    }
    function closeAuth() {
        const o = $('#auth-overlay'); if (!o) return;
        o.classList.remove('is-open');
        o.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
    }
    function bindAuth() {
        $$('[data-close-auth]').forEach(el => el.addEventListener('click', closeAuth));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && $('#auth-overlay')?.classList.contains('is-open')) closeAuth();
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       8. LISTENERS-ONLINE — gentle drift to feel alive
       ═══════════════════════════════════════════════════════════════ */
    function bindLiveCount() {
        const a  = $('#listeners-online'); // hidden ambient counter
        const b  = $('#l-online');         // legacy modal element
        const lp = $('#lp-online');        // new preview-card element (small int e.g. "6")
        let n = 12;
        let preview = 6;
        function tick() {
            const drift = Math.random() < .5 ? -1 : 1;
            n = clamp(n + drift, 8, 18);
            preview = clamp(preview + (Math.random() < .5 ? -1 : 1), 4, 9);
            if (a)  a.textContent = n;
            if (b)  b.textContent = `${n} listeners online`;
            if (lp) lp.textContent = preview;
        }
        setInterval(tick, 8000);
    }

    /* ═══════════════════════════════════════════════════════════════
       9. FOOTER YEAR
       ═══════════════════════════════════════════════════════════════ */
    function bindMisc() {
        const y = $('#foot-year'); if (y) y.textContent = new Date().getFullYear();
    }

    /* ═══════════════════════════════════════════════════════════════
       BOOT
       ═══════════════════════════════════════════════════════════════ */
    function boot() {
        initTheme();
        bindTheme();
        bindNav();
        bindHero();
        bindVibe();
        bindOverlay();
        bindFeaturePreviews();
        bindAuth();
        bindLiveCount();
        bindMisc();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();
